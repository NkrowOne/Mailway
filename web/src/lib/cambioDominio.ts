import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api, ApiError, type DomainRecord, type Mailbox } from './api';
import { plural } from './format';

/*
  Cambio de dominio de un cliente (dominio.es → dominio2.es): tipos de la API
  (contrato de §3.14), llamadas y textos que comparten el asistente de la
  ficha del dominio, la lista de dominios, la de buzones y la ficha del buzón.
  El estado vive solo en el servidor: aquí no se deduce nada que la vista no
  diga (las acciones disponibles llegan en `puedePasar`, `puedeVolver`…).
*/

/* --------------------------------- Tipos ---------------------------------- */

export type EstadoCambio =
  | 'preparando'
  | 'listo'
  | 'pasando'
  | 'pasado'
  | 'volviendo'
  | 'dando_de_baja'
  | 'dado_de_baja'
  | 'cancelada';

/** Papel de un dominio en un cambio abierto (`DomainRecord.migracion`). */
export interface MigracionDominio {
  id: string;
  rol: 'origen' | 'destino';
  estado: EstadoCambio;
  /** El otro dominio del cambio. */
  pareja: string;
  /** false para el dominio anterior: mientras dura el cambio no cuenta en el plan. */
  cuentaEnPlan: boolean;
}

export interface AvisoCambio {
  code: string;
  mensaje: string;
}

/** POST /api/domain-migrations/plan: lo que pasaría, sin efectos. */
export interface PlanCambioDominio {
  desde: { domainId: string; domain: string };
  hacia: { domain: string; existe: boolean; domainId: string | null };
  buzones: { id: string; de: string; a: string; usadoPorApps: string[] }[];
  alias: { id: string; de: string; a: string }[];
  formularios: { id: string; name: string; origenesNuevos: string[] }[];
  webmail: { viejo: string | null; nuevo: string | null };
  avisos: AvisoCambio[];
  /** No vacío: la creación respondería 409 o 400. */
  bloqueos: AvisoCambio[];
}

export type IdCompuerta = 'motor' | 'cliente' | 'propiedad' | 'recepcion' | 'dns' | 'webmail';

export interface CompuertaCambio {
  id: IdCompuerta;
  ok: boolean;
  bloquea: boolean;
  titulo: string;
  detalle: string;
}

export interface WebmailCambio {
  id: string;
  hostname: string;
  status: string;
  principal: boolean;
}

export interface PersonaCambio {
  id: string;
  email: string;
  login: string;
  pendiente: boolean;
  /** Contraseñas de aplicación de Skyway («skyway:tienda»): ese buzón lo actualiza Skyway. */
  usadoPorApps: string[];
}

/** Vista de un cambio (GET /api/domain-migrations/:id y respuesta de cada acción). */
export interface CambioDominioVista {
  id: string;
  clientId: string;
  origen: 'panel' | 'skyway';
  referenciaExterna: string | null;
  desde: { domainId: string | null; domain: string };
  hacia: { domainId: string | null; domain: string; cloudflare: boolean; recibeEnOtroProveedor: boolean };
  estado: EstadoCambio;
  paso: string;
  error: string | null;
  /** La pre-recepción está hecha: el dominio nuevo ya recibe en los buzones. */
  recepcionPreparada: boolean;
  compuertas: CompuertaCambio[];
  puedePasar: boolean;
  puedeVolver: boolean;
  puedeCancelar: boolean;
  puedeDarDeBaja: boolean;
  /** Lo que impide la baja sin consultar la red (apps SMTP e instancia); el MX se comprueba al pulsar. */
  bloqueosBaja: AvisoCambio[];
  buzones: { total: number; pendientes: number; lista: PersonaCambio[] };
  alias: { total: number };
  webmail: { viejo: WebmailCambio | null; nuevo: WebmailCambio | null };
  nombresCloudflare: string[];
  avisos: AvisoCambio[];
  fechas: { creado: number; listo: number | null; pasado: number | null; terminado: number | null };
  /**
   * El dominio nuevo lo dio de alta este cambio (cancelar lo elimina). No
   * está en el contrato de §3.14: sin el campo, la confirmación de cancelar
   * no lo anuncia.
   */
  creoDestino?: boolean;
}

