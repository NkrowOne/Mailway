---
name: Mailway
description: Panel de correo multi-cliente leído como un parte de laboratorio; todo dato es una medición con rango de referencia y veredicto.
colors:
  mesa: "rgb(238 236 229)"
  hoja: "rgb(255 255 255)"
  hoja-2: "rgb(248 247 243)"
  hoja-3: "rgb(242 240 234)"
  tinta: "rgb(22 21 19)"
  tinta-2: "rgb(88 85 78)"
  tinta-3: "rgb(120 116 107)"
  laboratorio: "rgb(10 62 69)"
  laboratorio-hondo: "rgb(7 44 49)"
  laboratorio-vivo: "rgb(0 176 178)"
  laboratorio-claro: "rgb(222 238 238)"
  normal: "rgb(8 122 76)"
  vigilar: "rgb(168 94 0)"
  fuera: "rgb(194 22 48)"
  normal-fondo: "rgb(228 245 236)"
  vigilar-fondo: "rgb(253 242 224)"
  fuera-fondo: "rgb(253 232 235)"
  regla: "rgb(22 21 19 / 0.13)"
  regla-fuerte: "rgb(22 21 19 / 0.36)"
typography:
  titular:
    fontFamily: "Archivo Narrow, Archivo Variable, sans-serif"
    fontSize: "34px"
    lineHeight: "0.94"
    fontWeight: 600
    letterSpacing: "-0.005em"
  lectura:
    fontFamily: "Azeret Mono Variable, ui-monospace, monospace"
    fontSize: "34px"
    lineHeight: "34px"
    fontWeight: 600
    letterSpacing: "-0.02em"
    fontVariation: "tabular-nums"
  marca:
    fontFamily: "Archivo Narrow, Archivo Variable, sans-serif"
    fontSize: "17px"
    lineHeight: "24px"
    fontWeight: 600
    letterSpacing: "0.14em"
  titulo-hoja:
    fontFamily: "Archivo Narrow, Archivo Variable, sans-serif"
    fontSize: "15px"
    lineHeight: "22px"
    fontWeight: 600
    letterSpacing: "0.06em"
  cuerpo:
    fontFamily: "Archivo Variable, system-ui, sans-serif"
    fontSize: "14px"
    lineHeight: "21px"
    fontWeight: 400
    fontVariation: "tabular-nums"
  valor:
    fontFamily: "Azeret Mono Variable, ui-monospace, monospace"
    fontSize: "21px"
    lineHeight: "21px"
    fontWeight: 500
    letterSpacing: "-0.02em"
    fontFeature: "'calt' 0"
  rotulo:
    fontFamily: "Archivo Narrow, Archivo Variable, sans-serif"
    fontSize: "11px"
    lineHeight: "15px"
    fontWeight: 600
    letterSpacing: "0.1em"
  veredicto:
    fontFamily: "Archivo Narrow, Archivo Variable, sans-serif"
    fontSize: "11px"
    lineHeight: "15px"
    fontWeight: 600
    letterSpacing: "0.08em"
rounded:
  recto: "0"
  minimo: "2px"
  circulo: "9999px"
spacing:
  fila: "12px"
  hoja: "16px"
  entre-hojas: "16px"
  campo: "20px"
  dialogo: "20px"
  pagina: "16px"
  pagina-ancha: "24px"
