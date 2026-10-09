import { normalizeHostname } from '../core/hostnames';
import { sha512Crypt } from '../core/sha512crypt';
import type {
  AcmeInput,
  CreatedAppPassword,
  CreateMailboxInput,
  EngineAcmeStatus,
  EngineApi,
  EngineDirectory,
  EngineDnsRecord,
  EngineHealth,
  EngineReloadResult,
  EngineSettingsStatus,
  MailboxCredentials,
  MailEngine,
  QueueSummary,
  RecommendedInput,
  UpdateMailboxPatch,
} from './types';

/**
 * Motor de demostración: no habla con ningún servidor real. Permite probar el
 * panel completo (clientes, dominios, buzones, claves de API) sin desplegar
 * Stalwart. Los envíos de la API se registran pero no salen a Internet.
 *
 * Guarda en memoria lo que recibe (como lo guardaría Stalwart 0.15) para que
 * las pruebas puedan comprobar qué le llega: los hashes de los buzones, las
 * contraseñas de aplicación, las suspensiones y los ajustes recomendados.
 * Al reiniciar el proceso lo olvida todo; las contraseñas se siguen
 * comprobando con la copia del panel (modules/credenciales.ts).
 */
export class DemoEngine implements MailEngine {
  readonly kind = 'demo' as const;

  private readonly domains = new Set<string>();
  private readonly passwords = new Map<string, string>();
  private readonly appPasswords = new Map<string, Set<string>>();
  private readonly suspended = new Set<string>();
  private readonly lists = new Map<string, string[]>();
  private recommended: RecommendedInput | null = null;
  private acme: EngineAcmeStatus | null = null;

  async detectApi(): Promise<EngineApi> {
    return 'demo';
  }

  async ping(): Promise<EngineHealth> {
    return { ok: true, api: 'demo', version: 'demo', detail: 'Modo demostración: sin motor de correo real.' };
  }

  async createDomain(domain: string): Promise<void> {
    this.domains.add(domain.toLowerCase());
  }

  async deleteDomain(domain: string): Promise<void> {
    this.domains.delete(domain.toLowerCase());
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

  async createMailbox(input: CreateMailboxInput): Promise<void> {
    const email = input.email.toLowerCase();
    this.passwords.set(email, input.passwordHash);
    this.appPasswords.set(email, new Set());
    this.suspended.delete(email);
  }

  async setMailboxPassword(email: string, passwordHash: string): Promise<void> {
    this.passwords.set(email.toLowerCase(), passwordHash);
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

  async upsertAlias(alias: string, destinations: string[], externalDestinations: string[] = []): Promise<void> {
    this.lists.set(alias.toLowerCase(), [...destinations, ...externalDestinations]);
  }

  async deleteAlias(alias: string): Promise<void> {
    this.lists.delete(alias.toLowerCase());
  }

  async addAppPassword(email: string, label: string, proposedSecret: string): Promise<CreatedAppPassword> {
    // Como Stalwart 0.15: vale la contraseña propuesta y se retira por su texto guardado.
    const ref = `$app$${label}$${sha512Crypt(proposedSecret)}`;
    const key = email.toLowerCase();
    if (!this.appPasswords.has(key)) this.appPasswords.set(key, new Set());
    this.appPasswords.get(key)!.add(ref);
    return { secret: proposedSecret, ref };
  }

  async removeAppPassword(email: string, ref: string): Promise<void> {
    this.appPasswords.get(email.toLowerCase())?.delete(ref);
  }

  /** Lo que tiene en memoria; un buzón de antes de reiniciar no lo conoce (null). */
  async readMailboxCredentials(email: string): Promise<MailboxCredentials | null> {
    const key = email.toLowerCase();
    const passwordHash = this.passwords.get(key);
    if (passwordHash === undefined) return null;
    return {
      passwordHash,
      appPasswords: [...(this.appPasswords.get(key) ?? [])].map((ref) => {
        const fin = ref.indexOf('$', 5);
        return { label: ref.slice(5, fin), hash: ref.slice(fin + 1), ref };
      }),
      suspended: this.suspended.has(key),
    };
  }

  async listDirectory(): Promise<EngineDirectory> {
    return {
      domains: [...this.domains],
      accounts: [...this.passwords.keys()],
      lists: [...this.lists.keys()],
    };
  }

  async getMailboxUsage(): Promise<Map<string, number>> {
    // Sin motor no hay correo guardado: todos los buzones conocidos están vacíos.
    return new Map([...this.passwords.keys()].map((email) => [email, 0]));
  }

  async applyRecommended(input: RecommendedInput): Promise<EngineReloadResult> {
    this.recommended = { ...input, trustedNetworks: [...input.trustedNetworks] };
    return { errors: [], warnings: [], restartRequired: [] };
  }

  async getSettingsStatus(input: { trustedNetworks: string[] }): Promise<EngineSettingsStatus> {
    const aplicadas = new Set(this.recommended?.trustedNetworks ?? []);
    return {
      api: 'demo',
      hostname: this.recommended ? normalizeHostname(this.recommended.hostname) || null : null,
      forwardedHeaders: this.recommended !== null,
      trustedNetworks: input.trustedNetworks.filter((n) => aplicadas.has(n)),
      acme: this.acme,
      certificateFiles: false,
      extra: {},
      restartRequired: [],
    };
  }

  async configureAcme(input: AcmeInput): Promise<EngineReloadResult> {
    // El token no se guarda: el estado nunca lo devuelve.
    this.acme = {
      directory: input.directory,
      challenge: 'dns-01',
      provider: 'cloudflare',
      contact: input.contact,
      domain: input.hostname,
      zone: input.zone,
    };
    return { errors: [], warnings: [], restartRequired: [] };
  }

  /** Sin motor real, «arranca» con el último nombre que se le aplicó (si alguno). */
  async getRunningHostname(): Promise<string | null> {
    const value = normalizeHostname(this.recommended?.hostname ?? '');
    return value || null;
  }

  async reloadCertificates(): Promise<void> {}

  async getQueueSummary(): Promise<QueueSummary> {
    return { pending: 0, oldestSeconds: null };
  }
}
