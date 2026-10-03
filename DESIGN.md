---
name: Mailway
description: Panel de correo multi-cliente claro, cercano y sobrio, con tarjetas blancas, un único color de identidad (verde petróleo) y estados fáciles de entender.
colors:
  mesa: "rgb(244 246 244)"
  hoja: "rgb(255 255 255)"
  hoja-2: "rgb(249 250 249)"
  hoja-3: "rgb(238 242 240)"
  tinta: "rgb(23 31 30)"
  tinta-2: "rgb(72 84 82)"
  tinta-3: "rgb(99 110 108)"
  petroleo: "rgb(13 92 94)"
  petroleo-hondo: "rgb(9 72 74)"
  petroleo-claro: "rgb(226 240 237)"
  normal: "rgb(8 122 76)"
  vigilar: "rgb(168 94 0)"
  fuera: "rgb(194 22 48)"
  normal-fondo: "rgb(228 245 236)"
  vigilar-fondo: "rgb(253 242 224)"
  fuera-fondo: "rgb(253 232 235)"
  regla: "rgb(23 31 30 / 0.10)"
  regla-fuerte: "rgb(23 31 30 / 0.20)"
typography:
  titulo-pagina:
    fontFamily: "Figtree Variable, system-ui, sans-serif"
    fontSize: "24px (28px desde sm)"
    lineHeight: "1.2"
    fontWeight: 650
    letterSpacing: "-0.018em"
  titulo-tarjeta:
    fontFamily: "Figtree Variable, system-ui, sans-serif"
    fontSize: "16px"
    lineHeight: "24px"
    fontWeight: 600
  cuerpo:
    fontFamily: "Figtree Variable, system-ui, sans-serif"
    fontSize: "15px"
    lineHeight: "23px"
    fontWeight: 400
  secundario:
    fontFamily: "Figtree Variable, system-ui, sans-serif"
    fontSize: "13px"
    lineHeight: "19px"
    fontWeight: 400
  rotulo:
    fontFamily: "Figtree Variable, system-ui, sans-serif"
    fontSize: "13px"
    lineHeight: "18px"
    fontWeight: 500
  codigo:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "0.93em"
    fontWeight: 400
rounded:
  control: "8px"
  tarjeta: "12px"
  portada: "16px"
  tesela: "16px"
  circulo: "9999px"
spacing:
  fila: "14px 16px"
  tarjeta: "16px"
  entre-tarjetas: "16px"
  pagina: "16px (32px desde sm, 48px desde xl)"
  cabecera-pagina: "24px por debajo (28px desde sm)"
components:
  boton-principal:
    backgroundColor: "{colors.petroleo}"
    textColor: "{colors.hoja}"
    rounded: "{rounded.control}"
    height: "36px"
  boton-principal-hover:
    backgroundColor: "{colors.petroleo-hondo}"
  boton-perfil:
    backgroundColor: "{colors.hoja}"
    textColor: "{colors.tinta}"
    border: "1px {colors.regla-fuerte}"
    rounded: "{rounded.control}"
    height: "36px"
  boton-plano:
    textColor: "{colors.tinta-2}"
    rounded: "{rounded.control}"
    height: "36px"
  boton-peligro:
    backgroundColor: "{colors.hoja}"
    textColor: "{colors.fuera}"
    border: "1px rgb(194 22 48 / 0.35)"
    rounded: "{rounded.control}"
    height: "36px"
  control:
    backgroundColor: "{colors.hoja}"
    border: "1px {colors.regla-fuerte}"
    rounded: "{rounded.control}"
    height: "40px"
  control-foco:
    border: "1px {colors.petroleo}"
    ring: "3px rgb(13 92 94 / 0.15)"
  tarjeta:
    backgroundColor: "{colors.hoja}"
    border: "1px {colors.regla}"
    rounded: "{rounded.tarjeta}"
    shadow: "sombra-suave"
  tesela:
    backgroundColor: "{colors.petroleo-claro}"
    textColor: "{colors.petroleo}"
    rounded: "{rounded.tesela}"
    size: "48px"
  logotipo:
    backgroundColor: "{colors.petroleo}"
    textColor: "{colors.hoja}"
    rounded: "11px"
    size: "36px"
  navegacion-activa:
    backgroundColor: "{colors.petroleo-claro}"
    textColor: "{colors.petroleo}"
  dialogo:
    backgroundColor: "{colors.hoja}"
    rounded: "{rounded.tarjeta}"
    shadow: "sombra-flotante"
