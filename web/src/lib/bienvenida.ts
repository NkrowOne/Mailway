import { fechaLarga } from './portal';
import type { Veredicto } from '../ui/kit';

/*
  Enlace de bienvenida del cliente: la administración lo envía a la persona
  de contacto de la empresa, que crea con él su acceso al panel y pone en
  marcha todo el correo (dominio, direcciones obligatorias, buzones del
  equipo y sus dispositivos).
*/

/** Respuesta de crear una invitación o de recuperar su enlace: la URL solo llega aquí. */
export interface InvitacionCreada {
  id: string;
  url: string;
  email: string;
  name: string;
  expiresAt: number;
}

/** Fila de GET /api/clients/:id/invites. */
export interface Invitacion {
  id: string;
  email: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  openedAt: number | null;
  acceptedAt: number | null;
  revokedAt: number | null;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  /** La administración puede volver a verlo y enviarlo mientras siga pendiente. */
  recoverable: boolean;
}

/** GET /api/invite/:token: lo que ve quien abre el enlace, sin sesión. */
export interface InvitacionPublica {
  clientName: string;
  brandName: string;
  email: string;
  name: string;
  expiresAt: number;
}

/** Respuesta de POST /api/invite/:token/accept (la sesión llega en la cookie). */
export interface AceptacionInvitacion {
  ok: true;
  redirect?: string;
}

/** Mínimo de la contraseña del panel (el servidor exige lo mismo). */
export const MINIMO_CONTRASENA = 10;
export const MAXIMO_CONTRASENA = 200;

/** Validez del enlace: la habitual es una semana, para que dé tiempo a abrirlo. */
export const VALIDECES_BIENVENIDA = [
  { horas: 24, texto: '1 día' },
  { horas: 72, texto: '3 días' },
  { horas: 168, texto: '7 días' },
  { horas: 720, texto: '30 días' },
] as const;

export const VALIDEZ_POR_DEFECTO = '168';

/**
 * Estado legible de una invitación. «Abierto» se distingue de «Pendiente»
 * porque cambia lo que conviene hacer: si nadie lo ha abierto, quizá no le
 * llegó el correo; si lo abrió y no terminó, quizá necesita ayuda.
 */
export function estadoInvitacion(inv: Invitacion, ahora = Date.now()): {
  etiqueta: string;
  veredicto: Veredicto;
  /** Sigue sirviendo: se puede volver a enviar o revocar. */
  vigente: boolean;
} {
  if (inv.status === 'accepted' || inv.acceptedAt) return { etiqueta: 'Aceptado', veredicto: 'normal', vigente: false };
  if (inv.status === 'revoked' || inv.revokedAt) return { etiqueta: 'Revocado', veredicto: 'sin-dato', vigente: false };
  if (inv.status === 'expired' || inv.expiresAt <= ahora) {
    return { etiqueta: 'Caducado', veredicto: 'sin-dato', vigente: false };
  }
  // Pendiente de que la persona complete un paso: ámbar, como los pasos pendientes.
  return { etiqueta: inv.openedAt ? 'Abierto' : 'Pendiente', veredicto: 'vigilar', vigente: true };
}

/**
 * Correo preparado para enviar el enlace desde el programa de correo de
 * quien administra, ya dirigido a la persona de contacto (a diferencia del
 * enlace de un buzón, aquí su dirección de siempre es la buena).
 */
export function mailtoBienvenida(opts: {
  email: string;
  name: string;
  clientName: string;
  brandName: string;
  url: string;
  expiresAt: number;
}): string {
  const nombre = opts.name.trim().split(/\s+/)[0] ?? '';
  const asunto = `Pon en marcha el correo de ${opts.clientName}`;
  const lineas = [
    nombre ? `Hola, ${nombre}:` : 'Hola:',
    '',
    `Ya está preparado el servicio de correo de ${opts.clientName} en ${opts.brandName}.`,
    '',
    'Con este enlace crearás tu acceso al panel y pondrás el correo en marcha paso a paso:',
    '',
    opts.url,
    '',
    'Lo que vas a hacer:',
    `- Crear tu acceso al panel con tu correo (${opts.email}) y una contraseña que elijas.`,
    '- Conectar el dominio de la empresa: te indicaremos qué registros DNS hay que añadir.',
    '- Decidir quién recibe los avisos de las direcciones obligatorias (postmaster y abuse).',
    '- Crear los buzones de tu equipo de una vez, cada uno con un enlace para que su titular lo configure.',
    '- Configurar el correo en tu móvil y en tu ordenador.',
    '',
    'Te llevará unos 15 minutos; los cambios de DNS pueden tardar algo más en aplicarse. Si lo dejas a medias, podrás continuar desde tu panel.',
    '',
    `El enlace es personal, solo se puede usar una vez y es válido hasta el ${fechaLarga(opts.expiresAt)}.`,
    '',
    'Si tienes cualquier duda, responde a este mensaje.',
    '',
    'Un saludo.',
  ];
  // La dirección va tal cual (la arroba codificada confunde a algunos
  // programas); solo se escapan los caracteres que romperían la URL.
  const para = opts.email.replace(/[?#&%\s]/g, (c) => encodeURIComponent(c));
  return `mailto:${para}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(lineas.join('\n'))}`;
}

/**
 * Destino tras aceptar: solo una ruta interna del panel. Lo propone el
 * servidor, pero una URL absoluta o «//otro-sitio» convertiría el enlace en
 * una redirección abierta.
 */
export function destinoTrasAceptar(redirect: unknown): string {
  if (typeof redirect !== 'string' || !redirect.startsWith('/')) return '/puesta-en-marcha';
  if (redirect.startsWith('//') || redirect.startsWith('/\\')) return '/puesta-en-marcha';
  return redirect;
}
