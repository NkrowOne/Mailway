# Correo desde un dominio de Skyway

El asistente de Skyway crea correo para el dominio raíz de un servicio, por
ejemplo `codanuancelegal.com`. Propone los buzones `info`, `no-reply` y
`postmaster`, deja elegir otras cuentas y prepara
`https://webmail.codanuancelegal.com`. No sustituye la web del dominio raíz.

## Conectar las instancias una vez

Actualizar ambos proyectos: esta integración necesita la versión de Skyway
con el asistente Mailway y la versión de Mailway con sincronización de hostname.
El motor Stalwart, Roundcube y el proxy deben estar operativos antes de dar
de alta clientes; el modo demo no crea correo real.

1. Generar un secreto con `openssl rand -hex 32`.
2. En las variables del **panel Mailway** en Skyway, definir:

   ```dotenv
   MAILWAY_SKYWAY_TOKEN=<secreto generado>
   MAILWAY_SKYWAY_PLAN_ID=plan_basico
   MAILWAY_MAIL_HOSTNAME=mail.tuproveedor.com
   MAILWAY_PUBLIC_IP=<IP pública del servidor>
   MAILWAY_WEBMAIL_BACKEND_URL=http://mailway-webmail:80
   MAILWAY_TRAEFIK_CERTRESOLVER=le
   ```

   El hostname es la identidad pública del **motor**, no el dominio del panel
   ni el de webmail. Se sincroniza con Stalwart y sirve de destino MX para
   todos los clientes. Debe resolver a la IP del motor sin proxy Cloudflare.
   Mantener `MAIL_HOSTNAME` del stack de correo alineado, incluidos certificados
   IMAP/SMTP y PTR. Las credenciales `STALWART_*` siguen siendo las del motor.

3. En el `.env` del **servidor Skyway**, definir:

   ```dotenv
   MAILWAY_URL=https://panel.tuproveedor.com
   MAILWAY_INTEGRATION_TOKEN=<el mismo secreto>
   MAILWAY_INSTANCE_ID=skyway-produccion
   ```

   Se admite también una URL HTTP interna en la red privada `skyway-edge`.
   Usar HTTPS al cruzar una red pública. La URL corresponde al panel Mailway,
   no a Roundcube ni a la API de Stalwart. El identificador de instancia debe
   ser estable y distinto si varias instalaciones usan el mismo Mailway.

4. Redesplegar el panel Mailway. Actualizar y recrear Skyway **y Traefik**
   usando el `docker-compose.yml` actualizado de Skyway. El proxy consulta
   `/api/mailway/traefik` cada 30 segundos con una cabecera autenticada y
   Skyway obtiene las rutas desde Mailway. No se necesita añadir cada dominio
   a mano ni un token Cloudflare. Si ya configuraste un proveedor HTTP directo
   a Mailway, sustituirlo por este: Traefik solo admite un proveedor HTTP.
5. Comprobar que Traefik y `mailway-webmail` comparten `skyway-edge`, que
   Let's Encrypt está configurado y que Mailway muestra actividad del proxy.

## Alta por dominio

En Skyway: servicio → Ajustes → Dominios. Añadir el dominio raíz y guardar
la configuración de la web. Abrir **Configurar correo**:

1. Elegir el dominio raíz guardado. Se admiten sufijos como `.co.uk`; no se
   confunden con `www`, el sufijo público o un hostname Docker.
2. Elegir cuentas y guardar sus contraseñas. `postmaster` se conserva para
   avisos técnicos; `no-reply` es un buzón normal y también puede recibir.
   Las contraseñas no se guardan en Skyway ni se incluyen en el archivo DNS.
3. Crear correo: Mailway crea un cliente para esa vinculación servicio/dominio,
   aplica el plan, genera DKIM y prepara el dominio personalizado de webmail.
4. Descargar el archivo e importarlo en Cloudflare → DNS → Import and Export.
   Revisar MX/SPF anteriores antes de importar; la importación no los elimina.
   Mantener un único SPF y los destinos de correo en **DNS only**.
5. Pulsar **Comprobar conexión**. El DNS público correcto habilita la ruta;
   Traefik emite el certificado. Comprobar de nuevo tras la propagación o la
   emisión. El vigilante de Mailway también continúa las comprobaciones.

El archivo incluye los registros de correo y el CNAME `webmail` hacia el
hostname público del motor. Excluye A/AAAA/CNAME del dominio raíz para conservar
el alojamiento web; los registros de la web se indican en el editor de dominios
de Skyway. El dominio debe usar Cloudflare como DNS autoritativo para que su
importación tenga efecto.

## Reintentos y acceso

- El alta se puede reintentar: conserva buzones existentes y sus contraseñas;
  continúa con los que falten. Nunca restablece contraseñas por repetir el asistente.
- Los límites de plan y la suspensión del cliente se aplican en Mailway.
- Solo administradores y propietarios del workspace pueden usar el asistente.
  Skyway fija la identidad del servicio en servidor y no entrega el secreto al navegador.
- Un dominio que ya exista en otra vinculación o cliente se rechaza. No se
  transfieren dominios existentes automáticamente: un administrador debe revisarlos.
- Cambiar el hostname en las variables actualiza la identidad del motor y las
  siguientes exportaciones; no modifica registros ya publicados en Cloudflare.
- El asistente confirma DNS y HTTPS, no autentica en IMAP ni envía mensajes de
  prueba. Entrar en Roundcube con el correo completo y probar envío/recepción.
  Un error IMAP requiere revisar conectividad, puerto y certificado del motor.
- Si el proceso o la conexión caen justo después de una creación en Stalwart y
  antes de guardarla en SQLite, puede quedar un recurso huérfano en el motor.
  Revisarlo antes de eliminarlo o repetir el alta; nunca se adopta una cuenta
  desconocida ni se cambia su contraseña automáticamente.