---

# Design System: Mailway

Contrato visual del panel, del portal del titular («Mi buzón» y enlaces de
configuración) y de la capa de Roundcube. Tokens en `web/src/styles.css` y
`web/tailwind.config.js`; primitivas en `web/src/ui/`; marco en
`web/src/shell/AppShell.tsx`. Los encabezados de sección van en inglés porque
son el contrato de formato de DESIGN.md; el resto, en español, como el producto.

## Overview

Mailway es una herramienta de trabajo para alguien que no es experto en
correo. Tiene que transmitir calma y orden: qué está bien, qué falta y cuál es
el siguiente paso. La referencia es el software sobrio hecho por equipos de
diseño —un panel de facturación, un cliente de correo de pago—, no un
instrumento de medida ni una página de producto.

- **Fondo gris verdoso muy claro** (`mesa`) y **tarjetas blancas** (`Hoja`) con
  borde fino, esquinas de 12 px y una sombra casi imperceptible.
- **Un solo color de identidad**, el verde petróleo, para la acción principal,
  la navegación activa, el foco, los enlaces y las teselas de icono.
- **Colores de estado** (verde, ámbar, rojo) solo para calificar un dato:
  «Correcto», «Revisar», «Necesita atención». Nunca para decorar.
- **Una sola familia de letra** (Figtree) para todo el texto; la
  monoespaciada (IBM Plex Mono) solo para lo que se copia tal cual.
- **Un único motivo gráfico**: la tesela, un icono de línea dentro de un
  cuadrado redondeado en petróleo tenue. Lo llevan los estados vacíos (con el
  icono de lo que falta) y, en su versión llena, el logotipo.

**Anti-referencias.** Se rechazan expresamente: la estética de laboratorio del
diseño anterior (reglas con marcas, cuadrículas de fondo, versalitas espaciadas,
monoespaciada decorativa, «midiendo», «fuera de rango»), las cabeceras oscuras
con degradado, las ilustraciones 3D brillantes y todo lo que delata una
interfaz generada: degradados morados o azules, brillos, cristal esmerilado,
bordes con degradado, iconos de chispa, emojis decorativos, titulares
grandilocuentes y saludos del tipo «¡Bienvenido a…!».

## Colors

Paleta clara de un solo acento. El contraste está calculado sobre blanco.

### Primary

- **Petróleo** (`petroleo`, 7.8:1): relleno del botón principal y del
  logotipo, texto e icono de la navegación activa, enlaces, borde del campo
  enfocado, anillo de foco (2 px, separado 2 px), `caret-color`,
  `accent-color` y selección de texto (al 16 %).
- **Petróleo hondo** (`petroleo-hondo`): solo el hover del botón principal.
- **Petróleo tenue** (`petroleo-claro`): fondo de la navegación activa, de la
  pestaña seleccionada, de las teselas de icono y de los números de paso.

### Secondary — Estados

Califican valores, nunca superficies de la interfaz.

- **Correcto** (`normal` / `normal-fondo`, 5.4:1).
- **Revisar** (`vigilar` / `vigilar-fondo`, 4.9:1): uso del plan al 80 % o
  más, cola de salida ≥ 20, puntuación entre 50 y 79, pasos pendientes.
- **Necesita atención** (`fuera` / `fuera-fondo`, 6.1:1): límite superado,
  registro que no coincide, IP listada, cliente suspendido, errores y botón
  destructivo.
- **Sin datos**: guion en `tinta-3` sobre `hoja-3`. Cuando algo no se ha podido
  comprobar no se finge un estado.
- Una fila que necesita atención o revisión se tiñe entera (`.fila-fuera`,
  `.fila-vigilar`) para que se vea de un vistazo.

### Neutral

- `mesa`: fondo de la aplicación. `hoja`: tarjetas, barra lateral, barra
  superior móvil y diálogos. `hoja-2`: bloques embutidos (`Muestra`), cabecera
  de columnas, hover de filas. `hoja-3`: pista de las barras, hover de botones
  planos, avatar.