components:
  campo-lab:
    backgroundColor: "{colors.laboratorio}"
    textColor: "{colors.hoja}"
    rounded: "{rounded.recto}"
    width: "100%"
  membrete:
    backgroundColor: "{colors.laboratorio}"
    textColor: "{colors.hoja}"
    typography: "{typography.titular}"
    rounded: "{rounded.recto}"
    padding: "20px"
    width: "100%"
  marca-campo:
    backgroundColor: "{colors.laboratorio}"
    textColor: "{colors.hoja}"
    typography: "{typography.marca}"
    rounded: "{rounded.recto}"
    padding: "16px"
  barra-movil:
    backgroundColor: "{colors.laboratorio}"
    textColor: "{colors.hoja}"
    typography: "{typography.titulo-hoja}"
    rounded: "{rounded.recto}"
    padding: "10px 16px"
  boton-tinta:
    backgroundColor: "{colors.tinta}"
    textColor: "{colors.hoja}"
    typography: "{typography.cuerpo}"
    rounded: "{rounded.recto}"
    height: "32px"
    padding: "0 12px"
  boton-tinta-hover:
    backgroundColor: "{colors.laboratorio}"
    textColor: "{colors.hoja}"
  boton-campo:
    backgroundColor: "{colors.hoja}"
    textColor: "{colors.laboratorio}"
    typography: "{typography.cuerpo}"
    rounded: "{rounded.recto}"
    height: "32px"
    padding: "0 12px"
  boton-campo-hover:
    backgroundColor: "{colors.laboratorio-claro}"
    textColor: "{colors.laboratorio}"
  boton-perfil:
    textColor: "{colors.tinta}"
    typography: "{typography.cuerpo}"
    rounded: "{rounded.recto}"
    height: "32px"
    padding: "0 12px"
  boton-perfil-hover:
    backgroundColor: "{colors.hoja-3}"
    textColor: "{colors.tinta}"
  boton-plano:
    textColor: "{colors.tinta-2}"
    typography: "{typography.cuerpo}"
    height: "32px"
    padding: "0 12px"
  boton-peligro:
    textColor: "{colors.fuera}"
    typography: "{typography.cuerpo}"
    rounded: "{rounded.recto}"
    height: "32px"
    padding: "0 12px"
  boton-peligro-hover:
    backgroundColor: "{colors.fuera-fondo}"
    textColor: "{colors.fuera}"
  boton-copiar:
    textColor: "{colors.tinta-2}"
    typography: "{typography.veredicto}"
    rounded: "{rounded.recto}"
    height: "24px"
    padding: "0 6px"
  boton-copiar-copiado:
    textColor: "{colors.normal}"
  control:
    backgroundColor: "{colors.hoja}"
    textColor: "{colors.tinta}"
    typography: "{typography.cuerpo}"
    rounded: "{rounded.recto}"
    height: "36px"
    padding: "0 10px"
    width: "100%"
  hoja:
    backgroundColor: "{colors.hoja}"
    textColor: "{colors.tinta}"
    rounded: "{rounded.recto}"
    padding: "16px"
  hoja-cabecera:
    typography: "{typography.titulo-hoja}"
    padding: "12px 16px"
  fila-medida:
    textColor: "{colors.tinta}"
    typography: "{typography.cuerpo}"
    padding: "12px"
  fila-medida-fuera:
    backgroundColor: "rgb(253 232 235 / 0.55)"
    textColor: "{colors.fuera}"
    padding: "12px"
  fila-medida-vigilar:
    backgroundColor: "rgb(253 242 224 / 0.5)"
    textColor: "{colors.vigilar}"
    padding: "12px"
  muestra:
    backgroundColor: "{colors.hoja-2}"
    textColor: "{colors.tinta}"
    rounded: "{rounded.recto}"
    padding: "8px 12px 10px"
  marca-normal:
    textColor: "{colors.normal}"
    typography: "{typography.veredicto}"
  marca-vigilar:
    textColor: "{colors.vigilar}"
    typography: "{typography.veredicto}"
  marca-fuera:
    textColor: "{colors.fuera}"
    typography: "{typography.veredicto}"
  marca-sin-dato:
    textColor: "{colors.tinta-3}"
    typography: "{typography.veredicto}"
  marca-fondo-normal:
    backgroundColor: "{colors.normal-fondo}"
    textColor: "{colors.normal}"
    typography: "{typography.veredicto}"
    rounded: "{rounded.minimo}"
    padding: "2px 6px"
  marca-fondo-vigilar:
    backgroundColor: "{colors.vigilar-fondo}"
    textColor: "{colors.vigilar}"
    typography: "{typography.veredicto}"
    rounded: "{rounded.minimo}"
    padding: "2px 6px"
  marca-fondo-fuera:
    backgroundColor: "{colors.fuera-fondo}"
    textColor: "{colors.fuera}"
    typography: "{typography.veredicto}"
    rounded: "{rounded.minimo}"
    padding: "2px 6px"
  marca-fondo-sin-dato:
    backgroundColor: "{colors.hoja-3}"
    textColor: "{colors.tinta-3}"
    typography: "{typography.veredicto}"
    rounded: "{rounded.minimo}"
    padding: "2px 6px"
  navegacion-activa:
    backgroundColor: "{colors.laboratorio-claro}"
    textColor: "{colors.laboratorio}"
    typography: "{typography.cuerpo}"
    padding: "6px 8px"
  navegacion-inactiva:
    textColor: "{colors.tinta-2}"
    typography: "{typography.cuerpo}"
    padding: "6px 8px"
  dialogo:
    backgroundColor: "{colors.hoja}"
    textColor: "{colors.tinta}"
    rounded: "{rounded.recto}"
    padding: "20px"
    width: "min(520px, calc(100vw - 32px))"
---

# Design System: Mailway

<!-- impeccable:design-doc 1 -->

Registrado desde el mundo construido (no desde la intención): tokens leídos de
`web/src/styles.css` y `web/tailwind.config.js`, primitivas de `web/src/ui/`,
composición de `web/src/shell/AppShell.tsx` y de las páginas. Los encabezados de
sección se mantienen en inglés porque son el contrato de formato de DESIGN.md;
todo lo demás va en español, como el producto.

## Overview

**Creative North Star: "El parte de análisis clínico"**

Mailway se lee como un informe de laboratorio impreso. No hay panel de control ni
tarjetas de métrica: hay una **mesa** de papel de estraza claro y, encima, **hojas**
blancas de informe. Cada dato del servicio —SPF, DKIM, PTR, reputación de la IP,
cola de salida, uso del plan, listas negras— se presenta como una **medición**: un
concepto, un valor en cifras tabulares, su **rango de referencia** y su **veredicto**.
El rango es lo que convierte un número en un diagnóstico, y es la razón de que el
operador (declarado sin experiencia en correo) pueda actuar sin saber de correo.

El mundo tiene dos materiales, no uno. El papel lleva los datos, y su estructura la
llevan los **filetes**: regla pesada (1.5px) bajo cada cabecera, hairline (1px) entre
filas, filete perimetral fino alrededor de la hoja. La identidad, en cambio, lleva
**campo**: el petróleo de laboratorio no bordea, **ocupa una región** —el membrete de
página, el membrete del índice lateral y la barra móvil— de modo que una banda oscura
recorre todo el borde superior de la aplicación. Un color que solo bordea no es un
color: es un adorno. Todo es rectangular; el radio es cero salvo tres excepciones
mínimas. La densidad es de informe: cuerpo de 14px con interlineado de 21px, filas de
medición con 12px de aire, ninguna zona muerta decorativa.

El color obedece a una única disciplina. El **petróleo de laboratorio** es identidad y
orientación —campo del membrete, marca, navegación activa, foco, caret— y nunca califica
un dato. Los **veredictos** (verde, ámbar, carmín) son el único color que puede tocar un
valor, y cuando un valor está fuera de su rango tiñen la **fila entera**, no solo la
marca del margen. Una pantalla sana es papel y tinta bajo una banda oscura; una pantalla
enferma tiene filas encendidas.

**Anti-referencia declarada.** El mundo anterior de este mismo producto —chasis oscuro
sobre cinta negra, acento naranja de seguridad `rgb(255 122 26)` como única tecla de
acción, y su lectura literal del nombre: etiquetas postales de papel con esquina
doblada, sellos girados, códigos de barras derivados del dato— queda **rechazado por
completo**. Aquella metáfora decoraba en vez de trabajar. También se rechaza el admin
SaaS oscuro genérico con tarjetas iguales y la plantilla hero-metric.

**Key Characteristics:**

- Papel claro y tinta cálida casi negra; nunca negro puro, nunca tema oscuro.
- La identidad ocupa regiones (campo de petróleo), no filetes sueltos.
- Filetes como única estructura del papel: 1.5px bajo cabeceras, 1px entre filas.
- El veredicto tiñe la fila entera, no solo su marca de margen.
- Toda cifra medida o copiable en mono tabular (`.valor`), sin ligaduras.
- Versalitas estrechas y muy espaciadas (`.rotulo`) para nombrar columnas.
- Titular a plena escala (`.titular`) invertido sobre el campo.
- Radio cero, sombra solo en lo que flota sobre la hoja.
- Las filas fuera de rango se arrastran arriba de la tabla.

