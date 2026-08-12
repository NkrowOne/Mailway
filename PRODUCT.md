# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: React 18 + Vite + Tailwind CSS en `web/`, servida por el backend Fastify (`server/`) en producción. Elegido para replicar el stack de Skyway (el otro proyecto del propietario), de modo que mantener ambos paneles sea una sola curva de aprendizaje. Despliegue vía Docker/Skyway.

## Users

- **Administrador de la instancia** (el propietario del servidor, confirmado en el brief): monta Mailway en su servidor, da de alta clientes y les asigna un plan. No es experto en correo; necesita que el sistema le diga qué hacer paso a paso (DNS, reputación, listas negras).
- **Cliente** (confirmado en el brief): una empresa o proyecto al que el administrador le vende correo. Entra a su propio panel, crea y gestiona sus buzones hasta el máximo que le permite su plan, configura el DNS de su dominio guiado por el asistente, y usa claves de API para envíos automatizados (códigos OTP, notificaciones).
- **Usuario final de buzón** (inferido): empleado del cliente que solo usa IMAP/webmail; no entra al panel. Recibe una tarjeta de datos de conexión.

## Product Purpose

Mailway convierte un servidor propio en un servicio de correo comercial multi-cliente: buzones IMAP/SMTP reales, panel de autogestión por cliente con límites de plan, API HTTP de envío transaccional y un asesor de entregabilidad que explica en español qué registro DNS falta y por qué. Éxito = un administrador sin experiencia en correo puede dar de alta un cliente y que ese cliente llegue a la bandeja de entrada de Gmail sin tocar una terminal.

## Positioning

A diferencia de un panel de hosting genérico o de contratar Mailgun/Google Workspace, Mailway es auto-alojado (los datos y la reputación son del dueño), multi-cliente con límites por plan (se puede revender), y trae el "por qué caigo en spam" integrado como asistente accionable, no como documentación externa.

## Operating Context

- Corre en el mismo servidor dedicado que Skyway (PaaS Docker propio del dueño); el panel se despliega desde GitHub vía Skyway y el motor de correo (Stalwart) vive en un docker-compose adyacente.
- El flujo real del administrador: crear cliente → crear su usuario → el cliente entra, añade dominio, copia registros DNS en su proveedor (Cloudflare, IONOS...), pulsa «Verificar», crea buzones y claves de API.
- Los envíos automatizados del cliente salen por `POST /v1/send` con `Authorization: Bearer mw_...`.
- Idioma de toda la interfaz: español (confirmado por el brief y por Skyway).

## Capabilities and Constraints

- Motor de correo desacoplado tras la interfaz `MailEngine` (driver Stalwart + modo demostración sin servidor real).
- Límites por plan: dominios, buzones, alias, cuota por buzón, envíos API por día y por minuto.
- El DNS es de terceros: la app no puede crear registros, solo mostrarlos listos para copiar y verificar su propagación en vivo.
- Restricción dura (inferido del análisis técnico): Skyway publica un único puerto por servicio, por lo que el panel y el motor de correo se despliegan por separado.
- Terminología fijada: «buzón» (no "cuenta de correo"), «alias», «clave de API», «plan», «entregabilidad».

## Evidence on Hand

- No hay logo ni identidad previa de Mailway: no inventar testimonios, clientes ni métricas.
- Existe el precedente visual de Skyway (React+Tailwind, oscuro, español) como referencia de familia, no como imposición.

## Product Principles

1. **El sistema explica, el usuario decide**: cada estado (DNS pendiente, IP en lista negra, límite alcanzado) viene con el porqué y el siguiente paso concreto en español llano.
2. **Autogestión con barandillas**: el cliente puede hacer todo lo de su ámbito sin poder romper nada de otros clientes ni exceder su plan.
3. **Los secretos se muestran una vez**: contraseñas generadas y claves de API aparecen una sola vez, con copia en un clic y aviso claro.
4. **Cada acción destructiva pesa lo que destruye**: borrar un dominio con buzones exige confirmación proporcional.
5. **Progreso visible**: onboarding por lista de comprobación; uso frente a límites siempre visible como barra.

## Accessibility & Inclusion

Interfaz operable con teclado, contraste AA en ambos temas, textos de error legibles por personas sin vocabulario técnico (audiencia declarada sin experiencia).