- `tinta` (texto principal), `tinta-2` (secundario, 7.9:1) y `tinta-3`
  (metadatos, 5.3:1; es el tono más tenue admitido para texto).
- `regla` separa filas y rodea tarjetas; `regla-fuerte` rodea controles y
  botones secundarios.

### Named Rules

- **Un acento.** No se introduce ningún otro color de marca. Si algo necesita
  destacar y no es la acción principal ni un estado, se resuelve con peso,
  tamaño o posición.
- **Nada de degradados.** Ni en fondos, ni en cabeceras, ni en botones.

## Typography

- **Figtree Variable** (`@fontsource-variable/figtree`) para todo: cercana,
  legible y sin rasgos técnicos. Cuerpo de 15 px con interlineado de 23 px.
- **IBM Plex Mono** 400/500 (`@fontsource/ibm-plex-mono`) solo en `.codigo`,
  `code` y `pre`: registros DNS, claves, tokens, contraseñas generadas,
  comandos y ejemplos de código. Distingue l, I y 1 u O y 0 cuando hay que
  copiar o teclear.
- `.valor` ya no cambia de familia: solo activa las cifras de ancho fijo para
  que cifras, fechas y recuentos no bailen en columna.

### Hierarchy

| Rol | Clase | Tamaño | Peso |
|---|---|---|---|
| Título de página | `.titular text-2xl sm:text-3xl` | 24 / 28 px | 650 |
| Título de diálogo | `text-lg` | 18 px | 600 |
| Título de tarjeta | `text-md` | 16 px | 600 |
| Cuerpo | `text-base` | 15 px | 400 |
| Secundario, ayudas | `text-sm` | 13 px | 400 |
| Etiqueta de campo o de columna | `.rotulo` | 13 px | 500, `tinta-2` |
| Cifra destacada | `.valor text-2xl` | 24 px | 600 |

### Named Rules

- **Frases, no versalitas.** Etiquetas, grupos de navegación y cabeceras de
  columna van en minúscula inicial y sin espaciado extra.
- **La monoespaciada se gana.** Solo para lo que el usuario copia o teclea.
  Correos, fechas, nombres y cifras van en Figtree.

## Layout

- Escritorio (≥ 1024 px): barra lateral blanca fija de 256 px con borde
  derecho; contenido a la derecha, con un ancho máximo de 72 rem y márgenes de
  32 px (48 px desde xl).
- Móvil: barra superior blanca y fija con el botón de menú, el logotipo y el
  nombre de la instancia; la navegación se abre en un cajón modal. Margen
  lateral de 16 px y nunca desplazamiento horizontal.
- Cada vista: buscador y ayuda (`PanelTools`) → cabecera de página
  (`Membrete`) → tarjetas (`Hoja`) en una o dos columnas, separadas 16 px.
- Las tablas se construyen con flex (nunca `<table>`): filas de 14 px de
  relleno vertical separadas por `regla`. En móvil las celdas secundarias se
  apilan llevándose su etiqueta; el identificador no se trunca.

### Named Rules

- **La página empieza por lo que es.** El título de página no va dentro de
  una caja ni sobre un fondo de color.
- **Un paso a la vez en el portal.** Columna estrecha (48 rem) y controles de
  44 px de alto en el móvil (`TACTIL`).

## Elevation & Depth

Dos niveles y nada más:

- `shadow-suave` (tarjetas, campos y botones secundarios a través de
  `shadow-boton`): separa del fondo sin que se note.
- `shadow-flotante`: lo que flota sobre la página (diálogo, cajón móvil,
  avisos emergentes).

### Shadow Vocabulary

- `--sombra-suave`: `0 1px 2px / 4 %` + `0 1px 3px / 3 %`.
- `--sombra-boton`: `0 1px 2px / 6 %`.
- `--sombra-flotante`: `0 12px 32px -8px / 18 %` + `0 2px 6px / 6 %`.

### Named Rules

- **Sin brillos ni cristal.** Nada de `backdrop-blur`, resplandores ni sombras
  de color.

## Shapes

- Controles y botones: 8 px (`rounded-lg`). Tarjetas y diálogos: 12 px
  (`rounded-xl`). Portada de acceso y teselas: 16 px (`rounded-2xl`).
