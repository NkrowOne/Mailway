import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

/*
 * IMAP y SMTP mínimos para las pruebas contra un motor de correo de verdad
 * (panel-motor-real.test.ts): lo justo para comprobar que lo que hace el
 * panel se nota en los protocolos que usan los programas de correo.
 *
 * El motor de prueba usa su certificado autofirmado: aquí, y solo aquí, se
 * acepta sin verificar (rejectUnauthorized: false).
 */

/** Dónde escucha el motor de prueba (los puertos publicados en el anfitrión). */
export interface DestinoCorreo {
  host: string;
  /** Nombre del servidor que se envía como SNI. */
  servername: string;
  puertos: { smtp: number; smtps: number; submission: number; imaps: number };
}

export type ResultadoAcceso = 'ok' | 'rechazado';

/** Conversación por líneas sobre un socket (IMAP o SMTP). */
export class Conversacion {
  private texto = '';
  private cerrada = false;
  private espera: { patron: RegExp; resolver: (t: string) => void; rechazar: (e: Error) => void } | null = null;

  constructor(private socket: net.Socket) {
    this.escuchar(socket);
  }

  private escuchar(socket: net.Socket): void {
    socket.on('data', (d: Buffer) => {
      this.texto += d.toString('utf8');
      this.revisar();
    });
    socket.on('close', () => {
      this.cerrada = true;
      this.revisar();
    });
    socket.on('error', () => {
      this.cerrada = true;
      this.revisar();
    });
  }

  private revisar(): void {
    const e = this.espera;
    if (!e) return;
    if (e.patron.test(this.texto)) {
      const t = this.texto;
      this.texto = '';
      this.espera = null;
      e.resolver(t);
    } else if (this.cerrada) {
      this.espera = null;
      e.rechazar(new Error(`conexión cerrada sin respuesta (${JSON.stringify(this.texto.slice(-200))})`));
    }
  }

  /** Espera hasta que lo recibido cumpla el patrón y lo devuelve (y lo descarta). */
  esperar(patron: RegExp, ms = 20_000): Promise<string> {
    return new Promise((resolver, rechazar) => {
      const temporizador = setTimeout(() => {
        this.espera = null;
        rechazar(new Error(`sin respuesta en ${ms} ms (${JSON.stringify(this.texto.slice(-200))})`));
      }, ms);
      this.espera = {
        patron,
        resolver: (t) => {
          clearTimeout(temporizador);
          resolver(t);
        },
        rechazar: (err) => {
          clearTimeout(temporizador);
          rechazar(err);
        },
      };
      this.revisar();
    });
  }

  enviar(linea: string): void {
    this.socket.write(`${linea}\r\n`);
  }

  /** STARTTLS: el resto de la conversación va cifrada sobre el mismo socket. */
  async cifrar(servername: string): Promise<void> {
    const plano = this.socket;
    plano.removeAllListeners('data');
    const seguro = tls.connect({ socket: plano, rejectUnauthorized: false, servername });
    await new Promise<void>((resolve, reject) => {
      seguro.once('secureConnect', () => resolve());
      seguro.once('error', reject);
    });
    this.socket = seguro;
    this.escuchar(seguro);
  }

  cerrar(): void {
    this.socket.destroy();
  }
}

/** Entrecomilla un valor para IMAP (cadena entre comillas con escapes). */
function comillas(valor: string): string {
  return `"${valor.replace(/(["\\])/g, '\\$1')}"`;
}

/** Nombres de las carpetas de una respuesta a LIST. */
export function carpetasDeList(respuesta: string): string[] {
  const carpetas: string[] = [];
  const patron = /^\* LIST \([^)]*\) (?:"(?:[^"\\]|\\.)*"|NIL) (?:"((?:[^"\\]|\\.)*)"|([^\r\n]+))\r?$/gm;
  for (let m = patron.exec(respuesta); m; m = patron.exec(respuesta)) {
    const nombre = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? '').trim();
    if (nombre) carpetas.push(nombre);
  }
  return carpetas;
}

export class ClienteCorreo {
  constructor(private readonly destino: DestinoCorreo) {}