## Colors

Paleta de papel impreso con una banda de laboratorio encima: tres grises cálidos de
superficie, tres pesos de tinta, un petróleo desdoblado en cuatro para poder ocupar
regiones, y una tríada clínica de croma alto que solo se enciende cuando algo falla.

### Primary

- **Petróleo campo** (`laboratorio`): el color de la región de identidad. Es el fondo base
  de `.campo-lab` (membrete de página, membrete del índice lateral, barra móvil), el fondo
  del avatar del usuario, el texto y el icono de la navegación activa, el borde del campo de
  formulario enfocado, el anillo de foco (2px, offset 2px), el `caret-color`, el
  `accent-color`, la selección de texto (al 16 %), el barrido del indicador de medición (al
  55 %), el borde superior de 2px de una `Muestra`, el filete de 2px bajo el membrete de la
  portada de acceso y el color de los enlaces dentro de una hoja. Es también el hover del
  botón principal: la tinta vira a petróleo.
- **Petróleo hondo** (`laboratorio-hondo`): el pie del campo. Solo existe dentro del degradado
  de `.campo-lab` —`linear-gradient(160deg, laboratorio 0%, laboratorio-hondo 100%)`—, que da
  al membrete profundidad de tinta sin recurrir a una sombra. No se usa suelto.
- **Petróleo vivo** (`laboratorio-vivo`): el único croma alto del sistema, y solo **sobre** el
  campo oscuro: el glifo de escala del logotipo en el membrete del índice. Prohibido sobre
  papel blanco, donde no tiene contraste.
- **Petróleo tenue** (`laboratorio-claro`): fondo del elemento activo de la navegación (con el
  texto en petróleo y peso 600), fondo de la fila del apartado en curso de la puesta en marcha,
  y hover del botón de acción sobre campo. Es el único fondo teñido que no es un veredicto.

### Secondary — Veredictos

Los tres califican valores, nunca superficies de la interfaz. Cada uno tiene su tinta, su
fondo tenue de la misma familia y, en una fila de medición, su tinte de fila.

- **Verde en rango** (`normal` / `normal-fondo`): «En rango». Marca de conformidad, relleno de
  la escala por debajo del 80 %, filete superior del aviso de éxito, borde del botón de copiar
  cuando ya ha copiado. Documentado en el código con 5.4:1 sobre hoja.
- **Ámbar vigilar** (`vigilar` / `vigilar-fondo`): «Vigilar». Zona de aviso previo: escala al
  80 % o más, cola de salida ≥ 20 mensajes, puntuación de entregabilidad entre 50 y 79, dominios
  verificados incompletos, envíos fallidos en 24 h. 4.9:1 sobre hoja.
- **Carmín fuera de rango** (`fuera` / `fuera-fondo`): «Fuera de rango». Escala agotada (≥ 100 %),
  cola ≥ 50, puntuación < 50, PTR o registro A que no cuadran, IP listada en una DNSBL, cliente
  suspendido, recuento de avisos abiertos en la navegación, banda de error de página, botón
  destructivo y filete superior del aviso fallido. 6.1:1 sobre hoja.
- **Tintes de fila** (`.fila-fuera`, `.fila-vigilar`): el fondo tenue rebajado para que la fila
  entera se tiña sin apagar el texto —fuera al 55 % de `fuera-fondo`, vigilar al 50 % de
  `vigilar-fondo`—. Los aplica `Medida` según su veredicto; «en rango» y «sin dato» no tiñen.
- **Sin dato**: no es un color propio; se dibuja en `tinta-3` sobre `hoja-3`, con un guion como
  glifo. Nunca se pinta de gris verdoso ni se disfraza de veredicto.

### Neutral

- **Mesa de estraza** (`mesa`): fondo de la aplicación, el tablero sobre el que se apoyan las
  hojas. También es el color del borde de 3px del pulgar de la barra de desplazamiento, para
  que la barra parezca recortada sobre la mesa.
- **Hoja** (`hoja`): la hoja del informe. Fondo de toda superficie de contenido, de la barra
  lateral, de los campos de formulario, del diálogo y de los avisos; y, invertido, el texto y
  el relleno del botón de acción sobre el campo oscuro.
- **Hoja embutida** (`hoja-2`): fondo de la `Muestra` (bloque recortable) y hover de fila en
  tablas largas.
- **Hoja de control** (`hoja-3`): fondo del carril de la escala, del glifo «sin dato» y del
  hover de botones de perfil, planos y de iconos.
- **Tinta** (`tinta`): texto principal y fondo del botón de acción principal. Cálida, nunca
  negro puro. Es también la base de los dos filetes y del pulgar de la barra de desplazamiento
  (24 %, 40 % en hover).
- **Tinta secundaria** (`tinta-2`): prosa explicativa, notas al pie de una medición, etiquetas
  de navegación inactivas.
- **Tinta terciaria** (`tinta-3`): metadatos, rótulos de columna, unidades, marcas de tiempo,
  placeholders. Documentada en el código con 5.2:1 sobre hoja; no bajar de este peso para texto.
- **Filetes** (`regla`, `regla-fuerte`): los dos únicos trazos del papel. `regla` es el hairline
  entre filas y el perímetro de hoja y campo; `regla-fuerte` es la regla bajo cabecera, el borde
  del botón de perfil, el del diálogo y el del control de formulario en hover. No hay filete de
  laboratorio: donde antes lo había, ahora hay campo.

### Named Rules

**La Regla del Campo.** El color de identidad ocupa **regiones**, no filetes sueltos. El petróleo
se pinta como superficie —membrete de página, membrete del índice, barra móvil, avatar, fondo de
navegación activa—, y sobre esa región el contenido se invierte. Una franja de 2px de petróleo
bajo un título no es identidad: es un adorno, y este sistema ya la rechazó.

