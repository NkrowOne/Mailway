import type { SincronizacionCorreoWeb } from './api';

/*
  Correo web de cada cliente: Roundcube (el predeterminado) o el correo web
  nuevo (Bulwark, beta), y la marca de cada cliente para este último. Tipos
  de GET /api/clients/:id/webmail y textos que comparten la ficha del
  cliente, «Marca blanca» y el resumen.
*/

export type MotorCorreoWeb = 'roundcube' | 'bulwark';

export const HUECOS_IMAGEN = ['logoClaro', 'logoOscuro', 'favicon', 'icono'] as const;
export type HuecoImagen = (typeof HUECOS_IMAGEN)[number];

export interface ImagenMarca {
  tipo: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: number;
  ancho: number;
  alto: number;
  actualizada: number;
  /** Para la vista previa (con la sesión del panel); cambia con cada versión. */
  url: string;
}

export interface MarcaCorreoWeb {
  nombre: string;
  nombreCorto: string;
  empresa: string;
  privacidadUrl: string;
  avisoLegalUrl: string;
  nombrePorDefecto: string;
  actualizada: number | null;
  imagenes: Record<HuecoImagen, ImagenMarca | null>;
}

export interface EstadoCorreoWeb {
  /** Lo elegido. */
  motor: MotorCorreoWeb;
  /** Lo que se sirve de verdad (Bulwark solo si está disponible y el motor es 0.16). */
  enServicio: MotorCorreoWeb;
  webmails: { hostname: string; status: 'pending_dns' | 'issuing' | 'active' | 'error' }[];
  marca: MarcaCorreoWeb;
  /** Solo para la administración. */
  bulwark?: {
    configurado: boolean;
    disponible: boolean;
    motivo: string | null;
    api: 'rest015' | 'jmap016' | 'demo' | null;
    /** null: no se ha podido averiguar la versión del motor. */
    motor016: boolean | null;
  };
  sincronizacion?: SincronizacionCorreoWeb | null;
}

export const NOMBRE_MOTOR: Record<MotorCorreoWeb, string> = {
  roundcube: 'Roundcube',
  bulwark: 'Correo web nuevo (beta)',
};

/** Tamaño máximo de cada imagen (el mismo que comprueba el servidor). */
export const MAX_IMAGEN_BYTES = 512 * 1024;
export const TIPOS_IMAGEN = ['image/png', 'image/jpeg', 'image/webp'];

export const IMAGENES: Record<HuecoImagen, { titulo: string; ayuda: string; fondoOscuro?: boolean }> = {
  logoClaro: {
    titulo: 'Logotipo',
    ayuda: 'En la pantalla de acceso y en la barra del correo web. Mejor apaisado y con fondo transparente.',
  },
  logoOscuro: {
    titulo: 'Logotipo para el modo oscuro',
    ayuda: 'Opcional. Sin él, en el modo oscuro se usa el logotipo normal.',
    fondoOscuro: true,
  },
  favicon: {
    titulo: 'Icono de la pestaña',
    ayuda: 'El que muestra el navegador junto al título. Cuadrado, de 32 × 32 píxeles o más.',
  },
  icono: {
    titulo: 'Icono de la aplicación',
    ayuda: 'Al instalar el correo web en el móvil o el ordenador. Cuadrado, de 512 × 512 píxeles. Sin él, se usa el de la pestaña.',
  },
};

/**
 * Por qué no se puede elegir el correo web nuevo (para la administración), o
 * null si se puede. Volver a Roundcube siempre se puede.
 */
export function motivoSinBulwark(estado: EstadoCorreoWeb): string | null {
  const b = estado.bulwark;
  if (!b) return null;
  if (!b.disponible) return b.motivo ?? 'El correo web nuevo no está instalado en este servidor.';
  if (b.api === 'demo') return 'No funciona con el motor de demostración.';
  if (b.motor016 === false) {
    return 'El servidor de correo es una versión anterior a Stalwart 0.16. Se podrá elegir tras actualizarlo.';
  }
  if (b.motor016 === null) {
    return 'No se ha podido comprobar la versión del servidor de correo. Vuelve a intentarlo cuando responda.';
  }
  return null;
}

/** Elegido pero servido con Roundcube: por qué (para la administración). */
export function motivoSinServicio(estado: EstadoCorreoWeb): string {
  const b = estado.bulwark;
  if (b && !b.disponible) return b.motivo ?? 'El correo web nuevo no está disponible en este servidor.';
  if (b && b.api === 'demo') return 'El motor de demostración no lo admite.';
  if (b && b.motor016 === false) return 'El servidor de correo no es Stalwart 0.16.';
  return 'El correo web nuevo no está disponible ahora mismo.';
}

/** Resumen corto de deploy/bulwark/README.md («Frente a Roundcube»). */
export const SE_GANA = [
  'Interfaz actual, con hilos, plantillas y envío programado.',
  'Calendario y contactos del servidor, compartidos con el móvil y el ordenador.',
  'Aplicación instalable y avisos al momento.',
  'La marca del cliente en su webmail: nombre, logotipos e iconos.',
];

export const SE_PIERDE = [
  'El cierre de la sesión por inactividad y el aviso claro de contraseña cambiada.',
  'El cambio de contraseña dentro del correo web: se hace en «Mi buzón».',
  'Las libretas, identidades y firmas de Roundcube, que no pasan solas.',
  'El español por defecto en navegadores configurados en otro idioma.',
];

/** Datos de una imagen para su vista previa: «PNG · 512 × 512 · 24 KB». */
export function resumenImagen(imagen: ImagenMarca): string {
  const tipo = imagen.tipo.slice('image/'.length).toUpperCase();
  const kb = Math.max(1, Math.round(imagen.bytes / 1024));
  return `${tipo} · ${imagen.ancho} × ${imagen.alto} · ${kb} KB`;
}
