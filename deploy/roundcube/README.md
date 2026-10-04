# Roundcube en Mailway

Los dos ficheros Compose de Mailway montan en solo lectura la configuración,
los complementos `mailway_theme` y `mailway_cuentas` (incluidos en
`ROUNDCUBEMAIL_PLUGINS`) y el diagnóstico de esta carpeta.

## Configuración y diagnóstico

`mailway.php` es la configuración de Mailway para Roundcube (servidores,
complemento de contraseña, ManageSieve, marca); el compose lo monta en
`/var/roundcube/config/`.

`diagnostico/comprobar.php` es el diagnóstico de línea de órdenes que usan
`deploy/instalar.sh --comprobar` y `--probar-acceso`: abre IMAP y SMTP con la
configuración efectiva de Roundcube, verifica el certificado público del
motor y, con `--probar-acceso`, inicia sesión una sola vez con la biblioteca
IMAP de Roundcube. Los compose montan esa carpeta en `/opt/mailway`, fuera de
la raíz web y de `/var/roundcube/config/` (cuyos `.php` se cargarían como
configuración).

## Apariencia: `mailway_theme`

`mailway_theme` añade una capa visual a Elastic 1.7 mediante la API de
complementos. No modifica la autenticación, el contenido de los mensajes, los
atajos ni la estructura adaptable de Elastic. El modo oscuro conserva los
estilos nativos y no sustituye el logotipo de marca blanca configurado.

Comprueba el acceso, las carpetas, la selección y lectura de mensajes, la
redacción, los adjuntos, los contactos, los ajustes, el teclado, el móvil y el
modo oscuro antes de ofrecerlo a los clientes: la compilación de la web no
valida esta capa PHP/CSS y la prueba requiere una instancia de Roundcube.

Para volver al aspecto original, retira `mailway_theme` de la variable de
complementos y recrea solo el servicio. No hay cambios de esquema ni de datos.

## Cambio de dominio: `mailway_cuentas`

Cuando un cliente pasa de `@dominio.es` a `@dominio2.es`, el servidor de
correo sigue conociendo cada buzón por su usuario anterior (`ana@dominio.es`)
hasta que su titular pulsa «Actualizar mis dispositivos». El complemento
`mailway_cuentas` hace que el webmail funcione igual mientras tanto:

- **Al entrar** (gancho `authenticate`) pregunta al panel qué usuario
  corresponde a lo que se ha tecleado —la dirección vieja, la nueva o el
  usuario— con `POST <MAILWAY_PANEL_INTERNAL_URL>/api/webmail/cuenta` y la
  cabecera `X-Mailway-Token`, el mismo canal que el complemento de contraseña.
  Entra con ese usuario y, si el buzón ya lo cambió, traslada al nuevo la fila
  de `users` del anterior: los contactos, las identidades, las respuestas y
  las preferencias van con ella porque el `user_id` no cambia.
- **Nunca borra nada.** Si ya había una fila con el usuario vigente (alguien
  entró con él antes), se aparta renombrándola a
  `<usuario>#apartado-<user_id>`: conserva sus datos y, si hiciera falta, se
  recuperan a mano desde esa fila.
- **Tras entrar** (gancho `login_after`) pasa a la dirección vigente la
  identidad que aún tenía la anterior, conservando el nombre, la firma y las
  respuestas.

El traslado se hace antes de comprobar la contraseña: solo ocurre cuando el
panel dice que el usuario vigente del buzón es otro y lleva al mismo estado
que la siguiente entrada legítima, así que quien no conoce la contraseña solo
puede adelantarlo (ver `docs/SEGURIDAD.md`).

No necesita configuración propia: lee `MAILWAY_PANEL_INTERNAL_URL` y
`MAILWAY_WEBMAIL_TOKEN`, que los compose ya pasan al webmail. Sin alguna de
las dos no hace nada. Si el panel no responde (espera 2 segundos como
máximo), contesta algo inesperado o no conoce la dirección, se entra como
siempre; los fallos que no son un simple «no existe» quedan en el registro de
errores de Roundcube con el prefijo `mailway_cuentas:`.

Tras «Actualizar mis dispositivos», una sesión del webmail que ya estaba
abierta pide volver a entrar; al hacerlo, el complemento traslada la fila.

La prueba `pruebas/mailway_cuentas.php` usa la biblioteca y el esquema SQLite
de la imagen real de Roundcube, con el panel simulado dentro del mismo
contenedor y sin red:

```sh
docker run --rm -v "$PWD/deploy/roundcube:/opt/mailway-rc:ro" \
  roundcube/roundcubemail:1.7.x-apache php /opt/mailway-rc/pruebas/mailway_cuentas.php
```

Para desactivarlo, retira `mailway_cuentas` de `ROUNDCUBEMAIL_PLUGINS` y
recrea solo el webmail. No cambia el esquema de Roundcube.

## Aplicar los cambios

Después de actualizar el repositorio, aplica los cambios con el instalador
(`sudo bash deploy/instalar.sh --actualizar`) o recrea solo el webmail con el
mismo Compose y el mismo fichero de entorno de siempre:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.mail.yml up -d --force-recreate mailway-webmail
```

En la instalación autónoma, usa `deploy/docker-compose.standalone.yml`.
