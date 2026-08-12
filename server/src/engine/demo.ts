import type {
  CreateMailboxInput,
  EngineDnsRecord,
  EngineHealth,
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

  async createMailbox(_input: CreateMailboxInput): Promise<void> {}
  async setMailboxPassword(): Promise<void> {}
  async updateMailbox(_email: string, _patch: UpdateMailboxPatch): Promise<void> {}
  async deleteMailbox(): Promise<void> {}
  async upsertAlias(): Promise<void> {}
  async deleteAlias(): Promise<void> {}
  async addAppPassword(_email: string, _password: string, label: string): Promise<string> {
    return `$app$${label}$demo`;
  }
  async removeAppPassword(): Promise<void> {}

  async getQueueSummary(): Promise<QueueSummary> {
    return { pending: 0, oldestSeconds: null };
  }
}