**La Regla del Veredicto.** El color solo aparece para calificar un valor que está fuera de su
rango de referencia. Si un dato está en rango, se imprime en tinta. Ningún fondo, borde, icono ni
título se colorea «para que destaque».

**La Regla de la Fila Teñida.** Cuando una medición está fuera de rango o en vigilancia, se tiñe
la **fila entera** y el valor se pinta de su veredicto. Así «fuera de rango primero» se **ve** de
un vistazo en lugar de afirmarse en el margen derecho: sin el tinte, el orden de las filas es una
promesa que el ojo no puede verificar.

**La Regla del Papel.** No hay tema oscuro. La mesa es `mesa`, la hoja es `hoja`, y la jerarquía
entre superficies se resuelve con filetes y con los dos grises embutidos, no invirtiendo el
contraste. Lo único oscuro del sistema es el campo de identidad.

## Typography

**Display Font:** Archivo Narrow (500 y 600 únicos pesos cargados; recae en Archivo Variable)
**Body Font:** Archivo Variable (con `system-ui`, `sans-serif`)
**Label/Mono Font:** Azeret Mono Variable (con `ui-monospace`, `monospace`)

Las tres se auto-hospedan vía `@fontsource`; ninguna cara de sistema es la voz. `Archivo Narrow`
solo está cargada en 500 y 600: usarla en 400 o 700 la sintetiza y rompe el trazo.

**Character:** Archivo es una grotesca de rotulación técnica: neutra, de aperturas cerradas,
legible en cuerpos pequeños. Su versión Narrow hace dos trabajos opuestos: en versalitas muy
espaciadas rotula el impreso (columnas, secciones, veredictos), y en `.titular` —interletrado
ceñido a −0.005em e interlineado 0.94— se convierte en la voz del membrete a plena escala. Azeret
Mono, con cifras tabulares y ligaduras contextuales desactivadas, hace de instrumento: todo lo que
se mide, se compara en columna o se copia va en mono, y por eso las cifras siempre se alinean.

El cuerpo lleva `font-variant-numeric: tabular-nums` a nivel de `body`: incluso los números en
prosa mantienen el ancho al refrescarse, y una tabla no baila cuando cambia un dato.

### Hierarchy

- **Titular** (`.titular`: Archivo Narrow 600, versalitas, `-0.005em`, interlineado 0.94, 34px que
  suben a **46px desde `sm`**): el título de página dentro de `Membrete`, en blanco sobre el campo
  de petróleo. Es el tipo más grande del sistema y hay uno por vista.
- **Lectura** (`.valor` 600, 34px con interlineado ceñido): la puntuación global de entregabilidad,
  teñida con su veredicto. Es la única cifra grande del sistema; una por vista como máximo.
- **Valor de medición** (`.valor` 500, 21px con interlineado ceñido): el dato de cada fila de
  `Medida`, a plena escala y teñido con el veredicto de su fila. Con unidad opcional a 12px en
  `tinta-3`. También lo usan el nombre de dominio del membrete de detalle y los recuentos destacados.
- **Portada** (Archivo Narrow 600, 21px/27px, versalitas, `0.04em`): el título de las pantallas sin
  shell (`Login`).
- **Marca** (Archivo Narrow 600, 17px/24px, versalitas, `0.14em`): el nombre de la instancia junto al
  logotipo, en el membrete del índice (invertido sobre el campo) y en la portada. El interletrado más
  abierto del sistema.
- **Título de hoja** (Archivo Narrow 600, 15px/22px, versalitas, `0.06em`): la cabecera de una `Hoja`
  y la de un `Dialogo`. En móvil la barra del shell usa el mismo tamaño con `0.12em`, invertido.
- **Cuerpo** (Archivo Variable 400, 14px/21px): prosa, conceptos de fila, etiquetas de navegación,
  botones y campos. Los párrafos explicativos se limitan a 70–75ch.
- **Dato secundario** (12px/17px): correos, zonas DNSBL, marcas de tiempo, ayuda y error de campo, y
  la línea de contexto del membrete (en blanco al 70–75 %). En mono cuando es un identificador copiable.
- **Rótulo** (`.rotulo`: Archivo Narrow 600, 11px/15px, versalitas, `0.1em`, `tinta-3`): nombres de
  columna, secciones de navegación, etiquetas de formulario y rótulo de una `Muestra`.
- **Veredicto** (Archivo Narrow 600, 11px/15px, versalitas, `0.08em`): el texto de `Marca` y
  `MarcaFondo`, y el del botón de copiar.

La escala completa disponible es `micro` 11/15, `sm` 12/17, `base` 14/21, `md` 15/22, `lg` 17/24,
`xl` 21/27, `2xl` 26/31, `3xl` 34/36, `4xl` 46/44, `5xl` 68/62. Los dos peldaños altos (`4xl`, `5xl`)
existen para el titular del campo; `2xl` y `5xl` no tienen hoy ningún uso en el código.

### Named Rules

**La Regla de la Cifra Tabular.** Todo lo que se mide, se compara en columna o se copia lleva la
clase `.valor`: mono, tabular, sin ligaduras contextuales. Un identificador (correo, dominio, IP,
registro DNS, clave, host) nunca se imprime en la cara de cuerpo.

**La Regla del Rótulo.** Una columna sin rótulo es un número sin nombre. Todo grupo de mediciones
lleva su `CabeceraMedidas` o su fila de `.rotulo`; en pantalla estrecha, el rótulo se repite dentro
de cada celda.

**La Regla de las Versalitas.** Las mayúsculas espaciadas son de rotulación —títulos, columnas,
veredictos— y jamás de prosa. Ningún párrafo, ayuda ni mensaje de error va en versalitas. `.titular`
es la excepción declarada: versalitas de gran cuerpo con interletrado ceñido, y solo en el membrete.

## Layout

**Shell.** Barra lateral fija de 224px (`w-56`) a partir de `lg`, pegada al viewport
(`sticky top-0 h-screen`), sobre `hoja` y separada del contenido por un hairline vertical; su
membrete superior es un bloque de `.campo-lab` con 16px de relleno. Por debajo de `lg` la barra
desaparece y se sustituye por una cabecera **también sobre `.campo-lab`**, con 16px laterales y 10px
verticales, el nombre de la instancia invertido en versalitas y un botón de menú de 32px enmarcado en
filete blanco al 30 %; el menú abre un cajón de 256px sobre un velo de `rgb(var(--tinta) / 0.4)`. Entre
ese bloque de marca y el membrete de la página, la banda oscura recorre el borde superior completo.

