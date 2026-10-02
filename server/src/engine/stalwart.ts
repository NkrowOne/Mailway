import { HttpError, upstream } from '../core/errors';
import { sha512Crypt, verifySha512Crypt } from '../core/sha512crypt';
import type {
  CreateMailboxInput,
  EngineDnsRecord,
  EngineHealth,
  EngineReloadResult,
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
      if (res.status === 404) {
        // En 0.15 «no existe» llega con HTTP 200 y { error: "notFound" }. Un
        // 404 de verdad es una RUTA desconocida (URL del motor mal puesta, un
        // proxy con otro prefijo o un motor sin esta API): si se tomara por
        // «no existe», los borrados «tendrían éxito» sin hacer nada y los
        // principales seguirían recibiendo correo y aceptando contraseñas.
        throw new HttpError(
          502,
          `El motor de correo no reconoce la ruta de gestión ${path.split('?')[0]} (HTTP 404). Revisa la URL del motor en Ajustes: debe ser la de la API de gestión de Stalwart 0.15.`,
          'engine_error',
        );
      }
      // Errores en formato RFC 7807 (application/problem+json)
      const problem = parsed as { detail?: string; title?: string } | null;
      const detail = problem?.detail || problem?.title || text.slice(0, 300) || res.statusText;
      throw new HttpError(502, `El motor de correo respondió ${res.status}: ${detail}`, 'engine_error');
    }
    // Stalwart 0.15 devuelve los errores de gestión con HTTP 200 y un cuerpo
    // { error: "notFound" | "fieldAlreadyExists" | "other" | … } sin "data".
    // Si no se miran aquí, un alta duplicada o un borrado de algo que no
    // existe pasarían por éxitos.
    if (parsed && typeof parsed === 'object' && !('data' in (parsed as object))) {
      const problem = parsed as {
        error?: unknown;
        details?: unknown;
        reason?: unknown;
        item?: unknown;
        field?: unknown;
        value?: unknown;
      };
      if (typeof problem.error === 'string') {
        throw engineProblem(problem);
      }
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
    try {
      await this.createDomainPrincipal(domain);
    } catch (err) {
      // Un dominio que ya existe en el motor (p. ej. huérfano de un borrado
      // interrumpido) se adopta: el panel es la fuente de verdad.
      if (err instanceof HttpError && err.code === 'engine_exists') return;
      throw err;
    }
  }

  private async createDomainPrincipal(domain: string): Promise<void> {
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
    // Stalwart autogenera id (rsa-<dominio> / ed25519-<dominio>, los que usa
    // su regla de firma por defecto) y selector (p. ej. 202609r / 202609e).
    // Se crean ambas firmas; "ya existe" no es un error.
    let created = false;
    for (const algorithm of ['Ed25519', 'Rsa'] as const) {
      try {
        await this.request('POST', '/api/dkim', {
          id: null,
          algorithm,
          domain,
          selector: null,
        });
        created = true;
      } catch (err) {
        if (err instanceof HttpError && err.code === 'engine_exists') continue;
        const message = (err as Error).message.toLowerCase();
        if (!message.includes('exist') && !message.includes('already')) throw err;
      }
    }
    // Los firmantes solo se cargan al reconstruir la configuración: sin la
    // recarga, el correo saldría sin firmar hasta el próximo reinicio.
    if (created) await this.reload().catch(() => undefined);
  }

  async getDnsRecords(domain: string): Promise<EngineDnsRecord[]> {
    const records = await this.request<{ type: string; name: string; content: string }[]>(
      'GET',
      `/api/dns/records/${encodeURIComponent(domain)}`,
    );
    return (records || []).map((r) => ({ type: r.type, name: r.name, content: r.content }));
  }

  async createMailbox(input: CreateMailboxInput): Promise<void> {
    try {
      await this.createMailboxPrincipal(input);
    } catch (err) {
      if (!(err instanceof HttpError) || err.code !== 'engine_exists') throw err;
      // Buzón huérfano en el motor (existía allí pero no en el panel): se
      // adopta y se deja exactamente como lo pide el panel, con la contraseña
      // nueva y sin contraseñas de aplicación antiguas.
      await this.updatePrincipal(input.email, [
        { action: 'set', field: 'description', value: input.displayName || '' },
        { action: 'set', field: 'quota', value: input.quotaBytes ?? 0 },
        { action: 'set', field: 'secrets', value: [sha512Crypt(input.password)] },
        { action: 'set', field: 'emails', value: [input.email] },
        { action: 'set', field: 'roles', value: ['user'] },
      ]);
    }
  }

  private async createMailboxPrincipal(input: CreateMailboxInput): Promise<void> {
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
    // En Stalwart 0.15, "addItem" de un secreto que no es $app$ sustituye solo
    // la contraseña principal: las contraseñas de aplicación (claves de API,
    // dispositivos, Skyway) siguen funcionando.
    await this.updatePrincipal(email, [
      { action: 'addItem', field: 'secrets', value: sha512Crypt(password) },
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

  async upsertAlias(
    alias: string,
    destinations: string[],
    externalDestinations: string[] = [],
  ): Promise<void> {
    // Un alias es un principal de tipo "list": los miembros (buzones de la
    // instancia) y los miembros externos (direcciones de fuera) reciben el
    // correo. Si ya existe, se sustituyen los miembros con UN solo PATCH:
    // Stalwart valida los miembros antes de escribir, así que si alguno no
    // existe la lista se queda como estaba. Borrar y recrear dejaba el alias
    // fuera del motor (y el correo rebotando) cuando la creación fallaba.
    const members: PrincipalUpdate[] = [
      { action: 'set', field: 'members', value: destinations },
      { action: 'set', field: 'externalMembers', value: externalDestinations },
    ];
    try {
      await this.updatePrincipal(alias, members);
      return;
    } catch (err) {
      // Solo «la lista no existe» lleva a crearla; un miembro inexistente es
      // un error de verdad y se propaga sin tocar nada.
      if (!isNotFoundOf(err, alias)) throw err;
    }
    try {
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
        externalMembers: externalDestinations,
      });
    } catch (err) {
      // Otra petición la creó entre el PATCH y el POST: se actualiza la suya.
      if (!(err instanceof HttpError) || err.code !== 'engine_exists') throw err;
      await this.updatePrincipal(alias, members);
    }
  }

  async verifyCredentials(email: string, password: string): Promise<boolean | null> {
    let data: { type?: string; secrets?: string[] | string; roles?: string[] } | null;
    try {
      data = await this.request<{ type?: string; secrets?: string[] | string; roles?: string[] }>(
        'GET',
        `/api/principal/${encodeURIComponent(email)}`,
      );
    } catch (err) {
      if (err instanceof HttpError && err.code === 'engine_not_found') return false;
      return null;
    }
    // Solo un buzón (principal individual) puede autenticarse.
    if (data?.type !== undefined && data.type !== 'individual') return false;
    // Sin el rol "user" la cuenta está suspendida y el motor la rechazaría.
    // Ojo: Stalwart omite los campos vacíos, así que un buzón suspendido
    // (roles: []) llega SIN la clave «roles»: su ausencia también es suspensión.
    if (!Array.isArray(data?.roles) || !data.roles.includes('user')) return false;
    const raw = data?.secrets;
    const secrets = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? [raw] : [];
    for (const secret of secrets) {
      if (secret.startsWith('$app$')) {
        // $app$<nombre>$<hash>: también valen para entrar (como en el motor).
        const hash = secret.slice(secret.indexOf('$', 5) + 1);
        if (hash.startsWith('$6$') && verifySha512Crypt(password, hash)) return true;
        continue;
      }
      if (secret.startsWith('$6$') && verifySha512Crypt(password, secret)) return true;
    }
    return false;
  }

  async getMailboxUsage(): Promise<Map<string, number>> {
    const result = await this.request<{ items?: { name?: string; usedQuota?: number }[] }>(
      'GET',
      '/api/principal?types=individual&page=1&limit=0&fields=name,usedQuota',
    );
    const usage = new Map<string, number>();
    for (const item of result?.items || []) {
      if (!item.name) continue;
      // usedQuota se omite cuando vale 0.
      usage.set(item.name.toLowerCase(), typeof item.usedQuota === 'number' ? item.usedQuota : 0);
    }
    return usage;
  }

  async applyServerSettings(values: Record<string, string>): Promise<EngineReloadResult> {
    const entries = Object.entries(values);
    if (entries.length > 0) {
      await this.request('POST', '/api/settings', [
        { type: 'insert', prefix: null, values: entries, assert_empty: false },
      ]);
    }
    return this.reload();
  }

  async getServerSettings(keys: string[]): Promise<Record<string, string>> {
    if (keys.length === 0) return {};
    const data = await this.request<Record<string, string | null> | null>(
      'GET',
      `/api/settings/keys?keys=${keys.map(encodeURIComponent).join(',')}`,
    );
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(data || {})) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  }

  async reloadCertificates(): Promise<void> {
    await this.request('GET', '/api/reload/certificate');
  }

  private async reload(): Promise<EngineReloadResult> {
    const result = await this.request<{ errors?: unknown; warnings?: unknown } | null>(
      'GET',
      '/api/reload',
    );
    return { errors: summarize(result?.errors), warnings: summarize(result?.warnings) };
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
    // Los elementos vienen en orden ascendente: el primero es el más antiguo.
    const result = await this.request<{ items?: { created?: string }[]; total?: number }>(
      'GET',
      '/api/queue/messages?page=1&limit=1&values=1',
    );
    const total = typeof result?.total === 'number' ? result.total : 0;
    const created = result?.items?.[0]?.created;
    const createdMs = created ? Date.parse(created) : NaN;
    const oldestSeconds = Number.isFinite(createdMs)
      ? Math.max(0, Math.round((Date.now() - createdMs) / 1000))
      : null;
    return { pending: total, oldestSeconds: total > 0 ? oldestSeconds : null };
  }

  private async updatePrincipal(name: string, updates: PrincipalUpdate[]): Promise<void> {
    await this.request('PATCH', `/api/principal/${encodeURIComponent(name)}`, updates);
  }

  /**
   * Borrado idempotente: si el principal ya no existe ({ error: "notFound" }),
   * es un éxito. Un HTTP 404 (ruta desconocida) NO lo es: llega como engine_error.
   */
  private async deletePrincipal(name: string): Promise<void> {
    try {
      await this.request('DELETE', `/api/principal/${encodeURIComponent(name)}`);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'engine_not_found') return;
      throw err;
    }
  }
}

