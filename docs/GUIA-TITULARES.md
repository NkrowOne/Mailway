# Su buzón de correo: guía de uso

> **Para quien administra el correo.** Esta guía está pensada para enviarla a
> los titulares de los buzones. Antes de enviarla, sustituya
> `mail.miempresa.com`, `webmail.miempresa.com` y `panel.miempresa.com` por los
> nombres de su servidor, y adjunte a cada persona su **enlace de
> configuración** (Buzones → el buzón → Conectar dispositivos).

---

Se ha creado un buzón de correo a su nombre. Con esta guía podrá usarlo en el
móvil, en el ordenador y en el navegador.

## 1. Lo que necesita

- **Su dirección de correo**, por ejemplo `ana@suempresa.com`. Es también su
  **nombre de usuario**: escríbala siempre completa.
- **Su contraseña**, o el **enlace de configuración** que le han enviado. El
  enlace caduca a los pocos días: úselo cuanto antes.

## 2. Configurar un dispositivo con el enlace

Abra el enlace de configuración **en el dispositivo que quiere configurar**. La
página detecta el dispositivo y muestra solo los pasos que necesita. Si lo abre
en un ordenador, puede escanear con el móvil el código QR que aparece.

### iPhone o iPad

1. Abra el enlace con **Safari** (no con otro navegador).
2. Pulse el botón para descargar el perfil y, cuando se lo pregunte, pulse
   **«Permitir»**.
3. Abra **Ajustes**: arriba aparece **«Perfil descargado»**. Púlselo antes de
   8 minutos (después el perfil caduca y hay que descargarlo de nuevo).
4. Pulse **«Instalar»**, escriba el código de desbloqueo del dispositivo y, si
   se lo pide, la contraseña del buzón.

El perfil aparece como «No verificado»: es normal y se puede instalar con
seguridad.

### Mac

1. Descargue el perfil desde el enlace y ábralo.
2. Abra **Ajustes del Sistema → General → Gestión de dispositivos** (en
   versiones anteriores de macOS: **Privacidad y seguridad → Perfiles**).
3. Seleccione el perfil, pulse **«Instalar»** y siga las indicaciones.

### Android

- **Thunderbird para Android**: en la aplicación, elija importar la
  configuración y escanee el código QR que muestra el enlace. También puede
  escribir su dirección y su contraseña: se configura sola.
- **Gmail, Samsung Email u otras aplicaciones**: añada una cuenta de tipo
  **IMAP** («Otra» o «Personal (IMAP)») y copie los datos del apartado 4.

### Thunderbird (ordenador)

Añada una cuenta de correo existente y escriba su nombre, su dirección y su
contraseña. Thunderbird encuentra el resto de la configuración por sí mismo.

### Outlook

Añada la cuenta con su dirección. Si Outlook no la configura solo, elija la
configuración manual de tipo **IMAP** y copie los datos del apartado 4.

## 3. Correo web

Puede leer y enviar correo desde cualquier navegador en
**https://webmail.miempresa.com**, con su dirección completa y su contraseña.
En **Ajustes** encontrará:

- **Contraseña**: cambiar la contraseña del buzón;
- **Filtros**: ordenar el correo entrante, reenviarlo o activar un **aviso de
  ausencia** (respuesta automática durante las vacaciones).

## 4. Datos para configurar a mano

| Dato | Valor |
|---|---|
| Nombre de usuario | Su dirección completa (p. ej. `ana@suempresa.com`) |
| Correo entrante (IMAP) | `mail.miempresa.com`, puerto **993**, cifrado **SSL/TLS** |
| Correo saliente (SMTP) | `mail.miempresa.com`, puerto **465**, cifrado **SSL/TLS** |
| Alternativa de salida | `mail.miempresa.com`, puerto **587**, cifrado **STARTTLS** |
| Autenticación | Contraseña normal, con el mismo usuario y contraseña en la entrada y en la salida |

Use el puerto 587 solo si su red bloquea el 465.

## 5. «Mi buzón»

En **https://panel.miempresa.com/mi-buzon** puede entrar con su dirección y su
contraseña para:

- ver sus datos de conexión y el espacio que ocupa su correo;
- descargar el perfil para iPhone, iPad o Mac;
- **cambiar su contraseña** (al menos 10 caracteres, distinta de la actual);
- crear y revocar **contraseñas de aplicación**.

### Contraseñas de aplicación

Una contraseña de aplicación es una contraseña adicional para **un solo
dispositivo o programa** (el móvil, la tableta, un programa de facturación…).
Se recomiendan porque:

- si pierde el móvil, basta con **revocar** su contraseña de aplicación: los
  demás dispositivos siguen funcionando y su contraseña principal no corre
  peligro;
- al cambiar su contraseña principal, los dispositivos configurados con
  contraseñas de aplicación **no** se desconectan.

La contraseña de aplicación se muestra una sola vez: cópiela en el dispositivo
en ese momento. No sirve para entrar en «Mi buzón» ni para cambiar la
contraseña principal.

## 6. Preguntas frecuentes

**He cambiado la contraseña y el móvil ha dejado de recibir correo.** Los
dispositivos configurados con la contraseña principal necesitan la nueva.
Escríbala en el dispositivo o, mejor, configúrelo con una contraseña de
aplicación.

**He perdido el móvil.** Entre en «Mi buzón» y revoque la contraseña de
aplicación de ese móvil. Si lo había configurado con la contraseña principal,
cámbiela.

**«Mi buzón» dice que hay demasiados intentos.** Tras varios intentos fallidos
el acceso se bloquea 15 minutos para proteger su buzón. Espere y vuelva a
intentarlo con cuidado.

**El enlace de configuración dice que no es válido.** Ha caducado o ya no está
activo. Solicite uno nuevo a la persona que administra el correo.

**El dispositivo avisa de un problema con el certificado de seguridad.** No
acepte el aviso. Comuníquelo a la persona que administra el correo.

**Su buzón está suspendido.** Póngase en contacto con la persona que
administra el correo.

## 7. Recomendaciones de seguridad

- No comparta su contraseña con nadie; tampoco la envíe por correo.
- Use una contraseña larga y distinta de la de otros servicios.
- Si le llega un mensaje que le pide la contraseña, aunque parezca de su
  empresa, no responda: nadie del servicio se la pedirá nunca.
- Tras configurar sus dispositivos, pulse **«Ya lo he configurado»** en la
  página del enlace: si el enlace incluía su contraseña, se borra.
