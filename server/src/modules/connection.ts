import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../config';
import { db } from '../core/db';
import { getInstanceSettings } from './settings';

/**
 * Datos de conexión de los buzones y generadores de los documentos de
 * autoconfiguración (Thunderbird, Outlook, perfiles de Apple).
 *
 * Todo sale de aquí para que el panel, el portal del titular, los enlaces de
 * configuración y las rutas públicas de autoconfiguración digan exactamente
 * lo mismo: si un día cambia un puerto, cambia en todas partes a la vez.
 */

export interface ServerEndpoint {
  host: string;
  port: number;
  security: 'SSL/TLS' | 'STARTTLS';
}

export interface ConnectionSettings {
  /** Nombre visible del proveedor (marca de la instancia). */
  brandName: string;
  imap: ServerEndpoint;
  /** Envío recomendado: 465 con TLS implícito (RFC 8314). */
  smtp: ServerEndpoint;
  /** Alternativa para redes que bloquean el 465. */
  smtpAlt: ServerEndpoint;
  /** Webmail: el dominio propio del cliente si lo tiene activo; si no, el global. */
  webmailUrl: string;
}

/** Puertos que publica el compose del motor; son fijos por diseño. */
export const PUERTOS = { imaps: 993, smtps: 465, submission: 587 } as const;

/** Webmail con la marca del cliente, si tiene uno activo. */
function webmailPropio(clientId: string | null): string | null {
  if (!clientId) return null;
  const row = db
    .prepare(
      `SELECT hostname FROM client_domains
       WHERE client_id = ? AND kind = 'webmail' AND status = 'active'
       ORDER BY activated_at ASC LIMIT 1`,
    )
    .get(clientId) as { hostname: string } | undefined;
  return row ? `https://${row.hostname}` : null;
}

/** Cliente dueño de un dominio de correo gestionado, o null si no es nuestro. */
export function clientOfMailDomain(domain: string): string | null {
  const row = db
    .prepare('SELECT client_id FROM domains WHERE domain = ?')
    .get(domain.toLowerCase()) as { client_id: string } | undefined;
  return row ? row.client_id : null;
}

/**
 * Datos de conexión para un dominio de correo. `clientId` se usa para elegir
 * el webmail con marca propia; si no se indica, se deduce del dominio.
 */
export function getConnectionSettings(domain: string, clientId?: string | null): ConnectionSettings {
  const instance = getInstanceSettings();
  const host = instance.mailHostname;
  const owner = clientId === undefined ? clientOfMailDomain(domain) : clientId;
  return {
    brandName: instance.brandName,
    imap: { host, port: PUERTOS.imaps, security: 'SSL/TLS' },
    smtp: { host, port: PUERTOS.smtps, security: 'SSL/TLS' },
    smtpAlt: { host, port: PUERTOS.submission, security: 'STARTTLS' },
    webmailUrl: webmailPropio(owner) || instance.webmailUrl,
  };
}

/**
 * URL pública del panel. Primero la configurada; si no, la de la petición en
 * curso (con trustProxy, Fastify ya respeta X-Forwarded-Proto/Host).
 */
export function publicBaseUrl(req?: FastifyRequest): string {
  const configured = getInstanceSettings().panelUrl;
  if (configured) return configured;
  if (req) {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const hostValue = Array.isArray(host) ? host[0] : host;
    if (hostValue) return `${req.protocol}://${String(hostValue).split(',')[0]!.trim()}`;
  }
  return '';
}

/* ------------------------------ Utilidades -------------------------------- */

/** Escapa texto para XML (también sirve para plist). */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Dominio de una dirección, en minúsculas; null si no parece una dirección. */
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

/**
 * UUID estable derivado de una semilla. Los perfiles de Apple se identifican
 * por PayloadUUID/PayloadIdentifier: si son estables, reinstalar el perfil
 * sustituye al anterior en vez de duplicar la cuenta en el dispositivo.
 */
export function stableUuid(seed: string): string {
  const h = crypto.createHmac('sha256', config.secret).update(seed).digest('hex');
  // Formato 8-4-4-4-12 con los bits de versión (5) y variante (RFC 4122).
  const variant = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    `${variant}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ]
    .join('-')
    .toUpperCase();
}

/* ------------------------- Thunderbird (autoconfig) ------------------------ */

/**
 * Documento clientConfig v1.1 de Thunderbird. Se sirve para el dominio del
 * correo; %EMAILADDRESS% lo sustituye el propio cliente por la dirección.
 */
export function thunderbirdAutoconfigXml(domain: string, settings: ConnectionSettings): string {
  const d = xmlEscape(domain);
  const brand = xmlEscape(settings.brandName);
  const imapHost = xmlEscape(settings.imap.host);
  const smtpHost = xmlEscape(settings.smtp.host);
  return `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${d}">
    <domain>${d}</domain>
    <displayName>${brand} (${d})</displayName>
    <displayShortName>${brand}</displayShortName>
    <incomingServer type="imap">
      <hostname>${imapHost}</hostname>
      <port>${settings.imap.port}</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>${smtpHost}</hostname>
      <port>${settings.smtp.port}</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
    <outgoingServer type="smtp">
      <hostname>${xmlEscape(settings.smtpAlt.host)}</hostname>
      <port>${settings.smtpAlt.port}</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
  </emailProvider>
</clientConfig>
`;
}

/* ---------------------------- Outlook (POX) -------------------------------- */

/** Extrae <EMailAddress> de la petición POX de Outlook (sin parser XML). */
export function autodiscoverRequestEmail(body: string): string | null {
  const match = /<EMailAddress>\s*([^<\s]+)\s*<\/EMailAddress>/i.exec(body);
  return match ? match[1]!.trim().toLowerCase() : null;
}

/** Respuesta Autodiscover POX con IMAP y SMTP, que Outlook entiende. */
export function autodiscoverXml(email: string, settings: ConnectionSettings): string {
  const e = xmlEscape(email);
  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <User>
      <DisplayName>${e}</DisplayName>
    </User>
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type>
        <Server>${xmlEscape(settings.imap.host)}</Server>
        <Port>${settings.imap.port}</Port>
        <DomainRequired>off</DomainRequired>
        <LoginName>${e}</LoginName>
        <SPA>off</SPA>
        <SSL>on</SSL>
        <Encryption>SSL</Encryption>
        <AuthRequired>on</AuthRequired>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>${xmlEscape(settings.smtp.host)}</Server>
        <Port>${settings.smtp.port}</Port>
        <DomainRequired>off</DomainRequired>
        <LoginName>${e}</LoginName>
        <SPA>off</SPA>
        <SSL>on</SSL>
        <Encryption>SSL</Encryption>
        <AuthRequired>on</AuthRequired>
        <UsePOPAuth>off</UsePOPAuth>
        <SMTPLast>off</SMTPLast>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>
`;
}

