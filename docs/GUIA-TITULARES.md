# Tu buzón de correo: guía de uso

> **Para quien administra el correo.** Esta guía está pensada para enviarla a
> los titulares de los buzones. Antes de enviarla, sustituye
> `mail.miempresa.com`, `webmail.miempresa.com` y `panel.miempresa.com` por los
> nombres de tu servidor, y adjunta a cada persona su **enlace de
> configuración** (Buzones → el buzón → Conectar dispositivos).

---

Se ha creado un buzón de correo a tu nombre. Con esta guía podrás usarlo en el
móvil, en el ordenador y en el navegador.

## 1. Lo que necesitas

- **Tu dirección de correo**, por ejemplo `ana@tuempresa.com`. Es también tu
  **nombre de usuario**: escríbela siempre completa.
- **Tu contraseña**, o el **enlace de configuración** que te han enviado. El
  enlace caduca a los pocos días: úsalo cuanto antes.

## 2. Configurar un dispositivo con el enlace

Abre el enlace de configuración **en el dispositivo que quieres configurar**. La
página detecta el dispositivo y muestra solo los pasos que necesita. Si lo abres
en un ordenador, puedes escanear con el móvil el código QR que aparece.

### iPhone o iPad

1. Abre el enlace con **Safari** (no con otro navegador).
2. Pulsa el botón para descargar el perfil y, cuando te lo pregunte, pulsa
   **«Permitir»**.
3. Abre **Ajustes**: arriba aparece **«Perfil descargado»**. Púlsalo antes de
   8 minutos (después el perfil caduca y hay que descargarlo de nuevo).
4. Pulsa **«Instalar»**, escribe el código de desbloqueo del dispositivo y, si
   te lo pide, la contraseña del buzón.

El perfil aparece como «No verificado»: es normal y se puede instalar con
seguridad.

### Mac

1. Descarga el perfil desde el enlace y ábrelo.
2. Abre **Ajustes del Sistema → General → Gestión de dispositivos** (en
   versiones anteriores de macOS: **Privacidad y seguridad → Perfiles**).
3. Selecciona el perfil, pulsa **«Instalar»** y sigue las indicaciones.

### Android

- **Thunderbird para Android**: en la aplicación, elige importar la
  configuración y escanea el código QR que muestra el enlace. También puedes
  escribir tu dirección y tu contraseña: se configura sola.
- **Gmail, Samsung Email u otras aplicaciones**: añade una cuenta de tipo
  **IMAP** («Otra» o «Personal (IMAP)») y copia los datos del apartado 4.

### Thunderbird (ordenador)

Añade una cuenta de correo existente y escribe tu nombre, tu dirección y tu
contraseña. Thunderbird encuentra el resto de la configuración por sí mismo.

### Outlook

Añade la cuenta con tu dirección. Si Outlook no la configura solo, elige la
configuración manual de tipo **IMAP** y copia los datos del apartado 4.

## 3. Correo web

Puedes leer y enviar correo desde cualquier navegador en
**https://webmail.miempresa.com**, con tu dirección completa y tu contraseña.
En **Ajustes** encontrarás:

- **Contraseña**: cambiar la contraseña del buzón;
- **Filtros**: ordenar el correo entrante, reenviarlo o activar un **aviso de
  ausencia** (respuesta automática durante las vacaciones).

## 4. Datos para configurar a mano

| Dato | Valor |
|---|---|
| Nombre de usuario | Tu dirección completa (p. ej. `ana@tuempresa.com`) |
| Correo entrante (IMAP) | `mail.miempresa.com`, puerto **993**, cifrado **SSL/TLS** |
| Correo saliente (SMTP) | `mail.miempresa.com`, puerto **465**, cifrado **SSL/TLS** |
| Alternativa de salida | `mail.miempresa.com`, puerto **587**, cifrado **STARTTLS** |
| Autenticación | Contraseña normal, con el mismo usuario y contraseña en la entrada y en la salida |

Usa el puerto 587 solo si tu red bloquea el 465.

## 5. «Mi buzón»

En **https://panel.miempresa.com/mi-buzon** puedes entrar con tu dirección y tu
contraseña para:

- ver tus datos de conexión y el espacio que ocupa tu correo;
- descargar el perfil para iPhone, iPad o Mac;
- **cambiar tu contraseña** (al menos 10 caracteres, distinta de la actual);
- crear y revocar **contraseñas de aplicación**.

### Contraseñas de aplicación

Una contraseña de aplicación es una contraseña adicional para **un solo
dispositivo o programa** (el móvil, la tableta, un programa de facturación…).
Se recomiendan porque:

- si pierdes el móvil, basta con **revocar** la contraseña de aplicación de ese
  móvil: los demás dispositivos siguen funcionando y tu contraseña principal no
  corre peligro;
- al cambiar tu contraseña principal, los dispositivos configurados con
  contraseñas de aplicación **no** se desconectan.

La contraseña de aplicación se muestra una sola vez: cópiala en el dispositivo
en ese momento. No sirve para entrar en «Mi buzón» ni para cambiar la
contraseña principal.

Si la contraseña es para una web o una aplicación que envía correo (una tienda
online, un formulario, un programa propio), pulsa **Ver las variables para una
web o una aplicación**: aparecen los datos listos para copiar en su
configuración (`.env`, Node, Laravel o Django). Tampoco se vuelven a mostrar.

Cada buzón admite hasta **25 contraseñas de aplicación activas**. Si llegas al
máximo, revoca las de los dispositivos que ya no utilizas antes de crear otra.

## 6. Preguntas frecuentes

**He cambiado la contraseña y el móvil ha dejado de recibir correo.** Los
dispositivos configurados con la contraseña principal necesitan la nueva.
Escríbela en el dispositivo o, mejor, configúralo con una contraseña de
aplicación.

**He perdido el móvil.** Entra en «Mi buzón» y revoca la contraseña de
aplicación de ese móvil. Si lo habías configurado con la contraseña principal,
cámbiala.

**«Mi buzón» dice que el correo electrónico o la contraseña no son
correctos.** Escribe la dirección completa y la contraseña principal del
buzón, no una contraseña de aplicación. Por seguridad, el aviso es el mismo
cuando la dirección no existe que cuando la contraseña es incorrecta.

**«Mi buzón» dice que hay demasiados intentos.** Tras varios intentos fallidos
el acceso se bloquea 15 minutos para proteger tu buzón. Espera y vuelve a
intentarlo con cuidado.

**El enlace de configuración dice que no es válido.** Ha caducado o ya no está
activo. Solicita uno nuevo a la persona que administra el correo.

**El dispositivo avisa de un problema con el certificado de seguridad.** No
aceptes el aviso. Comunícalo a la persona que administra el correo.

**Tu buzón está suspendido.** Ponte en contacto con la persona que
administra el correo.

## 7. Recomendaciones de seguridad

- No compartas tu contraseña con nadie; tampoco la envíes por correo.
- Usa una contraseña larga y distinta de la de otros servicios.
- Si te llega un mensaje que te pide la contraseña, aunque parezca de tu
  empresa, no respondas: nadie del servicio te la pedirá nunca.
- Tras configurar tus dispositivos, pulsa **«Ya lo he configurado»** en la
  página del enlace: si el enlace incluía tu contraseña, se borra.
