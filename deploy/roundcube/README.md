# Apariencia Mailway para Roundcube

`mailway_theme` añade una capa visual a Elastic 1.7 mediante la API de plugins.
Los dos archivos Compose de Mailway montan el plugin como solo lectura y lo
incluyen en `ROUNDCUBEMAIL_PLUGINS`. No modifica autenticación, contenido de
mensajes, atajos ni la estructura responsive de Elastic. El modo oscuro conserva
los estilos nativos. Tampoco sustituye el logotipo de marca blanca configurado.

Después de actualizar el repositorio, recrea únicamente el servicio webmail con
el mismo Compose y archivo de entorno que utilizas habitualmente:

```sh
docker compose -f deploy/docker-compose.mail.yml up -d --force-recreate mailway-webmail
```

En el despliegue autónomo usa `deploy/docker-compose.standalone.yml`.
Comprueba acceso, carpetas, selección de mensajes, lectura, redacción, adjuntos,
contactos, ajustes, teclado, móvil y modo oscuro antes de publicarlo a clientes.
La compilación React no valida esta capa PHP/CSS: requiere una instancia de
Roundcube para la prueba visual y funcional.

Para volver al aspecto original, elimina `mailway_theme` de la variable de
plugins y recrea solo el servicio. No hay cambios de esquema ni de datos.
