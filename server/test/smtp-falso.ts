import net from 'node:net';

/*
 * Servidor SMTP mínimo para probar el transporte REAL de nodemailer. Las demás
 * pruebas de envío sustituyen nodemailer por una fábrica falsa
 * (setTransportFactoryForTests) y no comprueban qué hace de verdad con las
 * opciones de Mailway ni con lo que contesta el servidor.
 *
 * Habla lo justo: EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA, RSET y QUIT, sin
 * STARTTLS, PIPELINING ni 8BITMIME, y anota lo que recibe.
 */

export interface OpcionesSmtpFalso {
  /** Credenciales que acepta AUTH PLAIN; cualquier otra recibe 535. */
  usuario: string;
  clave: string;
  /** Destinatarios que rechaza con 550 (buzón inexistente). */
  rechaza?: string[];
  /**
   * Cierra la conexión nada más aceptarla, sin saludo: lo que hace Stalwart
   * con una IP que ha bloqueado.
   */
  cierraAlAceptar?: boolean;
}

export interface MensajeSmtpRecibido {
  from: string;
  /** Destinatarios aceptados (el sobre, no las cabeceras). */
  to: string[];
  /** Contenido de DATA tal como llegó, con CRLF. */
  data: string;
}

export interface SmtpFalso {
  mensajes: MensajeSmtpRecibido[];
  autenticaciones: { usuario: string; clave: string }[];
  /** Conexiones aceptadas hasta ahora. */
  conexiones(): number;
  /** Arranca en un puerto libre de 127.0.0.1 y lo devuelve. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

/** «<a@b.c>» o «a@b.c» de un argumento MAIL FROM / RCPT TO. */
function direccionDe(argumento: string): string {
  const m = /<([^>]*)>/.exec(argumento);
  return (m ? m[1]! : argumento.split(/\s+/)[0] ?? '').trim();
}

export function smtpFalso(opciones: OpcionesSmtpFalso): SmtpFalso {
  const mensajes: MensajeSmtpRecibido[] = [];
  const autenticaciones: { usuario: string; clave: string }[] = [];
  const rechaza = new Set((opciones.rechaza ?? []).map((a) => a.toLowerCase()));
  const sockets = new Set<net.Socket>();
  let conexiones = 0;

  const server = net.createServer((socket) => {
    conexiones += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // El cliente puede cortar en cualquier momento: no es un fallo del servidor falso.
    socket.on('error', () => undefined);
    if (opciones.cierraAlAceptar) {
      socket.end();
      return;
    }

    const responder = (linea: string) => socket.write(`${linea}\r\n`);
    let buffer = '';
    let enDatos = false;
    let esperaClave = false;
    let datos = '';
    let from = '';
    let to: string[] = [];

    const comprobarClave = (b64: string) => {
      const [, usuario = '', clave = ''] = Buffer.from(b64, 'base64').toString('utf8').split('\0');
      autenticaciones.push({ usuario, clave });
      if (usuario === opciones.usuario && clave === opciones.clave) responder('235 2.7.0 Autenticado');
      else responder('535 5.7.8 Credenciales no válidas.');
    };

    responder('220 smtp-falso ESMTP');
    socket.on('data', (trozo) => {
      buffer += trozo.toString('latin1');
      for (;;) {
        if (enDatos) {
          const fin = buffer.indexOf('\r\n.\r\n');
          if (fin < 0) return;
          datos += buffer.slice(0, fin);
          buffer = buffer.slice(fin + 5);
          enDatos = false;
          mensajes.push({ from, to, data: datos });
          responder('250 2.0.0 En cola');
          continue;
        }
        const salto = buffer.indexOf('\r\n');
        if (salto < 0) return;
        const linea = buffer.slice(0, salto);
        buffer = buffer.slice(salto + 2);
        if (esperaClave) {
          esperaClave = false;
          comprobarClave(linea);
          continue;
        }
        const [orden = '', ...resto] = linea.split(' ');
        const argumento = resto.join(' ');
        switch (orden.toUpperCase()) {
          case 'EHLO':
          case 'HELO':
            responder('250-smtp-falso');
            responder('250 AUTH PLAIN');
            break;
          case 'AUTH': {
            const [, b64] = argumento.split(' ');
            if (b64) comprobarClave(b64);
            else {
              esperaClave = true;
              responder('334 ');
            }
            break;
          }
          case 'MAIL':
            from = direccionDe(argumento.replace(/^FROM:/i, ''));
            to = [];
            datos = '';
            responder('250 2.1.0 Remitente aceptado');
            break;
          case 'RCPT': {
            const destino = direccionDe(argumento.replace(/^TO:/i, ''));
            if (rechaza.has(destino.toLowerCase())) {
              responder('550 5.1.2 Mailbox does not exist.');
            } else {
              to.push(destino);
              responder('250 2.1.5 Destinatario aceptado');
            }
            break;
          }
          case 'DATA':
            if (to.length === 0) {
              responder('554 5.5.1 Sin destinatarios');
            } else {
              enDatos = true;
              responder('354 Adelante');
            }
            break;
          case 'RSET':
            from = '';
            to = [];
            datos = '';
            responder('250 2.0.0 Reiniciado');
            break;
          case 'QUIT':
            responder('221 2.0.0 Adiós');
            socket.end();
            break;
          default:
            responder('250 2.0.0 Correcto');
        }
      }
    });
  });

  return {
    mensajes,
    autenticaciones,
    conexiones: () => conexiones,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
      }),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
