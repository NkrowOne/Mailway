import { upstream } from '../core/errors';
import type {
  AcmeInput,
  CreatedAppPassword,
  CreateMailboxInput,
  EngineApi,
  EngineDnsRecord,
  EngineHealth,
  EngineReloadResult,
  EngineSettings,
  EngineSettingsStatus,
  MailboxCredentials,
  MailEngine,
  QueueSummary,
  RecommendedInput,
  UpdateMailboxPatch,
} from './types';

/**
 * Driver para Stalwart 0.16 (gestión por JMAP en `/jmap`).
 *
 * ESQUELETO: lo completa el trabajo del driver JMAP. Cada método lanza un
 * error claro mientras tanto, para que nada parezca funcionar sin hacerlo.
 */
export class Stalwart016Engine implements MailEngine {
  readonly kind = 'stalwart' as const;

  constructor(private settings: EngineSettings) {}

  private pendiente(): never {
    throw upstream(
      `El driver de Stalwart 0.16 aún no está disponible (${this.settings.url}).`,
      'engine_error',
    );
  }

  async detectApi(): Promise<EngineApi> {
    return 'jmap016';
  }
  async ping(): Promise<EngineHealth> {
    return this.pendiente();
  }
  async createDomain(_domain: string): Promise<void> {
    this.pendiente();
  }
  async deleteDomain(_domain: string): Promise<void> {
    this.pendiente();
  }
  async ensureDkim(_domain: string, _selector: string): Promise<void> {
    this.pendiente();
  }
  async getDnsRecords(_domain: string): Promise<EngineDnsRecord[]> {
    return this.pendiente();
  }
  async createMailbox(_input: CreateMailboxInput): Promise<void> {
    this.pendiente();
  }
  async setMailboxPassword(_email: string, _passwordHash: string): Promise<void> {
    this.pendiente();
  }
  async updateMailbox(_email: string, _patch: UpdateMailboxPatch): Promise<void> {
    this.pendiente();
  }
  async deleteMailbox(_email: string): Promise<void> {
    this.pendiente();
  }
  async upsertAlias(_alias: string, _destinations: string[], _external: string[] = []): Promise<void> {
    this.pendiente();
  }
  async deleteAlias(_alias: string): Promise<void> {
    this.pendiente();
  }
  async readMailboxCredentials(_email: string): Promise<MailboxCredentials | null> {
    return null;
  }
  async getMailboxUsage(): Promise<Map<string, number>> {
    return this.pendiente();
  }
  async applyRecommended(_input: RecommendedInput): Promise<EngineReloadResult> {
    return this.pendiente();
  }
  async getSettingsStatus(_input: { trustedNetworks: string[] }): Promise<EngineSettingsStatus> {
    return this.pendiente();
  }
  async configureAcme(_input: AcmeInput): Promise<EngineReloadResult> {
    return this.pendiente();
  }
  async getRunningHostname(): Promise<string | null> {
    return this.pendiente();
  }
  async reloadCertificates(): Promise<void> {
    this.pendiente();
  }
  async addAppPassword(_email: string, _label: string, _proposed: string): Promise<CreatedAppPassword> {
    return this.pendiente();
  }
  async removeAppPassword(_email: string, _ref: string): Promise<void> {
    this.pendiente();
  }
  async getQueueSummary(): Promise<QueueSummary> {
    return this.pendiente();
  }
}
