import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { decryptSecret, encryptSecret, generateMailboxPassword, randomId } from '../core/crypto';
import { HttpError, badRequest, conflict, forbidden, notFound, tooMany } from '../core/errors';
import { isValidHostname } from '../core/hostnames';
import { clientLockKey, withLock } from '../core/locks';
import { getEngine } from '../engine';
import { audit } from './audit';
import { requireAuth, requireClientAccess } from './auth';
import { assertClientActive, getClient } from './clients';
import { esDeOtroMotor } from './credenciales';
import { publicBaseUrl, xmlEscape } from './connection';
import { assertDomainOwnership } from './domains';
import { getMailbox, type Mailbox } from './mailboxes';
import { exigirSinMantenimiento } from './mantenimiento';
import { getEngineSettings, getInstanceSettings } from './settings';
import {
  cifrarCredencialSmtp,
  describeSmtpError,
  forgetTransport,
  getTransport,
  inicioDelDiaUtc,
  reservarCupoDiario,
} from './transactional';

/**
 * Formularios de contacto para webs estáticas, sin claves secretas en la web.
 *
 * El cliente crea un formulario con un buzón destinatario de su propio
 * dominio y la lista de orígenes (https://…) desde los que se puede usar. La
 * web pega un fragmento HTML con la clave pública `mwf_…` y el script
 * /forms/widget.js; cada envío llega a POST /forms/:clave, que:
 *
 * - solo acepta peticiones con un `Origin` de la lista (y solo esa ruta
 *   responde con CORS, para ese origen);
 * - descarta en silencio lo que rellena el campo trampa (`mw_web`);
 * - limita por IP, por formulario y hora y por formulario y día; ese cupo
 *   diario es propio y no gasta el de la API del plan, para que un formulario
 *   atacado no deje al cliente sin /v1/send;
 * - comprueba Cloudflare Turnstile si el formulario lo tiene configurado,
 *   incluido que el `hostname` que devuelve sea de un origen permitido;
 * - envía al buzón destinatario CON SU PROPIO REMITENTE: lo que escribe el
 *   visitante nunca es el From (sería suplantación y rompería SPF y DMARC);
 *   su dirección, saneada, va en Reply-To.
 *
 * El Origin no autentica nada (cualquiera puede falsearlo con curl); impide
 * que otra web use el formulario desde un navegador. Lo que frena el abuso
 * son los límites, el campo trampa y Turnstile, y que el destinatario es
 * siempre el buzón del propio cliente: no sirve para enviar correo a terceros.
 */

/* ------------------------------- Constantes -------------------------------- */

export const MAX_FORMULARIOS_POR_CLIENTE = 20;
const MAX_ORIGENES = 10;
/** Tamaño máximo de un envío: de sobra para un formulario de contacto. */
export const MAX_ENVIO_BYTES = 32 * 1024;
const MAX_CAMPOS = 30;
const MAX_VALOR = 5000;
/** Envíos admitidos por IP y formulario cada 10 minutos. */
export const LIMITE_POR_IP = { max: 5, ventanaMs: 10 * 60_000 };
/** Mensajes entregados por formulario cada hora. */
export const LIMITE_POR_FORMULARIO = { max: 30, ventanaMs: 60 * 60_000 };
/**
 * Mensajes entregados por formulario y día UTC. Cupo propio, contado en
 * `messages` (sobrevive a un reinicio) y separado del de la API del plan.
 * Con el máximo de formularios por cliente, acota lo que puede llegar a sus
 * buzones en un día.
 */
export const LIMITE_DIARIO_POR_FORMULARIO = 200;
/** Peticiones de cualquier tipo a /forms por IP y minuto (protege el servidor). */
const LIMITE_GENERAL = { max: 60, ventanaMs: 60_000 };

/** Campo trampa: las personas no lo ven; los robots que rellenan todo, sí. */
export const CAMPO_TRAMPA = 'mw_web';
const CAMPO_TURNSTILE = 'cf-turnstile-response';
/** Campos de control que no forman parte del mensaje. */
const CAMPOS_CONTROL = new Set([CAMPO_TRAMPA, CAMPO_TURNSTILE, 'g-recaptcha-response', 'h-captcha-response']);
const CAMPOS_CORREO = ['email', 'correo', 'e-mail'];
const CAMPOS_NOMBRE = ['nombre', 'name'];

const CLAVE_RE = /^mwf_[A-Za-z0-9_-]{22}$/;
const TURNSTILE_RE = /^[A-Za-z0-9_-]{8,200}$/;
/** Dirección prudente para Reply-To: sin comillas, espacios, comas ni saltos. */
const CORREO_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/* ---------------------------------- Tipos ---------------------------------- */

