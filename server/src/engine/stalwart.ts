import { HttpError, upstream } from '../core/errors';
import { sha512Crypt } from '../core/sha512crypt';
import type {
  CreateMailboxInput,
  EngineDnsRecord,
  EngineHealth,
  EngineSettings,
  MailEngine,
  QueueSummary,
  UpdateMailboxPatch,
} from './types';

/**
 * Driver para Stalwart Mail Server v0.12–v0.15 a través de su API REST de
 * gestión (`/api/...`). Verificado contra los docs 0.15 (stalw.art/docs/0.15)
 * y el código fuente del tag v0.15.5.
 *
 * Importante: Stalwart v0.16+ eliminó esta API REST (pasó a JMAP), por eso el
 * compose de Mailway fija la imagen a `stalwartlabs/stalwart:v0.15`.
 *
 * Autenticación: HTTP Basic con el "fallback admin" (authentication.fallback-admin).
 * Contraseñas: la API NO hashea; se envían ya en formato $6$ (sha512-crypt).
 */
export class StalwartEngine implements MailEngine {
  readonly kind = 'stalwart' as const;

  constructor(private settings: EngineSettings) {}

  private get baseUrl(): string {
    return this.settings.url.replace(/\/+$/, '');
  }

  private authHeader(): string {
    const raw = `${this.settings.adminUser}:${this.settings.adminPassword}`;
    return `Basic ${Buffer.from(raw).toString('base64')}`;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader(),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw upstream(
        `No se pudo conectar con el motor de correo (${this.baseUrl}): ${(err as Error).message}`,
        'engine_unreachable',
      );
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // cuerpo no JSON: se conserva el texto para el mensaje de error
    }
    if (!res.ok) {
      // Errores en formato RFC 7807 (application/problem+json)
      const problem = parsed as { detail?: string; title?: string } | null;
      const detail = problem?.detail || problem?.title || text.slice(0, 300) || res.statusText;
      // El 404 se marca aparte para que los borrados puedan ser idempotentes
      // (borrar un principal que ya no existe no debe ser un error fatal).
      throw new HttpError(
        502,
        `El motor de correo respondió ${res.status}: ${detail}`,
        res.status === 404 ? 'engine_not_found' : 'engine_error',
      );
    }
    // Las respuestas de la API de gestión envuelven en { data: ... }
    if (parsed && typeof parsed === 'object' && 'data' in (parsed as object)) {
      return (parsed as { data: T }).data;
    }
    return parsed as T;
  }

  async ping(): Promise<EngineHealth> {
    try {
      await this.request('GET', '/api/principal?types=domain&page=1&limit=1');
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async createDomain(domain: string): Promise<void> {
    await this.request('POST', '/api/principal', {
      type: 'domain',
      name: domain,
      description: 'Dominio gestionado por Mailway',
      quota: 0,
      secrets: [],
      emails: [],
      urls: [],
      memberOf: [],
      roles: [],
      lists: [],
      members: [],
      enabledPermissions: [],
      disabledPermissions: [],
      externalMembers: [],
    });
  }

  async deleteDomain(domain: string): Promise<void> {
    await this.deletePrincipal(domain);
  }

  async ensureDkim(domain: string, _selector: string): Promise<void> {
    // Stalwart autogenera id y selector (p. ej. 202508e / 202508r).
    // Se crean ambas firmas; los errores por "ya existe" no son fatales.
    for (const algorithm of ['Ed25519', 'Rsa'] as const) {
      try {
        await this.request('POST', '/api/dkim', {
          id: null,
          algorithm,
          domain,
          selector: null,
        });
      } catch (err) {
        const message = (err as Error).message.toLowerCase();
        if (!message.includes('exist') && !message.includes('already')) throw err;
      }
    }
  }

  async getDnsRecords(domain: string): Promise<EngineDnsRecord[]> {
    const records = await this.request<{ type: string; name: string; content: string }[]>(
      'GET',
      `/api/dns/records/${encodeURIComponent(domain)}`,
    );
    return (records || []).map((r) => ({ type: r.type, name: r.name, content: r.content }));
  }

  async createMailbox(input: CreateMailboxInput): Promise<void> {
    await this.request('POST', '/api/principal', {
      type: 'individual',
      name: input.email,
      description: input.displayName || '',
      quota: input.quotaBytes ?? 0,
      secrets: [sha512Crypt(input.password)],
      emails: [input.email],
      urls: [],
      memberOf: [],
      roles: ['user'],
      lists: [],
      members: [],
      enabledPermissions: [],
      disabledPermissions: [],
      externalMembers: [],
    });
  }

  async setMailboxPassword(email: string, password: string): Promise<void> {
    // "set" reemplaza TODOS los secrets. Para no romper las contraseñas de
    // aplicación ($app$…) de las claves de API activas, las conservamos: solo
    // se sustituye la contraseña principal del buzón.
    const appPasswords = (await this.getSecrets(email)).filter((s) => s.startsWith('$app$'));
    await this.updatePrincipal(email, [
      { action: 'set', field: 'secrets', value: [sha512Crypt(password), ...appPasswords] },
    ]);
  }

  async updateMailbox(email: string, patch: UpdateMailboxPatch): Promise<void> {
    const updates: PrincipalUpdate[] = [];
    if (patch.displayName !== undefined) {
      updates.push({ action: 'set', field: 'description', value: patch.displayName });
    }
    if (patch.quotaBytes !== undefined) {
      updates.push({ action: 'set', field: 'quota', value: patch.quotaBytes });
    }
    if (patch.suspended !== undefined) {
      // Sin el rol "user" la cuenta no puede autenticarse (IMAP/SMTP/webmail).
      updates.push({ action: 'set', field: 'roles', value: patch.suspended ? [] : ['user'] });
    }
    if (updates.length > 0) await this.updatePrincipal(email, updates);
  }

  async deleteMailbox(email: string): Promise<void> {
    await this.deletePrincipal(email);
  }

  async upsertAlias(alias: string, destinations: string[]): Promise<void> {
    // Un alias es un principal de tipo "list": los miembros reciben el correo.
    await this.deleteAlias(alias).catch(() => undefined);
    await this.request('POST', '/api/principal', {
      type: 'list',
      name: alias,
      description: 'Alias gestionado por Mailway',
      quota: 0,
      secrets: [],
      emails: [alias],
      urls: [],
      memberOf: [],
      roles: [],
      lists: [],
      members: destinations,
      enabledPermissions: [],
      disabledPermissions: [],
      externalMembers: [],
    });
  }

  async deleteAlias(alias: string): Promise<void> {
    await this.deletePrincipal(alias);
  }

  async addAppPassword(email: string, password: string, label: string): Promise<string> {
    // Formato verificado: $app$<nombre>$<hash>. El usuario se autentica con
    // la contraseña en claro; Stalwart la compara contra el hash.
    const stored = `$app$${label}$${sha512Crypt(password)}`;
    await this.updatePrincipal(email, [{ action: 'addItem', field: 'secrets', value: stored }]);
    return stored;
  }

  async removeAppPassword(email: string, storedSecret: string): Promise<void> {
    await this.updatePrincipal(email, [
      { action: 'removeItem', field: 'secrets', value: storedSecret },
    ]);
  }

  async getQueueSummary(): Promise<QueueSummary> {
    const result = await this.request<{ items?: unknown[]; total?: number }>(
      'GET',
      '/api/queue/messages?page=1&limit=1',
    );
    const total = typeof result?.total === 'number' ? result.total : 0;
    return { pending: total, oldestSeconds: null };
  }

  private async updatePrincipal(name: string, updates: PrincipalUpdate[]): Promise<void> {
    await this.request('PATCH', `/api/principal/${encodeURIComponent(name)}`, updates);
  }

  /** Borrado idempotente: si el principal ya no existe (404), es un éxito. */
  private async deletePrincipal(name: string): Promise<void> {
    try {
      await this.request('DELETE', `/api/principal/${encodeURIComponent(name)}`);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'engine_not_found') return;
      throw err;
    }
  }

  /** Lee los secrets actuales de un principal (contraseña + app-passwords). */
  private async getSecrets(email: string): Promise<string[]> {
    const data = await this.request<{ secrets?: string[] | string }>(
      'GET',
      `/api/principal/${encodeURIComponent(email)}`,
    );
    const secrets = data?.secrets;
    if (Array.isArray(secrets)) return secrets;
    if (typeof secrets === 'string' && secrets) return [secrets];
    return [];
  }
}

interface PrincipalUpdate {
  action: 'set' | 'addItem' | 'removeItem';
  field: string;
  value: unknown;
}
