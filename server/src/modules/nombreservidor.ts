import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { lookupA, lookupPtr } from '../core/dns';
import { isInternalHost, isValidHostname, normalizeHostname } from '../core/hostnames';
import { engineConfigured, getEngine } from '../engine';
import { requireAdmin } from './auth';
import { listDomains } from './domains';
import { certificadoParaNombre } from './engineops';
import { getInstanceSettings } from './settings';

/**
 * Qué arrastra cambiar el nombre del servidor de correo, para enseñarlo antes
 * de hacerlo. Guardarlo en Ajustes cambia al momento los datos de conexión
 * que ven los titulares; aplicarlo en el motor cambia el MX que se exige a
 * todos los dominios. Y fuera del panel quedan el registro A, el PTR, el
 * certificado y las rutas de Traefik (deploy/.env), que solo actualiza el
 * instalador.
 */
export interface ImpactoCambioNombre {
  /** Nombre con el que se anuncia hoy el motor (o el de Ajustes si no responde). */
  actual: string;
  nuevo: string;
  dominios: {
    total: number;
    /** Con el MX medido hacia el nombre actual: los que habría que cambiar. */
    conMxAlActual: number;
  };
  registroA: { ips: string[] | null; ip: string; apuntaAqui: boolean | null };
  ptr: { ip: string; nombres: string[] | null; coincide: boolean | null } | null;
  certificado: { cubre: boolean | null; detalle: string };
  /** Orden del instalador que mueve el motor, el certificado y Traefik al nombre nuevo. */
  comando: string;
  /**
   * El nombre nuevo cuelga de otro dominio base que el del instalador: este
   * también traslada webmail. y panel. Con el dominio base desconocido, false.
   */
  cambiaDominioBase: boolean;
}

const consultaSchema = z.object({
  nombre: z
    .string({ required_error: 'Indica el nombre nuevo del servidor de correo.' })
    .trim()
    .max(253)
    .refine(isValidHostname, 'El nombre del servidor de correo no es válido (ej.: mail.miempresa.com).'),
});

/** Dominio base del instalador: todo menos la primera etiqueta (mail.x.com → x.com). */
function dominioBase(nombre: string): string {
  return nombre.split('.').slice(1).join('.');
}

/** ¿Algún MX medido apunta a este nombre? `found` llega como «10 mail.x.com, 20 …». */
function mxApuntaA(found: string | null, nombre: string): boolean {
  if (!found) return false;
  return found
    .toLowerCase()
    .split(/[\s,]+/)
    .some((parte) => normalizeHostname(parte) === nombre);
}

/**
 * Orden del instalador para pasar al nombre nuevo. `referencia` es el nombre
 * del que el instalador deduce hoy el dominio base (el MAIL_HOSTNAME de
 * deploy/.env): si el nuevo cuelga de otro, hay que pasarle MAILWAY_DOMINIO,
 * porque ignora un MAILWAY_MAIL_HOST que no esté directamente bajo el suyo, y
 * con él traslada también los nombres del webmail y del panel. Un nombre
 * interno (el identificador del contenedor con el que se anuncia Stalwart
 * antes de aplicarle uno) no dice nada del dominio base: se trata como
 * desconocido y no se anuncia ningún traslado.
 */
export function comandoInstalador(
  referencia: string | null,
  nuevo: string,
): { comando: string; cambiaDominioBase: boolean } {
  const base = referencia && !isInternalHost(referencia) ? dominioBase(normalizeHostname(referencia)) : '';
  const cambiaDominioBase = Boolean(base) && base !== dominioBase(nuevo);
  const variables = cambiaDominioBase
    ? `MAILWAY_DOMINIO=${dominioBase(nuevo)} MAILWAY_MAIL_HOST=${nuevo}`
    : `MAILWAY_MAIL_HOST=${nuevo}`;
  return { comando: `sudo ${variables} bash deploy/instalar.sh --actualizar`, cambiaDominioBase };
}

export async function impactoCambioNombre(nuevoEntrada: string): Promise<ImpactoCambioNombre> {
  const nuevo = normalizeHostname(nuevoEntrada);
  const instance = getInstanceSettings();
  let enMotor: string | null = null;
  if (engineConfigured()) {
    enMotor = await getEngine()
      .getRunningHostname()
      .catch(() => null);
  }
  // El MX de los dominios apunta al nombre con el que se anuncia el motor (es
  // el que pide la comprobación), que puede no ser aún el de Ajustes. Uno
  // interno (el identificador del contenedor, antes de aplicarle un nombre)
  // no es el de ningún MX: entonces se cuenta con el de Ajustes.
  const actual = normalizeHostname(enMotor && !isInternalHost(enMotor) ? enMotor : instance.mailHostname);
  // El dominio base lo decide el instalador con su MAIL_HOSTNAME, que el
  // panel recibe como MAILWAY_MAIL_HOSTNAME; sin él (panel montado a mano),
  // el nombre actual.
  const referencia = normalizeHostname(config.mailHostnameDefault) || actual;
  const ip = instance.publicIp.trim();

  const dominios = listDomains();
  const conMxAlActual = actual
    ? dominios.filter((d) =>
        (d.dnsStatus.checks ?? []).some((c) => c.type === 'MX' && mxApuntaA(c.found, actual)),
      ).length
    : 0;

  const [ips, ptrNombres, certificado] = await Promise.all([
    lookupA(nuevo),
    ip ? lookupPtr(ip) : Promise.resolve(null),
    certificadoParaNombre(nuevo),
  ]);

  return {
    actual,
    nuevo,
    dominios: { total: dominios.length, conMxAlActual },
    registroA: { ips, ip, apuntaAqui: ips === null || !ip ? null : ips.includes(ip) },
    ptr: ip
      ? {
          ip,
          nombres: ptrNombres,
          coincide: ptrNombres === null ? null : ptrNombres.some((n) => normalizeHostname(n) === nuevo),
        }
      : null,
    certificado,
    ...comandoInstalador(referencia, nuevo),
  };
}

export function registerNombreServidorRoutes(app: FastifyInstance): void {
  /** Consecuencias de cambiar el nombre del servidor de correo (Ajustes). */
  app.get('/api/settings/mail-hostname/impact', async (req) => {
    requireAdmin(req);
    const { nombre } = consultaSchema.parse(req.query ?? {});
    return await impactoCambioNombre(nombre);
  });
}