interface FormRow {
  id: string;
  client_id: string;
  name: string;
  public_key: string;
  recipient_mailbox_id: string;
  allowed_origins_json: string;
  subject: string;
  smtp_password_enc: string;
  /** API del motor en que se creó la credencial SMTP (NULL = Stalwart 0.15, antes de guardarla). */
  smtp_engine_api: string | null;
  /** La credencial SMTP dejó de funcionar al cambiar de motor y no se pudo renovar. */
  smtp_invalidated_at: number | null;
  turnstile_site_key: string | null;
  turnstile_secret_enc: string | null;
  enabled: number;
  submissions_count: number;
  last_submission_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface FormInfo {
  id: string;
  clientId: string;
  name: string;
  /** Clave pública: va en el HTML de la web, no es un secreto. */
  publicKey: string;
  recipientMailboxId: string;
  recipientEmail: string;
  allowedOrigins: string[];
  subject: string;
  /** Solo la clave de sitio (pública); el secreto nunca sale del servidor. */
  turnstile: { siteKey: string } | null;
  enabled: boolean;
  submissionsCount: number;
  lastSubmissionAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** URL que recibe los envíos. */
  endpoint: string;
  /** Fragmento HTML listo para pegar en la web. */
  embedHtml: string;
}

function origenesDe(row: FormRow): string[] {
  try {
    const lista = JSON.parse(row.allowed_origins_json) as unknown;
    return Array.isArray(lista) ? lista.filter((o): o is string => typeof o === 'string') : [];
  } catch {
    return [];
  }
}

function toInfo(row: FormRow, base: string): FormInfo {
  let recipientEmail = '';
  try {
    recipientEmail = getMailbox(row.recipient_mailbox_id).email;
  } catch {
    recipientEmail = '(buzón eliminado)';
  }
  const turnstile = row.turnstile_site_key ? { siteKey: row.turnstile_site_key } : null;
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    publicKey: row.public_key,
    recipientMailboxId: row.recipient_mailbox_id,
    recipientEmail,
    allowedOrigins: origenesDe(row),
    subject: row.subject,
    turnstile,
    enabled: row.enabled === 1,
    submissionsCount: row.submissions_count,
    lastSubmissionAt: row.last_submission_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endpoint: `${base}/forms/${row.public_key}`,
    embedHtml: fragmentoHtml(base, row.public_key, turnstile?.siteKey ?? null),
  };
}

function filaPorId(id: string): FormRow {
  const row = db.prepare('SELECT * FROM forms WHERE id = ?').get(id) as FormRow | undefined;
  if (!row) throw notFound('Formulario no encontrado.', 'form_not_found');
  return row;
}

/* --------------------------------- Orígenes -------------------------------- */

/**
 * Origen tal como lo envía el navegador en la cabecera Origin
 * (https://host[:puerto], en minúsculas y sin barra final). Se admite que se
 * escriba sin esquema o con la ruta de la página: se toma solo el origen.
 * Solo https: un formulario servido sin cifrar no debe enviar datos personales.
 */
export function normalizarOrigen(entrada: string): string {
  const texto = entrada.trim();
  const invalido = () =>
    badRequest(
      `«${texto.slice(0, 120)}» no es un origen válido. Escríbelo como https://www.tu-dominio.com.`,
      'invalid_origin',
    );
  if (!texto || /\s/.test(texto) || texto.includes('*')) throw invalido();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(texto) ? texto : `https://${texto}`);
  } catch {
    throw invalido();
  }
  if (url.protocol !== 'https:') {
    throw badRequest(
      `El origen «${texto.slice(0, 120)}» debe empezar por https://: el formulario solo se admite en webs cifradas.`,
      'invalid_origin',
    );
  }
  if (url.username || url.password || !isValidHostname(url.hostname)) throw invalido();
  return url.origin;
}

function normalizarOrigenes(lista: string[]): string[] {
  const unicos = [...new Set(lista.map(normalizarOrigen))];
  if (unicos.length === 0) {
    throw badRequest('Indica al menos un origen permitido, por ejemplo https://www.tu-dominio.com.', 'invalid_origin');
  }
  return unicos;
}

/* ------------------------------ Fragmento HTML ----------------------------- */

/**
 * Fragmento para pegar en la web: un formulario accesible que funciona sin
 * JavaScript (envío nativo) y que, con el script, envía sin recargar y
 * muestra el resultado. Los `id` llevan parte de la clave para que dos
 * formularios en la misma página no choquen.
 */
export function fragmentoHtml(base: string, clave: string, turnstileSiteKey: string | null): string {
  const a = xmlEscape;
  const sufijo = clave.slice(4, 10).toLowerCase().replace(/[^a-z0-9]/g, 'x');
  const id = (campo: string) => `mw-${campo}-${sufijo}`;
  const lineas = [
    `<form action="${a(`${base}/forms/${clave}`)}" method="post" data-mailway-form="${a(clave)}">`,
    '  <p>',
    `    <label for="${id('nombre')}">Nombre</label>`,
    `    <input id="${id('nombre')}" name="nombre" type="text" autocomplete="name" required maxlength="200">`,
    '  </p>',
    '  <p>',
    `    <label for="${id('email')}">Correo electrónico</label>`,
    `    <input id="${id('email')}" name="email" type="email" autocomplete="email" required maxlength="254">`,
    '  </p>',
    '  <p>',
    `    <label for="${id('mensaje')}">Mensaje</label>`,
    `    <textarea id="${id('mensaje')}" name="mensaje" rows="6" required maxlength="${MAX_VALOR}"></textarea>`,
    '  </p>',
    '  <!-- Campo trampa: las personas no lo ven; si llega relleno, el envío se descarta. -->',
    '  <div aria-hidden="true" style="position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden">',
    `    <label for="${id('web')}">No rellenes este campo</label>`,
    `    <input id="${id('web')}" name="${CAMPO_TRAMPA}" type="text" tabindex="-1" autocomplete="off">`,
    '  </div>',
  ];
  if (turnstileSiteKey) {
    lineas.push(`  <div class="cf-turnstile" data-sitekey="${a(turnstileSiteKey)}" data-language="es"></div>`);
  }
  lineas.push(
    '  <button type="submit">Enviar</button>',
    '  <p data-mailway-estado role="status" aria-live="polite"></p>',
    '</form>',
    `<script src="${a(`${base}/forms/widget.js`)}" data-form="${a(clave)}" defer></script>`,
  );
  if (turnstileSiteKey) {
    lineas.push('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>');
  }
  return lineas.join('\n');
}

/* --------------------------------- Turnstile -------------------------------- */

export interface RespuestaTurnstile {
  success: boolean;
  hostname?: string;
  'error-codes'?: string[];
}

