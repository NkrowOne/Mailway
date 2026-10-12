import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeSmtpError,
  forgetTransport,
  getTransport,
  setTransportFactoryForTests,
} from '../src/modules/transactional';
import { smtpFalso } from './smtp-falso';

/*
 * Las demás pruebas de envío sustituyen nodemailer por una fábrica falsa, así
 * que no ven qué hace de verdad con las opciones de Mailway ni con lo que
 * contesta el servidor. Estas usan el transporte real (getTransport con la
 * fábrica por defecto) contra un SMTP mínimo en local: si una subida de
 * nodemailer cambia una opción, un campo del resultado o la forma de un error,
 * falla aquí y no en producción.
 */

setTransportFactoryForTests(null);

after(() => {
  setTransportFactoryForTests(null);
});

const USUARIO = 'noreply@ejemplo.com';
const CLAVE = 'clave-de-aplicacion';

function transporteHacia(puerto: number, clave = CLAVE) {
  // Se cierra con forgetTransport: el pool no puede quedar abierto al acabar la prueba.
  return getTransport(
    `key_real_${puerto}`,
    { usuario: USUARIO, remitente: USUARIO },
    clave,
    { smtpHost: '127.0.0.1', smtpPort: puerto, smtpSecure: false },
    'mail.ejemplo.com',
  );
}

test('un envío por el transporte real llega con su sobre, sus cabeceras y su adjunto', async () => {
  const smtp = smtpFalso({ usuario: USUARIO, clave: CLAVE });
  const puerto = await smtp.listen();
  try {
    const resultado = await transporteHacia(puerto).sendMail({
      from: { name: 'Tienda Ñandú', address: USUARIO },
      to: ['cliente@externo.test'],
      cc: ['copia@externo.test'],
      bcc: ['oculta@externo.test'],
      replyTo: 'soporte@ejemplo.com',
      subject: 'Código 123456 ñ',
      text: 'Tu código es 123456',
      html: '<p>Tu código es <b>123456</b></p>',
      headers: { 'X-Entity-Ref-ID': 'ref-1' },
      attachments: [
        {
          filename: 'factura.pdf',
          contentType: 'application/pdf',
          content: Buffer.from('%PDF-1.4 prueba'),
          contentDisposition: 'attachment' as const,
        },
      ],
    });

    // Lo que Mailway lee del resultado: el Message-ID que guarda en `messages`.
    assert.match(resultado.messageId, /^<[^>]+@ejemplo\.com>$/);
    assert.deepEqual([...(resultado.accepted ?? [])].sort(), [
      'cliente@externo.test',
      'copia@externo.test',
      'oculta@externo.test',
    ]);
    assert.deepEqual(resultado.rejected, []);

    assert.deepEqual(smtp.autenticaciones, [{ usuario: USUARIO, clave: CLAVE }]);
    assert.equal(smtp.mensajes.length, 1);
    const [recibido] = smtp.mensajes;
    assert.equal(recibido!.from, USUARIO);
    assert.deepEqual([...recibido!.to].sort(), [
      'cliente@externo.test',
      'copia@externo.test',
      'oculta@externo.test',
    ]);
    assert.ok(recibido!.data.includes(`Message-ID: ${resultado.messageId}`));
    assert.match(recibido!.data, /^Reply-To: soporte@ejemplo\.com\r?$/m);
    assert.match(recibido!.data, /^X-Entity-Ref-ID: ref-1\r?$/m);
    assert.match(recibido!.data, /^Cc: copia@externo\.test\r?$/m);
    assert.match(recibido!.data, /^Content-Disposition: attachment; filename=factura\.pdf\r?$/m);
    assert.match(recibido!.data, /^Content-Type: application\/pdf; name=factura\.pdf\r?$/m);
    assert.ok(recibido!.data.includes(Buffer.from('%PDF-1.4 prueba').toString('base64')));
    // Los destinatarios en copia oculta van en el sobre, nunca en las cabeceras.
    assert.doesNotMatch(recibido!.data, /^Bcc:/im);
    assert.ok(!recibido!.data.includes('oculta@externo.test'));
  } finally {
    forgetTransport(`key_real_${puerto}`);
    await smtp.close();
  }
});

