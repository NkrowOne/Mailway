import net from 'node:net';
import { dnsOffline } from './dns';

/**
 * Comprobación del puerto 25 de salida: sin él el servidor no entrega correo
 * a otros servidores, y muchos proveedores (OVH, Hetzner, AWS…) lo bloquean
 * por defecto. Se mide abriendo una conexión TCP a los servidores de entrada
 * de Gmail y Outlook, igual que el instalador; basta con que uno acepte la
 * conexión. No se envía nada: se cierra en cuanto conecta.
 *
 * Tres estados, no dos: un DNS que no resuelve los destinos no dice nada del
 * puerto, y darlo por bloqueado enseñaría una avería que no existe.
 */
export type EstadoPuerto25 = 'abierto' | 'bloqueado' | 'desconocido';

export interface ResultadoPuerto25 {
  estado: EstadoPuerto25;
  detalle: string;
  comprobadoEn: number;
}

export interface DestinoSmtp {
  host: string;
  port: number;
}

const DESTINOS: DestinoSmtp[] = [
  { host: 'gmail-smtp-in.l.google.com', port: 25 },
  { host: 'outlook-com.olc.protection.outlook.com', port: 25 },
];

const TIEMPO_LIMITE_MS = 6000;

/** Errores de resolución: el destino no tiene IP conocida, el puerto no se ha probado. */
const ERRORES_DNS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'ENODATA']);

type Intento = 'conecta' | 'no-conecta' | 'sin-dns';

function intentar(destino: DestinoSmtp, tiempoLimiteMs: number): Promise<Intento> {
  return new Promise((resolve) => {
    let hecho = false;
    // Solo IPv4: un contenedor sin IPv6 fallaría al instante por la v6 y se
    // tomaría por un puerto bloqueado.
    const socket = net.connect({ host: destino.host, port: destino.port, family: 4 });
    const terminar = (resultado: Intento) => {
      if (hecho) return;
      hecho = true;
      clearTimeout(reloj);
      socket.destroy();
      resolve(resultado);
    };
    const reloj = setTimeout(() => terminar('no-conecta'), tiempoLimiteMs);
    socket.once('connect', () => terminar('conecta'));
    socket.once('error', (err: NodeJS.ErrnoException) =>
      terminar(err.code && ERRORES_DNS.has(err.code) ? 'sin-dns' : 'no-conecta'),
    );
  });
}

/** Última medición: abrir Entregabilidad varias veces seguidas no repite la prueba. */
let cache: ResultadoPuerto25 | null = null;
const VIGENCIA_MS = 10 * 60_000;

/**
 * Mide el puerto 25 de salida. `destinos` solo lo indican las pruebas (un
 * servidor local); sin él, en modo sin red no se sale a Internet.
 */
export async function comprobarPuerto25(
  opciones: { destinos?: DestinoSmtp[]; tiempoLimiteMs?: number; sinCache?: boolean } = {},
): Promise<ResultadoPuerto25> {
  const propios = opciones.destinos !== undefined;
  if (!propios && dnsOffline()) {
    return { estado: 'desconocido', detalle: 'Comprobación desactivada (modo sin red).', comprobadoEn: Date.now() };
  }
  if (!propios && !opciones.sinCache && cache && Date.now() - cache.comprobadoEn < VIGENCIA_MS) return cache;

  const destinos = opciones.destinos ?? DESTINOS;
  const intentos = await Promise.all(
    destinos.map((d) => intentar(d, opciones.tiempoLimiteMs ?? TIEMPO_LIMITE_MS)),
  );
  let resultado: ResultadoPuerto25;
  if (intentos.includes('conecta')) {
    resultado = {
      estado: 'abierto',
      detalle: 'El servidor puede conectar con otros servidores de correo por el puerto 25.',
      comprobadoEn: Date.now(),
    };
  } else if (intentos.includes('no-conecta')) {
    resultado = {
      estado: 'bloqueado',
      detalle: `No se ha podido conectar por el puerto 25 con ${destinos.map((d) => d.host).join(' ni con ')}.`,
      comprobadoEn: Date.now(),
    };
  } else {
    resultado = {
      estado: 'desconocido',
      detalle: 'No se han podido resolver los servidores de prueba: el DNS del servidor no responde.',
      comprobadoEn: Date.now(),
    };
  }
  if (!propios) cache = resultado;
  return resultado;
}