- Estados con fondo (`MarcaFondo`): 6 px. Números de paso, avatar y
  contadores: círculo.
- Los glifos de estado son un trazo de 1.8 px con las puntas redondeadas.

## Components

### Buttons

`Button` y, para enlaces con aspecto de botón, `estiloBoton(variante)` (nunca
un `<button>` dentro de un `<a>`). Altura de 36 px, texto de 15 px en peso 500.

- `principal`: relleno petróleo. Una sola por zona (cabecera de página,
  diálogo o tarjeta con formulario).
- `perfil`: blanco con borde. Acciones secundarias.
- `plano`: solo texto. Terciarias y «Cerrar sesión».
- `peligro`: blanco con texto y borde rojos; se rellena de rojo tenue al pasar.

### Cards / Containers — `Hoja`

Tarjeta blanca con cabecera opcional (título de 16 px, contexto en `tinta-3`
y acciones a la derecha) separada por una línea `regla`. `flush` quita el
relleno para listas que van de borde a borde.

### Inputs / Fields

`Input`, `Select` y `Textarea` (`ui/Field.tsx`): etiqueta `.rotulo` encima,
control de 40 px con borde `regla-fuerte`, foco con borde petróleo y anillo de
3 px al 15 %, ayuda en `text-sm tinta-3` y error en rojo con el borde del
control también en rojo. `mono` pone el valor en `.codigo` para nombres de
servidor, IP o URL.

### Navigation

Barra lateral blanca: logotipo y nombre de la instancia arriba; grupos con
título en `text-sm tinta-3`; elementos de 36 px con icono de línea de 16 px en
`tinta-3`; el activo con fondo `petroleo-claro`, texto e icono petróleo y
peso 600. El recuento de avisos es una píldora roja. Al pie, avatar con
iniciales, nombre, rol y «Cerrar sesión».

### Signature Component — `Tesela` y `Vacio`

`Tesela` es el único adorno del sistema: icono de lucide de 22 px (trazo 1.75)
en petróleo, dentro de un cuadrado de 48 px y 16 px de radio en petróleo
tenue. `Vacio` la pone encima del título del estado vacío, con una frase que
orienta al siguiente paso y, si existe, la acción que lo resuelve. `icono` es
obligatorio y cada vista pasa el de lo que falta:

| Vista | Icono |
|---|---|
| Clientes | `Building2` |
| Dominios, «primero se necesita un dominio» | `Globe` |
| Buzones | `Inbox` |
| Alias | `Forward` |
| API de envío (claves) | `KeyRound` |
| Últimos envíos | `Send` |
| Formularios | `FormInput` |
| Marca blanca | `Tag` |
| Tokens de gestión | `Cable` |
| Cuenta de Cloudflare | `Cloud` |
| Planes | `ClipboardList` |
| Actividad | `History` |
| Avisos | `BellRing` |
| Servidor de correo, IP | `Server` |
| Usuarios del cliente | `UserRound` |
| Contraseñas de aplicación (portal) | `Smartphone` |
| Búsqueda sin resultados | `SearchX` |
| Comprobación incompleta / sin pendientes | `CircleDashed` / `CircleCheck` |

### Signature Component — `Logotipo`

Sobre blanco de línea en una tesela llena de petróleo (36 px; 44 px en
grande). Va en la barra lateral, la barra superior móvil, la portada de
acceso, el portal y el asistente de puesta en marcha. Es la única marca
gráfica: no se sustituye por iniciales, ilustraciones ni glifos.

### `Membrete` (cabecera de página)

Título de página, una línea de contexto en `tinta-2` y las acciones a la
derecha (debajo en móvil). Sin caja, sin fondo y sin ilustración.

### `Medida` + `CabeceraMedidas`

Fila de comprobación: concepto, valor actual (18 px, peso 600), valor
esperado y estado. La cabecera de columnas (Comprobación · Valor · Esperado ·
Estado) va sobre `hoja-2` y se oculta cuando la tarjeta es estrecha; entonces
cada celda lleva su etiqueta («Esperado: …»). Las filas se ordenan por estado:
lo que necesita atención primero.

### `Escala`

