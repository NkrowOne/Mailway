import { exigirSinMantenimiento } from '../modules/mantenimiento';
import { anotarApiDelMotor } from './apiconocida';
import type {
  AcmeInput,
  CreatedAppPassword,
  CreateMailboxInput,
  EngineApi,
  EngineDirectory,
  EngineDnsRecord,
  EngineHealth,
  EnginePrincipal,
  EngineReloadResult,
  EngineSettingsStatus,
  MailboxCredentials,
  MailEngine,
  QueueSummary,
  RecommendedInput,
  RemoteDomainsResult,
  SettingsStatusInput,
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
 *
 * Como todo lo del panel pasa por aquí, también anota la versión del motor
 * cada vez que se averigua (engine/apiconocida.ts).
 */
export class MotorProtegido implements MailEngine {
  constructor(private readonly motor: MailEngine) {}

  get kind(): 'stalwart' | 'demo' {
    return this.motor.kind;
  }

  /* ------------------------------ Lecturas ------------------------------- */

  // La versión que se averigua aquí queda anotada (engine/apiconocida.ts):
  // la necesitan las rutas de Traefik sin esperar al motor.
  async detectApi(): Promise<EngineApi> {
    const api = await this.motor.detectApi();
    anotarApiDelMotor(api);
    return api;
  }
  async ping(): Promise<EngineHealth> {
    const salud = await this.motor.ping();
    if (salud.api) anotarApiDelMotor(salud.api);
    return salud;
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
  getSettingsStatus(input: SettingsStatusInput): Promise<EngineSettingsStatus> {
    return this.motor.getSettingsStatus(input);
  }
  getRunningHostname(): Promise<string | null> {
    return this.motor.getRunningHostname();
  }
  getAcmeToken(): Promise<string | null> {
    return this.motor.getAcmeToken();
  }
  getQueueSummary(): Promise<QueueSummary> {
    return this.motor.getQueueSummary();
  }
  getPrincipal(name: string): Promise<EnginePrincipal | null> {
    return this.motor.getPrincipal(name);
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
  // Escribe en el motor las reglas de la recepción en otro proveedor.
  async syncRemoteDomains(domains: string[], opts?: { reload?: boolean }): Promise<RemoteDomainsResult> {
    exigirSinMantenimiento();
    return this.motor.syncRemoteDomains(domains, opts);
  }
  async setAddresses(name: string, ops: { add?: string[]; remove?: string[]; primary?: string }): Promise<string[]> {
    exigirSinMantenimiento();
    return this.motor.setAddresses(name, ops);
  }
  async renamePrincipal(from: string, to: string, opts: { expectEmail: string; emails?: string[] }): Promise<void> {
    exigirSinMantenimiento();
    return this.motor.renamePrincipal(from, to, opts);
  }
  async reloadDirectory(): Promise<void> {
    exigirSinMantenimiento();
    return this.motor.reloadDirectory();
  }
  async removeDkim(domain: string): Promise<string[]> {
    exigirSinMantenimiento();
    return this.motor.removeDkim(domain);
  }
}