**Página.** El contenido vive en `main` con 16px de aire lateral y 20px vertical, que pasan a 24px y
28px desde `sm`, dentro de un contenedor centrado de 1152px (`max-w-6xl`). Orden invariable de una
vista: `Membrete` (campo oscuro con título, línea de contexto y la acción de la vista) → tabla de
constantes → hojas de detalle. El membrete deja 20px de aire por debajo.

**Rejillas.** Las hojas se apilan con 16px de separación. Cuando una vista reparte en dos columnas
lo hace a partir de `lg`, y con proporciones deliberadas, no simétricas por defecto: `lg:grid-cols-2`
para pares equivalentes (hallazgos + registro), `lg:grid-cols-[1fr_1.35fr]` cuando la columna derecha
es el plan de acción, `lg:grid-cols-[1.5fr_1fr]` cuando la izquierda es la tabla principal. Los
formularios reparten a `sm:grid-cols-2`.

**Ritmo interno.** Hoja con 16px de relleno, o `flush` (sin relleno) cuando su contenido es una lista
reglada que debe llegar al borde; entonces cada fila lleva 16px laterales. Cabecera de hoja a 12px/16px.
Fila de medición: 12px por los cuatro lados —el tinte de veredicto necesita cuerpo, no una línea—, con
16px de separación horizontal entre celdas. Membrete a 20px (24px desde `sm`). Diálogo a 20px.

**Tablas regladas.** No hay `<table>`: las tablas son filas flex con `flex-wrap`, cabecera de columnas
en `.rotulo` sobre `regla-cabecera` y hairline `regla-fila` entre filas (la última, sin filete). Los anchos
de columna son fijos y declarados (`w-24`, `w-28`, `w-44`, `basis-28`, `basis-32`, `basis-40`) para que las
cifras se alineen verticalmente entre filas. En `Medida`: concepto flexible desde 160px, valor sin encoger,
referencia a 112px y veredicto a 128px alineado a la derecha.

**Comportamiento en móvil.** La tabla no se convierte en tarjetas ni se recorta con scroll horizontal:
se **pliega**. La fila de cabecera se oculta (`hidden … sm:flex`), el dato identificador ocupa una línea
propia a ancho completo (`basis-full sm:basis-0`) y se parte por palabras en vez de truncarse
(`break-words` / `break-all`), y cada celda secundaria muestra su propio `.rotulo` en línea
(`.rotulo sm:hidden`). Ningún dato desaparece al estrechar.

**Medida de lectura.** La prosa explicativa se corta a 70–75ch; la línea de contexto del membrete, a
`max-w-2xl`. La portada de acceso es una hoja de 25rem centrada sobre la mesa, y la puesta en marcha una
columna de `max-w-2xl`.

### Named Rules

**La Regla de la Banda Continua.** La región de identidad no aparece y desaparece: el membrete del índice,
la barra móvil y el membrete de página comparten `.campo-lab`, de modo que el borde superior de la
aplicación es una sola banda oscura en cualquier ancho.

**La Regla de la Tabla Reglada.** Un conjunto de datos comparables se presenta como tabla reglada con
su cabecera de columnas, nunca como rejilla de tarjetas. Si dos datos merecen compararse, comparten
columna; si no la comparten, no son la misma tabla.

**La Regla del Dato Identificador.** En pantalla estrecha, el dato que identifica la fila (nombre del
cliente, dirección del buzón, dominio, alias) conserva línea propia, tamaño completo y texto íntegro.
Lo que se pliega es todo lo demás, y siempre llevándose su rótulo consigo.

**La Regla del Fuera de Rango Primero.** Las filas se ordenan por veredicto —fuera, vigilar, sin dato,
en rango— antes que por nombre o fecha, y las dos primeras categorías van teñidas. Lo que está mal se
lee antes que lo que está bien.

## Elevation & Depth

El sistema es **plano por definición**. No hay elevación tonal ni sombras de reposo: una hoja se separa
de la mesa por su fondo blanco y su filete perimetral de 1px, y las secciones dentro de una hoja se
separan por filetes, no por capas. Los tres grises de papel (`hoja`, `hoja-2`, `hoja-3`) marcan encaje
—bloque recortable, fila en hover, carril de escala—, no altura. La única profundidad declarada del
mundo es el degradado del campo de identidad, que oscurece hacia el pie a 160°; no proyecta sombra.

Existe **una sola sombra declarada** en todo el sistema, y solo la llevan las superficies que dejan de
ser parte del informe para flotar sobre él.

### Shadow Vocabulary

- **Flotante** (`box-shadow: 0 18px 48px -20px rgb(var(--tinta) / 0.38)`): el diálogo modal, el cajón de
  navegación en móvil y el aviso al margen (toast). Nada más.

### Named Rules

**La Regla de la Hoja Plana.** Solo lleva sombra lo que flota sobre la hoja: diálogo, cajón móvil y
aviso. Hojas, tablas, filas, campos y botones no tienen sombra en ningún estado, ni siquiera en hover
o foco. Si un elemento parece necesitar sombra para leerse, le falta un filete o le sobra región.

**La Regla del Único Trazo.** Solo existen dos pesos de filete: 1px (`regla`) entre filas y en
perímetros, y 1.5px (`regla-fuerte`) bajo cabeceras. Los bordes de 2px son excepciones contadas: el
recorte superior de una `Muestra` y el membrete de la portada de acceso, ambos en petróleo, y el filete
superior de un aviso, del color de su veredicto. El membrete de página ya no lleva filete: lleva campo.

## Shapes

Geometría de impreso: **radio cero**. Hojas, campos, botones, diálogos, avisos, `Muestra` y el propio
campo de identidad son rectángulos exactos. Solo hay tres excepciones, todas funcionales: 2px en la
píldora de `MarcaFondo` y en el anillo de foco, un círculo completo en el indicador de ocupación del
botón, y 99px en el pulgar de la barra de desplazamiento.