Barra de uso de 8 px con extremos redondeados sobre `hoja-3`: verde hasta el
80 %, ámbar desde el 80 % y roja por encima del límite (o al alcanzarlo con
`limiteEsFuera`).

### `Muestra` y `BotonCopiar`

Bloque embutido (`hoja-2`, borde `regla`, 8 px) con etiqueta y botón «Copiar»
arriba y el valor debajo en monoespaciada. El botón dice «Copiado» solo si la
copia ha funcionado; si no, deja el texto seleccionado y lo anuncia.

### `Dialogo`

`<dialog>` modal de 520 px (720 px el amplio), 12 px de radio, título de
18 px, aspa a la derecha, velo de tinta al 40 % y botonera fija al pie. Con un
secreto de una sola vez pregunta antes de cerrarse.

### Estados — `Cargando`, `Vacio`, `AvisoError`

- `Cargando`: aro de 24 px que gira (petróleo sobre petróleo al 18 %) con el
  texto de lo que se espera («Cargando tu buzón…»). Aparece con 160 ms de
  retraso para no parpadear.
- `Vacio`: tesela + título + frase con el siguiente paso + acción.
- `AvisoError`: banda roja tenue con borde rojo, el problema en una frase y
  «Reintentar» cuando se puede repetir.
- Avisos emergentes (`ui/toast.tsx`): tarjeta flotante con un círculo de
  estado (marca o aspa) y el texto; abajo a la derecha.

### Motion

Corto y funcional: fundido de 160 ms al cambiar de vista, entrada de 200 ms de
diálogos y avisos, cajón móvil en 220 ms y el giro del aro de carga. Con
`prefers-reduced-motion` todo se detiene.

### Superficies del navegador

`theme-color` es el fondo (`#f4f6f4`) en la portada y el portal, y blanco
dentro del panel, a juego con la barra superior. Barras de desplazamiento
finas en `tinta` al 24 %.

### Portal del titular

Barra blanca con logotipo, nombre de la instancia y «Cerrar sesión»; debajo,
título, dirección del buzón y tarjetas en una columna. Selector de
dispositivo con botones de 8 px de radio; pasos numerados con círculos en
petróleo tenue. La portada de acceso del portal es igual que la del panel:
logotipo y nombre centrados y una tarjeta de 16 px de radio.

### Webmail

`deploy/roundcube/mailway_theme/mailway.css` traslada a Elastic los mismos
colores (petróleo, fondo y bordes), radios de 8 y 16 px y el foco petróleo,
sin tocar su modo oscuro.

## Do's and Don'ts

### Do:

- **Do** empezar cada vista con `Membrete` y repartir el contenido en `Hoja`.
- **Do** pasar a `Vacio` el icono de lo que falta y escribir una frase que
  diga cuál es el siguiente paso; si se puede resolver ahí, añadir la acción.
- **Do** declarar carga (`Cargando`), vacío (`Vacio`) y error (`AvisoError`,
  con `onRetry` si se puede repetir) en cada vista.
- **Do** usar `estiloBoton` para los enlaces con aspecto de botón.
- **Do** poner en `.codigo` (o en una `Muestra`) todo lo que se copia o se
  teclea tal cual, y en `.valor` las cifras en columna.
- **Do** escribir en español de España, de tú y con registro profesional:
  «Comprobar de nuevo», «Necesita atención», «Crea una clave para…».
- **Do** mantener el foco visible en petróleo y el contraste AA.

### Don't:

- **Don't** volver a la estética de laboratorio: reglas con marcas,
  cuadrículas de fondo, versalitas espaciadas, monoespaciada para correos o
  fechas, ni vocabulario de instrumento («medir», «medición», «rango»,
  «midiendo») en la interfaz.
- **Don't** poner cabeceras oscuras, degradados, ilustraciones 3D, brillos,
  cristal esmerilado, bordes con degradado, emojis, iconos de chispa ni
  titulares grandilocuentes.
- **Don't** usar un color distinto del petróleo para destacar, ni el petróleo
  para calificar un dato.
- **Don't** poner dos acciones principales en la misma zona.
- **Don't** usar `<table>`, recortar identificadores con elipsis en móvil ni
  permitir desplazamiento horizontal.
- **Don't** introducir un tema oscuro en el panel: el sistema es claro.