interface PrincipalUpdate {
  action: 'set' | 'addItem' | 'removeItem';
  field: string;
  value: unknown;
}

/**
 * Error de gestión del motor. Conserva el elemento al que se refiere un
 * «notFound»: en un PATCH distingue «la lista no existe» de «uno de sus
 * miembros no existe», que exigen reacciones opuestas.
 */
class EngineProblem extends HttpError {
  readonly item: string | null;

  constructor(status: number, message: string, code: string, item: string | null) {
    super(status, message, code);
    this.item = item;
  }
}

/** ¿Es un «notFound» del propio principal `name` (y no de otro elemento)? */
function isNotFoundOf(err: unknown, name: string): boolean {
  if (!(err instanceof HttpError) || err.code !== 'engine_not_found') return false;
  const item = err instanceof EngineProblem ? err.item : null;
  // Sin elemento en la respuesta no se puede saber: se trata como error.
  return item !== null && item.toLowerCase() === name.toLowerCase();
}

/** Traduce un error de gestión de Stalwart (llega con HTTP 200) a HttpError. */
function engineProblem(problem: {
  error?: unknown;
  details?: unknown;
  reason?: unknown;
  item?: unknown;
  field?: unknown;
  value?: unknown;
}): HttpError {
  const kind = String(problem.error);
  if (kind === 'notFound') {
    const item = typeof problem.item === 'string' ? problem.item : null;
    return new EngineProblem(
      502,
      `El motor de correo no encuentra el elemento${item ? ` (${item})` : ''}.`,
      'engine_not_found',
      item,
    );
  }
  if (kind === 'fieldAlreadyExists') {
    const value = typeof problem.value === 'string' ? ` «${problem.value}»` : '';
    return new HttpError(502, `El motor de correo ya tiene ese elemento${value}.`, 'engine_exists');
  }
  const detail = [problem.details, problem.reason].filter((v) => typeof v === 'string' && v).join(': ');
  return new HttpError(
    502,
    `El motor de correo rechazó la operación (${kind})${detail ? `: ${detail}` : ''}.`,
    'engine_error',
  );
}

/** Convierte la lista de errores/avisos de una recarga en texto legible. */
function summarize(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(
      ([key, v]) => `${key}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
    );
  }
  return [String(value)];
}
