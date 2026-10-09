import { config } from '../config';
import { db } from '../core/db';
import { ultimaApiDelMotor } from '../engine/apiconocida';

/*
 * Correo web de cada cliente: Roundcube (el predeterminado) o Bulwark (el
 * correo web nuevo, beta). Aquí solo lo que hay que saber deprisa y sin
 * esperar a nadie: si Bulwark está instalado, qué ha elegido cada cliente y
 * a qué clientes se les sirve de verdad. Lo usan las rutas de Traefik
 * (whitelabel.ts), los ajustes recomendados del motor (engineops.ts) y la
 * sincronización de la marca (correoweb.ts). No importa ningún otro módulo
 * del panel para que todos puedan importarlo sin ciclos.
 */

export type MotorCorreoWeb = 'roundcube' | 'bulwark';

export interface EstadoBulwark {
  /** Hay al menos una de sus variables: alguien ha empezado a instalarlo. */
  configurado: boolean;
  /** Están las tres y son válidas: se puede elegir para un cliente. */
  disponible: boolean;
  /** Por qué no está disponible, para la administración (null si lo está). */
  motivo: string | null;
}

function urlHttp(valor: string): boolean {
  try {
    const url = new URL(valor);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !!url.hostname;
  } catch {
    return false;
  }
}

/**
 * Bulwark está disponible con sus tres variables (config.ts): la API de
 * administración, su contraseña y el destino de Traefik. Con una sola que
 * falte no se ofrece: sin la API no habría marca ni política, y sin destino
 * los nombres de sus clientes no tendrían adónde ir.
 */
export function estadoBulwark(): EstadoBulwark {
  const { url, adminPassword, backendUrl } = config.bulwark;
  const configurado = Boolean(url || adminPassword.trim() || backendUrl);
  const faltan = [
    !url && 'MAILWAY_BULWARK_URL',
    !adminPassword.trim() && 'MAILWAY_BULWARK_ADMIN_PASSWORD',
    !backendUrl && 'MAILWAY_BULWARK_BACKEND_URL',
  ].filter((v): v is string => Boolean(v));
  if (faltan.length > 0) {
    return {
      configurado,
      disponible: false,
      motivo: configurado
        ? `La instalación del correo web nuevo está incompleta: falta ${faltan.join(', ')} en el entorno del panel.`
        : 'El correo web nuevo no está instalado en este servidor.',
    };
  }
  if (!urlHttp(url)) {
    return {
      configurado,
      disponible: false,
      motivo: 'MAILWAY_BULWARK_URL no es una dirección http(s):// válida (sin usuario ni contraseña).',
    };
  }
  if (!urlHttp(backendUrl)) {
    return {
      configurado,
      disponible: false,
      motivo: 'MAILWAY_BULWARK_BACKEND_URL no es una dirección http(s):// válida (sin usuario ni contraseña).',
    };
  }
  return { configurado, disponible: true, motivo: null };
}

export function bulwarkDisponible(): boolean {
  return estadoBulwark().disponible;
}

/** Lo que ha elegido el cliente (lo guardado), se pueda servir o no. */
export function motorCorreoWebDe(clientId: string): MotorCorreoWeb {
  const row = db.prepare('SELECT webmail_motor FROM clients WHERE id = ?').get(clientId) as
    | { webmail_motor: MotorCorreoWeb }
    | undefined;
  return row?.webmail_motor === 'bulwark' ? 'bulwark' : 'roundcube';
}

/**
 * ¿Se sirve el correo web nuevo? Hace falta Bulwark disponible y Stalwart
 * 0.16 (la última versión conocida del motor: no se espera a preguntarle).
 * Si deja de estar disponible o el motor vuelve a 0.15, los webmail de sus
 * clientes vuelven a Roundcube: nunca se quedan sin destino.
 */
export function bulwarkEnServicio(): boolean {
  return bulwarkDisponible() && ultimaApiDelMotor() === 'jmap016';
}

/** Clientes cuyos webmail propios van ahora a Bulwark. */
export function clientesConBulwarkEnServicio(): Set<string> {
  if (!bulwarkEnServicio()) return new Set();
  const filas = db.prepare(`SELECT id FROM clients WHERE webmail_motor = 'bulwark'`).all() as { id: string }[];
  return new Set(filas.map((f) => f.id));
}

/** El correo web que usan de verdad los webmail propios del cliente. */
export function motorCorreoWebEnServicio(clientId: string): MotorCorreoWeb {
  return motorCorreoWebDe(clientId) === 'bulwark' && bulwarkEnServicio() ? 'bulwark' : 'roundcube';
}

/**
 * ¿Necesita el motor CORS permisivo? Solo mientras Bulwark esté disponible y
 * algún cliente lo tenga elegido: su navegador habla JMAP con el motor desde
 * webmail.<dominio>, otro origen. Si no, se quita (ajustes recomendados).
 */
export function corsPermisivoNecesario(): boolean {
  if (!bulwarkDisponible()) return false;
  return Boolean(db.prepare(`SELECT 1 FROM clients WHERE webmail_motor = 'bulwark' LIMIT 1`).get());
}