Los glifos son **geometría dibujada**, nunca emoji ni carácter suelto ni ilustración: el veredicto es
un trazo de 1.8px sobre una caja de 10×10 (check, aspa, asta de atención, guion para «sin dato»); el
logotipo es una escala medida —línea base y cuatro barras de alturas distintas— con trazo de 1.6px, en
petróleo vivo cuando va sobre el campo y en petróleo cuando va sobre papel; el vacío es esa misma escala
sin lectura, con la referencia punteada; el chevrón del selector y el aspa de cierre son trazos de 1.5px.
Iconografía de navegación: Lucide a 16px, en `tinta-3` inactivo y en petróleo cuando el elemento está activo.

Las barras de la escala son rectas y de 6px de alto, con una marca de referencia de 1px al 80 % en
`rgb(22 21 19 / 0.3)`.

## Components

### Buttons

Cinco variantes (`Button`), todas de 32px de alto, 12px de aire lateral, cuerpo 14px, sin radio,
`transition-colors` de 100ms y un desplazamiento de 1px al pulsar. Desactivado: 35 % de opacidad (40 % en
la variante de campo). Ocupado (`busy`): un círculo de 12px con trazo de 1.5px girando, y el botón bloqueado.

- **`tinta` (principal sobre papel):** relleno sólido en tinta sobre texto de hoja, peso 600. En hover el
  fondo vira a **petróleo**, que es el único momento en que el color de identidad toca una acción sobre papel.
  Es el sello de conformidad del parte: uno por vista.
- **`campo` (principal sobre el campo oscuro):** la acción invertida que vive dentro del `Membrete`: relleno
  blanco, texto en petróleo, peso 600; hover a `laboratorio-claro`. Es la forma normal de la acción de página
  desde que el membrete es una región oscura; `tinta` queda para las acciones que viven sobre papel (formularios,
  diálogos, portada).
- **`perfil` (secundaria, por defecto):** solo filete `regla-fuerte`, sin relleno, texto en tinta; hover a `hoja-3`.
- **`plano` (terciaria):** solo texto en `tinta-2`; hover a `hoja-3` con texto en tinta.
- **`peligro` (destructiva):** filete de carmín al 40 % y texto en carmín de fuera de rango, hover sobre
  `fuera-fondo`. Comparte color con el veredicto a propósito: destruir es sacar algo de rango.

Los enlaces de navegación dentro de una hoja («Ver informe completo», «Ver todo») van en petróleo, a 12px,
subrayados con 2px de separación, y viran a tinta en hover.

### Cards / Containers — `Hoja`

- **Silueta:** rectángulo sin radio, fondo `hoja`, filete perimetral de 1px `regla`.
- **Cabecera:** título en versalitas estrechas, línea de contexto opcional a su derecha en 12px `tinta-3`
  (fecha de medición, recuento, «Fuera de rango primero»), y acciones alineadas al extremo; separada del
  cuerpo por la regla pesada de 1.5px.
- **Relleno:** 16px, o ninguno con `flush` cuando el contenido es una lista reglada a sangre.
- **Sin sombra en ningún estado.** Las hojas no se elevan al pasar el ratón; las filas sí pueden teñirse
  a `hoja-2` o `hoja-3` en hover, o a su veredicto de forma permanente.

### Inputs / Fields

- **Control:** 36px de alto, ancho completo, fondo `hoja`, filete `regla`, 10px de aire lateral, cuerpo
  14px, sin radio. `placeholder` en `tinta-3`.
- **Estados:** hover engrosa el filete a `regla-fuerte`; foco lo cambia a **petróleo sólido** (más el
  anillo global de 2px); desactivado al 35 %.
- **Etiqueta:** siempre visible, en `.rotulo`, a 6px sobre el control. Ayuda en 12px `tinta-3`; error en
  12px carmín, enlazado por `aria-describedby` y con `aria-invalid`.
- **Variantes:** `mono` conmuta el control a `.valor` a 12px para identificadores; el selector oculta la
  flecha nativa y dibuja su chevrón a 12px; el área de texto arranca en 84px de alto.
- **Bandas de mensaje:** el resultado de una comprobación se imprime como banda de 12px con filete del
  color de su veredicto sobre su fondo tenue (`role="status"`), con la animación `revelar`.

### Navigation

Índice del informe. Arriba, el **membrete del índice**: un bloque de `.campo-lab` de 16px con el logotipo de
escala en petróleo vivo y el nombre de la instancia invertido en versalitas de 17px con `0.14em` —no un filete
bajo un título, sino la misma región oscura que el membrete de página—. Debajo, sobre hoja, los enlaces se
agrupan bajo secciones rotuladas —«Parte diario», «Registro», «Instrumentos» para el administrador; «Tu correo»,
«Automatización», «Cuenta» para el cliente— con el rótulo en `.rotulo`. Cada enlace: icono de 16px + etiqueta de
14px, 8px de aire lateral y 6px vertical. Inactivo en `tinta-2` con icono en `tinta-3`; hover a `hoja-3`;
**activo** sobre `laboratorio-claro`, con texto e icono en petróleo y peso 600 —sin barra lateral de acento ni
relleno sólido—. El recuento de avisos abiertos se imprime al final del enlace en `.valor` sobre `fuera-fondo`.
Al pie, identidad: avatar cuadrado de 28px con las dos primeras letras en versalitas sobre petróleo, nombre a
12px, rol en `.rotulo`, y salir como botón de icono de 28px.

### Signature Component — `Membrete`

El membrete del parte, y la pieza que hace visible la regla del campo. Es una **región de identidad a ancho
completo**: `.campo-lab` (petróleo con degradado a 160° hacia `laboratorio-hondo`), 20px de relleno —24px desde
`sm`— y 20px de aire por debajo. Dentro, invertido: el título en `.titular` a 34px que suben a 46px desde `sm`,
en blanco; una línea de contexto opcional a `max-w-2xl` en blanco al 70 % (los identificadores, en `.valor` al
75 %); y a la derecha la acción de la vista, normalmente un `Button variant="campo"` o una `MarcaFondo` con el
veredicto global. Ningún filete: el color es superficie.

