# Apariencia Mailway para Roundcube

`mailway_theme` añade una capa visual a Elastic 1.7 mediante la API de
complementos. Los dos ficheros Compose de Mailway montan el complemento en
solo lectura y lo incluyen en `ROUNDCUBEMAIL_PLUGINS`. No modifica la
autenticación, el contenido de los mensajes, los atajos ni la estructura
adaptable de Elastic. El modo oscuro conserva los estilos nativos y no
sustituye el logotipo de marca blanca configurado.

`mailway.php` es la configuración de Mailway para Roundcube (servidores,
complemento de contraseña, ManageSieve, marca); el compose lo monta en
`/var/roundcube/config/`.

Después de actualizar el repositorio, aplique los cambios con el instalador
(`sudo bash deploy/instalar.sh --actualizar`) o recree solo el webmail con el
mismo Compose y el mismo fichero de entorno de siempre:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.mail.yml up -d --force-recreate mailway-webmail
```

En la instalación autónoma, use `deploy/docker-compose.standalone.yml`.
Compruebe el acceso, las carpetas, la selección y lectura de mensajes, la
redacción, los adjuntos, los contactos, los ajustes, el teclado, el móvil y el
modo oscuro antes de ofrecerlo a los clientes: la compilación de la web no
valida esta capa PHP/CSS y la prueba requiere una instancia de Roundcube.

Para volver al aspecto original, retire `mailway_theme` de la variable de
complementos y recree solo el servicio. No hay cambios de esquema ni de datos.
