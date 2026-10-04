import { HttpError } from '../core/errors';
import { normalizeHostname } from '../core/hostnames';
import { sha512Crypt, verifySha512Crypt } from '../core/sha512crypt';
import type {
  CreateMailboxInput,
  EngineDnsRecord,
  EngineHealth,
  EnginePrincipal,
  EngineReloadResult,
  MailEngine,
  QueueSummary,
  RemoteDomainsResult,
  UpdateMailboxPatch,
} from './types';
import { normalizarDominiosRemotos } from './recepcion';

/**
 * Motor de demostración: no habla con ningún servidor real. Permite probar el
 * panel completo (clientes, dominios, buzones, claves de API) sin desplegar
 * Stalwart. Los envíos de la API se registran pero no salen a Internet.
 */
export class DemoEngine implements MailEngine {
  readonly kind = 'demo' as const;

  async ping(): Promise<EngineHealth> {
    return { ok: true, version: 'demo', detail: 'Modo demostración: sin motor de correo real.' };
  }

  async createDomain(domain: string): Promise<void> {
    this.dominios.add(domain.toLowerCase());
  }

  async deleteDomain(domain: string): Promise<void> {
    this.dominios.delete(domain.toLowerCase());
  }

  async ensureDkim(): Promise<void> {}

  async getDnsRecords(domain: string): Promise<EngineDnsRecord[]> {
    return [
      { type: 'MX', name: domain, content: `10 mail.${domain}.` },
      { type: 'TXT', name: domain, content: `v=spf1 mx -all` },
      {
        type: 'TXT',
        name: `mail._domainkey.${domain}`,
        content: 'v=DKIM1; k=rsa; p=DEMO...',
      },
      {
        type: 'TXT',
        name: `_dmarc.${domain}`,
        content: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`,
      },
    ];
  }

  /*
   * Estado en memoria del modo demostración: basta para que el portal del
   * titular, las contraseñas de aplicación y las pruebas se comporten como
   * con un motor real (una contraseña equivocada se rechaza de verdad).
   */
  private readonly passwords = new Map<string, string>();
  private readonly appPasswords = new Map<string, Set<string>>();
  private readonly suspended = new Set<string>();
  private readonly settings = new Map<string, string>();
  /*
   * Directorio mínimo (nombre → principal) para el contrato del cambio de
   * dominio. La pieza del motor lo sustituye por el modelo de principales
   * completo; aquí basta para renombrar y leer direcciones en las pruebas.
   */
  private readonly principales = new Map<string, { id: number; type: string; emails: string[] }>();
  private readonly dominios = new Set<string>();
  private siguienteId = 1;
  /** Recargas del directorio pedidas (para las pruebas). */
  recargas = 0;

  private registrar(name: string, type: string): void {
    const key = name.toLowerCase();
    if (!this.principales.has(key)) {
      this.principales.set(key, { id: this.siguienteId++, type, emails: [key] });
    }
  }

  async createMailbox(input: CreateMailboxInput): Promise<void> {
    const email = input.email.toLowerCase();
    this.passwords.set(email, sha512Crypt(input.password));
    this.appPasswords.set(email, new Set());
    this.suspended.delete(email);
    this.registrar(email, 'individual');
  }

  async setMailboxPassword(email: string, password: string): Promise<void> {
    this.passwords.set(email.toLowerCase(), sha512Crypt(password));
  }

  async updateMailbox(email: string, patch: UpdateMailboxPatch): Promise<void> {
    if (patch.suspended === undefined) return;
    if (patch.suspended) this.suspended.add(email.toLowerCase());
    else this.suspended.delete(email.toLowerCase());
  }

  async deleteMailbox(email: string): Promise<void> {
    const key = email.toLowerCase();
    this.passwords.delete(key);
    this.appPasswords.delete(key);
    this.suspended.delete(key);
    this.principales.delete(key);
  }

  async upsertAlias(alias: string): Promise<void> {
    this.registrar(alias, 'list');
  }

  async deleteAlias(alias: string): Promise<void> {
    this.principales.delete(alias.toLowerCase());
  }

  async getPrincipal(name: string): Promise<EnginePrincipal | null> {
    const key = name.toLowerCase();
    const p = this.principales.get(key);
    return p ? { id: p.id, type: p.type, name: key, emails: [...p.emails] } : null;
  }

  /** Comprueba que cada dirección es de un dominio del motor y de nadie más. */
  private comprobarDirecciones(propio: string, emails: string[]): void {
    for (const email of emails) {
      const dominio = email.slice(email.lastIndexOf('@') + 1);
      if (!this.dominios.has(dominio)) {
        throw new HttpError(502, `El motor de correo no encuentra el elemento (${dominio}).`, 'engine_not_found');
      }
      for (const [name, p] of this.principales) {
        if (name !== propio && p.emails.includes(email)) {
          throw new HttpError(502, `El motor de correo ya tiene ese elemento «${email}».`, 'engine_exists');
        }
      }
    }
  }

  async setAddresses(name: string, ops: { add?: string[]; remove?: string[]; primary?: string }): Promise<string[]> {
    const key = name.toLowerCase();
    const p = this.principales.get(key);
    if (!p) throw new HttpError(502, `El motor de correo no encuentra el elemento (${key}).`, 'engine_not_found');
    const quitar = new Set((ops.remove ?? []).map((e) => e.toLowerCase()));
    let lista = p.emails.filter((e) => !quitar.has(e));
    for (const e of (ops.add ?? []).map((x) => x.toLowerCase())) if (!lista.includes(e)) lista.push(e);
    if (ops.primary) {
      const primera = ops.primary.toLowerCase();
      lista = [primera, ...lista.filter((e) => e !== primera)];
    }
    if (lista.join(',') === p.emails.join(',')) return [...lista];
    this.comprobarDirecciones(key, lista.filter((e) => !p.emails.includes(e)));
    p.emails = lista;
    return [...lista];
  }

  async renamePrincipal(from: string, to: string, opts: { expectEmail: string; emails?: string[] }): Promise<void> {
    const origen = from.toLowerCase();
    const destino = to.toLowerCase();
    const p = this.principales.get(origen);
    const ocupado = this.principales.get(destino);
    if (!p) {
      if (ocupado?.emails.includes(opts.expectEmail.toLowerCase())) return;
      if (ocupado) throw new HttpError(502, `El motor de correo ya tiene ese elemento «${destino}».`, 'engine_exists');
      throw new HttpError(502, `El motor de correo no encuentra el elemento (${origen}).`, 'engine_not_found');
    }
    if (ocupado) throw new HttpError(502, `El motor de correo ya tiene ese elemento «${destino}».`, 'engine_exists');
    if (opts.emails) {
      const emails = [...new Set(opts.emails.map((e) => e.toLowerCase()))];
      this.comprobarDirecciones(origen, emails.filter((e) => !p.emails.includes(e)));
      p.emails = emails;
    }
    this.principales.delete(origen);
    this.principales.set(destino, p);
    // Las contraseñas (principal y de aplicación) y la suspensión van con el principal.
    for (const mapa of [this.passwords, this.appPasswords] as Map<string, unknown>[]) {
      if (mapa.has(origen)) {
        mapa.set(destino, mapa.get(origen));
        mapa.delete(origen);
      }
    }
    if (this.suspended.delete(origen)) this.suspended.add(destino);
  }

  async reloadDirectory(): Promise<void> {
    this.recargas += 1;
  }

  async removeDkim(): Promise<string[]> {
    return [];
  }

  async addAppPassword(email: string, password: string, label: string): Promise<string> {
    const stored = `$app$${label}$${sha512Crypt(password)}`;
    const key = email.toLowerCase();
    if (!this.appPasswords.has(key)) this.appPasswords.set(key, new Set());
    this.appPasswords.get(key)!.add(stored);
    return stored;
  }

  async removeAppPassword(email: string, storedSecret: string): Promise<void> {
    this.appPasswords.get(email.toLowerCase())?.delete(storedSecret);
  }

  async verifyCredentials(email: string, password: string): Promise<boolean | null> {
    const key = email.toLowerCase();
    if (this.suspended.has(key)) return false;
    const main = this.passwords.get(key);
    if (main && verifySha512Crypt(password, main)) return true;
    for (const stored of this.appPasswords.get(key) || []) {
      const hash = stored.slice(stored.indexOf('$', 5) + 1);
      if (verifySha512Crypt(password, hash)) return true;
    }
    return false;
  }

  async getMailboxUsage(): Promise<Map<string, number>> {
    // Sin motor no hay correo guardado: todos los buzones conocidos están vacíos.
    return new Map([...this.passwords.keys()].map((email) => [email, 0]));
  }

  async applyServerSettings(values: Record<string, string>): Promise<EngineReloadResult> {
    for (const [key, value] of Object.entries(values)) this.settings.set(key, value);
    return { errors: [], warnings: [] };
  }

  async getServerSettings(keys: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const key of keys) {
      const value = this.settings.get(key);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  /** Sin motor real, «arranca» con el último nombre que se le aplicó (si alguno). */
  async getRunningHostname(): Promise<string | null> {
    const value = normalizeHostname(this.settings.get('server.hostname') ?? '');
    return value || null;
  }

  async reloadCertificates(): Promise<void> {}

  async getQueueSummary(): Promise<QueueSummary> {
    return { pending: 0, oldestSeconds: null };
  }

  /** Dominios que el motor de demostración «entrega por MX» (para las pruebas). */
  remoteDomains: string[] = [];

  async syncRemoteDomains(domains: string[]): Promise<RemoteDomainsResult> {
    const nuevos = normalizarDominiosRemotos(domains);
    const changed = nuevos.join(',') !== this.remoteDomains.join(',');
    this.remoteDomains = nuevos;
    return { changed, customized: false, errors: [], warnings: [] };
  }
}