test('una contraseña rechazada falla con EAUTH, 535 y el texto del servidor', async () => {
  const smtp = smtpFalso({ usuario: USUARIO, clave: CLAVE });
  const puerto = await smtp.listen();
  try {
    await assert.rejects(
      transporteHacia(puerto, 'otra-clave').sendMail({ from: USUARIO, to: 'cliente@externo.test', subject: 's', text: 'x' }),
      (err: NodeJS.ErrnoException & { responseCode?: number; command?: string }) => {
        assert.ok(err instanceof Error);
        assert.equal(err.code, 'EAUTH');
        assert.equal(err.responseCode, 535);
        assert.equal(err.command, 'AUTH PLAIN');
        // Es el texto que el panel muestra en el historial de envíos.
        assert.match(describeSmtpError(err, 'mail.ejemplo.com'), /^Invalid login: 535 5\.7\.8 /);
        return true;
      },
    );
    assert.equal(smtp.mensajes.length, 0);
  } finally {
    forgetTransport(`key_real_${puerto}`);
    await smtp.close();
  }
});

test('un destinatario rechazado: si queda alguno se envía; si no, EENVELOPE con el 550', async () => {
  const smtp = smtpFalso({ usuario: USUARIO, clave: CLAVE, rechaza: ['nadie@externo.test'] });
  const puerto = await smtp.listen();
  try {
    const transporte = transporteHacia(puerto);
    const parcial = await transporte.sendMail({
      from: USUARIO,
      to: ['cliente@externo.test', 'nadie@externo.test'],
      subject: 's',
      text: 'x',
    });
    assert.deepEqual(parcial.accepted, ['cliente@externo.test']);
    assert.deepEqual(parcial.rejected, ['nadie@externo.test']);

    await assert.rejects(
      transporte.sendMail({ from: USUARIO, to: 'nadie@externo.test', subject: 's', text: 'x' }),
      (err: NodeJS.ErrnoException & { responseCode?: number }) => {
        assert.equal(err.code, 'EENVELOPE');
        assert.equal(err.responseCode, 550);
        assert.match(describeSmtpError(err, 'mail.ejemplo.com'), /all recipients were rejected: 550 5\.1\.2/);
        return true;
      },
    );
  } finally {
    forgetTransport(`key_real_${puerto}`);
    await smtp.close();
  }
});

test('si el motor cierra la conexión nada más aceptarla, el envío falla en vez de quedarse colgado', async () => {
  // Es lo que hace Stalwart con una IP bloqueada. Con nodemailer 6.10.1 y 10.0.9
  // sendMail no se resolvía ni se rechazaba nunca: la petición de /v1/send no
  // recibía respuesta y el cupo en memoria y la reserva de Idempotency-Key
  // quedaban sin liberar. Se corrigió en la 10.0.12.
  const smtp = smtpFalso({ usuario: USUARIO, clave: CLAVE, cierraAlAceptar: true });
  const puerto = await smtp.listen();
  let temporizador: NodeJS.Timeout | undefined;
  try {
    const desenlace = await Promise.race([
      transporteHacia(puerto)
        .sendMail({ from: USUARIO, to: 'cliente@externo.test', subject: 's', text: 'x' })
        .then(
          () => 'enviado' as const,
          (err: NodeJS.ErrnoException) => err,
        ),
      new Promise<'colgado'>((resolve) => {
        temporizador = setTimeout(() => resolve('colgado'), 20_000);
      }),
    ]);
    assert.notEqual(desenlace, 'colgado', 'sendMail debe resolverse siempre (nodemailer 10.0.12 o posterior)');
    assert.notEqual(desenlace, 'enviado');
    assert.equal((desenlace as NodeJS.ErrnoException).code, 'ECONNECTION');
  } finally {
    clearTimeout(temporizador);
    // Cerrar el pool resuelve también un envío colgado (si lo hubiera).
    forgetTransport(`key_real_${puerto}`);
    await smtp.close();
  }
});