/** Respuesta de error de Autodiscover (dirección que no es de esta instancia). */
export function autodiscoverErrorXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response>
    <Error Time="00:00:00" Id="0">
      <ErrorCode>600</ErrorCode>
      <Message>Invalid Request</Message>
      <DebugData />
    </Error>
  </Response>
</Autodiscover>
`;
}

/* ----------------------------- Apple (perfil) ------------------------------ */

export interface MobileconfigOptions {
  email: string;
  displayName?: string;
  settings: ConnectionSettings;
  /**
   * Contraseña a incluir en el perfil. Si se omite, el iPhone/Mac la pide al
   * instalarlo: es lo recomendable salvo en el enlace de bienvenida.
   */
  password?: string;
}

/**
 * Perfil de configuración (.mobileconfig) con una cuenta IMAP para iPhone,
 * iPad y Mac. Sin firmar: el sistema lo marca como «no verificado», pero se
 * instala igual desde Ajustes → Perfil descargado.
 */
export function mobileconfigPlist(opts: MobileconfigOptions): string {
  const { email, settings } = opts;
  const e = xmlEscape(email);
  const brand = xmlEscape(settings.brandName);
  const name = xmlEscape(opts.displayName || email);
  const reverse = (settings.imap.host || 'mailway.local').split('.').reverse().join('.');
  const idBase = xmlEscape(`${reverse}.mailway`);
  const accountUuid = stableUuid(`mobileconfig-cuenta:${email}`);
  const profileUuid = stableUuid(`mobileconfig-perfil:${email}`);
  const passwordEntries = opts.password
    ? `
      <key>IncomingPassword</key>
      <string>${xmlEscape(opts.password)}</string>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>EmailAccountDescription</key>
      <string>${e}</string>
      <key>EmailAccountName</key>
      <string>${name}</string>
      <key>EmailAccountType</key>
      <string>EmailTypeIMAP</string>
      <key>EmailAddress</key>
      <string>${e}</string>
      <key>IncomingMailServerAuthentication</key>
      <string>EmailAuthPassword</string>
      <key>IncomingMailServerHostName</key>
      <string>${xmlEscape(settings.imap.host)}</string>
      <key>IncomingMailServerPortNumber</key>
      <integer>${settings.imap.port}</integer>
      <key>IncomingMailServerUseSSL</key>
      <true/>
      <key>IncomingMailServerUsername</key>
      <string>${e}</string>${passwordEntries}
      <key>OutgoingMailServerAuthentication</key>
      <string>EmailAuthPassword</string>
      <key>OutgoingMailServerHostName</key>
      <string>${xmlEscape(settings.smtp.host)}</string>
      <key>OutgoingMailServerPortNumber</key>
      <integer>${settings.smtp.port}</integer>
      <key>OutgoingMailServerUseSSL</key>
      <true/>
      <key>OutgoingMailServerUsername</key>
      <string>${e}</string>
      <key>OutgoingPasswordSameAsIncomingPassword</key>
      <true/>
      <key>PayloadDescription</key>
      <string>Cuenta de correo ${e}</string>
      <key>PayloadDisplayName</key>
      <string>${e}</string>
      <key>PayloadIdentifier</key>
      <string>${idBase}.cuenta.${accountUuid}</string>
      <key>PayloadType</key>
      <string>com.apple.mail.managed</string>
      <key>PayloadUUID</key>
      <string>${accountUuid}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PreventAppSheet</key>
      <false/>
      <key>PreventMove</key>
      <false/>
      <key>SMIMEEnabled</key>
      <false/>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Configura la cuenta de correo ${e} en este dispositivo.</string>
  <key>PayloadDisplayName</key>
  <string>Correo ${e}</string>
  <key>PayloadIdentifier</key>
  <string>${idBase}.perfil.${profileUuid}</string>
  <key>PayloadOrganization</key>
  <string>${brand}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${profileUuid}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}

/** Nombre de fichero seguro para el perfil de un buzón. */
export function mobileconfigFilename(email: string): string {
  return `correo-${email.replace(/[^a-z0-9._-]+/gi, '_')}.mobileconfig`;
}

export const MOBILECONFIG_CONTENT_TYPE = 'application/x-apple-aspen-config';
