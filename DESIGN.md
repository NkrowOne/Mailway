# Sistema de diseño de Mailway

<!-- impeccable:design-doc 1 -->

Registrado desde el mundo construido (no desde la intención). Mundo:
**central de clasificación postal**. El panel es el chasis y la cinta; todo lo
que el usuario debe llevarse fuera del sistema se imprime en una **etiqueta de
papel**. Clave de dirección: `mailway1` (forma 7/7 de la lista ordenada por
resonancia). Modo: **Operate**.

## Tesis

La infraestructura de correo como sala de máquinas de una central de reparto:
el operador ve la nave en marcha, localiza el paquete atascado (DNS pendiente,
IP en lista negra) y **imprime la etiqueta que lo arregla**. Rechaza el panel
SaaS oscuro genérico de acento azul con tarjetas iguales, y la plantilla
hero-metric.

## Color

Estrategia: **Restrained** — chasis neutro cálido + un único acento de acción.

| Token | RGB | Rol |
|---|---|---|
| `--cinta` | 19 20 23 | Fondo base (la cinta transportadora) |
| `--chasis` | 26 27 32 | Paneles (+7%) |
| `--chasis-2` | 31 33 39 | Filas activas, inputs elevados (+9%) |
| `--chasis-3` | 38 40 47 | Popovers y diálogos (+12%) |
| `--tinta` | 232 230 225 | Texto principal (papel cálido) |
| `--tinta-2` | 174 173 168 | Secundario |
| `--tinta-3` | 146 146 140 | Metadatos (AA sobre chasis a tamaños pequeños) |
| `--etiqueta` | 243 240 232 | Papel de etiqueta (lo copiable) |
| `--etiqueta-tinta` | 26 26 23 | Tinta casi negra sobre etiqueta |
| `--accion` | 255 122 26 | **Naranja de seguridad: única tecla de acción** |
| `--entregado / --transito / --devuelto` | verde/ámbar/rojo desat. | Semáforo de reparto |

Elevación: **una sola estrategia** — desplazamiento de color de superficie
(sin sombras salvo `--flotante` en diálogos). Bordes a `rgba(255,255,255,.05–.14)`.

## Tipografía

Auto-hospedadas vía `@fontsource` (sin caras de sistema como voz):

- **Barlow** — UI y cuerpo (400/500/600).
- **Barlow Condensed** — rotulación de nave: cabeceras, secciones, sellos.
- **Martian Mono** — «guía»: identificadores (correos, dominios, registros
  DNS, claves, IDs). Todo lo que hay que teclear o copiar va en mono.

Escala 1.25 sobre cuerpo 14 (micro 11 · sm 12.5 · base 14 · md 16 · lg 18 ·
xl 22 · 2xl 28 · 3xl 44). Números dinámicos con `tabular-nums` (clase `.num`).

## Signaturas (dónde vive el mundo)

1. **Etiqueta de papel** (`ui/kit.tsx` → `Etiqueta`): esquina doblada en
   geometría vectorial (clip-path), sin texturas fingidas. Envuelve TODO lo
   copiable: registros DNS (aduana del dominio), credenciales de buzón
   (una vez), clave de API, ejemplo curl, datos de conexión.
2. **Sellos de estado** (`Sello`): tampón girado −8° que **no desaparece**;
   VERIFICADO (registro DNS correcto), REVOCADA (clave), HECHO (manifiesto),
   LIMPIA (lista negra). «Nada desaparece, se cancela».
3. **Tecla de acción única**: naranja de seguridad, una por vista
   (`Button variant="accion"`). El resto en chasis/fantasma.
4. **Códigos de barras derivados del dato** (`Barcode`): geometría
   determinista por hash del correo/prefijo. Identifican filas de buzones,
   claves y registros DNS.
5. **Chevrones de enrutado**: en el logo, el paso activo del manifiesto, la
   línea de operación del panel admin, y los hover de «siguiente».
6. **Medidores de carga** (`Medidor`): uso/límite del plan con graduación,
   como el indicador de un contenedor; verde→ámbar→rojo.
7. **Cinta en marcha** como estado de carga (no spinner).

## Composición

- **Primer viewport del cliente** (`InicioCliente`): manifiesto de puesta en
  marcha a la izquierda (ALTA ›› DNS ›› BUZONES ›› API), medidores de carga a
  la derecha, una única tecla naranja.
  - *Adaptación citada*: la tecla dice «Siguiente parada: <paso pendiente>»
    en lugar de «Añadir dominio» cuando el cliente ya avanzó en el manifiesto
    (verdad del estado). En primera ejecución real (0/4, sin dominio) muestra
    «Añadir dominio». Ambas rutas nacen del mismo estado del manifiesto.
- **Panel de operaciones del admin**: línea «En marcha ahora» encadenada por
  chevrones de enrutado, inventario, avisos de entregabilidad y **movimiento
  reciente** (la cinta en marcha, no un hueco muerto).
- **Aduana del dominio** (`DominioDetalle`): la superficie donde el mundo y la
  tarea coinciden — cada registro DNS es una etiqueta con su código de barras,
  semáforo Falta/No coincide/VERIFICADO y la línea roja «Ahora mismo el DNS
  devuelve». No aplanar.

## Reglas

- Estados obligatorios en cada vista: default, hover, foco, cargando, vacío,
  error. Vacíos con silueta de paquete en tránsito.
- Superficies de navegador tematizadas: selección, caret, scrollbars, foco
  (todos naranja/chasis).
- Secretos (contraseñas, claves) se muestran **una vez**, en etiqueta, con
  copia en un clic.
- Interfaz 100% en español; errores que nombran el problema y el arreglo.
- Accesible por teclado; contraste AA en ambos tamaños.
