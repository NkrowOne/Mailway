# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: React 18 + Vite + Tailwind CSS en `web/`, servida por el backend Fastify (`server/`) en producción. Elegido para replicar el stack de Skyway (el otro proyecto del propietario), de modo que mantener ambos paneles sea una sola curva de aprendizaje. Despliegue vía Docker/Skyway, con un instalador (`deploy/instalar.sh`) que deja motor, webmail, DNS, certificado y panel en marcha.

## Users

- **Administrador de la instancia** (el propietario del servidor, confirmado en el brief): monta Mailway en su servidor, da de alta clientes y les asigna un plan. No es experto en correo; necesita que el sistema le diga qué hacer paso a paso (DNS, reputación, listas negras, certificado).
- **Cliente** (confirmado en el brief): una empresa o proyecto al que el administrador le vende correo. Entra a su propio panel, añade sus dominios (con el DNS aplicado en Cloudflare en un clic o guiado registro a registro), crea buzones hasta el máximo de su plan, genera enlaces de configuración para su equipo y usa claves de API para envíos automatizados (códigos OTP, notificaciones).
- **Titular del buzón** (empleado del cliente): no entra al panel. Recibe un enlace de configuración con los pasos para su dispositivo y un código QR, y dispone del portal «Mi buzón» para ver sus datos de conexión, cambiar su contraseña y crear contraseñas de aplicación. Usa IMAP/SMTP y el webmail.
- **Integraciones** (Skyway, scripts, agentes): gestionan el correo por API con un token de gestión; Skyway lo hace por proyecto desde su propio panel.

## Product Purpose

Mailway convierte un servidor propio en un servicio de correo comercial multi-cliente: buzones IMAP/SMTP reales, panel de autogestión por cliente con límites de plan, configuración automática de dispositivos, API HTTP de envío transaccional y un asesor de entregabilidad que explica en español qué registro DNS falta y por qué. Éxito = un administrador sin experiencia en correo puede dar de alta un cliente y que ese cliente llegue a la bandeja de entrada de Gmail sin tocar una terminal, y que sus empleados configuren el móvil sin llamar a nadie.

## Positioning

A diferencia de un panel de hosting genérico o de contratar Mailgun/Google Workspace, Mailway es auto-alojado (los datos y la reputación son del dueño), multi-cliente con límites por plan (se puede revender), y trae el "por qué caigo en spam" integrado como asistente accionable, no como documentación externa. Con Skyway, el correo es una función más de cada proyecto desplegado.

## Operating Context

- Corre en el mismo servidor dedicado que Skyway (PaaS Docker propio del dueño); el panel se despliega desde GitHub vía Skyway y el motor de correo (Stalwart) vive en un docker-compose adyacente. También funciona sin Skyway con un compose autónomo y un Traefik propio.
- El flujo real del administrador: ejecutar el instalador → completar la puesta en marcha → dar de alta un cliente con su usuario → el cliente añade su dominio (Cloudflare en un clic o registros para copiar en su proveedor) → la propiedad del dominio queda comprobada → crea buzones y envía a cada titular su enlace de configuración.
- Desde Skyway ≥ 0.34, el botón «Correo» de cada proyecto activa un cliente vinculado al proyecto, añade dominios y buzones y conecta servicios por SMTP o por la API; el Traefik de Skyway publica las rutas de Mailway a través de un puente que las filtra.
- Los envíos automatizados del cliente salen por `POST /v1/send` con `Authorization: Bearer mw_...`; la gestión por API usa tokens `mwt_...`.
- Idioma de toda la interfaz: español profesional y neutro, tratando al lector de tú (decisión del propietario, común a Mailway y Skyway), también el webmail.

## Capabilities and Constraints

- Motor de correo desacoplado tras la interfaz `MailEngine` (driver Stalwart + modo demostración sin servidor real). Stalwart queda fijado en v0.15.5: la v0.16 eliminó la API REST de gestión.
- Límites por plan: dominios, buzones, alias, cuota por buzón, envíos API por día y por minuto (compartidos por todas las claves del cliente). Las altas simultáneas no pueden superarlos.
- DNS: si la zona está en Cloudflare, la app crea los registros por el usuario (vista previa de cambios y conflictos, sin proxy, fusionando el SPF y sin tocar MX ajenos sin confirmación). En cualquier otro proveedor el DNS es de terceros: la app muestra los registros listos para copiar, ofrece un fichero de zona y verifica la propagación en vivo.
- Propiedad de los dominios: no se crean buzones ni alias hasta comprobar que el dominio es de quien lo da de alta (MX hacia el servidor o TXT de verificación). Nadie puede quedarse con el correo de un dominio ajeno.
- Autoconfiguración de Thunderbird, Outlook y Apple servida por el panel; los nombres `autoconfig.`/`autodiscover.`/`mta-sts.` solo se publican cuando su DNS apunta al servidor.
- Portal del titular («Mi buzón») y enlaces de configuración públicos: las contraseñas se verifican en local para no disparar el bloqueo automático de IPs del motor.
- Restricción dura: Skyway publica un único puerto por servicio, por lo que el panel y el motor de correo se despliegan por separado.
- Requisitos del servidor que la app no puede resolver sola: puerto 25 de salida desbloqueado y PTR configurado en el proveedor; la app los comprueba y lo explica.
- Terminología fijada: «buzón» (no "cuenta de correo"), «alias», «clave de API», «token de gestión», «contraseña de aplicación», «enlace de configuración», «plan», «entregabilidad».

## Evidence on Hand

- Identidad propia: el sobre cuya silueta forma la M, en tesela petróleo con degradado (`Logotipo`, `docs/marca/`). No inventar testimonios, clientes ni métricas.
- Existe el precedente visual de Skyway (React+Tailwind, oscuro, español) como referencia de familia, no como imposición.

## Product Principles

1. **El sistema explica, el usuario decide**: cada estado (DNS pendiente, propiedad sin comprobar, IP en lista negra, certificado a punto de caducar, límite alcanzado) viene con el porqué y el siguiente paso concreto en español llano.
2. **Autogestión con barandillas**: el cliente puede hacer todo lo de su ámbito sin poder romper nada de otros clientes, exceder su plan ni reclamar dominios ajenos.
3. **Los secretos se muestran una vez**: contraseñas generadas, tokens y claves de API aparecen una sola vez, con copia en un clic y aviso claro.
4. **Cada acción destructiva pesa lo que destruye**: borrar un dominio con buzones exige confirmación proporcional; sustituir los MX de otro proveedor exige confirmación expresa.
5. **Progreso visible**: onboarding por lista de comprobación; uso frente a límites siempre visible como barra; cada dominio pasa por estados con nombre.
6. **Lo automático, cuando se puede**: DNS en Cloudflare, certificado del motor, configuración de dispositivos y rutas de Traefik se resuelven sin intervención cuando las condiciones lo permiten, y se explican cuando no.

## Accessibility & Inclusion

Interfaz operable con teclado, contraste AA, textos de error legibles por personas sin vocabulario técnico (audiencia declarada sin experiencia). El portal del titular usa controles táctiles de 44 px y un paso a la vez.
