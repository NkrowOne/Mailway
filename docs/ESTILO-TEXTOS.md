# Guía de estilo de los textos de Mailway

Todo texto que ve una persona (el panel, «Mi buzón», el enlace de
configuración, la bienvenida, los correos que envía el panel, el webmail y sus
complementos, los mensajes de error del servidor y las órdenes del servidor)
suena como el software profesional actual en español: claro, neutro, sin
gracias ni metáforas, y tratando al lector de tú. No se aplica a comentarios
del código ni a identificadores.

Parte de la guía de Skyway (`docs/ESTILO-TEXTOS.md` de Skyway) y añade la
terminología de Mailway.

## Registro

- **Tú** en lo que se dirige al lector, con tono profesional: «Comprueba»,
  «Introduce», «Vuelve a intentarlo». Nunca «usted» ni sus formas.
- «Tu», «tus», «te», «puedes», «debes» solo cuando se refieren al lector. Si
  se refieren a un tercero (el cliente, el buzón, el titular) se mantienen
  «su», «le», «puede»: «El cliente no tiene acceso a su panel».
- Construcciones **impersonales** cuando no haga falta dirigirse a nadie:
  «No se ha podido guardar», «Se ha enviado el enlace».
- Botones y menús en **infinitivo**, con mayúscula solo en la primera palabra:
  «Guardar cambios», «Añadir buzón», «Usar llave de acceso». Excepción: el
  acceso va en imperativo («Accede al panel», ver «Acceso»).
- Frases completas, con punto en descripciones y mensajes; sin punto en
  etiquetas, botones y títulos.
- Sin primera persona del sistema, sin exclamaciones, sin emojis, sin
  preguntas retóricas, sin muletillas («ojo», «vaya», «sin más», «de golpe»,
  «a mano» se admite solo con su sentido literal), sin diminutivos.
- Sin metáforas ni coloquialismos: «pisar» → «sobrescribir», «tirar» →
  «detener», «colgado» → «sin respuesta», «se come» → «bloquea».
- Puntos suspensivos solo en acciones en curso: «Guardando…».
- Comillas latinas «» para citar elementos de la interfaz: la pestaña
  «Buzones», el botón «Guardar cambios».
- Mensajes de error: qué ha pasado y qué hacer, en ese orden y en dos frases
  como mucho. «No se ha podido comprobar la llave de acceso. Vuelve a
  intentarlo.»

## Acceso (regla fija)

- El verbo es **acceder**, en **imperativo** («Accede…») en botones, títulos
  y enlaces de acceso. Nunca «entrar» ni «iniciar sesión», ni el infinitivo
  «Acceder…». Es la excepción a la regla de los botones en infinitivo.
  - Botón de un formulario de acceso: **«Accede»**.
  - Llave de acceso: **«Usar llave de acceso»** (nunca «Entrar con llave de
    acceso»).
  - Ir al correo del titular: **«Accede a tu correo»** (nunca «entrar en el
    correo web», «abrir el webmail»).
  - «Accede al panel», «Accede a «Mi buzón»», «Accede con contraseña».
  - En descripciones: «Accede con tu dirección y tu contraseña», «No se ha
    podido acceder», «Tu sesión ha caducado. Vuelve a acceder.»
- **«Cerrar sesión»** para salir.
- **Llave de acceso** / llaves de acceso (passkey): «Añadir llave de acceso»,
  «Usar llave de acceso», «Renombrar», «Eliminar».

## A quién se habla

- **Titular** (la persona del buzón: «Mi buzón», enlace de configuración,
  webmail, correos de configuración): se habla de **«tu correo»**, «tu buzón»,
  «tu contraseña», «tus dispositivos». Sin términos técnicos que no necesite:
  ni «webmail», ni «Roundcube», ni «Bulwark», ni «motor», ni «IMAP» salvo en
  los datos de conexión y las guías de dispositivos, donde hacen falta.
- **Cliente** (la empresa en su panel) y **administración** (el panel de la
  instancia): pueden aparecer los términos del producto: webmail (el de
  siempre, Roundcube), **correo web nuevo** (Bulwark, beta), servidor de
  correo, registros DNS. Nunca «motor» en la interfaz del cliente: «servidor de
  correo».

## Terminología fija

buzón, alias, dominio, dominio anterior, cambio de dominio, contraseña de
aplicación, clave de API, token de gestión, enlace de configuración, plan,
entregabilidad, marca blanca, webmail, correo web nuevo, llave de acceso,
actualizar dispositivos, usuario del motor (solo en la administración),
servidor de correo, «Mi buzón», Actividad, Avisos, Ajustes.

## Ejemplos

- ✗ «Entrar con llave de acceso» → ✓ «Usar llave de acceso»
- ✗ «Entrar en el correo web» → ✓ «Accede a tu correo»
- ✗ «Entrar en mi buzón» → ✓ «Accede»
- ✗ «Acceder al panel» → ✓ «Accede al panel»
- ✗ «Abrir el correo web» (titular) → ✓ «Accede a tu correo»
- ✗ «No se ha podido entrar» → ✓ «No se ha podido acceder»
- ✗ «Inicia sesión en «Mi buzón» para continuar» → ✓ «Accede a «Mi buzón» para continuar»
- ✓ «Tu sesión ha caducado. Vuelve a acceder.» · «El buzón está suspendido. Ponte en contacto con quien administra tu correo.»