### Signature Component — `Medida` + `CabeceraMedidas`

La firma del mundo y la primitiva más reutilizada: una fila que sirve igual para el estado del motor, la
cola de salida, la reputación de la IP, un registro DNS o el uso del plan. Cuatro celdas sobre un hairline,
con 12px de aire por los cuatro lados:

1. **Concepto**, cuerpo 14px en tinta, flexible desde 160px.
2. **Valor** en `.valor` a 21px peso 500 con interlineado ceñido —el dato es el contenido del informe, así que
   va a plena escala— y **teñido con el veredicto de la fila** (carmín fuera, ámbar vigilar, tinta el resto).
   Unidad opcional a 12px en `tinta-3`.
3. **Referencia** en `.valor` 12px `tinta-3`, 112px: `< 20`, `≥ 80`, `= IP pública`, `todos`. Es lo que
   convierte el número en diagnóstico.
4. **Veredicto** en el margen derecho, 128px: `Marca` con su glifo y su texto («En rango», «Vigilar», «Fuera de
   rango», «Sin dato»).

**La fila entera se tiñe** según el veredicto: `.fila-fuera` para fuera de rango, `.fila-vigilar` para
vigilancia, sin tinte para en rango y sin dato. Bajo la fila, una **nota** opcional a ancho completo en 12px
`tinta-2` (máx. 75ch) que explica en español llano qué significa estar fuera de rango y cuál es el siguiente
paso. La `CabeceraMedidas` imprime los cuatro rótulos de columna sobre la regla pesada; la columna de
referencia puede omitirse.

`MarcaFondo` es la misma marca sobre su fondo tenue, con 2px de radio: se usa en listados densos donde el
veredicto es la última celda de una fila larga (clientes, listas negras, buzones) y en la acción del membrete.

### `Escala`

Medición con escala para uso frente a límite de plan. Etiqueta a la izquierda, `usado/máximo` a la derecha
en `.valor` (el denominador en `tinta-3`), y debajo un carril de 6px sobre `hoja-3` con relleno del color
del veredicto: en rango por debajo del 80 %, vigilar a partir del 80 %, fuera de rango al alcanzar el
límite. Una marca de referencia de 1px al 80 % avisa antes de agotarlo. El relleno anima solo su anchura
(500ms). Expone `role="meter"` con sus valores.

### `Muestra`

El apartado recortable del parte: el valor exacto que el usuario debe llevarse fuera del sistema (registro
DNS, credencial de buzón, clave de API, cadena de conexión). Fondo `hoja-2`, filete perimetral, **borde
superior de 2px en petróleo** —la marca de recorte, y una de las dos únicas supervivencias del filete de
identidad—, rótulo en `.rotulo` y `BotonCopiar` alineado a la derecha. El contenido va siempre en `.valor`.

### `BotonCopiar`

Botón de 24px con filete `regla-fuerte`, versalitas de 11px y un icono de dos rectángulos. Al copiar, el
filete y el texto pasan al verde de conformidad, el icono se convierte en check y el rótulo en «Copiado»
durante 1600ms; luego vuelve. No hay aviso emergente para una copia.

### `Dialogo`

Elemento `<dialog>` nativo con `showModal`. Anchura `min(520px, 100vw − 32px)`, fondo de hoja, filete
`regla-fuerte`, **la única sombra del sistema**, velo de fondo `rgb(var(--tinta) / 0.45)`. Cabecera con título
en versalitas sobre la regla pesada y botón de cierre de 28px; cuerpo a 20px. Entra con `aparecer` (220ms).
Cierra con Escape, con el aspa y al pulsar fuera. Es también la única superficie donde conviven una acción
principal y una secundaria.

### Estados — `Vacio`, `Midiendo`, error

- **`Vacio`:** centrado, 48px de aire vertical, el glifo de la escala sin lectura en `tinta-3`, título a
  15px peso 600, explicación a 14px `tinta-2` de menos de 448px, y una acción opcional —normalmente
  `perfil`, no principal—.
- **`Midiendo`:** el instrumento barriendo la muestra, nunca un spinner: un filete de 1px y 192px de ancho
  sobre el que corre un barrido de petróleo al 55 % (1.25s), y debajo la leyenda en versalitas de 11px con
  `0.1em`. El texto nombra lo que se está midiendo («Midiendo las constantes…», «Consultando PTR y listas
  negras…»). Expone `role="status"`.
- **Error de página:** banda de 14px carmín sobre `fuera-fondo` con filete, que nombra el problema y el
  arreglo. No se ilustra.
- **Aviso al margen (toast):** hoja de 360px máximo, abajo a la derecha, filete superior de 2px del color
  del veredicto, rótulo «Hecho» / «No se pudo» y el texto debajo; se apila hasta 4 y se retira a los 4200ms;
  `aria-live="polite"`.

### Motion

Tres movimientos, y ninguno decorativo:

- **`aparecer`** (220ms, `cubic-bezier(0.16, 1, 0.3, 1)`): 6px de desplazamiento vertical y opacidad. Entrada
  de diálogo, aviso y portada de acceso.
- **`revelar`** (420ms, `cubic-bezier(0.16, 1, 0.3, 1)`): desde 35 % de opacidad, −2px y 1.5px de desenfoque
  hasta nítido. Es «el resultado se revela al medirse»: se aplica al resultado de una comprobación, nunca a
  la navegación.
- **`medir`** (1.25s en bucle, `cubic-bezier(0.4, 0, 0.6, 1)`): el barrido del instrumento, exclusivo de
  `Midiendo`.

Los cambios de estado (hover, foco, veredicto) usan `transition-colors` de 100ms; la escala anima solo su
anchura (500ms). `@media (prefers-reduced-motion: reduce)` anula `revelar` y el barrido de `medir`; toda
animación nueva debe añadirse a ese bloque.

### Superficies del navegador

