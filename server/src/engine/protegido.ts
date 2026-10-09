import { exigirSinMantenimiento } from '../modules/mantenimiento';
import type {
  AcmeInput,
  CreatedAppPassword,
  CreateMailboxInput,
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
 * Guardián del modo mantenimiento (modules/mantenimiento.ts): delante del
 * motor que reciben las rutas, las integraciones y el vigilante. Cada
 * operación que MODIFICA el motor comprueba antes el modo mantenimiento y,
 * si está activo, responde 503 `engine_maintenance` sin llegar a él; las
 * lecturas pasan siempre, para que el panel siga mostrando lo que pueda.
 *
 * Se comprueba en cada llamada y no al crear el motor: el mantenimiento lo
 * activa otro proceso (la herramienta de terminal) con el panel en marcha.
 */
export class MotorProtegido implements MailEngine {
  constructor(private readonly motor: MailEngine) {}

  get kind(): 'stalwart' | 'demo' {
    return this.motor.kind;
  }

  /* ------------------------------ Lecturas ------------------------------- */

  detectApi(): Promise<EngineApi> {
    return this.motor.detectApi();
  }
  ping(): Promise<EngineHealth> {
    return this.motor.ping();
  }
  getDnsRecords(domain: string): Promise<EngineDnsRecord[]> {
    return this.motor.getDnsRecords(domain);
  }
  readMailboxCredentials(email: string): Promise<MailboxCredentials | null> {
    return this.motor.readMailboxCredentials(email);
  }
  listDirectory(): Promise<EngineDirectory> {
    return this.motor.listDirectory();
  }
  getMailboxUsage(): Promise<Map<string, number>> {
    return this.motor.getMailboxUsage();
  }
  getSettingsStatus(input: { trustedNetworks: string[] }): Promise<EngineSettingsStatus> {
    return this.motor.getSettingsStatus(input);
  }
  getRunningHostname(): Promise<string | null> {
    return this.motor.getRunningHostname();
  }
  getQueueSummary(): Promise<QueueSummary> {
    return this.motor.getQueueSummary();
  }

  /* ---------------------------- Modificaciones ---------------------------- */

  async createDomain(domain: string): Promise<void> {
    exigirSinMantenimiento();
    return this.motor.createDomain(domain);
  }
  async deleteDomain(domain: string): Promise<void> {
    exigirSinMantenimiento();
    return this.motor.deleteDomain(domain);
  }
  async ensureDkim(domain: string, selector: string): Promise<void> {
    exigirSinMantenimiento();
    return this.motor.ensureDkim(domain, selector);
  }
  async createMailbox(input: CreateMailboxInput): Promise<void> {
    exigirSinMantenimiento();
    return this.motor.createMailbox(input);
  }
  async setMailboxPassword(email: string, passwordHash: string): Promise<void> {
    exigirSinMantenimiento();
    return this.motor.setMailboxPassword(email, passwordHash);
  }
  async updateMailbox(email: string, patch: UpdateMailboxPatch): Promise<void> {
    exigirSinMantenimiento();
    return this.motor.updateMailbox(email, patch);
  }
  async deleteMailbox(email: string): Promise<void> {
    exigirSinMantenimiento();
    return this.motor.deleteMailbox(email);
  }
  async upsertAlias(alias: string, destinations: string[], externalDestinations?: string[]): Promise<void> {
    exigirSinMantenimiento();
    return this.motor.upsertAlias(alias, destinations, externalDestinations);
  }
  async deleteAlias(alias: string): Promise<void> {
    exigirSinMantenimiento();
    return this.motor.deleteAlias(alias);
  }
  async applyRecommended(input: RecommendedInput): Promise<EngineReloadResult> {
    exigirSinMantenimiento();
    return this.motor.applyRecommended(input);
  }
  async configureAcme(input: AcmeInput): Promise<EngineReloadResult> {
    exigirSinMantenimiento();
    return this.motor.configureAcme(input);
  }
  async reloadCertificates(): Promise<void> {
    exigirSinMantenimiento();
    return this.motor.reloadCertificates();
  }
  async addAppPassword(email: string, label: string, proposedSecret: string): Promise<CreatedAppPassword> {
    exigirSinMantenimiento();
    return this.motor.addAppPassword(email, label, proposedSecret);
  }
  async removeAppPassword(email: string, ref: string): Promise<void> {
    exigirSinMantenimiento();
    return this.motor.removeAppPassword(email, ref);
  }
}