/** POST /api/domain-migrations/:id/setup-links: un enlace por persona pendiente. */
export interface EnlacesEquipo {
  enlaces: { mailboxId: string; email: string; url: string; expiresAt: number }[];
}

/* -------------------------------- Llamadas -------------------------------- */

const base = '/api/domain-migrations';
const ruta = (id: string, accion: string) => `${base}/${encodeURIComponent(id)}/${accion}`;

/*
  Las acciones envían siempre `{}`: el servidor valida el cuerpo con zod y un
  POST sin cuerpo no pasaría `z.object({})`.
*/
export const cambioDominio = {
  plan: (fromDomainId: string, toDomain: string) =>
    api.post<PlanCambioDominio>(`${base}/plan`, { fromDomainId, toDomain }),
  crear: (fromDomainId: string, toDomain: string) =>
    api.post<CambioDominioVista>(base, { fromDomainId, toDomain }),
  obtener: (id: string) => api.get<CambioDominioVista>(`${base}/${encodeURIComponent(id)}`),
  comprobar: (id: string) => api.post<CambioDominioVista>(ruta(id, 'check'), {}),
  cambiarMx: (id: string) => api.post<CambioDominioVista>(ruta(id, 'mx'), {}),
  pasar: (id: string) => api.post<CambioDominioVista>(ruta(id, 'switch'), {}),
  volver: (id: string) => api.post<CambioDominioVista>(ruta(id, 'rollback'), {}),
  cancelar: (id: string) => api.post<CambioDominioVista>(ruta(id, 'cancel'), {}),
  darDeBaja: (id: string, confirm: string) => api.post<CambioDominioVista>(ruta(id, 'retire'), { confirm }),
  enlaces: (id: string) => api.post<EnlacesEquipo>(ruta(id, 'setup-links'), {}),
};

/** «Actualizar ahora» desde el panel: el usuario del buzón pasa a ser su dirección. Idempotente. */
export function actualizarUsuarioBuzon(mailboxId: string): Promise<{ mailbox: Mailbox }> {
  return api.post<{ mailbox: Mailbox }>(`/api/mailboxes/${encodeURIComponent(mailboxId)}/login-update`, {});
}

/** Clave de React Query de la vista de un cambio. */
export function claveCambio(id: string): readonly [string, string] {
  return ['domain-migration', id] as const;
}

/**
 * Tras una acción que cambia direcciones, usuarios o dominios: los buzones
 * y alias se mudan de dominio, las claves de API envían desde otra dirección,
 * el webmail principal cambia y el dominio anterior deja de contar en el plan.
 * La vista del cambio no se invalida: la acción ya la devuelve y se guarda.
 */
