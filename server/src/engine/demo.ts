import { sha512Crypt, verifySha512Crypt } from '../core/sha512crypt';
import type {
  CreateMailboxInput,
  EngineDnsRecord,
  EngineHealth,
  EngineReloadResult,
  MailEngine,
  QueueSummary,
  UpdateMailboxPatch,
} from './types';

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

  async createDomain(): Promise<void> {}
  async deleteDomain(): Promise<void> {}
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

  async createMailbox(input: CreateMailboxInput): Promise<void> {
    const email = input.email.toLowerCase();
    this.passwords.set(email, sha512Crypt(input.password));
    this.appPasswords.set(email, new Set());
    this.suspended.delete(email);
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
  }

  async upsertAlias(): Promise<void> {}
  async deleteAlias(): Promise<void> {}

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

  async reloadCertificates(): Promise<void> {}

  async getQueueSummary(): Promise<QueueSummary> {
    return { pending: 0, oldestSeconds: null };
  }
}