/** null = no se pudo consultar a Cloudflare (red, tiempo de espera, respuesta rara). */
type VerificadorTurnstile = (secreto: string, token: string, ip: string) => Promise<RespuestaTurnstile | null>;

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const verificarConCloudflare: VerificadorTurnstile = async (secreto, token, ip) => {
  try {
    const res = await fetch(SITEVERIFY, {
      method: 'POST',
      body: new URLSearchParams({ secret: secreto, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const datos = (await res.json()) as RespuestaTurnstile;
    return typeof datos?.success === 'boolean' ? datos : null;
  } catch {
    return null;
  }
};

let verificador: VerificadorTurnstile = verificarConCloudflare;

/** Sustituye la consulta a Cloudflare (solo pruebas: no hay red). */
export function setTurnstileVerifierForTests(fn: VerificadorTurnstile | null): void {
  verificador = fn ?? verificarConCloudflare;
}

/* --------------------------------- Límites --------------------------------- */

/**
 * Ventanas fijas en memoria. Como los demás límites de las rutas públicas,
 * no sobreviven a un reinicio: protegen de ráfagas, no llevan cuentas.
 */
function crearLimitador(limite: { max: number; ventanaMs: number }) {
  const cuentas = new Map<string, { desde: number; n: number }>();
  const vigente = (clave: string, t: number) => {
    const actual = cuentas.get(clave);
    return actual && t - actual.desde < limite.ventanaMs ? actual : null;
  };
  return {
    lleno(clave: string): boolean {
      return (vigente(clave, now())?.n ?? 0) >= limite.max;
    },
    apuntar(clave: string): void {
      const t = now();
      if (cuentas.size > 5000) {
        for (const [k, v] of cuentas) if (t - v.desde >= limite.ventanaMs) cuentas.delete(k);
      }
      const actual = vigente(clave, t);
      if (actual) actual.n += 1;
      else cuentas.set(clave, { desde: t, n: 1 });
    },
    olvidar(): void {
      cuentas.clear();
    },
  };
}

const limiteGeneral = crearLimitador(LIMITE_GENERAL);
const limitePorIp = crearLimitador(LIMITE_POR_IP);
const limitePorFormulario = crearLimitador(LIMITE_POR_FORMULARIO);

/** Vacía los contadores en memoria (solo pruebas). */
export function resetFormLimitsForTests(): void {
  limiteGeneral.olvidar();
  limitePorIp.olvidar();
  limitePorFormulario.olvidar();
}

/* ------------------------------ Campos y mensaje ---------------------------- */

/** Texto del visitante: sin caracteres de control salvo el salto de línea y el tabulador. */
function limpiarValor(valor: string): string {
  return valor
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
}

function limpiarClave(clave: string): string {
  return clave.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 60);
}

function aTexto(valor: unknown): string | null {
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
  return null;
}

/**
 * Campos del envío en orden, con los repetidos (casillas múltiples) unidos.
 * Admite el cuerpo de un formulario HTML y JSON plano.
 */
export function leerCampos(cuerpo: unknown): Map<string, string> {
  let entrada: [string, unknown][];
  if (typeof cuerpo === 'string') {
    // text/plain (envío «simple» sin petición previa de CORS): se admite JSON.
    try {
      cuerpo = JSON.parse(cuerpo) as unknown;
    } catch {
      throw badRequest('El envío no tiene un formato válido.', 'bad_request');
    }
  }
  if (cuerpo instanceof URLSearchParams) entrada = [...cuerpo.entries()];
  else if (cuerpo && typeof cuerpo === 'object' && !Array.isArray(cuerpo)) entrada = Object.entries(cuerpo);
  else throw badRequest('El formulario está vacío.', 'empty_submission');

  const campos = new Map<string, string>();
  for (const [claveBruta, valorBruto] of entrada) {
    const clave = limpiarClave(claveBruta);
    if (!clave) continue;
    const valores = Array.isArray(valorBruto) ? valorBruto : [valorBruto];
    const textos = valores.map(aTexto);
    if (textos.some((t) => t === null)) {
      throw badRequest(`El campo «${clave}» no tiene un formato válido.`, 'bad_request');
    }
    const valor = limpiarValor((textos as string[]).join(', '));
    const previo = campos.get(clave);
    campos.set(clave, previo ? `${previo}, ${valor}` : valor);
    if (campos.size > MAX_CAMPOS) {
      throw badRequest(`El formulario tiene demasiados campos (máximo ${MAX_CAMPOS}).`, 'too_many_fields');
    }
    if ((campos.get(clave) ?? '').length > MAX_VALOR) {
      throw badRequest(
        `El campo «${clave}» es demasiado largo (máximo ${MAX_VALOR} caracteres).`,
        'field_too_long',
      );
    }
  }
  return campos;
}

function primerCampo(campos: Map<string, string>, nombres: string[]): { clave: string; valor: string } | null {
  for (const [clave, valor] of campos) {
    if (nombres.includes(clave.toLowerCase()) && valor) return { clave, valor };
  }
  return null;
}

/** Nombre visible en una cabecera: sin saltos, comillas ni ángulos. */
function nombreVisible(texto: string): string {
  return texto.replace(/[\r\n"<>\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
}

function etiquetaCampo(clave: string): string {
  const texto = clave.replace(/[_-]+/g, ' ').trim();
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

export interface MensajeFormulario {
  from: { name: string; address: string };
  to: string;
  replyTo?: { name: string; address: string };
  subject: string;
  text: string;
  headers: Record<string, string>;
}

/**
 * Compone el mensaje que recibe el cliente. Solo texto (nada de HTML con lo
 * que escribe el visitante), el asunto lo fija el formulario y el remitente
 * es el propio buzón destinatario: de su dominio, firmado con su DKIM.
 */
export function componerMensajeFormulario(input: {
  formName: string;
  publicKey: string;
  subject: string;
  recipient: string;
  origin: string;
  campos: Map<string, string>;
  recibidoEn: number;
}): MensajeFormulario {
  const correo = primerCampo(input.campos, CAMPOS_CORREO);
  const nombre = primerCampo(input.campos, CAMPOS_NOMBRE);
  const lineas = [`Mensaje recibido con el formulario «${input.formName}» de ${input.origin}.`, ''];
  for (const [clave, valor] of input.campos) {
    if (CAMPOS_CONTROL.has(clave) || !valor) continue;
    if (valor.includes('\n')) {
      lineas.push(`${etiquetaCampo(clave)}:`, ...valor.split('\n').map((l) => `  ${l}`), '');
    } else {
      lineas.push(`${etiquetaCampo(clave)}: ${valor}`);
    }
  }
  const fecha = new Date(input.recibidoEn).toISOString().replace('T', ' ').slice(0, 16);
  lineas.push('', '--', `Recibido el ${fecha} (UTC).`);
  let replyTo: MensajeFormulario['replyTo'];
  if (correo && CORREO_RE.test(correo.valor) && correo.valor.length <= 254) {
    replyTo = { name: nombreVisible(nombre?.valor ?? ''), address: correo.valor };
    lineas.push(`Para contestar, responde a este correo: la respuesta irá a ${correo.valor}.`);
  }
  return {
    from: { name: nombreVisible(`${input.formName} (formulario web)`), address: input.recipient },
    to: input.recipient,
    replyTo,
    subject: input.subject,
    text: `${lineas.join('\n').replace(/\n{3,}/g, '\n\n')}\n`,
    // Neutra (la instancia puede ir con marca blanca): sirve para filtrar.
    headers: { 'X-Web-Form': input.publicKey },
  };
}

/* ------------------------------ Credencial SMTP ----------------------------- */

function credencialSmtp(row: FormRow): { plain: string; stored: string } {
  try {
    const datos = JSON.parse(decryptSecret(row.smtp_password_enc)) as { plain?: string; stored?: string };
    return { plain: datos.plain || '', stored: datos.stored || '' };
  } catch {
    return { plain: '', stored: '' };
  }
}

/* ---------------------------------- Envío ---------------------------------- */

function quiereHtml(req: FastifyRequest): boolean {
  const accept = String(req.headers.accept || '');
  return accept.includes('text/html') && !accept.includes('application/json');
}

/** Respuesta para el envío sin JavaScript: una página mínima con vuelta a la web. */
function paginaResultado(reply: FastifyReply, status: number, titulo: string, texto: string, volver: string | null) {
  const enlace = volver ? `<p><a href="${xmlEscape(volver)}">Volver a la web</a></p>` : '';
  reply
    .status(status)
    .type('text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${xmlEscape(titulo)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#161513}</style>
</head><body><h1>${xmlEscape(titulo)}</h1><p>${xmlEscape(texto)}</p>${enlace}</body></html>`;
}

function formularioPorClave(clave: string): FormRow | null {
  if (!CLAVE_RE.test(clave)) return null;
  return (db.prepare('SELECT * FROM forms WHERE public_key = ?').get(clave) as FormRow | undefined) ?? null;
}

/** Origen de la petición si está en la lista del formulario; si no, null. */
function origenPermitido(req: FastifyRequest, row: FormRow | null): string | null {
  const origen = req.headers.origin;
  if (!row || typeof origen !== 'string') return null;
  return origenesDe(row).includes(origen) ? origen : null;
}

async function recibirEnvio(req: FastifyRequest): Promise<{ origen: string }> {
  const ip = req.ip || '';
  if (limiteGeneral.lleno(ip)) {
    throw tooMany('Se han realizado demasiadas peticiones. Espera un minuto y vuelve a intentarlo.');
  }
  limiteGeneral.apuntar(ip);

  const { clave } = req.params as { clave: string };
  const row = formularioPorClave(clave);
  if (!row) throw notFound('Este formulario no existe o se ha eliminado.', 'form_not_found');
  const origen = origenPermitido(req, row);
  if (!origen) {
    throw forbidden('Este formulario no admite envíos desde esta página.', 'origin_not_allowed');
  }
  if (!row.enabled) throw forbidden('Este formulario está desactivado.', 'form_disabled');
  let buzon: Mailbox;
  try {
    buzon = getMailbox(row.recipient_mailbox_id);
  } catch {
    throw forbidden('Este formulario no está disponible en este momento.', 'form_unavailable');
  }
  const cliente = getClient(row.client_id);
  if (cliente.suspended || buzon.status === 'suspended') {
    throw forbidden('Este formulario no está disponible en este momento.', 'form_unavailable');
  }

  // Los errores de escritura no gastan el cupo de la IP: quien se equivoca
  // al teclear su correo puede corregirlo y volver a enviar.
  const campos = leerCampos(req.body);
  const correo = primerCampo(campos, CAMPOS_CORREO);
  if (correo && (!CORREO_RE.test(correo.valor) || correo.valor.length > 254)) {
    throw badRequest('Revisa la dirección de correo: no parece válida.', 'invalid_email');
  }
  const conContenido = [...campos].some(([k, v]) => !CAMPOS_CONTROL.has(k) && v);
  if (!conContenido) throw badRequest('El formulario está vacío.', 'empty_submission');

  // Cada envío bien formado cuenta para la IP, también los del robot que cae
  // en la trampa y los que no superan Turnstile.
  const claveIp = `${row.id}:${ip}`;
  if (limitePorIp.lleno(claveIp)) {
    throw tooMany('Has enviado varios mensajes seguidos. Espera unos minutos antes de enviar otro.');
  }
  limitePorIp.apuntar(claveIp);
  // Al robot se le responde como si hubiera funcionado: así no aprende nada.
  if (campos.get(CAMPO_TRAMPA)) return { origen };

  if (row.turnstile_secret_enc) {
    const token = campos.get(CAMPO_TURNSTILE);
    if (!token) {
      throw badRequest('Completa la verificación de seguridad antes de enviar.', 'turnstile_required');
    }
    let secreto: string | null = null;
    try {
      secreto = decryptSecret(row.turnstile_secret_enc);
    } catch {
      // Clave maestra cambiada: el secreto ya no se puede leer.
      secreto = null;
    }
    const respuesta = secreto ? await verificador(secreto, token.slice(0, 2048), ip) : null;
    if (!respuesta) {
      throw new HttpError(
        503,
        'No se ha podido completar la verificación de seguridad. Vuelve a intentarlo en unos minutos.',
        'turnstile_unavailable',
      );
    }
    // Un token resuelto en otra web (la del atacante, con su propia clave de
    // sitio no sirve, pero sí un widget copiado) no vale aquí.
    const hosts = origenesDe(row).map((o) => new URL(o).hostname);
    if (!respuesta.success || !respuesta.hostname || !hosts.includes(respuesta.hostname.toLowerCase())) {
      throw badRequest(
        'La verificación de seguridad no es válida o ha caducado. Vuelve a intentarlo.',
        'turnstile_failed',
      );
    }
  }

  if (limitePorFormulario.lleno(row.id)) {
    throw tooMany('Este formulario ha recibido muchos mensajes en la última hora. Vuelve a intentarlo más tarde.');
  }
  // Cupo diario propio del formulario, nunca el de la API del plan: el Origin
  // se falsea con curl, y si los formularios gastaran ese cupo, cualquiera
  // podría dejar al cliente sin sus envíos por API hasta el día siguiente.
  const liberarCupo = reservarCupoFormulario(row.id);
  try {
    limitePorFormulario.apuntar(row.id);
    await entregar(req, row, buzon, campos, origen);
  } finally {
    liberarCupo();
  }
  return { origen };
}

/** Reserva un mensaje del cupo diario del formulario (los ya entregados hoy y los que están saliendo). */
function reservarCupoFormulario(formId: string): () => void {
  const registrados = (
    db
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE form_id = ? AND created_at >= ?')
      .get(formId, inicioDelDiaUtc()) as { c: number }
  ).c;
  return reservarCupoDiario(`formulario:${formId}`, registrados, LIMITE_DIARIO_POR_FORMULARIO, () =>
    tooMany('Este formulario no admite más mensajes por hoy. Vuelve a intentarlo mañana.', 'daily_limit_reached'),
  );
}

/** Envía por el SMTP del motor con la credencial del formulario y deja la fila en `messages`. */
async function entregar(
  req: FastifyRequest,
  row: FormRow,
  buzon: Mailbox,
  campos: Map<string, string>,
  origen: string,
): Promise<void> {
  const mensaje = componerMensajeFormulario({
    formName: row.name,
    publicKey: row.public_key,
    subject: row.subject,
    recipient: buzon.email,
    origin: origen,
    campos,
    recibidoEn: now(),
  });
  const engineSettings = getEngineSettings();
  let status: 'sent' | 'failed' = 'sent';
  let error = '';
  let smtpMessageId = '';
  const id = randomId('msg');
  if (engineSettings?.kind === 'demo') {
    smtpMessageId = `<demo-${id}@mailway>`;
  } else if (!engineSettings) {
    status = 'failed';
    error = 'el motor de correo no está configurado';
  } else {
    const { mailHostname } = getInstanceSettings();
    try {
      const transport = getTransport(row.id, buzon.email, credencialSmtp(row).plain, engineSettings, mailHostname);
      const resultado = await transport.sendMail(mensaje);
      smtpMessageId = resultado.messageId || '';
    } catch (err) {
      status = 'failed';
      error = describeSmtpError(err, mailHostname || engineSettings.smtpHost);
      req.log.warn({ err, form: row.public_key }, 'Envío de un formulario rechazado por el SMTP del motor');
    }
  }
  const t = now();
  db.prepare(
    `INSERT INTO messages (id, client_id, api_key_id, form_id, source, from_address, to_json, subject,
       status, error, smtp_message_id, size_bytes, created_at)
     VALUES (?, ?, NULL, ?, 'form', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, row.client_id, row.id, buzon.email, JSON.stringify([buzon.email]), mensaje.subject,
    status, error, smtpMessageId, Buffer.byteLength(mensaje.text, 'utf8'), t,
  );
  db.prepare(
    'UPDATE forms SET submissions_count = submissions_count + 1, last_submission_at = ? WHERE id = ?',
  ).run(t, row.id);
  if (status === 'failed') {
    throw new HttpError(
      502,
      'No se ha podido enviar el mensaje en este momento. Vuelve a intentarlo más tarde.',
      'send_failed',
    );
  }
}

/** Lee el cuerpo de un formulario HTML (application/x-www-form-urlencoded). */
function analizarFormulario(texto: string): Record<string, string | string[]> {
  const resultado: Record<string, string | string[]> = {};
  for (const [clave, valor] of new URLSearchParams(texto)) {
    const previo = resultado[clave];
    if (previo === undefined) resultado[clave] = valor;
    else resultado[clave] = Array.isArray(previo) ? [...previo, valor] : [previo, valor];
  }
  return resultado;
}

/* ------------------------------- Panel: rutas ------------------------------- */

const sinControles = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

const turnstileCampo = z
  .string()
  .trim()
  .regex(TURNSTILE_RE, 'Las claves de Turnstile solo contienen letras, números, guiones y guiones bajos.');

const crearSchema = z.object({
  clientId: z.string().optional(),
  name: z
    .string({ required_error: 'Indica un nombre para el formulario, por ejemplo «Contacto».' })
    .trim()
    .min(2, 'Indica un nombre para el formulario, por ejemplo «Contacto».')
    .max(60, 'El nombre admite como máximo 60 caracteres.')
    .refine(sinControles, 'El nombre no puede contener saltos de línea.'),
  recipientMailboxId: z.string({ required_error: 'Selecciona el buzón que recibirá los mensajes.' }).min(1, 'Selecciona el buzón que recibirá los mensajes.'),
  allowedOrigins: z
    .array(z.string().max(300), { required_error: 'Indica al menos un origen permitido, por ejemplo https://www.tu-dominio.com.' })
    .min(1, 'Indica al menos un origen permitido, por ejemplo https://www.tu-dominio.com.')
    .max(MAX_ORIGENES, `Se admiten como máximo ${MAX_ORIGENES} orígenes por formulario.`),
  subject: z
    .string()
    .trim()
    .min(1, 'Indica el asunto de los mensajes.')
    .max(150, 'El asunto admite como máximo 150 caracteres.')
    .refine(sinControles, 'El asunto no puede contener saltos de línea.')
    .default('Nuevo mensaje desde la web'),
  turnstileSiteKey: turnstileCampo.optional(),
  turnstileSecret: turnstileCampo.optional(),
});

const editarSchema = z.object({
  name: crearSchema.shape.name.optional(),
  allowedOrigins: crearSchema.shape.allowedOrigins.optional(),
  subject: z
    .string()
    .trim()
    .min(1, 'Indica el asunto de los mensajes.')
    .max(150, 'El asunto admite como máximo 150 caracteres.')
    .refine(sinControles, 'El asunto no puede contener saltos de línea.')
    .optional(),
  enabled: z.boolean().optional(),
  /** null retira Turnstile; una cadena lo configura o sustituye. */
  turnstileSiteKey: turnstileCampo.nullable().optional(),
  turnstileSecret: turnstileCampo.nullable().optional(),
});

function turnstileIncompleto(): HttpError {
  return badRequest(
    'Para usar Turnstile indica la clave de sitio y la clave secreta; para no usarlo, deja las dos vacías.',
    'turnstile_incomplete',
  );
}

export function registerFormRoutes(app: FastifyInstance): void {
  app.get('/api/forms', async (req) => {
    const user = requireAuth(req);
    const { clientId } = req.query as { clientId?: string };
    const efectivo = user.role === 'admin' ? clientId : user.clientId!;
    const rows = efectivo
      ? (db.prepare('SELECT * FROM forms WHERE client_id = ? ORDER BY created_at DESC').all(efectivo) as FormRow[])
      : (db.prepare('SELECT * FROM forms ORDER BY created_at DESC').all() as FormRow[]);
    const base = publicBaseUrl(req);
    return { forms: rows.map((row) => toInfo(row, base)) };
  });

  app.post('/api/forms', async (req) => {
    const user = requireAuth(req);
    const body = crearSchema.parse(req.body ?? {});
    const clientId = user.role === 'admin' ? body.clientId || '' : user.clientId!;
    if (!clientId) throw badRequest('Indica el cliente propietario del formulario.');
    requireClientAccess(req, clientId);
    const allowedOrigins = normalizarOrigenes(body.allowedOrigins);
    if (Boolean(body.turnstileSiteKey) !== Boolean(body.turnstileSecret)) throw turnstileIncompleto();

    const row = await withLock(clientLockKey(clientId), async () => {
      assertClientActive(clientId);
      const total = (db.prepare('SELECT COUNT(*) AS c FROM forms WHERE client_id = ?').get(clientId) as { c: number }).c;
      if (total >= MAX_FORMULARIOS_POR_CLIENTE) {
        throw conflict(
          `Este cliente ya tiene ${MAX_FORMULARIOS_POR_CLIENTE} formularios. Elimina los que ya no se utilicen antes de crear otro.`,
          'form_limit',
        );
      }
      const buzon = getMailbox(body.recipientMailboxId);
      if (buzon.clientId !== clientId) {
        throw badRequest('El buzón destinatario debe pertenecer al mismo cliente que el formulario.', 'recipient_other_client');
      }
      if (buzon.status === 'suspended') {
        throw badRequest(
          `El buzón ${buzon.email} está suspendido. Reactívalo o selecciona otro buzón.`,
          'mailbox_suspended',
        );
      }
      // El formulario envía con el remitente del dominio: sin propiedad
      // comprobada, se enviaría en nombre de un dominio que quizá no es suyo.
      assertDomainOwnership(buzon.domainId);

      // Credencial SMTP propia, como las claves de API: el formulario envía
      // sin conocer la contraseña del buzón y se retira al eliminarlo. El
      // motor puede imponer su propio secreto: se guarda el que devuelve.
      const id = randomId('frm');
      const engine = getEngine();
      const smtp = await engine.addAppPassword(buzon.email, `mailway-form-${id.slice(4, 12)}`, generateMailboxPassword(24));
      const smtpApi = await engine.detectApi().catch(() => null);
      const publicKey = `mwf_${crypto.randomBytes(16).toString('base64url')}`;
      const t = now();
      try {
        db.prepare(
          `INSERT INTO forms (id, client_id, name, public_key, recipient_mailbox_id, allowed_origins_json,
             subject, smtp_password_enc, smtp_engine_api, turnstile_site_key, turnstile_secret_enc, created_by,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, clientId, body.name, publicKey, buzon.id, JSON.stringify(allowedOrigins), body.subject,
          cifrarCredencialSmtp(smtp.secret, smtp.ref), smtpApi,
          body.turnstileSiteKey ?? null,
          body.turnstileSecret ? encryptSecret(body.turnstileSecret) : null,
          user.id, t, t,
        );
      } catch (err) {
        // Sin fila, la credencial quedaría en el motor sin que nadie pudiera retirarla.
        await engine.removeAppPassword(buzon.email, smtp.ref).catch((rollbackErr: unknown) => {
          req.log.error({ err: rollbackErr }, 'No se pudo retirar la credencial tras fallar el alta del formulario');
        });
        throw err;
      }
      audit(req, 'form.created', {
        id,
        name: body.name,
        recipient: buzon.email,
        allowedOrigins,
        turnstile: Boolean(body.turnstileSecret),
      }, clientId);
      return filaPorId(id);
    });
    return { form: toInfo(row, publicBaseUrl(req)) };
  });

  app.patch('/api/forms/:id', async (req) => {
    const { id } = req.params as { id: string };
    requireAuth(req);
    const row = filaPorId(id);
    requireClientAccess(req, row.client_id);
    const body = editarSchema.parse(req.body ?? {});

    const cambios: Record<string, unknown> = {};
    const sets: string[] = [];
    const valores: (string | number | null)[] = [];
    if (body.name !== undefined && body.name !== row.name) {
      sets.push('name = ?');
      valores.push(body.name);
      cambios.name = body.name;
    }
    if (body.subject !== undefined && body.subject !== row.subject) {
      sets.push('subject = ?');
      valores.push(body.subject);
      cambios.subject = body.subject;
    }
    if (body.allowedOrigins !== undefined) {
      const origenes = normalizarOrigenes(body.allowedOrigins);
      sets.push('allowed_origins_json = ?');
      valores.push(JSON.stringify(origenes));
      cambios.allowedOrigins = origenes;
    }
    if (body.enabled !== undefined && body.enabled !== (row.enabled === 1)) {
      if (body.enabled) assertClientActive(row.client_id);
      sets.push('enabled = ?');
      valores.push(body.enabled ? 1 : 0);
      cambios.enabled = body.enabled;
    }
    if (body.turnstileSiteKey !== undefined || body.turnstileSecret !== undefined) {
      if (body.turnstileSiteKey === null || body.turnstileSecret === null) {
        if (body.turnstileSiteKey || body.turnstileSecret) throw turnstileIncompleto();
        sets.push('turnstile_site_key = NULL', 'turnstile_secret_enc = NULL');
        cambios.turnstile = 'retirado';
      } else {
        const siteKey = body.turnstileSiteKey ?? row.turnstile_site_key;
        const tieneSecreto = Boolean(body.turnstileSecret) || Boolean(row.turnstile_secret_enc);
        if (!siteKey || !tieneSecreto) throw turnstileIncompleto();
        sets.push('turnstile_site_key = ?');
        valores.push(siteKey);
        if (body.turnstileSecret) {
          sets.push('turnstile_secret_enc = ?');
          valores.push(encryptSecret(body.turnstileSecret));
        }
        // El secreto nunca va a la actividad: solo que se ha configurado.
        cambios.turnstile = 'configurado';
      }
    }
    if (sets.length > 0) {
      db.prepare(`UPDATE forms SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...valores, now(), id);
      audit(req, 'form.updated', { id, name: body.name ?? row.name, ...cambios }, row.client_id);
    }
    return { form: toInfo(filaPorId(id), publicBaseUrl(req)) };
  });

  app.delete('/api/forms/:id', async (req) => {
    const { id } = req.params as { id: string };
    requireAuth(req);
    const row = filaPorId(id);
    requireClientAccess(req, row.client_id);
    // La credencial se retira del motor después de borrar la fila: durante el
    // mantenimiento del motor no se podría, y quedaría viva sin formulario.
    exigirSinMantenimiento();
    db.prepare('DELETE FROM forms WHERE id = ?').run(id);
    forgetTransport(id);
    // La credencial SMTP del formulario se retira del motor: sin formulario,
    // nadie la necesita. Una de otra versión del motor ya no existe en este.
    try {
      const { stored } = credencialSmtp(row);
      const engine = getEngine();
      if (stored && !esDeOtroMotor(row.smtp_engine_api, await engine.detectApi())) {
        await engine.removeAppPassword(getMailbox(row.recipient_mailbox_id).email, stored);
      }
    } catch (err) {
      req.log.warn({ err }, 'No se pudo retirar la credencial SMTP al eliminar el formulario');
    }
    audit(req, 'form.deleted', { id, name: row.name }, row.client_id);
    return { ok: true };
  });

  /* ------------------------------ Rutas públicas ----------------------------- */

  // Ámbito propio: el analizador de formularios HTML y las cabeceras de CORS
  // solo existen aquí; el resto de la API sigue sin CORS y solo con JSON.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: MAX_ENVIO_BYTES },
      (_req, body, done) => {
        done(null, analizarFormulario(String(body)));
      },
    );

    // En onSend para que también los errores (400, 413, 429…) lleven CORS:
    // sin él, el script de la web no puede leer el motivo y solo ve «error de red».
    scope.addHook('onSend', async (req, reply, payload) => {
      const { clave } = (req.params ?? {}) as { clave?: string };
      if (!clave) return payload;
      const origen = origenPermitido(req, formularioPorClave(clave));
      reply.header('Vary', 'Origin');
      if (origen) {
        reply.header('Access-Control-Allow-Origin', origen);
        if (req.method === 'OPTIONS') {
          reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
          reply.header('Access-Control-Allow-Headers', 'Content-Type, Accept');
          reply.header('Access-Control-Max-Age', '600');
        }
      }
      return payload;
    });

    scope.options('/forms/:clave', async (req, reply) => {
      const { clave } = req.params as { clave: string };
      if (!origenPermitido(req, formularioPorClave(clave))) {
        return reply.status(403).send({
          error: 'Este formulario no admite envíos desde esta página.',
          code: 'origin_not_allowed',
        });
      }
      return reply.status(204).send();
    });

    scope.post('/forms/:clave', { bodyLimit: MAX_ENVIO_BYTES }, async (req, reply) => {
      const html = quiereHtml(req);
      try {
        const { origen } = await recibirEnvio(req);
        reply.header('Cache-Control', 'no-store');
        if (html) {
          return paginaResultado(reply, 200, 'Mensaje enviado', 'Gracias. Tu mensaje se ha enviado correctamente.', origen);
        }
        return { ok: true };
      } catch (err) {
        if (html && err instanceof HttpError) {
          return paginaResultado(reply, err.status, 'No se ha podido enviar el mensaje', err.message, origenPermitido(req, formularioPorClave((req.params as { clave: string }).clave)));
        }
        throw err;
      }
    });

    scope.get('/forms/widget.js', async (_req, reply) => {
      reply
        .type('application/javascript; charset=utf-8')
        .header('Cache-Control', 'public, max-age=3600')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cross-Origin-Resource-Policy', 'cross-origin');
      return WIDGET_JS;
    });
  });
}

/* ---------------------------------- Widget ---------------------------------- */

/**
 * Script que pega la web junto al formulario. Sin dependencias y en ES5 para
 * cualquier navegador: si falta fetch, no hace nada y el formulario se envía
 * de forma nativa (el servidor responde entonces con una página). Envía con
 * credentials: 'omit' (nunca viajan cookies del panel) y escribe el resultado
 * con textContent en una región aria-live.
 */
export const WIDGET_JS = `/* Formularios de contacto · envío sin recargar la página. */
(function () {
  'use strict';
  var script = document.currentScript;
  var clave = script && script.getAttribute('data-form');
  if (!clave) return;
  var TEXTOS = {
    enviando: 'Enviando…',
    ok: 'Gracias. Tu mensaje se ha enviado correctamente.',
    400: 'Revisa los datos del formulario y vuelve a intentarlo.',
    403: 'Este formulario no admite envíos desde esta página.',
    404: 'Este formulario ya no está disponible.',
    413: 'El mensaje es demasiado largo. Acórtalo y vuelve a intentarlo.',
    429: 'Se han enviado demasiados mensajes. Espera unos minutos y vuelve a intentarlo.',
    red: 'No se ha podido enviar el mensaje. Comprueba la conexión y vuelve a intentarlo.',
    error: 'No se ha podido enviar el mensaje. Vuelve a intentarlo más tarde.'
  };

  function mostrar(region, texto, error) {
    region.textContent = texto;
    region.setAttribute('data-estado', error ? 'error' : 'ok');
  }

  function preparar(form) {
    if (form.getAttribute('data-mailway-listo')) return;
    form.setAttribute('data-mailway-listo', '1');
    if (!window.fetch || !window.FormData || !window.URLSearchParams) return;
    if (!form.querySelector('[name="${CAMPO_TRAMPA}"]')) {
      var trampa = document.createElement('input');
      trampa.type = 'text';
      trampa.name = '${CAMPO_TRAMPA}';
      trampa.tabIndex = -1;
      trampa.autocomplete = 'off';
      trampa.setAttribute('aria-hidden', 'true');
      trampa.style.cssText = 'position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden';
      form.appendChild(trampa);
    }
    var region = form.querySelector('[data-mailway-estado]');
    if (!region) {
      region = document.createElement('p');
      region.setAttribute('data-mailway-estado', '');
      form.appendChild(region);
    }
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');

    form.addEventListener('submit', function (evento) {
      evento.preventDefault();
      if (form.getAttribute('aria-busy') === 'true') return;
      var boton = form.querySelector('[type="submit"]');
      form.setAttribute('aria-busy', 'true');
      if (boton) boton.disabled = true;
      mostrar(region, TEXTOS.enviando, false);
      var datos = new URLSearchParams();
      new FormData(form).forEach(function (valor, nombre) {
        if (typeof valor === 'string') datos.append(nombre, valor);
      });
      fetch(form.action, {
        method: 'POST',
        body: datos,
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        mode: 'cors'
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (cuerpo) {
            if (res.ok) {
              form.reset();
              mostrar(region, TEXTOS.ok, false);
            } else if (res.status === 400 && cuerpo && typeof cuerpo.error === 'string') {
              mostrar(region, cuerpo.error, true);
            } else {
              mostrar(region, TEXTOS[res.status] || TEXTOS.error, true);
            }
          });
        }, function () {
          mostrar(region, TEXTOS.red, true);
        })
        .then(function () {
          form.removeAttribute('aria-busy');
          if (boton) boton.disabled = false;
          var widget = form.querySelector('.cf-turnstile');
          if (widget && window.turnstile) {
            try { window.turnstile.reset(widget); } catch (e) { /* sin Turnstile cargado */ }
          }
        });
    });
  }

  function iniciar() {
    var formularios = document.querySelectorAll('form[data-mailway-form]');
    for (var i = 0; i < formularios.length; i++) {
      if (formularios[i].getAttribute('data-mailway-form') === clave) preparar(formularios[i]);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
`;