  private conectarTls(puerto: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = tls.connect({
        host: this.destino.host,
        port: puerto,
        rejectUnauthorized: false,
        servername: this.destino.servername,
      });
      s.once('secureConnect', () => resolve(s));
      s.once('error', reject);
    });
  }

  private conectarPlano(puerto: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: this.destino.host, port: puerto });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
  }

  /** LOGIN por IMAP en el 993: 'ok' o 'rechazado' (NO, o el motor corta). */
  async imapLogin(usuario: string, clave: string): Promise<ResultadoAcceso> {
    const c = new Conversacion(await this.conectarTls(this.destino.puertos.imaps));
    try {
      await c.esperar(/^\* OK.*\r\n/m);
      c.enviar(`a1 LOGIN ${comillas(usuario)} ${comillas(clave)}`);
      const r = await c.esperar(/^a1 (OK|NO|BAD)[^\r\n]*\r\n/m).catch((err: Error) => {
        // Una cuenta sin permiso para autenticarse (0.16): el motor corta sin responder.
        if (/cerrada/.test(err.message)) return 'a1 NO cerrada';
        throw err;
      });
      return /^a1 OK/m.test(r) ? 'ok' : 'rechazado';
    } finally {
      c.cerrar();
    }
  }

  /**
   * Mensajes con ese asunto en todas las carpetas del buzón. Todas, no solo
   * INBOX: un mensaje de un remitente desconocido puede acabar en la de
   * correo no deseado, y para la prueba lo que cuenta es que llegó al buzón.
   */
  async imapBuscar(usuario: string, clave: string, asunto: string): Promise<number> {
    const c = new Conversacion(await this.conectarTls(this.destino.puertos.imaps));
    let n = 0;
    const orden = async (comando: string): Promise<{ ok: boolean; texto: string }> => {
      n += 1;
      const etiqueta = `a${n}`;
      c.enviar(`${etiqueta} ${comando}`);
      const texto = await c.esperar(new RegExp(`^${etiqueta} (OK|NO|BAD)[^\\r\\n]*\\r\\n`, 'm'));
      return { ok: new RegExp(`^${etiqueta} OK`, 'm').test(texto), texto };
    };
    try {
      await c.esperar(/^\* OK.*\r\n/m);
      const login = await orden(`LOGIN ${comillas(usuario)} ${comillas(clave)}`);
      if (!login.ok) throw new Error(`IMAP rechaza a ${usuario}: ${login.texto.trim()}`);
      const carpetas = carpetasDeList((await orden('LIST "" "*"')).texto);
      let total = 0;
      for (const carpeta of carpetas.length > 0 ? carpetas : ['INBOX']) {
        if (!(await orden(`EXAMINE ${comillas(carpeta)}`)).ok) continue;
        const r = await orden(`SEARCH SUBJECT ${comillas(asunto)}`);
        const linea = /^\* SEARCH([^\r\n]*)/m.exec(r.texto)?.[1] ?? '';
        total += linea.trim() ? linea.trim().split(/\s+/).length : 0;
      }
      return total;
    } finally {
      c.cerrar();
    }
  }

  private async ehlo(c: Conversacion): Promise<string> {
    c.enviar('EHLO prueba.mailway.test');
    return c.esperar(/^250 [^\r\n]*\r\n/m);
  }

  private async auth(c: Conversacion, usuario: string, clave: string): Promise<ResultadoAcceso> {
    c.enviar(`AUTH PLAIN ${Buffer.from(`\0${usuario}\0${clave}`).toString('base64')}`);
    const r = await c.esperar(/^\d{3} [^\r\n]*\r\n/m).catch((err: Error) => {
      // Que el motor corte la conexión también es un rechazo; que no conteste, no.
      if (/cerrada/.test(err.message)) return '535 cerrada';
      throw err;
    });
    return /^235 /m.test(r) ? 'ok' : 'rechazado';
  }

  /**
   * Abre el envío: 465 con TLS implícito, o 587 con STARTTLS (exige que el
   * EHLO lo anuncie). Devuelve la conversación ya cifrada y el EHLO cifrado.
   */
  private async abrirEnvio(modo: 465 | 587): Promise<{ c: Conversacion; ehlo: string }> {
    const c =
      modo === 465
        ? new Conversacion(await this.conectarTls(this.destino.puertos.smtps))
        : new Conversacion(await this.conectarPlano(this.destino.puertos.submission));
    try {
      await c.esperar(/^220 [^\r\n]*\r\n/m);
      let ehlo = await this.ehlo(c);
      if (modo === 587) {
        if (!/STARTTLS/i.test(ehlo)) throw new Error(`el 587 no anuncia STARTTLS: ${ehlo.trim()}`);
        c.enviar('STARTTLS');
        await c.esperar(/^220 [^\r\n]*\r\n/m);
        await c.cifrar(this.destino.servername);
        ehlo = await this.ehlo(c);
      }
      return { c, ehlo };
    } catch (err) {
      c.cerrar();
      throw err;
    }
  }

  /** EHLO del 587 tras STARTTLS: si llega, el puerto acepta STARTTLS. */
  async ehloTrasStarttls(): Promise<string> {
    const { c, ehlo } = await this.abrirEnvio(587);
    c.enviar('QUIT');
    c.cerrar();
    return ehlo;
  }

  /** AUTH PLAIN por SMTP: 465 con TLS implícito o 587 con STARTTLS. */
  async smtpLogin(modo: 465 | 587, usuario: string, clave: string): Promise<ResultadoAcceso> {
    const { c } = await this.abrirEnvio(modo);
    try {
      return await this.auth(c, usuario, clave);
    } finally {
      c.cerrar();
    }
  }

  /**
   * Entrega un mensaje por el 25 sin autenticar, como un servidor de
   * Internet que entrega a un dominio de esta instancia.
   */
  async smtpEntregar(opciones: { de: string; para: string; asunto: string }): Promise<void> {
    const c = new Conversacion(await this.conectarPlano(this.destino.puertos.smtp));
    try {
      await c.esperar(/^220 [^\r\n]*\r\n/m);
      await this.ehlo(c);
      const paso = async (linea: string, esperado: RegExp, que: string): Promise<void> => {
        c.enviar(linea);
        const r = await c.esperar(/^\d{3} [^\r\n]*\r\n/m, 60_000);
        if (!esperado.test(r)) throw new Error(`SMTP rechaza ${que}: ${r.trim()}`);
      };
      await paso(`MAIL FROM:<${opciones.de}>`, /^250 /m, 'el remitente');
      await paso(`RCPT TO:<${opciones.para}>`, /^250 /m, 'el destinatario');
      await paso('DATA', /^354 /m, 'DATA');
      await paso(
        [
          `From: <${opciones.de}>`,
          `To: <${opciones.para}>`,
          `Subject: ${opciones.asunto}`,
          `Message-ID: <${crypto.randomUUID()}@prueba.mailway.test>`,
          `Date: ${new Date().toUTCString()}`,
          '',
          'Mensaje de la prueba del panel contra un motor real.',
          '.',
        ].join('\r\n'),
        /^250 /m,
        'el mensaje',
      );
      c.enviar('QUIT');
    } finally {
      c.cerrar();
    }
  }
}