export function invalidarTrasCambio(queryClient: QueryClient): Promise<unknown> {
  const claves: string[][] = [
    ['domain'],
    ['domains'],
    ['mailboxes'],
    ['aliases'],
    ['apikeys'],
    ['forms'],
    ['conexion'],
    ['setup-links'],
    ['whitelabel-domains'],
    ['whitelabel-domain'],
    ['domain-cloudflare'],
    ['domain-conflicto'],
    ['clients'],
    ['client'],
    ['client-dashboard'],
    ['admin-dashboard'],
  ];
  return Promise.all(claves.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

/**
 * Tras actualizar el usuario de un buzón: la lista de buzones, la vista del
 * cambio (cuenta los pendientes) y los datos de conexión, que muestran el usuario.
 */
export function invalidarTrasActualizarUsuario(queryClient: QueryClient): Promise<unknown> {
  const claves: string[][] = [['mailboxes'], ['domain-migration'], ['conexion'], ['setup-links']];
  return Promise.all(claves.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

/* --------------------------------- Fases ---------------------------------- */

export type FaseCambio = 'preparar' | 'transicion' | 'terminado';

/** Fase que ve la interfaz (§2.1): «pasando» aún es preparar; «volviendo», transición. */
export function faseDe(estado: EstadoCambio): FaseCambio {
  if (estado === 'preparando' || estado === 'listo' || estado === 'pasando') return 'preparar';
  if (estado === 'dado_de_baja' || estado === 'cancelada') return 'terminado';
  return 'transicion';
}

export type EstadoEnCurso = 'pasando' | 'volviendo' | 'dando_de_baja';

export function esEstadoEnCurso(estado: EstadoCambio): estado is EstadoEnCurso {
  return estado === 'pasando' || estado === 'volviendo' || estado === 'dando_de_baja';
}

/**
 * Una acción se está ejecutando ahora mismo (estado en curso sin error): la
 * vista se vuelve a pedir cada pocos segundos y no se ofrecen acciones.
 */
export function accionEnMarcha(vista: CambioDominioVista): boolean {
  return esEstadoEnCurso(vista.estado) && !vista.error;
}

/** Los estados en los que el asistente consulta el DNS cada 30 segundos. */
export function enPreparacion(vista: CambioDominioVista): boolean {
  return vista.estado === 'preparando' || vista.estado === 'listo';
}

/**
 * Las altas de buzones y alias que el servidor rechazaría (409
 * `domain_migrating`): en el dominio anterior mientras el cambio esté
 * abierto y en el nuevo hasta pasar (decisión 3). null si se admiten.
 */
export function motivoAltaBloqueada(m: MigracionDominio | null | undefined): string | null {
  if (!m) return null;
  if (m.estado === 'dado_de_baja' || m.estado === 'cancelada') return null;
  if (m.rol === 'origen') return 'En un cambio de dominio';
  if (m.estado === 'pasado' || m.estado === 'dando_de_baja') return null;
  return 'Disponible al pasar a este dominio';
}

/**
 * Dominios que cuentan en el plan: el uso del cliente (`usage.domains`)
 * incluye el dominio anterior de un cambio abierto, que no cuenta (§3.13).
 * Se descuenta igual que hace el servidor en el límite y en el exceso del plan.
 */
export function dominiosQueCuentan(
  usados: number,
  dominios: readonly { migracion?: MigracionDominio | null }[],
): number {
  const exentos = dominios.filter((d) => d.migracion && !d.migracion.cuentaEnPlan).length;
  return Math.max(0, usados - exentos);
}

/** Etiqueta del dominio en la lista de dominios («Dominio anterior…», «Sustituye a…»). */
export function etiquetaMigracion(m: MigracionDominio, isAdmin: boolean): string {
  if (m.rol === 'origen') {
    return isAdmin ? 'Dominio anterior (no cuenta en el plan)' : 'Dominio anterior (no cuenta en tu plan)';
  }
  return faseDe(m.estado) === 'preparar' ? `Se prepara para sustituir a ${m.pareja}` : `Sustituye a ${m.pareja}`;
}

/* --------------------------------- Textos --------------------------------- */

/** «tienda, blog» a partir de los nombres de las contraseñas de aplicación de Skyway («skyway:tienda»). */
export function nombresApps(apps: string[]): string {
  return apps.map((a) => a.replace(/^skyway:/, '')).join(', ');
}

/** Texto que sustituye a «Actualizar ahora» cuando el buzón lo usa una aplicación de Skyway. */
export function textoUsadoPorApp(apps: string[]): string {
  const nombres = nombresApps(apps);
  return `La usa una aplicación para enviar${nombres ? ` (${nombres})` : ''}. Actualízalo desde Skyway.`;
}

/** Confirmación de «Actualizar ahora» (panel). */
export function textoConfirmarActualizar(email: string, login: string): string {
  return `Los dispositivos de ${email} que sigan configurados con ${login} dejarán de conectar hasta que se actualicen. La contraseña no cambia.`;
}

/** «Pasarán a dominio2.es 12 buzones y 4 alias. …» del paso «Elegir». */
export function resumenPlan(plan: PlanCambioDominio): string {
  const buzones = plan.buzones.length;
  const alias = plan.alias.length;
  if (buzones === 0 && alias === 0) {
    return `${plan.desde.domain} no tiene buzones ni alias: solo se preparará ${plan.hacia.domain}.`;
  }
  const partes = [buzones > 0 ? plural(buzones, 'buzón', 'buzones') : '', alias > 0 ? plural(alias, 'alias', 'alias') : '']
    .filter(Boolean)
    .join(' y ');
  return `Pasarán a ${plan.hacia.domain} ${partes}. Las contraseñas, las contraseñas de aplicación, las claves de API y los formularios siguen funcionando.`;
}

/** Nombre para el mensaje del equipo: «Ana (ana@dominio2.es)» o solo la dirección. */
export function personaEnMensaje(email: string, nombre: string | undefined): string {
  const limpio = (nombre ?? '').trim();
  return limpio ? `${limpio} (${email})` : email;
}

/** «Mensaje para tu equipo»: el texto que se copia y se envía a quien tenga que actualizar. */
export function textoMensajeEquipo(
  hacia: string,
  enlaces: { email: string; url: string; nombre?: string }[],
): string {
  const lineas = [
    `Nuestra dirección de correo pasa a ser @${hacia} y ya recibes en las dos. Para que tu móvil y tu ordenador sigan conectando, abre tu enlace y pulsa «Actualizar mis dispositivos». Tu contraseña no cambia.`,
    '',
    ...enlaces.map((e) => `${personaEnMensaje(e.email, e.nombre)}: ${e.url}`),
    '',
    'Los enlaces caducan en 7 días.',
  ];
  return lineas.join('\n');
}

/** Mensaje de un error de la API listo para mostrar, o el genérico indicado. */
export function mensajeCambio(err: unknown, generico: string): string {
  return err instanceof ApiError ? err.message : generico;
}

/**
 * Nombre técnico (ASCII) de un dominio escrito a mano: «señor.es» pasa a
 * «xn--seor-hqa.es» y «Dominio.ES » a «dominio.es». La conversión la hace el
 * navegador al analizar el nombre como el host de una URL. Con caracteres
 * que una URL interpreta (@, /, :…) se compara tal cual: el host analizado
 * sería solo una parte de lo escrito («x@dominio.es» daría dominio.es).
 */
export function nombreTecnico(escrito: string): string {
  const limpio = escrito.trim().toLowerCase();
  if (!limpio || /[\s/@:?#\\%]/.test(limpio)) return limpio;
  try {
    return new URL(`http://${limpio}`).hostname;
  } catch {
    return limpio;
  }
}

/**
 * La confirmación de la baja admite mayúsculas, espacios alrededor y, en un
 * dominio internacionalizado, tanto la forma que ve el usuario («señor.es»)
 * como la técnica. Al servidor se envía siempre la técnica (`dominio`), que
 * es la que compara.
 */
export function confirmacionCoincide(escrito: string, dominio: string): boolean {
  return nombreTecnico(escrito) === dominio.toLowerCase();
}

/**
 * Nombre de un dominio tal como se ve en el resto del panel: la vista del
 * cambio da el técnico («xn--seor-hqa.es») y la ficha y la lista muestran
 * «señor.es». Solo consulta la lista de dominios si el nombre es
 * internacionalizado; si no la tiene, devuelve el técnico.
 */
export function useNombreVisible(domainId: string | null, tecnico: string): string {
  const idn = tecnico.split('.').some((etiqueta) => etiqueta.startsWith('xn--'));
  const dominios = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ domains: DomainRecord[] }>('/api/domains'),
    enabled: idn && domainId !== null,
  });
  if (!idn) return tecnico;
  return dominios.data?.domains.find((d) => d.id === domainId)?.domainUnicode || tecnico;
}