También son del diseño y ya están tematizadas: selección de texto en petróleo al 16 % conservando la tinta;
`caret-color` y `accent-color` en petróleo; foco visible como anillo de 2px en petróleo con 2px de separación
y 2px de radio, aplicado a enlaces, botones, campos y cualquier elemento con `tabindex`; barra de
desplazamiento fina (11px en WebKit), pulgar en tinta al 24 % (40 % en hover) con 3px de borde en color de mesa
y 99px de radio, carril transparente; enlaces con subrayado a 1px y 3px de separación. El `theme-color` del
documento sigue declarado como `#f0eee8`, valor de la mesa **anterior** a la amplificación: la mesa actual es
`rgb(238 236 229)`, así que ese meta va por detrás del token.

## Do's and Don'ts

### Reglas del mundo

1. **La identidad ocupa regiones, no filetes.** El petróleo se pinta como superficie —membrete, marca, barra
   móvil, avatar, navegación activa—. Un filete de acento bajo un título es el adorno que este sistema quitó.
2. **El veredicto tiñe la fila entera.** Fuera de rango y vigilar pintan fondo de fila y valor; así «fuera de
   rango primero» se ve, no solo se afirma.
3. **Tabla reglada, no tarjeta.** Datos comparables van en tabla con cabecera de columnas y hairlines. La
   rejilla de tarjetas iguales es el patrón que este mundo rechaza.
4. **Una sola acción principal por vista.** Un botón de relleno por pantalla: `campo` si vive en el membrete,
   `tinta` si vive sobre papel. El resto, `perfil` o `plano`. Los diálogos tienen la suya propia.
5. **Sombra solo en lo que flota.** `shadow-flotante` es la única sombra y solo la llevan diálogo, cajón
   móvil y aviso. Todo lo demás es plano y se estructura con filetes y regiones.
6. **Color solo como veredicto.** Verde, ámbar y carmín califican valores fuera de rango; el petróleo es
   identidad y orientación. Nada se colorea para decorar ni para jerarquizar.
7. **Móvil pliega, no oculta.** El dato identificador conserva línea propia y texto íntegro; las celdas
   secundarias se apilan llevándose su rótulo. Nunca se recorta con scroll horizontal ni se trunca un
   identificador.
8. **Todo valor lleva referencia y veredicto.** Un número sin rango de referencia no es una medición: es
   una cifra suelta, y en este informe no tiene sitio.

### Do:

- **Do** construir cualquier vista nueva con `Membrete` (campo oscuro) → tabla de mediciones → hojas de
  detalle, en ese orden.
- **Do** poner la acción de la página dentro del `Membrete` como `Button variant="campo"`, y reservar
  `variant="tinta"` para las acciones que viven sobre papel.
- **Do** expresar cada dato con `Medida` (concepto, valor a 21px, referencia, veredicto) y encabezarlo con
  `CabeceraMedidas`.
- **Do** ordenar filas por veredicto antes que por nombre o fecha: fuera de rango, vigilar, sin dato, en rango.
- **Do** teñir con `.fila-fuera` / `.fila-vigilar` cualquier fila reglada propia que califique un valor, no
  solo las de `Medida`.
- **Do** poner todo identificador, cifra y valor copiable en `.valor` (mono tabular), y todo nombre de columna
  en `.rotulo`.
- **Do** usar `.titular` únicamente dentro de una región `.campo-lab`, invertido en blanco.
- **Do** envolver en `Muestra` con `BotonCopiar` todo lo que el usuario tenga que copiar fuera del sistema.
- **Do** acompañar cada veredicto fuera de rango de una nota en español llano que diga qué significa y cuál es
  el siguiente paso.
- **Do** declarar los seis estados en cada vista: reposo, hover, foco, cargando (`Midiendo`), vacío (`Vacio`) y
  error.
- **Do** usar `sin-dato` —guion y `tinta-3`— cuando algo no se ha podido medir; no fingir un veredicto.
- **Do** mantener el foco visible de 2px en petróleo y el contraste AA; el texto más tenue admitido es `tinta-3`.
- **Do** escribir toda la interfaz en español, con la terminología fijada: buzón, alias, clave de API, plan,
  entregabilidad.

### Don't:

- **Don't** reintroducir el mundo anterior: chasis oscuro completo, acento naranja `rgb(255 122 26)`, etiquetas
  de papel con esquina doblada, sellos girados ni códigos de barras derivados del dato. Es anti-referencia explícita.
- **Don't** volver a reducir la identidad a un filete: el membrete de página es una región, y solo sobreviven dos
  bordes de petróleo (el recorte de una `Muestra` y el membrete de la portada de acceso).
- **Don't** usar `laboratorio-vivo` sobre papel blanco: existe para leerse sobre el campo oscuro y solo ahí.
- **Don't** marcar una medición fuera de rango únicamente con la `Marca` del margen: sin tinte de fila, el orden
  por veredicto no se ve.
- **Don't** usar tarjetas de métrica ni una fila de KPIs grandes: las únicas piezas a gran cuerpo son el titular
  del membrete y la puntuación de entregabilidad, una por vista.
- **Don't** colorear fondos, bordes, títulos ni iconos fuera de la lógica de veredicto o de la región de identidad.
- **Don't** pintar un valor de petróleo ni un veredicto de petróleo.
- **Don't** añadir sombras, brillos, cristales, texturas de papel fingidas ni bordes redondeados: el único
  degradado del sistema es el del campo de identidad, y el radio es 0 salvo las tres excepciones funcionales.
- **Don't** poner dos botones de relleno en la misma vista, ni convertir un enlace de navegación en botón principal.
- **Don't** usar `<table>` con bordes de celda ni rejillas de tarjetas para datos comparables.
- **Don't** truncar identificadores con elipsis en móvil ni esconder columnas sin trasladar su rótulo a la celda.
- **Don't** emplear emoji, iconos de colores ni ilustraciones como glifo de estado: el veredicto es geometría de
  un solo trazo.
- **Don't** usar un spinner genérico como estado de carga; el instrumento mide (`Midiendo`) y dice qué está
  midiendo.
- **Don't** usar Archivo Narrow en pesos distintos de 500 y 600: no están cargados.
- **Don't** poner versalitas espaciadas en prosa, ayudas ni mensajes de error; `.titular` es la única versalita
  de gran cuerpo, y solo en el membrete.
- **Don't** introducir un tema oscuro ni invertir la relación mesa/hoja: lo único oscuro es el campo de identidad.
