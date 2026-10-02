import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../config';
import { db } from '../core/db';
import { notFound } from '../core/errors';
import { getInstanceSettings, getJsonSetting } from './settings';

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

/** Webmail con la marca del cliente, si tiene uno activo: el principal que haya elegido o, si no, el primero que se activó. */
export function webmailPropio(clientId: string | null): string | null {
  if (!clientId) return null;
  const row = db
    .prepare(
      `SELECT hostname FROM client_domains
       WHERE client_id = ? AND kind = 'webmail' AND status = 'active'
       ORDER BY is_primary DESC, activated_at ASC, created_at ASC, id ASC LIMIT 1`,
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

/** Webmail que debe ver un cliente: el de su marca si lo tiene activo; si no, el global. */
export function webmailUrlForClient(clientId: string | null): string {
  return webmailPropio(clientId) || getInstanceSettings().webmailUrl;
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

/* ------------------- Hosts de autoconfiguración (estado) ------------------- */

/**
 * Estado del DNS de un host de autoconfiguración (autoconfig.<d>,
 * autodiscover.<d>, mta-sts.<d>): `ok` apunta a este servidor, `pending` el
 * registro falta o apunta a otro sitio, `unknown` nunca se pudo consultar.
 * Lo escribe autoconfig.ts; aquí solo se lee, para elegir las URL que se
 * enseñan al usuario.
 */
export type AutoconfigHostState = 'ok' | 'pending' | 'unknown';

export interface AutoconfigHostRecord {
  state: AutoconfigHostState;
  /** Explicación en español de la última medición concluyente. */
  detail: string;
  /** Última consulta concluyente (ok o pending). */
  checkedAt: number | null;
  /** Cuándo cambió de estado por última vez. */
  changedAt: number | null;
  /** Última consulta, concluyente o no. */
  lastAttemptAt: number | null;
  /** true si la última consulta no obtuvo respuesta (se conservó el estado previo). */
  lastAttemptInconclusive: boolean;
}

/** Clave de ajustes con el mapa host → estado. */
export const AUTOCONFIG_HOSTS_SETTING = 'autoconfig_hosts';

export function readAutoconfigHostStates(): Record<string, AutoconfigHostRecord> {
  return getJsonSetting<Record<string, AutoconfigHostRecord>>(AUTOCONFIG_HOSTS_SETTING) || {};
}

/**
 * Dominio base de la instancia para la autoconfiguración: el nombre del
 * servidor de correo sin su primera etiqueta (mail.proveedor.com →
 * proveedor.com). Thunderbird, si el dominio del usuario no tiene
 * autoconfiguración propia, consulta https://autoconfig.<dominio del MX>: con
 * servir ese host, cualquier dominio cuyo MX sea este servidor se configura
 * sin registros DNS adicionales.
 */
export function instanceAutoconfigBase(mailHostname = getInstanceSettings().mailHostname): string | null {
  const labels = mailHostname.trim().toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return null;
  if (labels.length === 2) return labels.join('.');
  return labels.slice(1).join('.');
}

/* --------------------------- Datos de un buzón ----------------------------- */

export interface ConnectionInfo {
  email: string;
  username: string;
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
  smtpAlt: ServerEndpoint;
  webmailUrl: string;
  autoconfig: {
    /** Documento de Thunderbird para esta dirección (sirve para comprobarlo en el navegador). */
    thunderbird: string;
    /** Punto de Autodiscover (POX) que usan Outlook y Thunderbird. */
    outlook: string;
    /** Descarga autenticada del perfil de Apple (sin contraseña). */
    appleProfileUrl: string;
  };
  /** Página «Mi buzón» del titular. */
  portalUrl: string;
}

/**
 * Datos de conexión completos de un buzón. Las URL de autoconfiguración usan
 * el host del propio dominio si su DNS ya apunta aquí; si no, el de la
 * instancia; y como último recurso el panel, que sirve las mismas rutas en
 * cualquier host (así el enlace funciona siempre, aunque falte el DNS).
 */
export function buildConnectionInfo(mailboxId: string, req?: FastifyRequest): ConnectionInfo {
  const row = db
    .prepare(
      `SELECT m.id, m.local_part, d.domain, d.client_id
       FROM mailboxes m JOIN domains d ON d.id = m.domain_id WHERE m.id = ?`,
    )
    .get(mailboxId) as { id: string; local_part: string; domain: string; client_id: string } | undefined;
  if (!row) throw notFound('Buzón no encontrado.');
  const email = `${row.local_part}@${row.domain}`;
  const settings = getConnectionSettings(row.domain, row.client_id);
  const base = publicBaseUrl(req);
  const states = readAutoconfigHostStates();
  const instanceBase = instanceAutoconfigBase();
  const ok = (host: string | null): host is string => Boolean(host && states[host]?.state === 'ok');

  const pick = (prefix: 'autoconfig' | 'autodiscover'): string => {
    const own = `${prefix}.${row.domain}`;
    if (ok(own)) return `https://${own}`;
    const shared = instanceBase ? `${prefix}.${instanceBase}` : null;
    if (ok(shared)) return `https://${shared}`;
    return base || `https://${own}`;
  };

  return {
    email,
    username: email,
    imap: settings.imap,
    smtp: settings.smtp,
    smtpAlt: settings.smtpAlt,
    webmailUrl: settings.webmailUrl,
    autoconfig: {
      thunderbird: `${pick('autoconfig')}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
      outlook: `${pick('autodiscover')}/autodiscover/autodiscover.xml`,
      appleProfileUrl: `${base}/api/mailboxes/${row.id}/mobileconfig`,
    },
    portalUrl: `${base}/mi-buzon`,
  };
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
export function thunderbirdAutoconfigXml(
  domain: string,
  settings: ConnectionSettings,
  opts: { placeholderDomain?: boolean } = {},
): string {
  const d = xmlEscape(domain);
  // Thunderbird para Android llega por el MX (autoconfig.<dominio de la
  // instancia>) sin ?emailaddress: %EMAILDOMAIN% hace que el documento valga
  // para cualquier dominio de cliente. El Thunderbird de escritorio ignora la
  // entrada que no entiende y usa la otra.
  const extraDomain = opts.placeholderDomain ? '\n    <domain>%EMAILDOMAIN%</domain>' : '';
  const brand = xmlEscape(settings.brandName);
  const imapHost = xmlEscape(settings.imap.host);
  const smtpHost = xmlEscape(settings.smtp.host);
  return `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${d}">
    <domain>${d}</domain>${extraDomain}
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

/**
 * Respuesta Autodiscover POX con IMAP y SMTP. Para 993/465 basta <SSL>on</SSL>:
 * <Encryption>TLS</Encryption> significaría STARTTLS y rompería el 465.
 * Ojo al servirla: Thunderbird envía aquí la contraseña real por Basic auth;
 * la ruta nunca debe responder 401 ni registrar la cabecera Authorization.
 */
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

/** Tipos de contenido que exigen los clientes (Thunderbird descarta otros). */
export const AUTOCONFIG_CONTENT_TYPE = 'application/xml; charset=utf-8';
export const AUTODISCOVER_CONTENT_TYPE = 'text/xml; charset=utf-8';

/* ------------------------ Thunderbird para Android ------------------------- */

/**
 * Contenido del QR de importación de Thunderbird para Android (formato v1 de
 * «Exportar para el móvil» del Thunderbird de escritorio): el titular lo
 * escanea desde Incorporación → Importar ajustes. Seguridad 3 = TLS implícito,
 * autenticación 1 = contraseña normal. La contraseña va vacía: la pide la app.
 */
export function thunderbirdAndroidQrPayload(
  email: string,
  displayName: string,
  settings: ConnectionSettings,
): string {
  const incoming = [0, settings.imap.host, settings.imap.port, 3, 1, email, email, ''];
  const outgoing = [[0, settings.smtp.host, settings.smtp.port, 3, 1, email, ''], [email, displayName || email]];
  return JSON.stringify([1, [1, 1], incoming, [outgoing]]);
}

/* ----------------------- Variables para aplicaciones ------------------------ */

/**
 * Bloques «listos para copiar» que acompañan a una clave de API o a una
 * contraseña de aplicación recién creadas: un .env genérico y el código de
 * Node, Laravel y Django que lo usa.
 *
 * Solo existen en la respuesta que crea la credencial: el secreto no se
 * guarda en claro, así que no se pueden volver a generar después.
 *
 * Los nombres de las variables son los mismos que Skyway inyecta al conectar
 * el correo a un servicio (MAILWAY_API_URL, MAILWAY_API_KEY y MAIL_FROM en
 * modo API; SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS y
 * SMTP_FROM en modo SMTP): el código copiado de aquí funciona igual en una
 * aplicación desplegada con Skyway.
 */
export interface BloqueVariables {
  id: 'env' | 'node' | 'laravel' | 'django';
  /** Nombre de la pestaña. */
  label: string;
  /** Lenguaje del contenido, para resaltarlo o elegir la extensión. */
  language: 'dotenv' | 'javascript' | 'php' | 'python';
  /** Fichero o ficheros donde va el bloque (orientativo). */
  filename: string;
  content: string;
}

/** Texto de usuario dentro de un comentario de una línea: sin saltos ni controles. */
function comentario(texto: string): string {
  return texto.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, 80);
}

/** Valor de .env: tal cual si es seguro, entre comillas dobles si no. */
function valorEnv(valor: string): string {
  return /^[A-Za-z0-9_.:/@+-]*$/.test(valor) ? valor : JSON.stringify(valor);
}

/** Cadena entre comillas dobles válida en JavaScript y en Python. */
function cadena(valor: string): string {
  return JSON.stringify(valor);
}

export function bloquesClaveApi(input: {
  /** URL pública del panel, donde vive /v1/send. */
  apiUrl: string;
  key: string;
  /** Buzón remitente de la clave. */
  from: string;
  name: string;
}): BloqueVariables[] {
  const { apiUrl, key, from } = input;
  const env = [
    `# Clave de API «${comentario(input.name)}» · remite ${comentario(from)}`,
    `MAILWAY_API_URL=${valorEnv(apiUrl)}`,
    `MAILWAY_API_KEY=${valorEnv(key)}`,
    `MAIL_FROM=${valorEnv(from)}`,
  ].join('\n');

  const node = [
    '// Node.js 18 o superior. Lee MAILWAY_API_URL y MAILWAY_API_KEY del entorno (bloque .env).',
    "import { randomUUID } from 'node:crypto';",
    '',
    'export async function enviarCorreo(mensaje, idempotencyKey = randomUUID()) {',
    '  const res = await fetch(`${process.env.MAILWAY_API_URL}/v1/send`, {',
    "    method: 'POST',",
    '    headers: {',
    '      Authorization: `Bearer ${process.env.MAILWAY_API_KEY}`,',
    "      'Content-Type': 'application/json',",
    '      // Si reintentas, reutiliza el mismo valor: el mensaje no saldrá dos veces.',
    "      'Idempotency-Key': idempotencyKey,",
    '    },',
    '    body: JSON.stringify(mensaje),',
    '  });',
    '  const data = await res.json();',
    "  if (!res.ok || data.status !== 'sent') throw new Error(`${data.code ?? data.status}: ${data.error}`);",
    "  return data; // { id, status: 'sent', messageId }",
    '}',
    '',
    'await enviarCorreo({',
    "  to: 'cliente@ejemplo.com',",
    "  subject: 'Tu código de acceso',",
    "  text: 'Tu código es 482913. Caduca en 10 minutos.',",
    '});',
  ].join('\n');

  const laravel = [
    '# .env',
    `MAILWAY_API_URL=${valorEnv(apiUrl)}`,
    `MAILWAY_API_KEY=${valorEnv(key)}`,
    '',
    '// config/services.php',
    "'mailway' => [",
    "    'url' => env('MAILWAY_API_URL'),",
    "    'key' => env('MAILWAY_API_KEY'),",
    '],',
    '',
    '// En un controlador o un job',
    'use Illuminate\\Support\\Facades\\Http;',
    'use Illuminate\\Support\\Str;',
    '',
    "$respuesta = Http::withToken(config('services.mailway.key'))",
    "    ->withHeaders(['Idempotency-Key' => (string) Str::uuid()])",
    '    ->acceptJson()',
    '    ->timeout(30)',
    "    ->post(config('services.mailway.url').'/v1/send', [",
    "        'to' => 'cliente@ejemplo.com',",
    "        'subject' => 'Tu código de acceso',",
    "        'text' => 'Tu código es 482913. Caduca en 10 minutos.',",
    '    ])',
    '    ->throw()',
    "    ->json(); // ['id' => …, 'status' => 'sent', 'messageId' => …]",
  ].join('\n');

  const django = [
    '# settings.py: valores del entorno (bloque .env)',
    'import os',
    '',
    `MAILWAY_API_URL = os.environ.get("MAILWAY_API_URL", ${cadena(apiUrl)})`,
    'MAILWAY_API_KEY = os.environ["MAILWAY_API_KEY"]',
    `DEFAULT_FROM_EMAIL = os.environ.get("MAIL_FROM", ${cadena(from)})`,
    '',
    '# correo.py',
    'import uuid',
    '',
    'import requests',
    'from django.conf import settings',
    '',
    '',
    'def enviar_correo(to, subject, text, html=None, idempotency_key=None):',
    '    mensaje = {"to": to, "subject": subject, "text": text}',
    '    if html:',
    '        mensaje["html"] = html',
    '    respuesta = requests.post(',
    '        f"{settings.MAILWAY_API_URL}/v1/send",',
    '        headers={',
    '            "Authorization": f"Bearer {settings.MAILWAY_API_KEY}",',
    '            # Si reintentas, reutiliza el mismo valor: el mensaje no saldrá dos veces.',
    '            "Idempotency-Key": idempotency_key or str(uuid.uuid4()),',
    '        },',
    '        json=mensaje,',
    '        timeout=30,',
    '    )',
    '    datos = respuesta.json()',
    '    if respuesta.status_code != 200 or datos.get("status") != "sent":',
    '        raise RuntimeError(datos.get("error") or datos.get("status"))',
    '    return datos',
  ].join('\n');

  return [
    { id: 'env', label: '.env', language: 'dotenv', filename: '.env', content: env },
    { id: 'node', label: 'Node.js', language: 'javascript', filename: 'enviar-correo.mjs', content: node },
    { id: 'laravel', label: 'PHP · Laravel', language: 'php', filename: '.env y config/services.php', content: laravel },
    { id: 'django', label: 'Python · Django', language: 'python', filename: 'settings.py y correo.py', content: django },
  ];
}

export function bloquesContrasenaAplicacion(input: {
  email: string;
  password: string;
  name: string;
  settings: ConnectionSettings;
}): BloqueVariables[] {
  const { email, password } = input;
  // El envío autenticado de las aplicaciones va por el 587 con STARTTLS, como
  // en Skyway: es el puerto que menos redes de servidores bloquean.
  const { host, port } = input.settings.smtpAlt;
  const env = [
    `# Contraseña de aplicación «${comentario(input.name)}» del buzón ${comentario(email)}`,
    '# SMTP_SECURE=false: STARTTLS en el puerto 587 (con el 465, SMTP_SECURE=true).',
    `SMTP_HOST=${valorEnv(host)}`,
    `SMTP_PORT=${port}`,
    'SMTP_SECURE=false',
    `SMTP_USER=${valorEnv(email)}`,
    `SMTP_PASS=${valorEnv(password)}`,
    `SMTP_FROM=${valorEnv(email)}`,
  ].join('\n');

  const node = [
    '// npm install nodemailer · Lee SMTP_* del entorno (bloque .env).',
    "import nodemailer from 'nodemailer';",
    '',
    'const transporte = nodemailer.createTransport({',
    '  host: process.env.SMTP_HOST,',
    `  port: Number(process.env.SMTP_PORT ?? ${port}),`,
    '  // false: STARTTLS en el 587; true: TLS directo en el 465.',
    "  secure: process.env.SMTP_SECURE === 'true',",
    '  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },',
    '});',
    '',
    'await transporte.sendMail({',
    '  from: process.env.SMTP_FROM,',
    "  to: 'cliente@ejemplo.com',",
    "  subject: 'Prueba de envío',",
    "  text: 'El correo de la aplicación ya funciona.',",
    '});',
  ].join('\n');

  const laravel = [
    '# .env de Laravel',
    'MAIL_MAILER=smtp',
    `MAIL_HOST=${valorEnv(host)}`,
    `MAIL_PORT=${port}`,
    `MAIL_USERNAME=${valorEnv(email)}`,
    `MAIL_PASSWORD=${valorEnv(password)}`,
    '# Laravel 10 o anterior: STARTTLS en el puerto 587.',
    'MAIL_ENCRYPTION=tls',
    '# Laravel 11 o posterior: «smtp» usa STARTTLS en el puerto 587.',
    'MAIL_SCHEME=smtp',
    `MAIL_FROM_ADDRESS=${valorEnv(email)}`,
    'MAIL_FROM_NAME="${APP_NAME}"',
    '',
    '# Prueba: php artisan tinker',
    "# Mail::raw('El correo de la aplicación ya funciona.', fn ($m) => $m->to('cliente@ejemplo.com')->subject('Prueba de envío'));",
  ].join('\n');

  const django = [
    '# settings.py: valores del entorno (bloque .env)',
    'import os',
    '',
    'EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"',
    `EMAIL_HOST = os.environ.get("SMTP_HOST", ${cadena(host)})`,
    `EMAIL_PORT = int(os.environ.get("SMTP_PORT", "${port}"))`,
    '# SMTP_SECURE=false: STARTTLS en el 587; true: TLS directo en el 465.',
    'EMAIL_USE_SSL = os.environ.get("SMTP_SECURE", "false") == "true"',
    'EMAIL_USE_TLS = not EMAIL_USE_SSL',
    `EMAIL_HOST_USER = os.environ.get("SMTP_USER", ${cadena(email)})`,
    'EMAIL_HOST_PASSWORD = os.environ["SMTP_PASS"]',
    `DEFAULT_FROM_EMAIL = os.environ.get("SMTP_FROM", ${cadena(email)})`,
    '',
    '# Prueba: python manage.py sendtestemail cliente@ejemplo.com',
  ].join('\n');

  return [
    { id: 'env', label: '.env', language: 'dotenv', filename: '.env', content: env },
    { id: 'node', label: 'Node.js', language: 'javascript', filename: 'correo.mjs (nodemailer)', content: node },
    { id: 'laravel', label: 'PHP · Laravel', language: 'php', filename: '.env de Laravel', content: laravel },
    { id: 'django', label: 'Python · Django', language: 'python', filename: 'settings.py', content: django },
  ];
}
