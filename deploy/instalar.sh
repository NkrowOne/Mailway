#!/usr/bin/env bash
# ============================================================================
# Instalador de Mailway
# ----------------------------------------------------------------------------
# Deja en marcha el motor de correo (Stalwart), el webmail (Roundcube) y, si
# se dispone de Skyway, el panel de Mailway desplegado desde GitHub. Es
# idempotente: puede ejecutarse tantas veces como haga falta y reutiliza la
# configuración y los secretos de deploy/.env.
#
# Uso:
#   sudo bash deploy/instalar.sh                 # junto a Skyway (recomendado)
#   sudo bash deploy/instalar.sh --sin-skyway    # todo en un compose propio
#   sudo bash deploy/instalar.sh --actualizar    # reaplicar sin preguntas
#   sudo bash deploy/instalar.sh --comprobar     # diagnóstico de solo lectura
#   sudo bash deploy/instalar.sh --probar-acceso # abrir un buzón desde el webmail
#   sudo bash deploy/instalar.sh --emparejar     # repetir solo el emparejado con Skyway
#   sudo bash deploy/instalar.sh --migrar-motor  # pasar de Stalwart 0.15 a 0.16 (con vuelta atrás)
#   bash deploy/instalar.sh --ayuda
#
# Ejecución desatendida: todas las preguntas se pueden responder con
# variables de entorno (ver --ayuda). Sin terminal interactiva, el
# instalador no pregunta y usa esas variables o los valores por defecto.
# ============================================================================
# Los «$t» y «$n» entre comillas simples son variables de jq, no de bash.
# shellcheck disable=SC2016
set -euo pipefail

VERSION_INSTALADOR="1.4.0"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$RAIZ/deploy"
ENV_FILE="${MAILWAY_ENV_FILE:-$DEPLOY_DIR/.env}"
COMPOSE_MAIL="$DEPLOY_DIR/docker-compose.mail.yml"
COMPOSE_SOLO="$DEPLOY_DIR/docker-compose.standalone.yml"
IMAGEN_CURL="curlimages/curl:8.11.1"
# Huella de la configuración de Roundcube: la etiqueta del webmail en los
# compose la usa para que Compose lo recree cuando cambia mailway.php.
MAILWAY_ROUNDCUBE_CONFIG_HASH=$(sha256sum "$DEPLOY_DIR/roundcube/mailway.php" 2>/dev/null | cut -c1-16 || true)
export MAILWAY_ROUNDCUBE_CONFIG_HASH
IMAGEN_JQ="ghcr.io/jqlang/jq:1.7.1"
# Motor de correo (MAILWAY_MOTOR en deploy/.env): elige el fichero
# motor/<motor>/compose.yml que completa el servicio mailway-mail.
MOTOR_015="stalwart-0.15"
MOTOR_016="stalwart-0.16"
MOTOR=""
COMPOSE_MOTOR_016="$DEPLOY_DIR/motor/stalwart-0.16/compose.yml"
# Último día con parches de seguridad de Stalwart 0.15 (SECURITY.md de la 0.16).
FIN_SOPORTE_015="2026-12-01"
FIN_SOPORTE_015_TEXTO="1 de diciembre de 2026"
# Diagnóstico del webmail: deploy/roundcube/diagnostico, que los compose montan en /opt/mailway.
COMPROBAR_PHP="/opt/mailway/comprobar.php"
LE_DIRECTORIO="https://acme-v02.api.letsencrypt.org/directory"

CON_SKYWAY=1
CON_CLOUDFLARE=1
ACTUALIZAR=0
COMPROBAR=0
PROBAR_ACCESO=0
EMPAREJAR=0
MIGRAR_MOTOR=0
REVERTIR_MOTOR=0
RETIRAR_MOTOR_ANTERIOR=0
# -y: sin confirmación en las órdenes del motor (las demás no preguntan nada
# que no se pueda responder con variables de entorno).
SIN_CONFIRMAR=0
INTERACTIVO=0
if [ -t 0 ] && [ -t 1 ]; then INTERACTIVO=1; fi

# Resultado de la última petición HTTP (ver peticion_http).
RESP_CODE=""
RESP_BODY=""

# Estado para el resumen final.
RESUMEN_CERT="pendiente"
RESUMEN_PTR="sin comprobar"
RESUMEN_P25="sin comprobar"
RESUMEN_DNS="sin comprobar"
RESUMEN_AJUSTES=""
RESUMEN_SKYWAY="no se ha desplegado el panel"
MIGRAR_CONTENEDORES=0
ENV_COPIADO=0
CERT_CONFIGURADO=0
SKYWAY_VERSION=""
PANEL_CONTENEDOR=""
CF_TOKEN=""
CF_ZONA_ID=""
CF_ZONA_NOMBRE=""
# Qué ha pasado con la cuenta de Cloudflare del operador en el panel y en
# Skyway (ver conectar_cloudflare_en_panel); vacío = no se ha intentado.
RESUMEN_CF_PANEL=""
RESUMEN_CF_SKYWAY=""
CF_PANEL_CONECTADA=0

# Emparejado con Skyway (ver emparejar_con_skyway).
ADMIN_EMAIL=""
PANEL_SERVICIO_ID=""
PANEL_PROYECTO_ID=""
# Panel que Skyway ya despliega (ver detectar_panel_existente): servicio,
# contenedor, nombre público y lo que interesa de su entorno en ejecución.
PANEL_EXISTENTE_SERVICIO=""
PANEL_EXISTENTE_CONTENEDOR=""
PANEL_EXISTENTE_HOST=""
declare -A PANEL_EXISTENTE_ENV=()
# Servicio de Skyway que se actualiza en lugar de crear otro: «proyecto
# slug-del-proyecto servicio slug-del-servicio» (ver localizar_panel_en_skyway).
PANEL_ADOPTADO=""
# 1 si quien instala ha dicho que el panel detectado no es el de esta instalación,
# y el servicio de Skyway de ese panel (no se reutiliza por su nombre).
PANEL_SIN_ADOPCION=0
PANEL_RECHAZADO=""
# 1 si SKYWAY_URL la fijó preparar_api_skyway_en_silencio (no la indicó nadie).
SKYWAY_URL_AUTOMATICA=0
# 1 si deploy/.env guarda el MAILWAY_TRAEFIK_TOKEN que usa el panel. Un panel
# anterior a la 1.0 lo tiene en su base de datos, no en sus variables: el del
# instalador no le sirve (ver la fusión de variables en desplegar_en_skyway).
TRAEFIK_TOKEN_PROPIO=1
SKY_TOKEN_TEMPORAL_ID=""
RESUMEN_EMPAREJADO="sin emparejar: no se ha desplegado el panel"
EMPAREJADO_OK=0
EMPAREJADO_ADMIN_EMAIL=""
# La contraseña del administrador que crea el emparejado: solo vive en esta
# variable hasta que el resumen la muestra (una vez) y la borra.
EMPAREJADO_ADMIN_PASSWORD=""
# Ficheros temporales que hay que borrar al salir, pase lo que pase.
ENV_TMP=""
ERR_TMP=""
# ¿Escribió avisos la última herramienta de terminal? (ver mostrar_errores_herramienta)
HERRAMIENTA_CON_AVISOS=0

# ------------------------------------------------------------------ salida --

if [ -t 1 ]; then
  C_TIT=$'\033[1m'; C_OK=$'\033[32m'; C_AV=$'\033[33m'; C_ER=$'\033[31m'; C_0=$'\033[0m'
else
  C_TIT=""; C_OK=""; C_AV=""; C_ER=""; C_0=""
fi

titulo() { printf '\n%s== %s ==%s\n' "$C_TIT" "$*" "$C_0"; }
info() { printf '   %s\n' "$*"; }
ok() { printf '   %s[ok]%s %s\n' "$C_OK" "$C_0" "$*"; }
aviso() { printf '   %s[aviso]%s %s\n' "$C_AV" "$C_0" "$*" >&2; }
fallo() {
  printf '\n   %s[error]%s %s\n' "$C_ER" "$C_0" "$*" >&2
  exit 1
}

ayuda() {
  cat <<'AYUDA'
Instalador de Mailway

Uso: sudo bash deploy/instalar.sh [opciones]

Opciones:
  --sin-skyway      Instala panel, motor y webmail con docker-compose.standalone.yml,
                    con un Traefik propio en 80/443 si esos puertos están libres.
  --sin-cloudflare  No usa la API de Cloudflare: los registros DNS se crean a mano.
  --actualizar      Reaplica la configuración existente (deploy/.env) sin preguntas:
                    descarga imágenes, recrea contenedores, reaplica los ajustes del
                    motor y, con Skyway, actualiza las variables y redespliega el panel.
                    Mantiene el modo de la instalación (junto a Skyway o autónoma).
                    Ejecuta antes «git pull» en la carpeta de Mailway.
  --comprobar       Diagnóstico de solo lectura: contenedores, ajustes y certificado del
                    motor (993 y 465; con la 0.16, también el 587), conexión IMAP y SMTP
                    desde el webmail y extractor del certificado. No cambia nada. Código de
                    salida 1 si algo falla.
  --probar-acceso   Pide la dirección y la contraseña de un buzón (sin mostrarla ni
                    guardarla) e inicia sesión desde el webmail: un único intento, porque
                    cada contraseña incorrecta cuenta para el bloqueo automático del motor.
  --emparejar       Repite solo el emparejado del panel con Skyway con la configuración de
                    deploy/.env: crea el administrador del panel si aún no existe, completa su
                    puesta en marcha y conecta Skyway con un token de gestión nuevo.
  --migrar-motor    Pasa el motor de Stalwart 0.15 a 0.16 (las instalaciones nuevas ya usan
                    la 0.16): comprueba antes, copia y convierte los datos con las
                    herramientas oficiales, verifica antes de abrir los puertos y, si algo
                    falla, vuelve sola a la 0.15, cuyo volumen no se toca. Pide confirmación.
                    Unos minutos sin correo; las contraseñas de aplicación hay que crearlas de
                    nuevo (sección 8.3 de docs/DESPLIEGUE-SKYWAY.md).
  --revertir-motor  Vuelve a Stalwart 0.15 tras una migración terminada. El correo recibido
                    desde entonces se queda en el volumen de la 0.16. Pide confirmación.
  --retirar-motor-anterior
                    Borra el volumen de Stalwart 0.15 que la migración conserva como vuelta
                    atrás. Pide escribir su nombre. Sin vuelta atrás.
  -y, --si          Sin confirmación en --migrar-motor y --revertir-motor (en
                    --retirar-motor-anterior, además MAILWAY_RETIRAR_VOLUMEN=<volumen>).
  --ayuda           Muestra esta ayuda.

Junto a Skyway, el instalador termina emparejando el panel con Skyway: crea la cuenta de
administración del panel (su contraseña se muestra una sola vez en el resumen), completa
la puesta en marcha y conecta Skyway → Ajustes → Correo (Mailway) sin pasos manuales.
Si el emparejado falla, la instalación no se interrumpe: repítelo con --emparejar.

Con un token de Cloudflare, el instalador lo pasa también al panel (como cuenta de la
instancia) y a Skyway por la entrada estándar de sus herramientas: los dominios que da de
alta el administrador configuran su DNS solos, sin modificar los registros existentes. Las
acciones de los clientes nunca usan esa cuenta. El token no se guarda en deploy/.env:
--actualizar sin CLOUDFLARE_API_TOKEN y --emparejar (que nunca lo usa, ni con esa variable)
no lo tienen y no tocan la cuenta que hubiera conectada; con un token nuevo en
CLOUDFLARE_API_TOKEN, --actualizar lo sustituye en esa cuenta.

Los secretos (CLOUDFLARE_API_TOKEN, SKYWAY_TOKEN, STALWART_ADMIN_PASSWORD) nunca se escriben en
la orden: delante de sudo («sudo CLOUDFLARE_API_TOKEN=… bash …») quedan a la vista en «ps»
mientras dura la instalación. Léelos sin mostrarlos y pásalos por el entorno:
  read -rs CLOUDFLARE_API_TOKEN; export CLOUDFLARE_API_TOKEN
  sudo --preserve-env=CLOUDFLARE_API_TOKEN bash deploy/instalar.sh --actualizar

Variables de entorno (ejecución desatendida):
  MAILWAY_DOMINIO           Dominio base (mail., webmail. y panel. cuelgan de él).
  MAILWAY_MAIL_HOST         Nombre del servidor de correo (por defecto mail.<dominio>).
  MAILWAY_WEBMAIL_HOST      Nombre del webmail (por defecto webmail.<dominio>).
  MAILWAY_PANEL_HOST        Nombre del panel (por defecto panel.<dominio>).
  MAILWAY_IP                IPv4 pública del servidor (se detecta si falta).
  MAILWAY_MARCA             Nombre del servicio en el webmail (por defecto «Webmail»).
  LETSENCRYPT_EMAIL         Correo de contacto para Let's Encrypt.
  CLOUDFLARE_API_TOKEN      Token de Cloudflare (Zona: Lectura y DNS: Edición). Vacío = sin Cloudflare.
                            Además del DNS de la plataforma, se guarda en el panel (cuenta de la
                            instancia) y en Skyway para que el DNS de los dominios que da de alta el
                            administrador se configure solo. Nunca se escribe en deploy/.env.
  MAILWAY_ADMIN_EMAIL       Correo de la cuenta de administración del panel que crea el emparejado
                            con Skyway (por defecto, el de Let's Encrypt).
  SKYWAY_TOKEN              Token de API de Skyway (sky_…). Si falta y Skyway corre en este servidor
                            (contenedor «skyway»), se crea uno temporal (60 min) que se revoca al
                            terminar. Sin él ni Skyway en este servidor, no se despliega el panel.
  SKYWAY_URL                API de Skyway (por defecto http://127.0.0.1:4000; si ahí no responde,
                            se prueba la IP del contenedor «skyway»).
  SKYWAY_DIR                Carpeta de Skyway (se detecta a partir de su Traefik).
  MAILWAY_PROYECTO          Proyecto de Skyway para el panel (por defecto «mailway»).
  MAILWAY_REPO              Repositorio del panel (por defecto https://github.com/NkrowOne/Mailway).
  MAILWAY_RAMA              Rama a desplegar (por defecto main).
  MAILWAY_TRAEFIK_PROVEEDOR 1 para ajustar el Traefik de Skyway sin preguntar, 0 para no tocarlo.
                            Con Skyway 0.34 o posterior no se instala ningún fichero: su Traefik ya
                            lee las rutas de Mailway a través de Skyway (Ajustes → Correo (Mailway)).
  STALWART_ADMIN_PASSWORD   Contraseña del motor existente, si deploy/.env se perdió.
  MAILWAY_INTERNAL_SUBNET   Subred de la red interna (por defecto 10.203.53.0/24). Cámbiala si
                            choca con otra red del servidor.
  MAILWAY_MAIL_INTERNAL_IP  IP del motor en esa red (por defecto 10.203.53.10).
  MAILWAY_ESPERA_DNS        Segundos máximos de espera a que propague el DNS (por defecto 300).
  MAILWAY_DNS_REEMPLAZAR    1 = sin terminal, permite cambiar los registros A de mail., webmail. y
                            panel. que ya existan con otra IP o con el proxy de Cloudflare. Sin ella,
                            una ejecución desatendida no modifica ningún registro existente.
  MAILWAY_ENV_FILE          Fichero de configuración con los secretos (por defecto deploy/.env).
  MAILWAY_COMPOSE_EXTRA     Fichero de Compose adicional que se aplica sobre el del instalador
                            (ajustes locales; lo usa la prueba de la pila en la CI).
  MAILWAY_CLOUDFLARE_API    Base de la API de Cloudflare (solo para pruebas).
  MAILWAY_MOTOR             Motor de una instalación NUEVA: stalwart-0.16 (por defecto) o
                            stalwart-0.15. En una que ya existe manda deploy/.env: para cambiar
                            de motor, --migrar-motor.
  MAILWAY_MIGRACION_DIR     Carpeta de trabajo y registro de --migrar-motor (por defecto
                            deploy/.migracion-motor).
  MAILWAY_MIGRACION_COLA_MAX
                            Mensajes en la cola de salida a partir de los cuales --migrar-motor no
                            empieza (por defecto 50): pasan a la 0.16, pero una cola grande suele
                            ser un problema de entrega que conviene resolver antes.
  MAILWAY_MIGRACION_MINUTOS Duración máxima del mantenimiento del panel durante --migrar-motor
                            (por defecto 120; se quita al terminar, y caduca solo).
  MAILWAY_MIGRACION_CONSERVAR
                            1 = no borra de la carpeta de trabajo el volcado y el plan de la
                            migración (llevan contraseñas cifradas y claves DKIM): para revisarlos.
  MAILWAY_RETIRAR_VOLUMEN   Con --retirar-motor-anterior -y: el nombre del volumen de la 0.15.
  MAILWAY_TLS_CA_FILE       CA adicional para verificar el certificado del motor al migrar (solo
                            para pruebas con certificados de laboratorio).

Los nombres del servidor de correo, del webmail y del panel cuelgan directamente
del dominio base (un solo nivel: correo.miempresa.com, no a.b.miempresa.com).
AYUDA
}

while [ $# -gt 0 ]; do
  case "$1" in
    --sin-skyway) CON_SKYWAY=0 ;;
    --sin-cloudflare) CON_CLOUDFLARE=0 ;;
    --actualizar) ACTUALIZAR=1 ;;
    --comprobar) COMPROBAR=1 ;;
    --probar-acceso) PROBAR_ACCESO=1 ;;
    --emparejar) EMPAREJAR=1 ;;
    --migrar-motor) MIGRAR_MOTOR=1 ;;
    --revertir-motor) REVERTIR_MOTOR=1 ;;
    --retirar-motor-anterior) RETIRAR_MOTOR_ANTERIOR=1 ;;
    -y | --si | --yes) SIN_CONFIRMAR=1 ;;
    --ayuda | -h | --help)
      ayuda
      exit 0
      ;;
    *) fallo "Opción desconocida: $1 (usa --ayuda)." ;;
  esac
  shift
done

if [ "$((ACTUALIZAR + COMPROBAR + PROBAR_ACCESO + EMPAREJAR + MIGRAR_MOTOR + REVERTIR_MOTOR + RETIRAR_MOTOR_ANTERIOR))" -gt 1 ]; then
  fallo "Las opciones --actualizar, --comprobar, --probar-acceso, --emparejar, --migrar-motor, --revertir-motor y --retirar-motor-anterior no se combinan: usa una."
fi
if [ "$SIN_CONFIRMAR" = 1 ] && [ "$((MIGRAR_MOTOR + REVERTIR_MOTOR + RETIRAR_MOTOR_ANTERIOR))" = 0 ]; then
  fallo "-y solo sirve con --migrar-motor, --revertir-motor o --retirar-motor-anterior."
fi
if [ "$EMPAREJAR" = 1 ] && [ "$CON_SKYWAY" = 0 ]; then
  fallo "El emparejado solo existe junto a Skyway: --emparejar no se combina con --sin-skyway."
fi
# --emparejar usa lo que ya está en deploy/.env: no pregunta nada.
if [ "$ACTUALIZAR" = 1 ] || [ "$EMPAREJAR" = 1 ]; then INTERACTIVO=0; fi
if [ -n "${MAILWAY_COMPOSE_EXTRA:-}" ] && [ ! -f "$MAILWAY_COMPOSE_EXTRA" ]; then
  fallo "No existe el fichero de MAILWAY_COMPOSE_EXTRA: $MAILWAY_COMPOSE_EXTRA."
fi

# -------------------------------------------------------------- utilidades --

tiene() { command -v "$1" >/dev/null 2>&1; }

# Al salir, también tras un fallo o una interrupción: sin ficheros temporales,
# sin el token temporal de Skyway y sin perder la contraseña del administrador
# que acaba de crear el emparejado (si el resumen no llegó a mostrarla).
# Con una migración del motor a medias (--migrar-motor), además, la vuelta
# atrás: a la 0.15 si ya se había parado (código 1, o 2 si tampoco se puede
# volver), o solo el fin del mantenimiento si aún no se había tocado nada.
al_salir() {
  local codigo=$?
  if [ -n "$ENV_TMP" ]; then rm -f "$ENV_TMP"; fi
  if [ -n "$ERR_TMP" ]; then rm -f "$ERR_TMP"; fi
  case "${MIG_FASE:-}" in
    parado | abierto)
      if volver_a_015; then codigo=1; else codigo=2; fi
      ;;
    preparada)
      MIG_FASE=""
      set +e
      desactivar_mantenimiento
      limpiar_trabajo_migracion
      info "No se ha cambiado nada del motor: sigue Stalwart 0.15."
      ;;
    '')
      # Otra orden del motor que no termina (o una comprobación previa que
      # falla): sin mantenimiento que dure de más ni descargas sueltas.
      if [ -n "${MIG_DIR:-}" ] && [ "$codigo" != 0 ]; then
        set +e
        desactivar_mantenimiento
        limpiar_trabajo_migracion
      fi
      ;;
  esac
  revocar_token_temporal_skyway || true
  if [ -n "$EMPAREJADO_ADMIN_PASSWORD" ]; then
    printf '\n'
    info "Cuenta de administración del panel creada por el emparejado (la contraseña se muestra solo esta vez):"
    info "  Correo:     $EMPAREJADO_ADMIN_EMAIL"
    info "  Contraseña: $EMPAREJADO_ADMIN_PASSWORD"
    EMPAREJADO_ADMIN_PASSWORD=""
  fi
  exit "$codigo"
}
trap al_salir EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Pregunta con valor por defecto. Sin terminal, devuelve el valor por defecto.
preguntar() {
  local __var=$1 __texto=$2 __def=${3:-} __resp=""
  if [ "$INTERACTIVO" = 1 ]; then
    if [ -n "$__def" ]; then
      read -r -p "   $__texto [$__def]: " __resp || true
    else
      read -r -p "   $__texto: " __resp || true
    fi
  fi
  if [ -z "$__resp" ]; then __resp=$__def; fi
  printf -v "$__var" '%s' "$__resp"
}

# Pregunta sin eco (tokens). Sin terminal, devuelve el valor por defecto.
preguntar_secreto() {
  local __var=$1 __texto=$2 __def=${3:-} __resp=""
  if [ "$INTERACTIVO" = 1 ]; then
    read -r -s -p "   $__texto: " __resp || true
    printf '\n'
  fi
  if [ -z "$__resp" ]; then __resp=$__def; fi
  printf -v "$__var" '%s' "$__resp"
}

# confirmar "texto" s|n → 0 si la respuesta es sí.
confirmar() {
  local texto=$1 def=${2:-n} resp=""
  if [ "$INTERACTIVO" = 1 ]; then
    if [ "$def" = s ]; then
      read -r -p "   $texto [S/n]: " resp || true
    else
      read -r -p "   $texto [s/N]: " resp || true
    fi
  fi
  if [ -z "$resp" ]; then resp=$def; fi
  case "$resp" in s | S | si | sí | Si | Sí | SI | y | Y) return 0 ;; *) return 1 ;; esac
}

# Hexadecimal aleatorio de $1 bytes. od lee exactamente N bytes, así que no
# hay tuberías cortadas (con pipefail, «tr </dev/urandom | head» aborta).
aleatorio_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

# Lee CLAVE de deploy/.env sin ejecutarlo (quita comillas envolventes).
leer_env() {
  local linea valor
  [ -f "$ENV_FILE" ] || return 0
  linea=$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 || true)
  valor=${linea#*=}
  case "$valor" in
    \'*\') valor=${valor:1:${#valor}-2} ;;
    \"*\") valor=${valor:1:${#valor}-2} ;;
  esac
  printf '%s' "$valor"
}

# Escapa un texto para una línea «clave = "valor"» de configuración de curl.
# Un salto de línea sin escapar terminaría la línea y el resto se leería
# como otra opción de curl: se convierten en sus secuencias de escape.
escapar_curl() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

# Escapa un texto para una cadena JSON. Los demás caracteres de control no
# tienen cabida en ningún valor del instalador y se descartan.
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  s=${s//[[:cntrl:]]/}
  printf '%s' "$s"
}

# ¿Casa el texto ENTERO con la expresión regular extendida? Con «grep» bastaría
# con que casara una de sus líneas: un valor con un salto de línea pasaría.
coincide() { [[ $1 =~ $2 ]]; }

# Dirección de correo razonable (la validación completa la hace quien la usa).
correo_valido() { coincide "$1" '^[A-Za-z0-9._%+-]+@([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$'; }

# Correo de la cuenta de administración del panel: además, nada de lo que el
# panel rechaza (zod .email(): «%», «..» o un punto al principio o al final
# de la parte local). Así un valor que el panel no admite falla aquí, al
# principio, y no en el emparejado del final de la instalación.
correo_admin_valido() {
  correo_valido "$1" || return 1
  case "$1" in *%* | *..* | .* | *.@*) return 1 ;; esac
  [ "${#1}" -le 254 ]
}

# ¿Tiene el texto caracteres de control (saltos de línea incluidos)?
tiene_control() { case "$1" in *[[:cntrl:]]*) return 0 ;; *) return 1 ;; esac; }

# Nombre de host en minúsculas (RFC 1123, con al menos un punto). Es lo que
# acaba en las reglas Host(`…`) de Traefik y en deploy/.env.
host_valido() {
  coincide "$1" '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' &&
    [ "${#1}" -le 253 ]
}

ipv4_valida() {
  local IFS=. octeto
  case "$1" in '' | *[!0-9.]*) return 1 ;; esac
  # shellcheck disable=SC2086 # se separa por puntos a propósito
  set -- $1
  [ $# -eq 4 ] || return 1
  for octeto in "$@"; do
    case "$octeto" in '' | *[!0-9]*) return 1 ;; esac
    [ "${#octeto}" -le 3 ] && [ "$((10#$octeto))" -le 255 ] || return 1
  done
}

# IPv4 como entero (para comparar rangos).
ipv4_num() {
  local IFS=. a b c d
  # shellcheck disable=SC2086
  set -- $1
  a=$((10#$1)) b=$((10#$2)) c=$((10#$3)) d=$((10#$4))
  printf '%s' "$(((a << 24) | (b << 16) | (c << 8) | d))"
}

# Rango IPv4 en notación CIDR (cualquier prefijo).
cidr_formato() {
  local ip=${1%/*} bits=${1#*/}
  if [ "$ip" = "$1" ] || ! ipv4_valida "$ip"; then return 1; fi
  case "$bits" in '' | *[!0-9]*) return 1 ;; esac
  [ "$bits" -le 32 ]
}

# Subred utilizable para la red interna: ni enorme ni sin sitio para el motor.
cidr_valido() {
  cidr_formato "$1" && [ "${1#*/}" -ge 8 ] && [ "${1#*/}" -le 29 ]
}

# ¿Se solapan dos rangos IPv4 en notación CIDR?
cidr_solapan() {
  local a=$1 b=$2 ma mb m
  ma=${a#*/}
  mb=${b#*/}
  m=$((ma < mb ? ma : mb))
  [ "$(($(ipv4_num "${a%/*}") >> (32 - m)))" = "$(($(ipv4_num "${b%/*}") >> (32 - m)))" ]
}

# ¿Está la IP dentro del rango?
ip_en_cidr() { cidr_solapan "$1/32" "$2"; }

# Línea CLAVE='valor' de deploy/.env. Entre comillas simples, Compose no
# interpreta «$», «#» ni espacios; a cambio, el valor no puede contener una
# comilla simple ni saltos de línea (no hay forma de escaparlos).
linea_env() {
  case "$2" in
    *\'*) fallo "El valor de $1 contiene una comilla simple, que deploy/.env no admite." ;;
  esac
  if tiene_control "$2"; then fallo "El valor de $1 contiene caracteres de control."; fi
  printf "%s='%s'\n" "$1" "$2"
}

# jq del sistema o, si no está instalado, el de su imagen oficial.
jqr() {
  if tiene jq; then
    jq "$@"
  else
    docker run --rm -i "$IMAGEN_JQ" "$@"
  fi
}

# Petición HTTP con las credenciales por la entrada estándar (-K -): ni el
# token ni la contraseña aparecen en la lista de procesos.
#   peticion_http <cabecera de autorización> <método> <url> [cuerpo JSON]
peticion_http() {
  local auth=$1 metodo=$2 url=$3 cuerpo=${4:-} salida
  salida=$(
    {
      if [ -n "$auth" ]; then printf 'header = "%s"\n' "$(escapar_curl "$auth")"; fi
      if [ -n "$cuerpo" ]; then
        printf 'header = "Content-Type: application/json"\n'
        printf 'data = "%s"\n' "$(escapar_curl "$cuerpo")"
      fi
    } | curl -sS --max-time 30 -X "$metodo" -w '\n%{http_code}' -K - "$url" 2>/dev/null
  ) || {
    RESP_CODE="000"
    RESP_BODY=""
    return 0
  }
  RESP_CODE=${salida##*$'\n'}
  RESP_BODY=${salida%$'\n'*}
}

cf_api() { peticion_http "Authorization: Bearer $CF_TOKEN" "$1" "${MAILWAY_CLOUDFLARE_API:-https://api.cloudflare.com/client/v4}$2" "${3:-}"; }
sky_api() { peticion_http "Authorization: Bearer $SKYWAY_TOKEN" "$1" "$SKYWAY_URL$2" "${3:-}"; }

# API de gestión del motor desde un contenedor efímero en la red interna: el
# puerto 8080 del motor no está publicado en el host.
motor_api() {
  local metodo=$1 ruta=$2 cuerpo=${3:-}
  {
    printf 'user = "admin:%s"\n' "$(escapar_curl "$STALWART_ADMIN_PASSWORD")"
    if [ -n "$cuerpo" ]; then
      printf 'header = "Content-Type: application/json"\n'
      printf 'data = "%s"\n' "$(escapar_curl "$cuerpo")"
    fi
  } | docker run -i --rm --network mailway-internal "$IMAGEN_CURL" \
    -sS --max-time 30 -X "$metodo" -K - "http://mailway-mail:8080$ruta"
}

# Operación «insert» de /api/settings con los pares clave valor indicados.
motor_op_insertar() {
  local valores="" primero=1
  while [ $# -gt 1 ]; do
    if [ "$primero" = 0 ]; then valores+=","; fi
    primero=0
    valores+=$(printf '["%s","%s"]' "$(json_escape "$1")" "$(json_escape "$2")")
    shift 2
  done
  printf '{"type":"insert","prefix":null,"values":[%s],"assert_empty":false}' "$valores"
}

# Inserta ajustes (pares clave valor) en el motor y lo recarga. Devuelve 1 si
# el motor informa de errores.
motor_ajustes() { motor_cambios "[$(motor_op_insertar "$@")]"; }

# Aplica en el motor una lista JSON de operaciones de /api/settings (las
# procesa en orden y se detiene en la primera que falla) y lo recarga.
# Devuelve 1 si el motor informa de errores.
motor_cambios() {
  local respuesta errores
  respuesta=$(motor_api POST /api/settings "$1") || return 1
  if ! printf '%s' "$respuesta" | grep -q '"data"'; then
    # El motor no repite los valores en sus errores, pero el token de
    # Cloudflare nunca debe acabar en pantalla: se tapa por si acaso.
    if [ -n "$CF_TOKEN" ]; then respuesta=${respuesta//"$CF_TOKEN"/•••}; fi
    aviso "El motor rechazó los ajustes: $respuesta"
    return 1
  fi
  respuesta=$(motor_api GET /api/reload) || return 1
  errores=$(printf '%s' "$respuesta" | jqr -r '(.data.errors // {}) | to_entries | map("\(.key): \(.value)") | join("; ")' 2>/dev/null || true)
  if [ -n "$CF_TOKEN" ]; then errores=${errores//"$CF_TOKEN"/•••}; fi
  if [ -n "$errores" ]; then
    aviso "El motor recargó con errores: $errores"
    return 1
  fi
  return 0
}

# Cuerpo de una petición de gestión de Stalwart 0.16 (JMAP en /jmap) con las
# llamadas $1, una lista JSON. Sin la capacidad urn:stalwart:jmap en «using»,
# los métodos x:… no existen.
jmap_cuerpo() { printf '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":%s}' "$1"; }

# Petición JMAP a la gestión del motor 0.16, como motor_api: desde un
# contenedor efímero en la red interna y con la credencial por la entrada
# estándar de curl. Deja la respuesta en RESP_CODE y RESP_BODY. Los errores
# de cada llamada llegan con HTTP 200 (RFC 8620): hay que mirar el cuerpo.
#   jmap_motor <cuerpo> [host del motor en la red interna]
jmap_motor() {
  local salida
  salida=$(
    {
      printf 'user = "admin:%s"\n' "$(escapar_curl "$STALWART_ADMIN_PASSWORD")"
      printf 'header = "Content-Type: application/json"\n'
      printf 'data = "%s"\n' "$(escapar_curl "$1")"
    } | docker run -i --rm --network mailway-internal "$IMAGEN_CURL" \
      -sS --max-time 60 -X POST -w '\n%{http_code}' -K - "http://${2:-mailway-mail}:8080/jmap" 2>/dev/null
  ) || {
    RESP_CODE="000"
    RESP_BODY=""
    return 0
  }
  RESP_CODE=${salida##*$'\n'}
  RESP_BODY=${salida%$'\n'*}
}

# Primer error de una respuesta JMAP (de la petición o de una llamada), o nada.
jmap_error() {
  if [ "$RESP_CODE" != 200 ]; then
    printf 'HTTP %s' "$RESP_CODE"
    return 0
  fi
  campo_json 'first((.methodResponses // [])[] | select(.[0] == "error") | .[1] | "\(.type)\(if .description then ": \(.description)" else "" end)") // empty'
}

# Imagen (con su versión exacta) de un compose: la que mantiene Dependabot.
#   imagen_compose <fichero> <inicio de la imagen, p. ej. python:>
imagen_compose() {
  sed -n -E "s#^[[:space:]]*image:[[:space:]]*($2[^[:space:]]+)[[:space:]]*\$#\1#p" "$1" | head -n 1
}

# Cambia (o añade) claves de deploy/.env sin tocar las demás: lo usan las
# órdenes del motor, que no tienen todos los datos de una instalación para
# reescribirlo entero. Un valor vacío quita la clave. Se escribe aparte y se
# renombra: un corte a medias no deja un fichero roto.
#   fijar_en_env CLAVE valor [CLAVE valor…]
fijar_en_env() {
  local tmp linea clave umask_previa i
  local -a pares=("$@")
  umask_previa=$(umask)
  umask 077
  tmp=$(mktemp "$(dirname "$ENV_FILE")/.env.XXXXXX")
  ENV_TMP=$tmp
  {
    while IFS= read -r linea || [ -n "$linea" ]; do
      clave=${linea%%=*}
      for ((i = 0; i < ${#pares[@]}; i += 2)); do
        if [ "$clave" = "${pares[i]}" ]; then continue 2; fi
      done
      printf '%s\n' "$linea"
    done <"$ENV_FILE"
    for ((i = 0; i < ${#pares[@]}; i += 2)); do
      if [ -n "${pares[i + 1]}" ]; then linea_env "${pares[i]}" "${pares[i + 1]}"; fi
    done
  } >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  ENV_TMP=""
  umask "$umask_previa"
}

# Estado de salud (o de ejecución, si no tiene healthcheck) de un contenedor.
estado_contenedor() {
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || printf 'ausente'
}

esperar_sano() {
  local contenedor=$1 max=$2 t=0 estado
  while [ "$t" -lt "$max" ]; do
    estado=$(estado_contenedor "$contenedor")
    case "$estado" in
      healthy) return 0 ;;
      running) return 0 ;;
    esac
    sleep 3
    t=$((t + 3))
  done
  return 1
}

# ¿Resuelve el nombre a la IP en los resolutores públicos? (DNS sobre HTTPS)
# Un resolutor que no contesta (red filtrada) no cuenta; los que contestan
# deben dar todos la IP esperada, y al menos uno tiene que contestar.
resuelve_a() {
  local nombre=$1 ip=$2 servidor respuesta contestados=0
  for servidor in "https://cloudflare-dns.com/dns-query" "https://dns.google/resolve"; do
    respuesta=$(curl -fsS --max-time 8 -H 'accept: application/dns-json' "$servidor?name=$nombre&type=A" 2>/dev/null) ||
      continue
    contestados=$((contestados + 1))
    printf '%s' "$respuesta" | grep -Fq "\"data\":\"$ip\"" || return 1
  done
  [ "$contestados" -gt 0 ]
}

# Compose da prioridad al entorno sobre --env-file: sin quitarla, una
# LETSENCRYPT_EMAIL exportada para responder al instalador ganaría al valor
# elegido y guardado en deploy/.env. Por lo mismo, el motor (MAILWAY_MOTOR,
# que elige motor/<motor>/compose.yml) se pasa siempre: es el que ha decidido
# el instalador, nunca uno que llegue exportado. MAILWAY_COMPOSE_EXTRA añade
# un fichero que se aplica encima (ajustes locales; la prueba de la pila de la
# CI lo usa para la CA de laboratorio).
compose() {
  local ficheros=(-f "$COMPOSE_MAIL")
  if [ "$CON_SKYWAY" = 0 ]; then ficheros=(-f "$COMPOSE_SOLO"); fi
  if [ -n "${MAILWAY_COMPOSE_EXTRA:-}" ]; then ficheros+=(-f "$MAILWAY_COMPOSE_EXTRA"); fi
  env -u LETSENCRYPT_EMAIL MAILWAY_MOTOR="${MOTOR:-$MOTOR_015}" docker compose --env-file "$ENV_FILE" "${ficheros[@]}" "$@"
}

# Compose sin su barra de progreso; la salida completa solo si falla.
compose_q() {
  local salida
  if ! salida=$(compose "$@" 2>&1); then
    printf '%s\n' "$salida" >&2
    return 1
  fi
}

puerto_ocupado_por_otro() {
  local puerto=$1 duenos
  tiene ss || return 1
  if [ -z "$(ss -ltnH "sport = :$puerto" 2>/dev/null)" ]; then return 1; fi
  # Ocupado por un contenedor de Mailway (reinstalación): no es un conflicto.
  duenos=$(docker ps --filter "publish=$puerto" --format '{{.Names}}' 2>/dev/null || true)
  if [ -n "$duenos" ] && ! printf '%s\n' "$duenos" | grep -qv '^mailway-'; then return 1; fi
  return 0
}

# ------------------------------------------------------------ comprobaciones --

comprobaciones_previas() {
  titulo "Comprobaciones previas"
  local falta=""
  for cmd in docker curl od grep sed awk timeout; do
    if ! tiene "$cmd"; then falta+=" $cmd"; fi
  done
  if [ -n "$falta" ]; then fallo "Faltan herramientas:$falta. Instálalas y vuelve a ejecutar."; fi
  docker info >/dev/null 2>&1 || fallo "No se puede hablar con Docker. Ejecuta como root (sudo) o con un usuario del grupo docker."
  docker compose version >/dev/null 2>&1 || fallo "Falta Docker Compose v2 («docker compose»). Instala el plugin docker-compose-plugin."
  ok "Docker y Docker Compose v2 disponibles."

  if [ "$CON_SKYWAY" = 1 ]; then
    if [ "$(docker inspect -f '{{.State.Running}}' skyway-traefik 2>/dev/null || true)" != "true" ]; then
      fallo "No está en marcha el Traefik de Skyway (contenedor skyway-traefik). Arranca Skyway o usa --sin-skyway."
    fi
    docker network inspect skyway-edge >/dev/null 2>&1 ||
      fallo "No existe la red skyway-edge de Skyway. Arranca Skyway o usa --sin-skyway."
    ok "Skyway detectado (Traefik y red skyway-edge)."
    # Let's Encrypt rechaza los contactos de example.com: con el valor por
    # defecto del compose de Skyway, Traefik no obtiene ningún certificado
    # (tampoco los del webmail y del servidor de correo).
    # Sin el flag (configuración por fichero) no se puede saber: no se avisa.
    local correo_le
    correo_le=$(docker inspect -f '{{json .Config.Cmd}}' skyway-traefik 2>/dev/null |
      grep -o 'acme\.email=[^",]*' | head -n 1 || true)
    if [ -n "$correo_le" ]; then
      correo_le=${correo_le#acme.email=}
      case "$correo_le" in
        '' | *@example.com | *@example.org | *@example.net)
          aviso "El Traefik de Skyway no tiene un correo válido para Let's Encrypt («${correo_le:-vacío}»): no obtendrá certificados."
          aviso "Define LETSENCRYPT_EMAIL en el fichero .env de Skyway y ejecuta «docker compose up -d traefik» en su carpeta."
          ;;
      esac
    fi
  fi

  local puerto ocupados=""
  for puerto in 25 465 587 993 4190; do
    if puerto_ocupado_por_otro "$puerto"; then ocupados+=" $puerto"; fi
  done
  if [ -n "$ocupados" ]; then
    fallo "Puertos de correo ocupados por otro programa:$ocupados. Libéralos (p. ej. postfix o exim del sistema) y vuelve a ejecutar."
  fi
  if tiene ss; then ok "Puertos 25, 465, 587, 993 y 4190 libres."; else aviso "Sin «ss» no se pueden comprobar los puertos."; fi

  if timeout 6 bash -c 'exec 3<>/dev/tcp/gmail-smtp-in.l.google.com/25' 2>/dev/null; then
    RESUMEN_P25="abierto"
    ok "Puerto 25 de salida abierto."
  else
    RESUMEN_P25="BLOQUEADO"
    aviso "El puerto 25 de salida parece bloqueado: sin él no se entrega correo a otros servidores. Solicita al proveedor que lo desbloquee."
  fi
}

# -------------------------------------------------------------- configuración --

detectar_ip() {
  local ip=""
  ip=$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)
  if ! ipv4_valida "$ip"; then
    ip=$(curl -4 -fsS --max-time 8 https://ipv4.icanhazip.com 2>/dev/null | tr -d '[:space:]' || true)
  fi
  if ipv4_valida "$ip"; then printf '%s' "$ip"; fi
}

# Nombre de un servicio de la plataforma: el indicado (variable o deploy/.env)
# si cuelga directamente del dominio base, o <prefijo>.<dominio>. Un solo
# nivel: el panel deduce de él el dominio de la autoconfiguración.
elegir_host() {
  local __var=$1 prefijo=$2 indicado=$3 variable=$4 previo=$5 host
  host=$(printf '%s' "${indicado:-$previo}" | tr '[:upper:]' '[:lower:]')
  if [ -n "$host" ] && { [ "${host#*.}" != "$DOMINIO" ] || ! host_valido "$host"; }; then
    if [ -n "$indicado" ]; then
      aviso "Se ignora $variable=«$indicado»: debe ser un nombre directamente bajo $DOMINIO."
    fi
    host=""
  fi
  printf -v "$__var" '%s' "${host:-$prefijo.$DOMINIO}"
}

recoger_datos() {
  titulo "Datos de la instalación"
  if [ "$ACTUALIZAR" = 1 ] && [ ! -f "$ENV_FILE" ]; then
    fallo "No existe $ENV_FILE: no hay nada que actualizar. Ejecuta el instalador sin --actualizar."
  fi

  local mail_prev dominio_def
  mail_prev=$(leer_env MAIL_HOSTNAME)
  # Sin deploy/.env (panel creado a mano en Skyway), los nombres que ya usa.
  mail_prev=${mail_prev:-$(valor_panel MAILWAY_MAIL_HOSTNAME)}
  dominio_def=${MAILWAY_DOMINIO:-}
  # Los nombres cuelgan de un solo nivel bajo el dominio base: quitar la
  # primera etiqueta lo recupera también con un nombre propio (correo.x.com).
  if [ -z "$dominio_def" ] && [ -n "$mail_prev" ]; then dominio_def=${mail_prev#*.}; fi
  preguntar DOMINIO "Dominio base de la plataforma (p. ej. miempresa.com)" "$dominio_def"
  DOMINIO=$(printf '%s' "$DOMINIO" | tr '[:upper:]' '[:lower:]' | sed 's/^[.]*//; s/[.]*$//')
  host_valido "$DOMINIO" ||
    fallo "Dominio no válido: «$DOMINIO». Indica un dominio como miempresa.com (variable MAILWAY_DOMINIO)."

  local webmail_prev panel_prev
  webmail_prev=$(leer_env WEBMAIL_HOSTNAME)
  webmail_prev=${webmail_prev:-$(host_de_url "$(valor_panel MAILWAY_WEBMAIL_URL)")}
  panel_prev=$(leer_env PANEL_HOSTNAME)
  panel_prev=${panel_prev:-$PANEL_EXISTENTE_HOST}
  elegir_host MAIL_HOSTNAME mail "${MAILWAY_MAIL_HOST:-}" MAILWAY_MAIL_HOST "$mail_prev"
  elegir_host WEBMAIL_HOSTNAME webmail "${MAILWAY_WEBMAIL_HOST:-}" MAILWAY_WEBMAIL_HOST "$webmail_prev"
  elegir_host PANEL_HOSTNAME panel "${MAILWAY_PANEL_HOST:-}" MAILWAY_PANEL_HOST "$panel_prev"
  if [ -n "$PANEL_EXISTENTE_HOST" ] && [ "$PANEL_HOSTNAME" != "$PANEL_EXISTENTE_HOST" ]; then
    info "El panel también se publicará en $PANEL_HOSTNAME (hoy está en $PANEL_EXISTENTE_HOST, que se conserva)."
  fi
  if [ "$MAIL_HOSTNAME" = "$WEBMAIL_HOSTNAME" ] || [ "$MAIL_HOSTNAME" = "$PANEL_HOSTNAME" ] ||
    [ "$WEBMAIL_HOSTNAME" = "$PANEL_HOSTNAME" ]; then
    fallo "El servidor de correo, el webmail y el panel necesitan tres nombres distintos."
  fi
  info "Servidor de correo: $MAIL_HOSTNAME"
  info "Webmail:            $WEBMAIL_HOSTNAME"
  info "Panel:              $PANEL_HOSTNAME"

  local marca_def
  marca_def=${MAILWAY_MARCA:-$(leer_env MAILWAY_BRAND)}
  preguntar MARCA "Nombre del servicio que verán los usuarios del webmail" "${marca_def:-Webmail}"
  # Sin comillas, «$», barras ni caracteres de control: el valor acaba en
  # deploy/.env (que interpreta Compose) y en la configuración del webmail.
  MARCA=$(printf '%s' "$MARCA" | tr -d "'\"\$\\\\\`" | tr -d '[:cntrl:]')
  MARCA=${MARCA:0:60}
  MARCA=${MARCA:-Webmail}

  local correo_def
  correo_def=${LETSENCRYPT_EMAIL:-$(leer_env LETSENCRYPT_EMAIL)}
  preguntar LE_EMAIL "Correo de contacto para Let's Encrypt" "${correo_def:-postmaster@$DOMINIO}"
  correo_valido "$LE_EMAIL" || fallo "Correo no válido: «$LE_EMAIL» (variable LETSENCRYPT_EMAIL)."
  case "$LE_EMAIL" in
    *@example.com | *@example.org | *@example.net) fallo "Let's Encrypt rechaza los correos de ${LE_EMAIL#*@}: indica uno real (variable LETSENCRYPT_EMAIL)." ;;
  esac
  if [ "$CON_SKYWAY" = 1 ]; then elegir_correo_admin "$LE_EMAIL"; fi

  local ip_def
  ip_def=${MAILWAY_IP:-$(leer_env MAILWAY_PUBLIC_IP)}
  ip_def=${ip_def:-$(valor_panel MAILWAY_PUBLIC_IP)}
  if [ -z "$ip_def" ]; then ip_def=$(detectar_ip); fi
  preguntar IP_PUBLICA "IPv4 pública del servidor" "$ip_def"
  ipv4_valida "$IP_PUBLICA" || fallo "IPv4 no válida: «$IP_PUBLICA» (variable MAILWAY_IP)."
  if ip_en_cidr "$IP_PUBLICA" 10.0.0.0/8 || ip_en_cidr "$IP_PUBLICA" 172.16.0.0/12 ||
    ip_en_cidr "$IP_PUBLICA" 192.168.0.0/16 || ip_en_cidr "$IP_PUBLICA" 100.64.0.0/10 ||
    ip_en_cidr "$IP_PUBLICA" 127.0.0.0/8; then
    aviso "$IP_PUBLICA es una IP privada: el DNS, el SPF y el PTR necesitan la IP pública con la que el servidor sale a Internet."
  fi
  ok "IP pública: $IP_PUBLICA"

  INTERNAL_SUBNET=${MAILWAY_INTERNAL_SUBNET:-$(leer_env MAILWAY_INTERNAL_SUBNET)}
  INTERNAL_SUBNET=${INTERNAL_SUBNET:-10.203.53.0/24}
  MAIL_INTERNAL_IP=${MAILWAY_MAIL_INTERNAL_IP:-$(leer_env MAILWAY_MAIL_INTERNAL_IP)}
  MAIL_INTERNAL_IP=${MAIL_INTERNAL_IP:-10.203.53.10}
  comprobar_subred

  if [ "$CON_SKYWAY" = 1 ]; then
    TRAEFIK_ACME_VOLUME=$(docker inspect skyway-traefik \
      -f '{{range .Mounts}}{{if eq .Destination "/letsencrypt"}}{{.Name}}{{end}}{{end}}' 2>/dev/null || true)
    SKYWAY_DIR=${SKYWAY_DIR:-$(docker inspect skyway-traefik \
      -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)}
    if [ -n "$TRAEFIK_ACME_VOLUME" ]; then ok "Volumen de certificados de Traefik: $TRAEFIK_ACME_VOLUME"; fi
    if [ -n "$SKYWAY_DIR" ]; then ok "Carpeta de Skyway: $SKYWAY_DIR"; fi
  else
    TRAEFIK_ACME_VOLUME=""
    SKYWAY_DIR=""
  fi
}

# Correo de la cuenta de administración del panel que crea el emparejado con
# Skyway (solo si el panel aún no tiene ninguna). Por defecto, el de Let's
# Encrypt ($1) o el de una ejecución anterior.
elegir_correo_admin() {
  local def
  def=${MAILWAY_ADMIN_EMAIL:-$(leer_env MAILWAY_ADMIN_EMAIL)}
  preguntar ADMIN_EMAIL "Correo de la cuenta de administración del panel" "${def:-$1}"
  ADMIN_EMAIL=$(printf '%s' "$ADMIN_EMAIL" | tr '[:upper:]' '[:lower:]')
  correo_admin_valido "$ADMIN_EMAIL" || fallo "Correo no válido: «$ADMIN_EMAIL» (variable MAILWAY_ADMIN_EMAIL)."
}

# La red interna tiene subred fija (el motor la exime de su bloqueo
# automático). Si se solapa con otra red de Docker o con una ruta del
# servidor (VPN, red privada del proveedor), Docker no puede crearla o el
# tráfico hacia esa otra red se desviaría: se comprueba antes de tocar nada.
comprobar_subred() {
  cidr_valido "$INTERNAL_SUBNET" ||
    fallo "Subred interna no válida: «$INTERNAL_SUBNET» (variable MAILWAY_INTERNAL_SUBNET, p. ej. 10.203.53.0/24)."
  if ! { ipv4_valida "$MAIL_INTERNAL_IP" && ip_en_cidr "$MAIL_INTERNAL_IP" "$INTERNAL_SUBNET"; }; then
    fallo "La IP interna del motor «$MAIL_INTERNAL_IP» no pertenece a $INTERNAL_SUBNET (variable MAILWAY_MAIL_INTERNAL_IP)."
  fi
  case "$MAIL_INTERNAL_IP" in *.0 | *.1 | *.255)
    fallo "La IP interna del motor «$MAIL_INTERNAL_IP» está reservada (red, puerta de enlace o difusión). Usa p. ej. la .10." ;;
  esac

  # «nombre subred» de cada red de Docker con IPv4.
  local redes red subred ruta conflictos=""
  redes=$(docker network ls -q 2>/dev/null |
    xargs -r docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null |
    awk '{for (i = 2; i <= NF; i++) if ($i ~ /^[0-9.]+\/[0-9]+$/) print $1, $i}' || true)
  while read -r red subred; do
    if [ -z "$subred" ] || [ "$red" = "mailway-internal" ] || ! cidr_formato "$subred"; then continue; fi
    if cidr_solapan "$subred" "$INTERNAL_SUBNET"; then conflictos+=" red de Docker «$red» ($subred);"; fi
  done <<<"$redes"

  # Rutas del servidor que no son de una red de Docker (VPN, red privada).
  if tiene ip; then
    local subredes_docker
    subredes_docker=$(awk '{print $2}' <<<"$redes")
    while read -r ruta; do
      case "$ruta" in default | '' | */0) continue ;; esac
      [ "${ruta#*/}" = "$ruta" ] && ruta="$ruta/32"
      cidr_formato "$ruta" || continue
      if grep -Fqx "$ruta" <<<"$subredes_docker"; then continue; fi
      if cidr_solapan "$ruta" "$INTERNAL_SUBNET"; then conflictos+=" ruta del servidor $ruta;"; fi
    done < <(ip -4 route show 2>/dev/null | awk '{print $1}')
  fi

  if [ -n "$conflictos" ]; then
    fallo "La subred interna $INTERNAL_SUBNET se solapa con:${conflictos%;}. Elige otra libre con MAILWAY_INTERNAL_SUBNET y MAILWAY_MAIL_INTERNAL_IP (p. ej. 10.231.87.0/24 y 10.231.87.10)."
  fi
  ok "Subred interna $INTERNAL_SUBNET libre (motor en $MAIL_INTERNAL_IP)."
}

# ------------------------------------------------------- motor de correo --

nombre_motor() { if [ "$1" = "$MOTOR_016" ]; then printf 'Stalwart 0.16'; else printf 'Stalwart 0.15'; fi; }

# Volúmenes de cada motor: el de la 0.15 (MAILWAY_MAIL_VOLUME, que también fija
# la detección de las instalaciones anteriores a la 1.0) y los dos de la 0.16
# (los que fija la migración, o los de una instalación nueva).
volumen_015() { printf '%s' "${MAILWAY_MAIL_VOLUME:-mailway-mail-data}"; }
volumen_016_etc() { printf '%s' "${MAILWAY_STALWART_ETC_VOLUME:-mailway-stalwart-etc}"; }
volumen_016_datos() { printf '%s' "${MAILWAY_STALWART_DATA_VOLUME:-mailway-stalwart-data}"; }

# Las fechas ISO se comparan como texto.
aviso_fin_soporte_015() {
  if [[ $(date -u +%F) < "$FIN_SOPORTE_015" ]]; then
    aviso "Stalwart 0.15 deja de recibir parches de seguridad el $FIN_SOPORTE_015_TEXTO. Para pasar a la 0.16, con vuelta atrás si algo falla: sudo mailway migrar-motor (sección 8.3 de docs/DESPLIEGUE-SKYWAY.md)."
  else
    aviso "Stalwart 0.15 ya no recibe parches de seguridad (desde el $FIN_SOPORTE_015_TEXTO). Pasa a la 0.16 cuanto antes, con vuelta atrás si algo falla: sudo mailway migrar-motor (sección 8.3 de docs/DESPLIEGUE-SKYWAY.md)."
  fi
}

# Motor de la instalación según deploy/.env. Sin valor (instalaciones de antes
# de la 0.16), el del contenedor del motor y, si no lo hay, la 0.15: la que
# tenían todas.
motor_configurado() {
  local m
  m=$(leer_env MAILWAY_MOTOR)
  case "$m" in
    "$MOTOR_015" | "$MOTOR_016") printf '%s' "$m" ;;
    *)
      case "$(docker inspect --type container -f '{{.Config.Image}}' mailway-mail 2>/dev/null || true)" in
        *stalwart:v0.16*) printf '%s' "$MOTOR_016" ;;
        *) printf '%s' "$MOTOR_015" ;;
      esac
      ;;
  esac
}

# Elige el motor al instalar o actualizar:
#   1. El de deploy/.env, si lo dice (una actualización nunca lo cambia).
#   2. Si no, el de los datos que ya hay: un motor 0.15 (su volumen o su
#      contenedor) sigue en la 0.15; uno 0.16, en la 0.16.
#   3. Sin datos de ningún motor, la instalación es nueva: la 0.16, salvo que
#      MAILWAY_MOTOR pida la 0.15.
# MAILWAY_MOTOR solo elige en una instalación nueva: en una que ya existe,
# pedir otro motor se rechaza (el cambio es --migrar-motor, que convierte los
# datos y vuelve atrás si falla).
elegir_motor() {
  local guardado entorno=${MAILWAY_MOTOR:-} hay015=0 hay016=0
  MAILWAY_STALWART_ETC_VOLUME=$(leer_env MAILWAY_STALWART_ETC_VOLUME)
  MAILWAY_STALWART_DATA_VOLUME=$(leer_env MAILWAY_STALWART_DATA_VOLUME)
  MAILWAY_MOTOR_MIGRADO=$(leer_env MAILWAY_MOTOR_MIGRADO)
  case "$entorno" in
    '' | "$MOTOR_015" | "$MOTOR_016") ;;
    *) fallo "MAILWAY_MOTOR debe ser $MOTOR_016 o $MOTOR_015 (no «$entorno»)." ;;
  esac
  guardado=$(leer_env MAILWAY_MOTOR)
  case "$guardado" in
    '') ;;
    "$MOTOR_015" | "$MOTOR_016") MOTOR=$guardado ;;
    *) fallo "MAILWAY_MOTOR no es válido en $ENV_FILE («$guardado»): debe ser $MOTOR_016 o $MOTOR_015." ;;
  esac
  if [ -z "$MOTOR" ]; then
    case "$(docker inspect --type container -f '{{.Config.Image}}' mailway-mail 2>/dev/null || true)" in
      *stalwart:v0.15*) hay015=1 ;;
      *stalwart:v0.16*) hay016=1 ;;
    esac
    if docker volume inspect "$(volumen_015)" >/dev/null 2>&1; then hay015=1; fi
    if docker volume inspect "$(volumen_016_datos)" >/dev/null 2>&1; then hay016=1; fi
    if [ "$hay015" = 1 ] && [ "$hay016" = 1 ]; then
      fallo "Hay datos de Stalwart 0.15 y de 0.16 y $ENV_FILE no dice cuál usa esta instalación: indícalo con MAILWAY_MOTOR='$MOTOR_015' o MAILWAY_MOTOR='$MOTOR_016' en $ENV_FILE."
    elif [ "$hay015" = 1 ]; then
      MOTOR=$MOTOR_015
    elif [ "$hay016" = 1 ]; then
      MOTOR=$MOTOR_016
    else
      MOTOR=${entorno:-$MOTOR_016}
    fi
  fi
  if [ -n "$entorno" ] && [ "$entorno" != "$MOTOR" ]; then
    fallo "Esta instalación usa $(nombre_motor "$MOTOR") y MAILWAY_MOTOR pide $(nombre_motor "$entorno"). Una actualización nunca cambia de motor: para pasar de la 0.15 a la 0.16, sudo bash deploy/instalar.sh --migrar-motor"
  fi
  ok "Motor de correo: $(nombre_motor "$MOTOR")."
  if [ "$MOTOR" = "$MOTOR_015" ]; then aviso_fin_soporte_015; fi
}

# Volumen con los datos del motor elegido, si ya existe (lo fija la detección
# de instalaciones anteriores, que se ejecuta antes).
volumen_datos_motor() {
  local v
  if [ "$MOTOR" = "$MOTOR_016" ]; then v=$(volumen_016_datos); else v=$(volumen_015); fi
  if docker volume inspect "$v" >/dev/null 2>&1; then printf '%s' "$v"; fi
  return 0
}

preparar_secretos() {
  titulo "Secretos"
  MAILWAY_SECRET=$(leer_env MAILWAY_SECRET)
  ROUNDCUBE_DES_KEY=$(leer_env ROUNDCUBE_DES_KEY)
  MAILWAY_TRAEFIK_TOKEN=$(leer_env MAILWAY_TRAEFIK_TOKEN)
  MAILWAY_SETUP_TOKEN=$(leer_env MAILWAY_SETUP_TOKEN)
  MAILWAY_WEBMAIL_TOKEN=$(leer_env MAILWAY_WEBMAIL_TOKEN)
  local generar_clave=1
  if [ -n "$PANEL_EXISTENTE_CONTENEDOR" ]; then
    # Panel que Skyway ya despliega (confirmado en detectar_panel_existente):
    # lo que usa él manda sobre deploy/.env, empezando por su clave maestra.
    local clave
    clave=$(clave_maestra_del_panel)
    if [ -n "$clave" ]; then
      MAILWAY_SECRET=$clave
      ok "Se conserva la clave maestra del panel."
    else
      # No se puede saber (contenedor parado): deploy/.env no guarda ninguna,
      # para que nadie copie al panel una clave que no es la suya.
      MAILWAY_SECRET=""
      generar_clave=0
      aviso "No se ha podido leer la clave maestra del panel (¿está parado?): sigue en su volumen /data y no se cambia."
    fi
    # Un panel anterior a la 1.0 guarda el token de Traefik en su base de
    # datos: uno nuevo en sus variables lo sustituiría y dejaría sin acceso a
    # quien ya consulta las rutas con el antiguo.
    if [ -n "$(valor_panel MAILWAY_TRAEFIK_TOKEN)" ]; then
      MAILWAY_TRAEFIK_TOKEN=$(valor_panel MAILWAY_TRAEFIK_TOKEN)
    else
      MAILWAY_TRAEFIK_TOKEN=""
      TRAEFIK_TOKEN_PROPIO=0
    fi
    if [ -z "$MAILWAY_SETUP_TOKEN" ]; then MAILWAY_SETUP_TOKEN=$(valor_panel MAILWAY_SETUP_TOKEN); fi
    if [ -z "$MAILWAY_WEBMAIL_TOKEN" ]; then MAILWAY_WEBMAIL_TOKEN=$(valor_panel MAILWAY_WEBMAIL_TOKEN); fi
  fi
  if [ -z "$MAILWAY_SECRET" ] && [ "$generar_clave" = 1 ]; then MAILWAY_SECRET=$(aleatorio_hex 32); fi
  if [ -z "$ROUNDCUBE_DES_KEY" ]; then ROUNDCUBE_DES_KEY=$(aleatorio_hex 12); fi
  if [ -z "$MAILWAY_TRAEFIK_TOKEN" ] && [ "$TRAEFIK_TOKEN_PROPIO" = 1 ]; then MAILWAY_TRAEFIK_TOKEN=$(aleatorio_hex 24); fi
  if [ -z "$MAILWAY_SETUP_TOKEN" ]; then MAILWAY_SETUP_TOKEN=$(aleatorio_hex 16); fi
  if [ -z "$MAILWAY_WEBMAIL_TOKEN" ]; then MAILWAY_WEBMAIL_TOKEN=$(aleatorio_hex 24); fi

  # Con Stalwart 0.15 la contraseña del motor solo se aplica en su PRIMER
  # arranque; con la 0.16 se aplica en cada uno, pero el panel guarda la que
  # usa. En los dos casos, si ya hay datos del motor, generar otra dejaría al
  # panel sin acceso: se reutiliza la guardada o se pide. La del panel solo
  # sirve para un motor que ya existe (es la que el panel usa con él); un
  # motor nuevo estrena la suya.
  local previa volumen
  volumen=$(volumen_datos_motor)
  previa=${STALWART_ADMIN_PASSWORD:-$(leer_env STALWART_ADMIN_PASSWORD)}
  if [ -z "$previa" ] && [ -n "$volumen" ]; then previa=$(valor_panel STALWART_ADMIN_PASSWORD); fi
  if [ -n "$previa" ]; then
    STALWART_ADMIN_PASSWORD=$previa
    ok "Se reutiliza la contraseña del motor existente."
  elif [ -n "$volumen" ]; then
    aviso "El motor ya tiene datos (volumen $volumen), pero deploy/.env no guarda su contraseña."
    preguntar_secreto STALWART_ADMIN_PASSWORD "Contraseña actual del administrador del motor" ""
    [ -n "$STALWART_ADMIN_PASSWORD" ] ||
      fallo "Sin la contraseña actual del motor no se puede continuar (variable STALWART_ADMIN_PASSWORD)."
  else
    STALWART_ADMIN_PASSWORD=$(aleatorio_hex 24)
    ok "Contraseña del motor generada."
  fi
}

# Instalaciones anteriores a la 1.0: proyecto de Compose «deploy» (o el
# nombre de la carpeta desde la que se lanzó), volúmenes <proyecto>_* y red
# interna sin subred fija. Se reutilizan los datos sin copiarlos. Va antes que
# los secretos: la contraseña del motor depende de si ya hay datos.
migrar_instalacion_anterior() {
  local proyecto="" par nombre var candidato
  proyecto=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' mailway-mail 2>/dev/null || true)
  MAILWAY_MAIL_VOLUME=$(leer_env MAILWAY_MAIL_VOLUME)
  MAILWAY_WEBMAIL_DB_VOLUME=$(leer_env MAILWAY_WEBMAIL_DB_VOLUME)
  MAILWAY_PANEL_VOLUME=$(leer_env MAILWAY_PANEL_VOLUME)

  # Para cada volumen sin fijar: si el de la 1.0 no existe pero sí el del
  # proyecto anterior (aunque sus contenedores ya se hayan borrado), se usa ese.
  for par in mailway-mail-data:MAILWAY_MAIL_VOLUME mailway-webmail-db:MAILWAY_WEBMAIL_DB_VOLUME \
    mailway-panel-data:MAILWAY_PANEL_VOLUME; do
    nombre=${par%%:*}
    var=${par#*:}
    [ -z "${!var}" ] || continue
    docker volume inspect "$nombre" >/dev/null 2>&1 && continue
    for candidato in "${proyecto:+${proyecto}_$nombre}" "deploy_$nombre"; do
      if [ -n "$candidato" ] && docker volume inspect "$candidato" >/dev/null 2>&1; then
        printf -v "$var" '%s' "$candidato"
        break
      fi
    done
  done

  if [ -n "$MAILWAY_MAIL_VOLUME" ] && [ "$MAILWAY_MAIL_VOLUME" != "$(leer_env MAILWAY_MAIL_VOLUME)" ]; then
    info "Se reutiliza el correo de una instalación anterior (volumen $MAILWAY_MAIL_VOLUME)."
  fi

  if [ -n "$proyecto" ] && [ "$proyecto" != "mailway" ]; then
    titulo "Migración de una instalación anterior"
    info "Los contenedores actuales pertenecen al proyecto de Compose «$proyecto»; la 1.0 usa «mailway»."
    confirmar "Se detendrán y recrearán los contenedores de Mailway conservando el correo. ¿Continuar?" s ||
      fallo "Migración cancelada."
    MIGRAR_CONTENEDORES=1
    info "Se reutilizarán los volúmenes (${MAILWAY_MAIL_VOLUME:-sin volumen de correo}); los contenedores se recrean al levantar el servicio."
  fi
}

# Justo antes de levantar el servicio (para que el correo esté parado el menor
# tiempo posible): retira los contenedores del proyecto anterior y recrea la
# red interna si no tiene la subred fija, que el motor exime de su bloqueo.
retirar_contenedores_anteriores() {
  local c servidor_webmail="" imagen_webmail=""
  if [ "$MIGRAR_CONTENEDORES" = 1 ]; then
    # Antes de retirar el webmail: el servidor por el que entraba al motor y
    # su imagen (ya descargada y con php y SQLite), para trasladar sus usuarios.
    if docker inspect --type container mailway-webmail >/dev/null 2>&1; then
      servidor_webmail=$(servidor_webmail_anterior)
      imagen_webmail=$(docker inspect --type container -f '{{.Image}}' mailway-webmail 2>/dev/null || true)
    fi
    for c in mailway-webmail mailway-certs-dumper mailway-mail mailway-panel; do
      if docker inspect "$c" >/dev/null 2>&1; then docker rm -f "$c" >/dev/null; fi
    done
    ok "Contenedores de la instalación anterior retirados; los volúmenes se conservan."
    migrar_usuarios_webmail "$servidor_webmail" "$imagen_webmail"
  elif docker inspect --type container mailway-webmail >/dev/null 2>&1; then
    # Contenedores ya en el proyecto «mailway» pero quizá trasladados por un
    # instalador sin este paso (la 1.0): la base puede conservar usuarios con
    # el nombre público. Se trasladan con el webmail en marcha (la escritura
    # espera a su bloqueo); sin filas que cambiar, no dice nada.
    migrar_usuarios_webmail "$MAIL_HOSTNAME" \
      "$(docker inspect --type container -f '{{.Image}}' mailway-webmail 2>/dev/null || true)"
  fi

  if docker network inspect mailway-internal >/dev/null 2>&1; then
    local subred proyecto_red conectados
    subred=$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' mailway-internal)
    proyecto_red=$(docker network inspect -f '{{index .Labels "com.docker.compose.project"}}' mailway-internal)
    if [ "$subred" != "$INTERNAL_SUBNET" ] || [ "$proyecto_red" != "mailway" ]; then
      conectados=$(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' mailway-internal)
      for c in $conectados; do
        case "$c" in
          mailway-*) docker rm -f "$c" >/dev/null ;;
          *) fallo "La red mailway-internal tiene conectado «$c», que no es de Mailway. Desconéctalo y vuelve a ejecutar." ;;
        esac
      done
      docker network rm mailway-internal >/dev/null
      ok "Red mailway-internal recreada con la subred $INTERNAL_SUBNET."
    fi
  fi
}

# Servidor IMAP del webmail de la 1.0 (ROUNDCUBEMAIL_DEFAULT_HOST de los dos
# compose, ssl://mailway-mail), como lo guarda Roundcube: sin esquema ni puerto.
SERVIDOR_WEBMAIL="mailway-mail"

# Servidor IMAP del webmail actual (ROUNDCUBEMAIL_DEFAULT_HOST), como lo
# guarda Roundcube en users.mail_host: sin esquema ni puerto y en minúsculas.
# Se lee con bash: el entorno del contenedor lleva secretos.
servidor_webmail_anterior() {
  local linea
  while IFS= read -r linea; do
    case "$linea" in
      ROUNDCUBEMAIL_DEFAULT_HOST=*)
        host_de_url "${linea#*=}"
        return 0
        ;;
    esac
  done <<<"$(entorno_contenedor mailway-webmail)"
}

# Cambia en la base SQLite de Roundcube (MAILWAY_RC_BASE) el servidor de los
# usuarios de MAILWAY_RC_ANTERIOR a MAILWAY_RC_NUEVO. «OR IGNORE»: el índice
# único es (username, mail_host), y el usuario que ya entró con el servidor
# nuevo conserva esa fila. Escribe «<cambiados> <pendientes>»; sin base, «0 0»
# (abrirla con PDO la crearía vacía).
PHP_MIGRAR_WEBMAIL='$base = getenv("MAILWAY_RC_BASE");
if (!is_file($base)) { echo "0 0\n"; exit(0); }
$db = new PDO("sqlite:" . $base, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 30]);
$antes = getenv("MAILWAY_RC_ANTERIOR");
$cambio = $db->prepare("UPDATE OR IGNORE users SET mail_host = ? WHERE lower(mail_host) = ?");
$cambio->execute([getenv("MAILWAY_RC_NUEVO"), $antes]);
$quedan = $db->prepare("SELECT COUNT(*) FROM users WHERE lower(mail_host) = ?");
$quedan->execute([$antes]);
echo $cambio->rowCount(), " ", $quedan->fetchColumn(), "\n";'

# El webmail anterior a la 1.0 entraba al motor por su nombre público
# (ssl://<MAIL_HOSTNAME>); el de la 1.0, por la red interna (ssl://mailway-mail).
# Roundcube identifica a cada usuario por su dirección y por ese servidor
# (users.mail_host): sin trasladarlos, cada titular entraría en un usuario
# nuevo y vacío, sin sus contactos, identidades, firmas ni preferencias,
# aunque sigan en la base. Se hace con el webmail antiguo ya retirado y antes
# de levantar el nuevo (o, al repetir la instalación, con el actual en
# marcha), en un contenedor efímero sin red. Si falla, avisa y la
# instalación sigue.
#   migrar_usuarios_webmail <servidor del webmail anterior> <su imagen>
migrar_usuarios_webmail() {
  local anterior=$1 imagen=$2 volumen=${MAILWAY_WEBMAIL_DB_VOLUME:-mailway-webmail-db}
  local salida="" resultado cambiados pendientes re='^([0-9]+) ([0-9]+)$'
  if [ -z "$anterior" ] || [ "$anterior" = "$SERVIDOR_WEBMAIL" ]; then return 0; fi
  if [ "$anterior" != "$MAIL_HOSTNAME" ]; then
    info "El webmail anterior entraba al motor por $anterior, que no es $MAIL_HOSTNAME: sus usuarios no se trasladan."
    return 0
  fi
  if [ -z "$imagen" ] || ! docker volume inspect "$volumen" >/dev/null 2>&1; then return 0; fi
  # Como root (el usuario de la imagen): la base puede ser de root, según
  # quién la creara. Sin secretos: los valores pueden ir en el entorno.
  if salida=$(docker run --rm --network none -v "$volumen:/var/roundcube/db" \
    -e MAILWAY_RC_BASE=/var/roundcube/db/sqlite.db -e "MAILWAY_RC_ANTERIOR=$anterior" \
    -e "MAILWAY_RC_NUEVO=$SERVIDOR_WEBMAIL" --entrypoint php "$imagen" -r "$PHP_MIGRAR_WEBMAIL" 2>&1); then
    resultado=${salida##*$'\n'}
  else
    resultado=""
  fi
  if ! [[ $resultado =~ $re ]]; then
    aviso "No se pudo trasladar a los usuarios del webmail al servidor $SERVIDOR_WEBMAIL: ${salida:0:300}"
    aviso "Hasta hacerlo, los titulares verán el webmail sin sus contactos ni preferencias (sección 8.2 de docs/DESPLIEGUE-SKYWAY.md)."
    return 0
  fi
  cambiados=${BASH_REMATCH[1]}
  pendientes=${BASH_REMATCH[2]}
  if [ "$cambiados" -gt 0 ]; then
    ok "Usuarios del webmail trasladados de $anterior a $SERVIDOR_WEBMAIL: $cambiados. Conservan sus contactos, identidades y preferencias."
  fi
  if [ "$pendientes" -gt 0 ]; then
    aviso "Usuarios del webmail que ya habían entrado por $SERVIDOR_WEBMAIL y conservan ese usuario: $pendientes. Sus datos anteriores siguen en la base."
  fi
  return 0
}

escribir_env() {
  titulo "Configuración (deploy/.env)"
  local tmp claves clave linea umask_previa
  umask_previa=$(umask)
  umask 077
  tmp=$(mktemp "$(dirname "$ENV_FILE")/.env.XXXXXX")
  # Si algo falla a medias, no queda una copia parcial con secretos (al_salir).
  ENV_TMP=$tmp
  {
    printf '# Generado por deploy/instalar.sh %s el %s. Contiene secretos: permisos 600.\n' \
      "$VERSION_INSTALADOR" "$(date -u '+%Y-%m-%d %H:%M UTC')"
    printf '# Se puede volver a ejecutar el instalador: reutiliza estos valores.\n\n'
    if [ "$CON_SKYWAY" = 1 ]; then linea_env MAILWAY_INSTALACION skyway; else linea_env MAILWAY_INSTALACION autonoma; fi
    linea_env MAIL_HOSTNAME "$MAIL_HOSTNAME"
    linea_env WEBMAIL_HOSTNAME "$WEBMAIL_HOSTNAME"
    linea_env PANEL_HOSTNAME "$PANEL_HOSTNAME"
    linea_env MAILWAY_PUBLIC_IP "$IP_PUBLICA"
    linea_env MAILWAY_BRAND "$MARCA"
    linea_env LETSENCRYPT_EMAIL "$LE_EMAIL"
    if [ -n "$ADMIN_EMAIL" ]; then linea_env MAILWAY_ADMIN_EMAIL "$ADMIN_EMAIL"; fi
    printf '\n# Motor de correo (%s). Para pasar de la 0.15 a la 0.16: sudo mailway migrar-motor.\n' "$(nombre_motor "$MOTOR")"
    if [ -n "$MOTOR" ]; then linea_env MAILWAY_MOTOR "$MOTOR"; fi
    if [ -n "${MAILWAY_STALWART_ETC_VOLUME:-}" ]; then linea_env MAILWAY_STALWART_ETC_VOLUME "$MAILWAY_STALWART_ETC_VOLUME"; fi
    if [ -n "${MAILWAY_STALWART_DATA_VOLUME:-}" ]; then linea_env MAILWAY_STALWART_DATA_VOLUME "$MAILWAY_STALWART_DATA_VOLUME"; fi
    if [ -n "${MAILWAY_MOTOR_MIGRADO:-}" ]; then linea_env MAILWAY_MOTOR_MIGRADO "$MAILWAY_MOTOR_MIGRADO"; fi
    printf '# Contraseña VIGENTE del administrador del motor (la usan el panel, el instalador y el\n'
    printf '# extractor). Stalwart 0.16 la toma de aquí en cada arranque; la 0.15, solo en el primero:\n'
    printf '# si la cambias en el motor, cámbiala también aquí.\n'
    linea_env STALWART_ADMIN_PASSWORD "$STALWART_ADMIN_PASSWORD"
    printf '\n# Webmail\n'
    linea_env ROUNDCUBE_DES_KEY "$ROUNDCUBE_DES_KEY"
    linea_env MAILWAY_PANEL_URL "https://$PANEL_HOSTNAME"
    linea_env MAILWAY_WEBMAIL_URL "https://$WEBMAIL_HOSTNAME"
    linea_env MAILWAY_PANEL_INTERNAL_URL "$PANEL_INTERNAL_URL"
    printf '\n# Secretos compartidos con el panel (sus variables en Skyway llevan los mismos).\n'
    # Vacías cuando el panel las guarda él mismo (anterior a la 1.0): aquí no
    # se escribe una que no es la suya.
    if [ -n "$MAILWAY_SECRET" ]; then
      linea_env MAILWAY_SECRET "$MAILWAY_SECRET"
    else
      printf '# MAILWAY_SECRET: el panel la guarda en su volumen /data.\n'
    fi
    linea_env MAILWAY_SETUP_TOKEN "$MAILWAY_SETUP_TOKEN"
    if [ -n "$MAILWAY_TRAEFIK_TOKEN" ]; then
      linea_env MAILWAY_TRAEFIK_TOKEN "$MAILWAY_TRAEFIK_TOKEN"
    else
      printf '# MAILWAY_TRAEFIK_TOKEN: el panel lo guarda en su base de datos (Ajustes → Rutas de Traefik).\n'
    fi
    linea_env MAILWAY_WEBMAIL_TOKEN "$MAILWAY_WEBMAIL_TOKEN"
    printf '\n# Red interna (subred fija que el motor exime de su bloqueo automático).\n'
    linea_env MAILWAY_INTERNAL_SUBNET "$INTERNAL_SUBNET"
    linea_env MAILWAY_MAIL_INTERNAL_IP "$MAIL_INTERNAL_IP"
    if [ -n "$TRAEFIK_ACME_VOLUME" ]; then linea_env TRAEFIK_ACME_VOLUME "$TRAEFIK_ACME_VOLUME"; fi
    if [ -n "$MAILWAY_MAIL_VOLUME" ]; then linea_env MAILWAY_MAIL_VOLUME "$MAILWAY_MAIL_VOLUME"; fi
    if [ -n "$MAILWAY_WEBMAIL_DB_VOLUME" ]; then linea_env MAILWAY_WEBMAIL_DB_VOLUME "$MAILWAY_WEBMAIL_DB_VOLUME"; fi
    if [ -n "$MAILWAY_PANEL_VOLUME" ]; then linea_env MAILWAY_PANEL_VOLUME "$MAILWAY_PANEL_VOLUME"; fi
  } >"$tmp"

  # Las claves añadidas a mano se conservan.
  claves=" MAILWAY_INSTALACION MAIL_HOSTNAME WEBMAIL_HOSTNAME PANEL_HOSTNAME MAILWAY_PUBLIC_IP MAILWAY_BRAND LETSENCRYPT_EMAIL"
  claves+=" MAILWAY_ADMIN_EMAIL MAILWAY_MOTOR MAILWAY_STALWART_ETC_VOLUME MAILWAY_STALWART_DATA_VOLUME MAILWAY_MOTOR_MIGRADO"
  claves+=" STALWART_ADMIN_PASSWORD ROUNDCUBE_DES_KEY MAILWAY_PANEL_URL MAILWAY_WEBMAIL_URL MAILWAY_PANEL_INTERNAL_URL"
  claves+=" MAILWAY_SECRET MAILWAY_SETUP_TOKEN MAILWAY_TRAEFIK_TOKEN MAILWAY_WEBMAIL_TOKEN MAILWAY_INTERNAL_SUBNET"
  claves+=" MAILWAY_MAIL_INTERNAL_IP TRAEFIK_ACME_VOLUME MAILWAY_MAIL_VOLUME MAILWAY_WEBMAIL_DB_VOLUME MAILWAY_PANEL_VOLUME "
  if [ -f "$ENV_FILE" ]; then
    local extra=""
    while IFS= read -r linea || [ -n "$linea" ]; do
      case "$linea" in '' | '#'*) continue ;; esac
      clave=${linea%%=*}
      case "$claves" in *" $clave "*) ;; *) extra+="$linea"$'\n' ;; esac
    done <"$ENV_FILE"
    if [ -n "$extra" ]; then
      printf '\n# Conservado de la versión anterior de este fichero.\n%s' "$extra" >>"$tmp"
    fi
    # Copia de la versión con la que empezó esta ejecución (una sola vez:
    # la segunda escritura, tras desplegar el panel, no debe pisarla).
    if [ "$ENV_COPIADO" = 0 ]; then
      cp -p "$ENV_FILE" "$ENV_FILE.anterior"
      chmod 600 "$ENV_FILE.anterior"
      ENV_COPIADO=1
    fi
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  ENV_TMP=""
  umask "$umask_previa"
  ok "Escrito $ENV_FILE (permisos 600)."
}

# ------------------------------------------------------------------- DNS --

cf_primer_error() {
  printf '%s' "$RESP_BODY" | jqr -r '(.errors // [])[0] | if . then "\(.message) (código \(.code))" else "HTTP '"$RESP_CODE"'" end' 2>/dev/null ||
    printf 'HTTP %s' "$RESP_CODE"
}

# Campo de la última respuesta JSON (vacío si no es JSON o no existe).
campo_json() { printf '%s' "$RESP_BODY" | jqr -r "$@" 2>/dev/null || true; }

# Comprueba que el token existe y está activo. Los tokens de cuenta (cfat_…)
# no se pueden verificar en /user/tokens/verify (responden «Invalid API
# Token»): se verifican en su cuenta, que se deduce de las zonas visibles.
cf_verificar_token() {
  case "$CF_TOKEN" in
    cfk_*) fallo "Has indicado la clave global de Cloudflare. Crea un token de API con los permisos Zona: Lectura y DNS: Edición." ;;
  esac
  coincide "$CF_TOKEN" '^[A-Za-z0-9_-]{20,200}$' ||
    fallo "El token de Cloudflare no tiene un formato válido (variable CLOUDFLARE_API_TOKEN)."

  local estado="" cuenta
  if [ "${CF_TOKEN#cfat_}" = "$CF_TOKEN" ]; then
    cf_api GET /user/tokens/verify
    if [ "$RESP_CODE" = "200" ]; then estado=$(campo_json '.result.status // empty'); fi
  fi
  if [ -z "$estado" ]; then
    cf_api GET "/zones?per_page=50"
    [ "$RESP_CODE" = "200" ] ||
      fallo "Cloudflare rechazó el token: $(cf_primer_error). Comprueba que está activo y tiene los permisos Zona: Lectura y DNS: Edición."
    cuenta=$(campo_json '(.result // [])[0].account.id // empty')
    coincide "$cuenta" '^[A-Za-z0-9]{1,64}$' ||
      fallo "El token de Cloudflare no da acceso a ninguna zona. Añade la zona de $DOMINIO a sus permisos."
    cf_api GET "/accounts/$cuenta/tokens/verify"
    if [ "$RESP_CODE" = "200" ]; then estado=$(campo_json '.result.status // empty'); fi
  fi
  [ "$estado" = "active" ] ||
    fallo "El token de Cloudflare no está activo (estado: ${estado:-no verificable; $(cf_primer_error)})."
  ok "Token de Cloudflare verificado."
}

configurar_cloudflare() {
  titulo "DNS en Cloudflare"
  if [ "$CON_CLOUDFLARE" = 0 ]; then
    info "Omitido (--sin-cloudflare)."
    return 0
  fi
  if [ "$ACTUALIZAR" = 1 ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    info "Omitido: sin CLOUDFLARE_API_TOKEN en la actualización."
    return 0
  fi
  if [ "$INTERACTIVO" = 1 ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    info "Con un token de Cloudflare (permisos Zona: Lectura y DNS: Edición) se crean los registros"
    info "del servidor y el motor obtiene su certificado de Let's Encrypt por DNS. Intro para omitir."
  fi
  preguntar_secreto CF_TOKEN "Token de API de Cloudflare" "${CLOUDFLARE_API_TOKEN:-}"
  if [ -z "$CF_TOKEN" ]; then
    info "Sin token: crea a mano los registros A de $MAIL_HOSTNAME, $WEBMAIL_HOSTNAME y $PANEL_HOSTNAME hacia $IP_PUBLICA."
    return 0
  fi
  cf_verificar_token

  # La zona se busca del nombre más largo al más corto (admite subdominios
  # delegados). Una zona que el token no ve responde con una lista vacía.
  local candidato="$DOMINIO" estado_zona
  while :; do
    cf_api GET "/zones?name=$candidato&per_page=5"
    [ "$RESP_CODE" = "200" ] || fallo "No se pudieron consultar las zonas de Cloudflare: $(cf_primer_error)."
    CF_ZONA_ID=$(campo_json '(.result // [])[0].id // empty')
    if [ -n "$CF_ZONA_ID" ]; then
      coincide "$CF_ZONA_ID" '^[A-Za-z0-9]{1,64}$' || fallo "Cloudflare devolvió un identificador de zona inesperado."
      CF_ZONA_NOMBRE=$candidato
      estado_zona=$(campo_json '(.result // [])[0].status // empty')
      break
    fi
    case "$candidato" in *.*.*) candidato=${candidato#*.} ;; *) break ;; esac
  done
  if [ -z "$CF_ZONA_ID" ]; then
    fallo "El token no tiene acceso a la zona de $DOMINIO en Cloudflare. Añade la zona a los permisos del token."
  fi
  ok "Zona de Cloudflare: $CF_ZONA_NOMBRE"
  if [ "$estado_zona" = "pending" ]; then
    aviso "La zona $CF_ZONA_NOMBRE aún está pendiente en Cloudflare: los registros no se publican hasta que el dominio"
    aviso "use estos servidores de nombres: $(campo_json '(.result // [])[0].name_servers // [] | join(", ")')."
  fi

  local nombre
  for nombre in "$MAIL_HOSTNAME" "$WEBMAIL_HOSTNAME" "$PANEL_HOSTNAME"; do
    cf_registro A "$nombre" "$IP_PUBLICA" s
  done
  # Autoconfiguración de programas de correo para el propio dominio base.
  # Suelen existir ya (p. ej. autodiscover hacia Microsoft 365): sin
  # confirmación expresa no se cambian.
  for nombre in "autoconfig.$DOMINIO" "autodiscover.$DOMINIO"; do
    cf_registro CNAME "$nombre" "$MAIL_HOSTNAME" n
  done
}

# Crea o corrige un registro sin proxy (el proxy de Cloudflare rompe SMTP/IMAP
# y la validación de certificados). Lo que falta se crea siempre; lo que ya
# existe con otro valor o con el proxy activado solo se modifica con permiso:
# con terminal, preguntando (<s|n> es la respuesta por defecto si apunta a otro
# sitio); sin terminal (ejecución desatendida, --actualizar), nunca, salvo con
# MAILWAY_DNS_REEMPLAZAR=1 y solo en los registros cuya respuesta por defecto
# es «s» (los A de la plataforma): un autodiscover hacia Microsoft 365 no se
# cambia nunca sin preguntar.
#   cf_registro <tipo> <nombre> <contenido> <s|n>
cf_registro() {
  local tipo=$1 nombre=$2 contenido=$3 cambiar_def=$4 existente id actual proxied otro cuerpo total
  cf_api GET "/zones/$CF_ZONA_ID/dns_records?name=$nombre&per_page=100"
  [ "$RESP_CODE" = "200" ] || fallo "No se pudieron leer los registros de $nombre: $(cf_primer_error)."
  existente=$(campo_json --arg t "$tipo" 'first((.result // [])[] | select(.type == $t)) | "\(.id) \(.content) \(.proxied)"')
  total=$(campo_json --arg t "$tipo" '[(.result // [])[] | select(.type == $t)] | length')
  # Un CNAME no convive con ningún otro registro del mismo nombre; un A solo
  # choca con un CNAME (un AAAA puede acompañarlo).
  if [ "$tipo" = "CNAME" ]; then
    otro=$(campo_json 'first((.result // [])[] | select(.type != "CNAME")) | .type')
  else
    otro=$(campo_json 'first((.result // [])[] | select(.type == "CNAME")) | .type')
  fi
  cuerpo=$(printf '{"type":"%s","name":"%s","content":"%s","ttl":1,"proxied":false,"comment":"Mailway"}' \
    "$tipo" "$(json_escape "$nombre")" "$(json_escape "$contenido")")

  if [ -n "$otro" ]; then
    aviso "$nombre ya tiene un registro $otro: no se crea el $tipo. Revísalo en Cloudflare."
    return 0
  fi
  if [ "$tipo" = "A" ] && [ -n "$(campo_json 'first((.result // [])[] | select(.type == "AAAA")) | .content')" ]; then
    aviso "$nombre tiene además un registro AAAA (IPv6): comprueba que apunta a este servidor o bórralo."
  fi
  if [ -z "$existente" ]; then
    cf_api POST "/zones/$CF_ZONA_ID/dns_records" "$cuerpo"
    [ "$RESP_CODE" = "200" ] || fallo "No se pudo crear $tipo $nombre: $(cf_primer_error)."
    ok "Creado $tipo $nombre → $contenido"
    return 0
  fi
  if [ "${total:-1}" -gt 1 ] 2>/dev/null; then
    aviso "$nombre tiene $total registros $tipo: solo se ajusta el primero. Borra los demás en Cloudflare."
  fi
  read -r id actual proxied <<<"$existente"
  coincide "$id" '^[A-Za-z0-9]{1,64}$' || fallo "Cloudflare devolvió un identificador de registro inesperado."
  if [ "$actual" = "$contenido" ] && [ "$proxied" = "false" ]; then
    ok "$tipo $nombre → $contenido (ya correcto)"
    return 0
  fi
  # Sin terminal decide la respuesta por defecto que pasó quien llama:
  # MAILWAY_DNS_REEMPLAZAR solo abre los A de la plataforma («s»), nunca los
  # CNAME de autoconfiguración, tampoco cuando solo cambiaría su proxy.
  local que="apunta a $actual" pregunta="¿Cambiarlo a $contenido (sin proxy)?" def_desatendida=$cambiar_def
  if [ "$actual" = "$contenido" ]; then
    que="tiene el proxy de Cloudflare activado, que impide el correo y la validación del certificado"
    pregunta="¿Desactivar el proxy («Solo DNS»)?"
    # Con el mismo destino, quitar el proxy es lo único que se haría: con
    # terminal se propone por defecto.
    cambiar_def=s
  fi
  if [ "$INTERACTIVO" = 1 ]; then
    if ! confirmar "$nombre $que. $pregunta" "$cambiar_def"; then
      aviso "$nombre se deja como está ($que)."
      return 0
    fi
  elif [ "${MAILWAY_DNS_REEMPLAZAR:-0}" != 1 ] || [ "$def_desatendida" != s ]; then
    # Sin nadie a quien preguntar, un registro existente es un conflicto: se
    # informa y no se toca.
    aviso "$nombre $que: no se modifica sin confirmación. Cámbialo en Cloudflare o repite la instalación con terminal (o con MAILWAY_DNS_REEMPLAZAR=1)."
    return 0
  fi
  cf_api PUT "/zones/$CF_ZONA_ID/dns_records/$id" "$cuerpo"
  [ "$RESP_CODE" = "200" ] || fallo "No se pudo actualizar $tipo $nombre: $(cf_primer_error)."
  ok "Actualizado $tipo $nombre → $contenido (sin proxy)"
}

# Traefik pide los certificados en cuanto ve las rutas: si el DNS aún no
# apunta aquí, Let's Encrypt falla la validación y aplica esperas por reintento.
esperar_dns() {
  titulo "Propagación del DNS"
  local nombre pendientes t=0 max=${MAILWAY_ESPERA_DNS:-300}
  case "$max" in '' | *[!0-9]*) fallo "MAILWAY_ESPERA_DNS debe ser un número de segundos." ;; esac
  while :; do
    pendientes=""
    for nombre in "$MAIL_HOSTNAME" "$WEBMAIL_HOSTNAME" "$PANEL_HOSTNAME"; do
      if ! resuelve_a "$nombre" "$IP_PUBLICA"; then pendientes+=" $nombre"; fi
    done
    if [ -z "$pendientes" ]; then
      RESUMEN_DNS="correcto"
      ok "Los tres nombres resuelven a $IP_PUBLICA."
      return 0
    fi
    if [ -z "$CF_TOKEN" ] && [ "$INTERACTIVO" = 1 ] && [ "$t" = 0 ]; then
      info "Pendientes:$pendientes"
      info "Crea los registros A hacia $IP_PUBLICA en tu proveedor de DNS (sin proxy)."
      if ! confirmar "¿Esperar a que propaguen?" s; then break; fi
    fi
    if [ "$t" -ge "$max" ]; then break; fi
    if [ "$t" = 0 ]; then info "Esperando a que propague:$pendientes (hasta $((max / 60)) min)…"; fi
    sleep 10
    t=$((t + 10))
  done
  RESUMEN_DNS="pendiente:$pendientes"
  aviso "Sin propagar:$pendientes. Se continúa; Traefik reintentará los certificados cuando el DNS esté listo."
}

comprobar_ptr() {
  local inverso ptr
  inverso=$(printf '%s' "$IP_PUBLICA" | awk -F. '{print $4"."$3"."$2"."$1".in-addr.arpa"}')
  ptr=$(curl -fsS --max-time 8 -H 'accept: application/dns-json' \
    "https://cloudflare-dns.com/dns-query?name=$inverso&type=PTR" 2>/dev/null |
    grep -o '"data":"[^"]*"' | head -n 1 | sed 's/"data":"//; s/"$//; s/\.$//' || true)
  if [ "$ptr" = "$MAIL_HOSTNAME" ]; then
    RESUMEN_PTR="correcto ($IP_PUBLICA → $ptr)"
  elif [ -n "$ptr" ]; then
    RESUMEN_PTR="INCORRECTO: $IP_PUBLICA → $ptr (debe ser $MAIL_HOSTNAME; se cambia en el panel del proveedor del servidor)"
  else
    RESUMEN_PTR="SIN CONFIGURAR: pide al proveedor del servidor el DNS inverso $IP_PUBLICA → $MAIL_HOSTNAME"
  fi
}

# ------------------------------------------------------------ contenedores --

levantar_servicios() {
  titulo "Motor de correo y webmail"
  retirar_contenedores_anteriores
  local perfiles=()
  if [ "$CON_SKYWAY" = 0 ] && [ "$USAR_PROXY_PROPIO" = 1 ]; then perfiles+=(--profile proxy); fi

  if [ "$ACTUALIZAR" = 1 ]; then
    info "Descargando imágenes…"
    compose ${perfiles[@]+"${perfiles[@]}"} pull --quiet --ignore-buildable 2>/dev/null || compose ${perfiles[@]+"${perfiles[@]}"} pull --quiet || true
  fi
  if [ "$CON_SKYWAY" = 0 ]; then
    info "Compilando el panel (la primera vez tarda unos minutos)…"
    compose_q ${perfiles[@]+"${perfiles[@]}"} build mailway-panel
  fi
  # Primero el motor: el webmail (y el panel) esperan a que esté sano.
  compose_q ${perfiles[@]+"${perfiles[@]}"} up -d --remove-orphans mailway-mail
  if [ "$MOTOR" = "$MOTOR_016" ]; then
    preparar_motor_016
  elif ! esperar_sano mailway-mail 150; then
    # Núcleos sin IPv6: la configuración por defecto escucha en [::] y
    # Stalwart no abre ningún puerto. Se pasa a IPv4.
    if docker exec mailway-mail sh -c 'grep -qs "Address family not supported" /opt/stalwart/logs/*' 2>/dev/null; then
      aviso "El núcleo no admite IPv6: el motor pasa a escuchar solo en IPv4."
      docker exec mailway-mail sed -i 's/"\[::\]:/"0.0.0.0:/' /opt/stalwart/etc/config.toml
      docker restart mailway-mail >/dev/null
      esperar_sano mailway-mail 90 || fallo "El motor no arranca. Revisa: docker exec mailway-mail tail -n 50 /opt/stalwart/logs/stalwart.log.$(date -u +%F)"
    else
      fallo "El motor no arranca. Revisa: docker logs mailway-mail y docker exec mailway-mail ls /opt/stalwart/logs"
    fi
  fi
  ok "Motor en marcha (mailway-mail, $(nombre_motor "$MOTOR"))."
  compose_q ${perfiles[@]+"${perfiles[@]}"} up -d --remove-orphans
  if esperar_sano mailway-webmail 180; then
    ok "Webmail en marcha (mailway-webmail)."
  else
    aviso "El webmail aún no está sano. Revisa: docker logs mailway-webmail"
  fi
  if [ "$CON_SKYWAY" = 0 ]; then
    if esperar_sano mailway-panel 120; then ok "Panel en marcha (mailway-panel)."; else aviso "El panel aún no está sano. Revisa: docker logs mailway-panel"; fi
  fi
}

# ------------------------------------------------------ Stalwart 0.16 --

# ¿Responde el motor 0.16 en /healthz/<live|ready>? Desde dentro de su
# contenedor (la imagen trae curl), sin credenciales.
#   motor_responde <contenedor> [live|ready]
motor_responde() {
  docker exec "$1" curl -fsS -o /dev/null --max-time 5 -H 'X-Forwarded-For: 127.0.0.1' \
    "http://127.0.0.1:8080/healthz/${2:-live}" >/dev/null 2>&1
}

# ¿Acepta conexiones el motor en ese puerto? Dentro de su contenedor, sin
# credenciales: una escucha nueva de la 0.16 (el 587) solo se abre al
# reiniciarlo, aunque ya figure en sus ajustes.
#   puerto_abierto_motor <contenedor> <puerto>
puerto_abierto_motor() {
  docker exec "$1" bash -c "exec 3<>/dev/tcp/127.0.0.1/$2" >/dev/null 2>&1
}

# Espera a que el motor 0.16 responda; se rinde antes si su contenedor se para
# (un arranque que aborta no se arregla esperando).
#   esperar_motor_016 <contenedor> <segundos> [live|ready]
esperar_motor_016() {
  local contenedor=$1 max=$2 punto=${3:-live} t=0
  while [ "$t" -lt "$max" ]; do
    if motor_responde "$contenedor" "$punto"; then return 0; fi
    if ! en_marcha "$contenedor"; then return 1; fi
    sleep 3
    t=$((t + 3))
  done
  return 1
}

# Motor 0.16 recién levantado por Compose: si aún no tiene configuración
# (/etc/stalwart/config.json), es su primer arranque y está en modo
# «bootstrap» (solo el puerto 8080); se completa y se reinicia. Con ella, solo
# se espera a que esté sano.
preparar_motor_016() {
  esperar_motor_016 mailway-mail 120 live ||
    fallo "El motor no arranca. Revisa: docker logs mailway-mail"
  if ! docker exec mailway-mail test -f /etc/stalwart/config.json; then
    arranque_inicial_016
  fi
  if ! { esperar_motor_016 mailway-mail 150 ready && esperar_sano mailway-mail 150; }; then
    fallo "El motor no arranca. Revisa: docker logs mailway-mail"
  fi
}

# Primer arranque de una instalación nueva con Stalwart 0.16, sin asistente:
# el objeto Bootstrap por JMAP, con el administrador de recuperación
# (STALWART_RECOVERY_ADMIN, la contraseña de deploy/.env). Nombre del
# servidor; como dominio por defecto, uno reservado con ese mismo nombre (así
# ningún dominio de un cliente queda como el del sistema, que el motor no deja
# borrar); sin certificado ni DKIM propios del motor (el certificado lo lleva
# el extractor desde Traefik; las claves DKIM de cada dominio, el panel) y el
# registro de eventos en la salida estándar (docker logs). El motor escribe
# config.json, pero no se reinicia solo.
arranque_inicial_016() {
  local cuerpo detalle
  info "Primer arranque de Stalwart 0.16: nombre del servidor $MAIL_HOSTNAME y registro en «docker logs mailway-mail»…"
  docker image inspect "$IMAGEN_CURL" >/dev/null 2>&1 || docker pull -q "$IMAGEN_CURL" >/dev/null
  cuerpo=$(jmap_cuerpo "[[\"x:Bootstrap/set\",{\"update\":{\"singleton\":{\"serverHostname\":\"$MAIL_HOSTNAME\",\"defaultDomain\":\"$MAIL_HOSTNAME\",\"requestTlsCertificate\":false,\"generateDkimKeys\":false,\"tracer\":{\"@type\":\"Stdout\",\"ansi\":false,\"buffered\":false}}}},\"b\"]]")
  jmap_motor "$cuerpo"
  # Si va bien, la respuesta trae la contraseña de una cuenta de
  # administración que crea el motor (admin@<nombre>): no se muestra ni se
  # guarda, y la cuenta se retira después (Mailway usa la de recuperación).
  if [ "$RESP_CODE" != 200 ] || [ -z "$(campo_json '.methodResponses[0][1].updated.singleton // empty | keys | join(",")')" ]; then
    detalle=$(jmap_error)
    if [ -z "$detalle" ]; then
      detalle=$(campo_json '.methodResponses[0][1].notUpdated.singleton // empty | "\(.type)\(if .description then ": \(.description)" else "" end)"')
    fi
    RESP_BODY=""
    if [ "$RESP_CODE" = 401 ]; then
      fallo "El motor rechaza la contraseña de $ENV_FILE (STALWART_ADMIN_PASSWORD) en su primer arranque."
    fi
    fallo "El motor no ha completado su primer arranque (${detalle:-sin detalle}). Si su volumen ya tenía datos de otra instalación, no se toca: revisa docker logs mailway-mail."
  fi
  RESP_BODY=""
  docker restart mailway-mail >/dev/null
  esperar_motor_016 mailway-mail 150 ready || fallo "El motor no vuelve tras su primer arranque. Revisa: docker logs mailway-mail"
  ok "Stalwart 0.16 configurado: $MAIL_HOSTNAME, sin certificado ni claves DKIM propios y registro en docker logs."
  retirar_admin_del_arranque
}

# El primer arranque crea admin@<nombre del servidor> con rol de
# administración y una contraseña aleatoria que nadie guarda: una cuenta con
# todos los permisos que no usa nadie. Se borra (aún vacía), solo si es la
# única cuenta del motor. Si no se puede, se avisa y se sigue.
retirar_admin_del_arranque() {
  local ids
  jmap_motor "$(jmap_cuerpo '[["x:Account/query",{},"q"],["x:Account/get",{"#ids":{"resultOf":"q","name":"x:Account/query","path":"/ids"},"properties":["emailAddress","roles"]},"g"]]')"
  ids=$(campo_json --arg a "admin@$MAIL_HOSTNAME" '(.methodResponses[1][1].list // []) as $l | if ($l | length) == 1 then ($l[] | select(.emailAddress == $a and .roles["@type"] == "Admin") | .id) else empty end')
  if [ -z "$ids" ] || ! id_simple "$ids"; then return 0; fi
  jmap_motor "$(jmap_cuerpo "[[\"x:Account/set\",{\"destroy\":[\"$ids\"]},\"d\"]]")"
  if [ -n "$(campo_json --arg i "$ids" '.methodResponses[0][1].destroyed // [] | map(select(. == $i)) | .[0] // empty')" ]; then
    ok "Retirada la cuenta admin@$MAIL_HOSTNAME que crea el primer arranque (Mailway usa el administrador de recuperación)."
  else
    aviso "No se pudo retirar la cuenta admin@$MAIL_HOSTNAME que crea el primer arranque del motor ($(jmap_error)): no tiene uso y nadie conoce su contraseña."
  fi
}

# Ajustes del motor 0.16 que dependen del instalador: el certificado. Lo demás
# (nombre del servidor, X-Forwarded-For, exención de la red interna, envío por
# 587…) lo aplica el panel con su herramienta en cuanto está en marcha
# (aplicar_ajustes_mailway). El certificado de IMAP/SMTP es siempre el que
# Traefik obtiene para el nombre del servidor de correo: el ACME propio de la
# 0.16 obligaría a darle la gestión automática del DNS de un dominio.
configurar_motor_016() {
  if [ -n "$CF_TOKEN" ]; then
    info "Con Stalwart 0.16 el certificado de IMAP/SMTP es el de Traefik: el token de Cloudflare sirve para el DNS y para el panel."
  fi
  if [ "$CON_SKYWAY" = 1 ] && [ -z "$TRAEFIK_ACME_VOLUME" ]; then
    RESUMEN_CERT="SIN CERTIFICADO: no se encuentra el volumen de certificados de Traefik (TRAEFIK_ACME_VOLUME en deploy/.env)"
    aviso "No se encontró el volumen de certificados de Traefik: sin él, el motor no tiene certificado para IMAP y SMTP. Indica TRAEFIK_ACME_VOLUME en deploy/.env y repite con --actualizar."
    return 0
  fi
  if [ "$CON_SKYWAY" = 0 ] && [ "$USAR_PROXY_PROPIO" = 0 ]; then
    RESUMEN_CERT="SIN CERTIFICADO: sin el Traefik propio (puertos 80/443 ocupados), el motor no tiene de dónde obtenerlo"
    aviso "Sin el Traefik propio (80/443 ocupados), el motor no tiene certificado para IMAP y SMTP: los programas de correo avisarán. Libera 80/443 y repite con --actualizar (sección 7 de docs/DESPLIEGUE-SKYWAY.md)."
    return 0
  fi
  info "Extrayendo el certificado que obtiene Traefik para $MAIL_HOSTNAME…"
  CERT_CONFIGURADO=1
  aplicar_extractor
}

configurar_motor() {
  titulo "Ajustes del motor"
  if [ "$MOTOR" = "$MOTOR_016" ]; then
    configurar_motor_016
    return 0
  fi
  docker image inspect "$IMAGEN_CURL" >/dev/null 2>&1 || docker pull -q "$IMAGEN_CURL" >/dev/null
  # Nombre del servidor, confianza en el proxy y exención de la red interna:
  # lo mismo que aplica el panel con «Aplicar ajustes recomendados».
  if motor_ajustes \
    server.hostname "$MAIL_HOSTNAME" \
    http.use-x-forwarded true \
    "server.allowed-ip.$INTERNAL_SUBNET" ""; then
    ok "Nombre del servidor ($MAIL_HOSTNAME), proxy y exención de $INTERNAL_SUBNET aplicados."
  else
    aviso "No se pudieron aplicar todos los ajustes; el panel permite repetirlo en Ajustes → Servidor de correo."
  fi

  # Lo ya configurado (por el panel o por una ejecución anterior) se respeta.
  local existentes con_volcado=0 volcado_antiguo=0
  existentes=$(motor_api GET '/api/settings/keys?keys=acme.mailway.directory,certificate.mailway.cert,certificate.mailway.subjects.0,certificate.default.cert,certificate.default.private-key' 2>/dev/null || true)
  if printf '%s' "$existentes" | grep -q '"certificate.mailway.cert"'; then con_volcado=1; fi
  if certificado_del_volcado_antiguo "$existentes"; then volcado_antiguo=1; fi
  if [ -z "$CF_TOKEN" ] && printf '%s' "$existentes" | grep -q '"acme.mailway.directory"'; then
    CERT_CONFIGURADO=1
    RESUMEN_CERT="Let's Encrypt emitido por el propio motor (configurado antes)"
    ok "El motor ya emite su certificado con Let's Encrypt."
    if [ "$volcado_antiguo" = 1 ]; then retirar_certificado_antiguo; fi
    extractor_con_acme "$con_volcado" "$volcado_antiguo"
    return 0
  fi
  if [ -z "$CF_TOKEN" ] && [ "$volcado_antiguo" = 1 ]; then
    pasar_volcado_antiguo_al_extractor
    return 0
  fi
  if [ -z "$CF_TOKEN" ] && printf '%s' "$existentes" | grep -q '"certificate.default.cert"'; then
    CERT_CONFIGURADO=1
    RESUMEN_CERT="certificado propio configurado a mano en el motor"
    ok "El motor ya tiene un certificado configurado a mano; no se modifica."
    return 0
  fi
  if [ -z "$CF_TOKEN" ] && [ "$con_volcado" = 1 ]; then
    # Instalación que ya usa el certificado de Traefik: mismas rutas, ahora
    # con el extractor. El nombre del servidor como sujeto explícito hace que
    # el motor lo sustituya al recargar aunque el certificado nuevo sea un
    # comodín (sin él, conservaría en memoria el exacto anterior).
    if ! printf '%s' "$existentes" | grep -q '"certificate.mailway.subjects.0"'; then
      motor_ajustes certificate.mailway.subjects.0 "$MAIL_HOSTNAME" ||
        aviso "No se pudo añadir $MAIL_HOSTNAME como sujeto del certificado; el extractor funciona igualmente."
    fi
    CERT_CONFIGURADO=1
    aplicar_extractor
    return 0
  fi

  if [ -n "$CF_TOKEN" ] && [ -n "$CF_ZONA_NOMBRE" ]; then
    # Vía preferida: el motor pide y renueva su certificado por DNS-01. El
    # certificate.default de la guía 0.x se retira en la misma petición: si
    # apunta a ficheros que ya no existen, haría fallar la recarga que activa
    # el ACME (y cualquier recarga posterior).
    local ops
    ops="[$(motor_op_insertar \
      acme.mailway.directory "$LE_DIRECTORIO" \
      acme.mailway.challenge dns-01 \
      acme.mailway.provider cloudflare \
      acme.mailway.secret "$CF_TOKEN" \
      acme.mailway.contact.0 "$LE_EMAIL" \
      acme.mailway.domains.0 "$MAIL_HOSTNAME" \
      acme.mailway.origin "$CF_ZONA_NOMBRE" \
      acme.mailway.renew-before 30d \
      acme.mailway.default true)"
    if [ "$volcado_antiguo" = 1 ]; then ops+=",$OP_RETIRAR_CERT_ANTIGUO"; fi
    ops+="]"
    if motor_cambios "$ops"; then
      CERT_CONFIGURADO=1
      RESUMEN_CERT="Let's Encrypt emitido por el propio motor (DNS-01 en Cloudflare); tarda unos minutos"
      ok "Certificado de IMAP/SMTP solicitado a Let's Encrypt por DNS-01."
      if [ "$volcado_antiguo" = 1 ]; then
        ok "Retirado certificate.default, el certificado de la instalación anterior: el motor pasa a usar el de Let's Encrypt."
      fi
      extractor_con_acme "$con_volcado" "$volcado_antiguo"
    else
      aviso "No se pudo configurar la emisión del certificado; puede repetirse en Ajustes → Servidor de correo."
    fi
    return 0
  fi

  # Sin Cloudflare: el extractor lleva al motor el certificado que Traefik
  # obtiene para el nombre del servidor de correo (y solo ese).
  if [ "$CON_SKYWAY" = 1 ] && [ -z "$TRAEFIK_ACME_VOLUME" ]; then
    aviso "No se encontró el volumen de certificados de Traefik: emite el certificado desde Ajustes → Servidor de correo."
    return 0
  fi
  if [ "$CON_SKYWAY" = 0 ] && [ "$USAR_PROXY_PROPIO" = 0 ]; then
    aviso "Sin proxy propio ni Cloudflare, el certificado de IMAP/SMTP se emite desde Ajustes → Servidor de correo."
    return 0
  fi
  info "Extrayendo el certificado que obtiene Traefik para $MAIL_HOSTNAME…"
  if ! arrancar_extractor; then
    aviso "No se pudo arrancar el extractor del certificado. Revisa: docker logs mailway-certs-dumper"
    return 0
  fi
  local t=0 ruta="/opt/stalwart/certs/$MAIL_HOSTNAME"
  while [ "$t" -lt 180 ]; do
    if docker exec mailway-mail test -s "$ruta/cert.pem" 2>/dev/null; then break; fi
    sleep 5
    t=$((t + 5))
  done
  if ! docker exec mailway-mail test -s "$ruta/cert.pem" 2>/dev/null; then
    RESUMEN_CERT="pendiente: Traefik aún no tiene el certificado de $MAIL_HOSTNAME (vuelve a ejecutar con --actualizar)"
    aviso "Traefik aún no tiene el certificado de $MAIL_HOSTNAME. Cuando el DNS apunte aquí, ejecuta de nuevo con --actualizar."
    return 0
  fi
  if motor_ajustes \
    certificate.mailway.cert "%{file:$ruta/cert.pem}%" \
    certificate.mailway.private-key "%{file:$ruta/key.pem}%" \
    certificate.mailway.default true \
    certificate.mailway.subjects.0 "$MAIL_HOSTNAME"; then
    motor_api GET /api/reload/certificate >/dev/null || true
    CERT_CONFIGURADO=1
    comprobar_extractor
  else
    aviso "No se pudo configurar el certificado de Traefik en el motor; revisa Ajustes → Servidor de correo."
  fi
}

# Extractor del certificado de Traefik (servicio certs-dumper, perfil «tls»;
# deploy/tls/extractor.py). Se recrea siempre: así arranca con el código
# actual tras un «git pull» y, en las instalaciones anteriores, sustituye al
# volcado de traefik-certs-dumper, que copiaba al volumen del motor las claves
# privadas de todos los dominios de Traefik (el extractor retira esas copias).
arrancar_extractor() {
  compose_q --profile tls up -d --force-recreate certs-dumper
}

# Espera a que el extractor confirme que el motor sirve el certificado en 993
# y 465. Mientras no lo logra, lo comprueba cada 30 segundos.
esperar_extractor() {
  local t=0 max=${1:-150}
  while [ "$t" -lt "$max" ]; do
    if docker exec mailway-certs-dumper python /app/extractor.py estado >/dev/null 2>&1; then return 0; fi
    sleep 5
    t=$((t + 5))
  done
  return 1
}

comprobar_extractor() {
  info "Esperando a que el extractor compruebe el certificado que sirve el motor en 993 y 465…"
  if esperar_extractor 150; then
    RESUMEN_CERT="el de Traefik, aplicado por el extractor y comprobado en 993 y 465 (lo renueva solo)"
    ok "El motor sirve en 993 y 465 el certificado de Traefik para $MAIL_HOSTNAME."
  else
    RESUMEN_CERT="el de Traefik, configurado; el extractor aún no lo ha comprobado (deploy/instalar.sh --comprobar)"
    aviso "El extractor aún no ha comprobado el certificado. Estado: docker exec mailway-certs-dumper python /app/extractor.py estado"
  fi
}

# La guía 0.x arrancaba traefik-certs-dumper y apuntaba certificate.default
# a los ficheros que volcaba para el servidor de correo: las mismas rutas en
# las que escribe hoy el extractor. La migración retira ese volcador, así que
# un certificate.default así no es un certificado propio: sin el extractor,
# nadie lo renovaría. Uno con otras rutas sí lo es, y se respeta.
#   certificado_del_volcado_antiguo <respuesta de /api/settings/keys>
certificado_del_volcado_antiguo() {
  local ruta="/opt/stalwart/certs/$MAIL_HOSTNAME" cert clave
  printf '%s' "$1" | grep -q '"certificate.default.cert"' || return 1
  cert=$(printf '%s' "$1" | jqr -r '.data["certificate.default.cert"] // "" | gsub("^\\s+|\\s+$"; "")' 2>/dev/null || true)
  clave=$(printf '%s' "$1" | jqr -r '.data["certificate.default.private-key"] // "" | gsub("^\\s+|\\s+$"; "")' 2>/dev/null || true)
  [ "$cert" = "%{file:$ruta/cert.pem}%" ] && [ "$clave" = "%{file:$ruta/key.pem}%" ]
}

# Borra certificate.default.* (con el punto: no toca otros identificadores
# que empiecen igual).
OP_RETIRAR_CERT_ANTIGUO='{"type":"clear","prefix":"certificate.default."}'

# Instalación de la guía 0.x sin Cloudflare: el mismo certificado pasa a
# certificate.mailway (las rutas que mantiene el extractor, con el nombre del
# servidor como sujeto explícito) y certificate.default se borra en la misma
# petición, después: el motor no se queda sin certificado en ningún momento.
# El extractor sustituye al volcado antiguo y retira del volumen las claves de
# los demás dominios que este copiaba.
pasar_volcado_antiguo_al_extractor() {
  local ruta="/opt/stalwart/certs/$MAIL_HOSTNAME"
  info "El motor usa el certificado que volcaba traefik-certs-dumper (instalación anterior): pasa al extractor, que lo renueva."
  CERT_CONFIGURADO=1
  if ! motor_cambios "[$(motor_op_insertar \
    certificate.mailway.cert "%{file:$ruta/cert.pem}%" \
    certificate.mailway.private-key "%{file:$ruta/key.pem}%" \
    certificate.mailway.default true \
    certificate.mailway.subjects.0 "$MAIL_HOSTNAME"),$OP_RETIRAR_CERT_ANTIGUO]"; then
    RESUMEN_CERT="el de la instalación anterior, SIN RENOVACIÓN: no se pudo pasar al extractor (repite con --actualizar)"
    aviso "No se pudo pasar el certificado al extractor: el motor sigue con el de la instalación anterior, que nadie renueva. Repite con --actualizar."
    return 0
  fi
  motor_api GET /api/reload/certificate >/dev/null || true
  ok "Certificado del motor en certificate.mailway; retirado certificate.default."
  aplicar_extractor
}

# Con el ACME del motor, el certificate.default de la guía 0.x sobra: apunta a
# ficheros que ya nadie renueva y competiría con el certificado de ACME.
retirar_certificado_antiguo() {
  if motor_cambios "[$OP_RETIRAR_CERT_ANTIGUO]"; then
    ok "Retirado certificate.default, el certificado de la instalación anterior: el motor pasa a usar el de Let's Encrypt."
  else
    aviso "No se pudo retirar certificate.default, el certificado de la instalación anterior, que ya nadie renueva. Bórralo en la web del motor (Settings → TLS → Certificates)."
  fi
}

aplicar_extractor() {
  if ! arrancar_extractor; then
    RESUMEN_CERT="el de Traefik, pero el extractor no arranca (docker logs mailway-certs-dumper)"
    aviso "No se pudo arrancar el extractor del certificado. Revisa: docker logs mailway-certs-dumper"
    return 0
  fi
  comprobar_extractor
}

# Con el ACME del motor, el extractor solo sigue si el motor conserva además
# certificate.mailway: el motor vuelve a cargar esos ficheros en cada recarga
# de certificados y no deben caducar. Si no, se retira y se limpian del
# volumen las claves de otros dominios que dejó el volcado antiguo: también
# sin contenedor del extractor si el motor venía de ese volcado ($2 = 1), ya
# que la migración retira el contenedor de traefik-certs-dumper.
#   extractor_con_acme <con certificate.mailway: 0|1> [con el volcado antiguo: 0|1]
extractor_con_acme() {
  if [ "$1" = 1 ]; then
    if [ "$CON_SKYWAY" = 1 ] && [ -z "$TRAEFIK_ACME_VOLUME" ]; then return 0; fi
    if arrancar_extractor; then
      info "El motor conserva además certificate.mailway: el extractor mantiene esos ficheros al día sin recargar el motor."
    else
      aviso "No se pudo arrancar el extractor del certificado. Revisa: docker logs mailway-certs-dumper"
    fi
    return 0
  fi
  if docker inspect mailway-certs-dumper >/dev/null 2>&1; then
    docker rm -f mailway-certs-dumper >/dev/null
  elif [ "${2:-0}" != 1 ]; then
    return 0
  fi
  if compose_q --profile tls run --rm --no-deps -T certs-dumper python /app/extractor.py purgar; then
    ok "El motor usa su propio ACME: sin extractor del certificado y con el volumen de certificados limpio."
  else
    aviso "No se pudo limpiar el volumen de certificados del motor. A mano: docker compose --env-file deploy/.env -f deploy/docker-compose.mail.yml --profile tls run --rm --no-deps certs-dumper python /app/extractor.py purgar"
  fi
}

# --------------------------------------------- herramienta del motor (panel) --
#
# El panel trae una herramienta de terminal para el motor (dentro de su
# contenedor y como el usuario «node»): node server/dist/tools/motor.js
# <orden>. Una línea JSON por la salida estándar y el texto para las personas
# por la de errores; código 0 bien, 1 problema (JSON con ok:false y error) y
# 2 uso incorrecto. El instalador la usa para lo que sabe el panel y no el
# motor: los ajustes de Mailway en la 0.16 (provisionar) y, al migrar, el
# modo mantenimiento, las contraseñas guardadas y las tareas de después.

HM_SALIDA=""

# Contenedor del panel según deploy/.env: el autónomo es mailway-panel; junto
# a Skyway, el de MAILWAY_PANEL_INTERNAL_URL (o skyway-mailway-panel).
contenedor_panel_conocido() {
  local interna re='^http://(skyway-[a-z0-9][a-z0-9_.-]*):[0-9]{1,5}$'
  if [ "$CON_SKYWAY" = 0 ]; then
    printf 'mailway-panel'
    return 0
  fi
  interna=$(leer_env MAILWAY_PANEL_INTERNAL_URL)
  if [[ $interna =~ $re ]]; then printf '%s' "${BASH_REMATCH[1]}"; else printf 'skyway-mailway-panel'; fi
}

panel_tiene_herramienta_motor() { docker exec "$1" test -f server/dist/tools/motor.js 2>/dev/null; }

# Ejecuta la herramienta y deja su línea JSON en HM_SALIDA. Su texto (salida
# de errores) se muestra tal cual, como información; las líneas «Aviso:» o
# «Error:», como avisos.
#   herramienta_motor <contenedor del panel> <segundos máximos> <orden> [opciones]
herramienta_motor() {
  local panel=$1 espera=$2 codigo=0 linea
  shift 2
  preparar_errores_herramienta
  HM_SALIDA=$(timeout "$espera" docker exec -i -u node "$panel" node server/dist/tools/motor.js "$@" </dev/null 2>"$ERR_TMP") || codigo=$?
  while IFS= read -r linea || [ -n "$linea" ]; do
    case "$linea" in
      '') ;;
      Aviso:* | Error:*) aviso "${linea#*: }" ;;
      *) info "$linea" ;;
    esac
  done <"$ERR_TMP"
  rm -f "$ERR_TMP"
  ERR_TMP=""
  HM_SALIDA=$(printf '%s\n' "$HM_SALIDA" | sed -n '$p')
  if [ "$codigo" = 124 ]; then aviso "La herramienta del motor del panel no ha terminado en $espera segundos ($1)."; fi
  return "$codigo"
}

# Campo de la última salida de la herramienta (vacío si no es JSON).
hm_campo() { printf '%s' "$HM_SALIDA" | jqr -r "$@" 2>/dev/null || true; }

# Hora (HH:MM) de una marca de tiempo del panel, en milisegundos; «?» si no
# lo es.
hora_de_ms() {
  case "$1" in
    '' | *[!0-9]*) printf '?' ;;
    *) date -d "@$(($1 / 1000))" '+%H:%M' 2>/dev/null || printf '?' ;;
  esac
}

# Explica por qué «provisionar» no ha dejado todo aplicado.
explicar_provisionar() {
  local error errores faltan fallidas
  error=$(hm_campo '.error // empty')
  error=${error%.}
  errores=$(hm_campo '(.errores // []) | map(if type == "string" then . else tostring end) | join("; ")')
  faltan=$(hm_campo '[(.faltan // {}) | to_entries[] | select((.value | length) > 0) | "\(.key): \(.value | join(", "))"] | join("; ")')
  fallidas=$(hm_campo '.suspensiones.fallidas // [] | if type == "array" then join(", ") elif . == 0 then empty else tostring end')
  aviso "El panel no ha dejado el motor con los ajustes de Mailway${error:+: $error}."
  # El error ya dice el primero: la lista, solo si hay más.
  if [ -n "$errores" ] && [ "${errores%.}" != "$error" ]; then aviso "Errores: ${errores:0:600}"; fi
  if [ -n "$faltan" ]; then aviso "Faltan en el motor: ${faltan:0:600}"; fi
  if [ -n "$fallidas" ]; then aviso "Suspensiones sin reaplicar: ${fallidas:0:600}."; fi
}

# Ajustes de Mailway en el motor 0.16 con «motor.js provisionar»: nombre del
# servidor, X-Forwarded-For, exención de la red interna, límite de contraseñas
# de aplicación, envío por 587 con STARTTLS y sin autoservicio; además
# reaplica las suspensiones y comprueba que existe en el motor todo lo que el
# panel conoce. Los sockets nuevos (el 587) solo se abren al arrancar: si la
# herramienta lo pide (restartRequired), se reinicia el motor y se repite, y
# la segunda vez ya no debe pedirlo. Devuelve 1 (y lo explica) si no queda
# todo aplicado.
#   provisionar_motor <contenedor del panel> <contenedor del motor>
provisionar_motor() {
  local panel=$1 motor=$2 intento codigo reinicio
  for intento in 1 2; do
    codigo=0
    herramienta_motor "$panel" 900 provisionar || codigo=$?
    if [ "$codigo" != 0 ] || [ "$(hm_campo '.ok')" != true ]; then
      explicar_provisionar
      return 1
    fi
    reinicio=$(hm_campo '(.restartRequired // []) | map(tostring) | join(", ")')
    # Una ejecución anterior pudo crear el 587 sin llegar a reiniciar el
    # motor: la herramienta ya no lo pide, pero el puerto sigue cerrado.
    if [ -z "$reinicio" ] && ! puerto_abierto_motor "$motor" 587; then
      reinicio="el puerto 587 aún no escucha"
    fi
    if [ -z "$reinicio" ]; then
      ok "Ajustes de Mailway aplicados en el motor (suspensiones reaplicadas: $(hm_campo '.suspensiones.reaplicadas // 0'))."
      return 0
    fi
    if [ "$intento" = 2 ]; then
      aviso "El motor sigue pidiendo un reinicio después de reiniciarlo (${reinicio:0:300})."
      return 1
    fi
    info "Se reinicia el motor para que abra lo nuevo y se repite."
    docker restart "$motor" >/dev/null
    if ! esperar_motor_016 "$motor" 150 ready; then
      aviso "El motor no vuelve después de reiniciarlo. Revisa: docker logs $motor"
      return 1
    fi
  done
}

# Paso de la instalación y de --actualizar con Stalwart 0.16: con el panel en
# marcha, los ajustes de Mailway en el motor. Nunca interrumpe la instalación:
# lo que quede pendiente va al resumen, --comprobar lo señala y repetir
# --actualizar lo completa (es idempotente).
#   aplicar_ajustes_mailway <contenedor del panel>
aplicar_ajustes_mailway() {
  local panel=$1
  titulo "Ajustes de Mailway en el motor"
  if [ -z "$panel" ] || ! en_marcha "$panel" || ! esperar_sano "$panel" 180; then
    RESUMEN_AJUSTES="pendientes: el panel no está en marcha (repite con sudo mailway update -y --reaplicar)"
    aviso "El panel${panel:+ ($panel)} no está en marcha: el motor sigue sin los ajustes de Mailway (envío por 587, exención de la red interna…). Repite cuando lo esté: sudo mailway update -y --reaplicar"
    return 0
  fi
  if ! panel_tiene_herramienta_motor "$panel"; then
    RESUMEN_AJUSTES="pendientes: el panel desplegado no tiene la herramienta del motor"
    aviso "El panel desplegado ($panel) no tiene la herramienta del motor (server/dist/tools/motor.js): despliega la versión actual de Mailway y repite con sudo mailway update -y --reaplicar."
    return 0
  fi
  if provisionar_motor "$panel" mailway-mail; then
    RESUMEN_AJUSTES="aplicados por el panel"
  else
    # Lo más común: el panel aún no ha hecho su puesta en marcha (la
    # instalación autónoma la hace en el navegador) y su herramienta todavía
    # no tiene motor.
    RESUMEN_AJUSTES="INCOMPLETOS (detalle arriba): completa la puesta en marcha del panel si falta y repite con sudo mailway update -y --reaplicar"
  fi
}

# ----------------------------------------------------------------- Skyway --

# Mensaje de error de la última respuesta de Skyway (o su código HTTP).
sky_error() {
  local mensaje
  mensaje=$(campo_json '.error // empty')
  printf '%s' "${mensaje:-HTTP $RESP_CODE}"
}

# Identificadores de Skyway: van en rutas de la API, así que se exigen simples.
id_simple() { coincide "$1" '^[A-Za-z0-9_-]{1,100}$'; }

# ¿Es la versión $1 igual o posterior a $2?
version_ge() {
  coincide "$1" '^[0-9]+(\.[0-9]+){1,2}' || return 1
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]
}

# Si la API de Skyway no responde en la dirección por defecto, se prueba la IP
# del contenedor «skyway» en cada una de sus redes (puerto 4000): un compose
# propio puede no publicar el puerto en el host. Deja SKYWAY_URL en la que
# responde; si ninguna, la deja como estaba y devuelve 1.
skyway_por_ip_del_contenedor() {
  local original=$SKYWAY_URL ip
  en_marcha skyway || return 1
  for ip in $(docker inspect --type container -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' skyway 2>/dev/null || true); do
    ipv4_valida "$ip" || continue
    SKYWAY_URL="http://$ip:4000"
    sky_api GET /api/health
    if [ "$RESP_CODE" = "200" ]; then return 0; fi
  done
  SKYWAY_URL=$original
  RESP_CODE="000"
  return 1
}

# ------------------------------------------------- panel que ya está en Skyway --
#
# Antes de la 1.0, el panel se creaba a mano en Skyway (con el nombre de
# proyecto y de servicio que cada uno eligiera) y su clave maestra se generaba
# sola en su volumen /data. El instalador tiene que actualizar ESE panel: crear
# otro lo duplicaría, y darle otra MAILWAY_SECRET le haría perder sus secretos
# cifrados (Cloudflare, motor), invalidaría tokens de gestión, claves de API y
# sesiones y cambiaría el TXT _mailway con el que se verificaron los dominios.

# Entorno de un contenedor, una variable por línea.
entorno_contenedor() {
  docker inspect --type container -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null || true
}

# ¿Es un panel de Mailway? Su imagen fija MAILWAY_DATA_DIR desde la primera
# versión: no depende de las variables que se pusieran a mano. Se comprueba
# con bash, sin pasar el entorno (con secretos) a otro programa.
es_panel_mailway() {
  local entorno
  entorno=$'\n'$(entorno_contenedor "$1")
  [[ $entorno == *$'\nMAILWAY_DATA_DIR='* ]]
}

# Guarda en PANEL_EXISTENTE_ENV las variables del panel en ejecución que el
# instalador reutiliza (secretos, nombres e IP).
leer_entorno_panel() {
  local linea clave
  PANEL_EXISTENTE_ENV=()
  while IFS= read -r linea; do
    clave=${linea%%=*}
    case "$clave" in
      MAILWAY_SECRET | MAILWAY_TRAEFIK_TOKEN | MAILWAY_WEBMAIL_TOKEN | MAILWAY_SETUP_TOKEN | \
        STALWART_ADMIN_PASSWORD | MAILWAY_MAIL_HOSTNAME | MAILWAY_WEBMAIL_URL | MAILWAY_PANEL_URL | MAILWAY_PUBLIC_IP | \
        MAILWAY_DATA_DIR)
        if [ "$clave" != "$linea" ]; then PANEL_EXISTENTE_ENV[$clave]=${linea#*=}; fi
        ;;
    esac
  done <<<"$(entorno_contenedor "$1")"
}

# Valor de una variable del panel existente (vacío si no hay panel o no la tiene).
valor_panel() { printf '%s' "${PANEL_EXISTENTE_ENV[$1]:-}"; }

# Como config.ts del panel: una clave maestra solo cuenta con 16 caracteres o
# más, sin los espacios de los extremos. Escribe la clave limpia o nada.
clave_maestra_valida() {
  local c=$1
  c=${c#"${c%%[![:space:]]*}"}
  c=${c%"${c##*[![:space:]]}"}
  if [ "${#c}" -ge 16 ]; then printf '%s' "$c"; fi
}

# Clave maestra con la que arranca el panel existente (contenedor $1, por
# defecto el detectado): la de su entorno si vale y, si no, la de su volumen
# (<MAILWAY_DATA_DIR>/.secret), que es la que usa. Vacía si no se puede saber
# (contenedor parado). Se lee con bash: solo pasa por el «cat» del propio
# contenedor, nunca por argumentos.
clave_maestra_del_panel() {
  local contenedor=${1:-$PANEL_EXISTENTE_CONTENEDOR} clave dir
  clave=$(clave_maestra_valida "$(valor_panel MAILWAY_SECRET)")
  if [ -z "$clave" ] && [ -n "$contenedor" ] && en_marcha "$contenedor"; then
    dir=$(valor_panel MAILWAY_DATA_DIR)
    dir=${dir:-/data}
    if coincide "$dir" '^/[A-Za-z0-9._/-]*$'; then
      clave=$(clave_maestra_valida "$(docker exec "$contenedor" cat "$dir/.secret" 2>/dev/null || true)")
    fi
  fi
  printf '%s' "$clave"
}

# Nombre de una URL (https://Panel.x.com:443/ruta → panel.x.com).
host_de_url() {
  local resto=${1#*://}
  resto=${resto%%/*}
  resto=${resto%%:*}
  printf '%s' "$resto" | tr '[:upper:]' '[:lower:]'
}

# Primer Host(`…`) de las reglas de Traefik de un contenedor: el dominio con
# el que Skyway publica el panel.
host_traefik_contenedor() {
  local etiquetas linea re='Host\(`([^`]+)`\)'
  etiquetas=$(docker inspect --type container \
    -f '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}' "$1" 2>/dev/null || true)
  while IFS= read -r linea; do
    case "$linea" in traefik.http.routers.*.rule=*) ;; *) continue ;; esac
    if [[ $linea =~ $re ]]; then
      printf '%s' "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]'
      return 0
    fi
  done <<<"$etiquetas"
}

# Contenedores que despliega Skyway (con -a, también los parados).
contenedores_skyway() {
  docker ps "$@" --filter label=skyway.service --format '{{.Names}}' 2>/dev/null || true
}

# Servicio de Skyway del panel que ya conoce deploy/.env (una ejecución
# anterior de la 1.0 guarda su contenedor en MAILWAY_PANEL_INTERNAL_URL).
servicio_del_panel_conocido() {
  local url c servicio re='^http://([a-z0-9][a-z0-9_.-]*):[0-9]{1,5}$'
  url=$(leer_env MAILWAY_PANEL_INTERNAL_URL)
  [[ $url =~ $re ]] || return 0
  c=${BASH_REMATCH[1]}
  servicio=$(docker inspect --type container -f '{{index .Config.Labels "skyway.service"}}' "$c" 2>/dev/null || true)
  if id_simple "$servicio"; then printf '%s' "$servicio"; fi
}

# Acceso a la API de Skyway antes de tiempo y sin preguntar (token temporal y
# dirección que responde), para saber de quién es un panel antes de usar
# nada suyo. Devuelve 1 si aún no se puede; desplegar_en_skyway lo resuelve
# después como siempre.
preparar_api_skyway_en_silencio() {
  if [ -n "${SKYWAY_URL:-}" ] && ! coincide "$SKYWAY_URL" '^https?://[][A-Za-z0-9.:-]+(/[A-Za-z0-9._~/-]*)?$'; then
    return 1
  fi
  if [ -z "${SKYWAY_TOKEN:-}" ]; then
    crear_token_temporal_skyway >/dev/null 2>&1 || return 1
    ok "Token temporal de Skyway creado (caduca en 60 minutos y se revoca al terminar)."
  fi
  if [ -z "${SKYWAY_URL:-}" ]; then SKYWAY_URL_AUTOMATICA=1; fi
  SKYWAY_URL=${SKYWAY_URL:-http://127.0.0.1:4000}
  SKYWAY_URL=${SKYWAY_URL%/}
  sky_api GET /api/health
  [ "$RESP_CODE" = "200" ] || skyway_por_ip_del_contenedor
}

# ¿Es de un proyecto de un cliente (workspace) el contenedor $1? Solo se sabe
# si la API de Skyway responde; si no, o si no existe, devuelve 1.
contenedor_de_cliente() {
  local proyecto
  proyecto=$(docker inspect --type container -f '{{index .Config.Labels "skyway.project"}}' "$1" 2>/dev/null || true)
  id_simple "$proyecto" || return 1
  preparar_api_skyway_en_silencio || return 1
  sky_api GET "/api/projects/$proyecto"
  [ "$RESP_CODE" = "200" ] && [ -n "$(campo_json '.project.workspace_id // empty')" ]
}

# Busca el panel entre los contenedores de Skyway antes de preguntar nada,
# para proponer sus nombres y conservar su clave y sus secretos. Primero los
# que están en marcha; si no hay ninguno, también los parados.
#   - MAILWAY_PANEL_SERVICIO=<id> lo indica a mano; =ninguno, no se adopta nada.
#   - El que nombra deploy/.env (MAILWAY_PANEL_INTERNAL_URL) es el de siempre.
#   - Si no, se ignoran los de proyectos de clientes (workspaces) y, antes de
#     usar nada del que queda, se pregunta si es el de esta instalación: en
#     un Skyway con clientes, otro puede desplegar también un Mailway.
detectar_panel_existente() {
  [ "$CON_SKYWAY" = 1 ] || return 0
  local forzado=${MAILWAY_PANEL_SERVICIO:-} conocido="" c servicio vistos=" " par
  local -a encontrados=() propios=()
  if [ "$forzado" = ninguno ]; then
    PANEL_SIN_ADOPCION=1
    return 0
  fi
  if [ -n "$forzado" ] && ! id_simple "$forzado"; then
    fallo "MAILWAY_PANEL_SERVICIO no es un identificador de servicio de Skyway válido."
  fi
  if [ -z "$forzado" ]; then conocido=$(servicio_del_panel_conocido); fi
  for par in en-marcha todos; do
    while IFS= read -r c; do
      [ -n "$c" ] || continue
      servicio=$(docker inspect --type container -f '{{index .Config.Labels "skyway.service"}}' "$c" 2>/dev/null || true)
      id_simple "$servicio" || continue
      # Las réplicas y los contenedores de un despliegue anterior son el mismo servicio.
      case "$vistos" in *" $servicio "*) continue ;; esac
      vistos+="$servicio "
      if [ -n "$forzado$conocido" ]; then
        [ "$servicio" = "${forzado:-$conocido}" ] || continue
      else
        es_panel_mailway "$c" || continue
      fi
      encontrados+=("$servicio $c")
    done < <(if [ "$par" = en-marcha ]; then contenedores_skyway; else contenedores_skyway -a; fi)
    [ "${#encontrados[@]}" -eq 0 ] || break
  done
  if [ "${#encontrados[@]}" -eq 0 ]; then
    # Indicado pero sin contenedor (parado y retirado): se localiza por la API.
    PANEL_EXISTENTE_SERVICIO=$forzado
    return 0
  fi
  titulo "Panel existente en Skyway"

  if [ -z "$forzado$conocido" ] && preparar_api_skyway_en_silencio; then
    for par in "${encontrados[@]}"; do
      sky_api GET "/api/services/${par%% *}"
      if [ "$RESP_CODE" = "200" ] && [ -n "$(campo_json '.project.workspace_id // empty')" ]; then
        info "Se ignora el panel de Mailway del contenedor ${par#* }: es de un proyecto de un cliente."
        continue
      fi
      propios+=("$par")
    done
    encontrados=(${propios[@]+"${propios[@]}"})
    if [ "${#encontrados[@]}" -eq 0 ]; then return 0; fi
  fi
  if [ "${#encontrados[@]}" -gt 1 ]; then
    aviso "Skyway despliega varios paneles de Mailway:"
    for par in "${encontrados[@]}"; do info "servicio ${par%% *} (contenedor ${par#* })"; done
    fallo "Indica el de esta instalación con MAILWAY_PANEL_SERVICIO=<servicio> y vuelve a ejecutar."
  fi

  servicio=${encontrados[0]%% *}
  c=${encontrados[0]#* }
  leer_entorno_panel "$c"
  PANEL_EXISTENTE_HOST=$(host_de_url "$(valor_panel MAILWAY_PANEL_URL)")
  if ! host_valido "$PANEL_EXISTENTE_HOST"; then
    PANEL_EXISTENTE_HOST=$(host_traefik_contenedor "$c")
    host_valido "$PANEL_EXISTENTE_HOST" || PANEL_EXISTENTE_HOST=""
  fi
  if [ -z "$forzado$conocido" ] && { [ -z "$PANEL_EXISTENTE_HOST" ] || [ "$PANEL_EXISTENTE_HOST" != "$(leer_env PANEL_HOSTNAME)" ]; }; then
    info "Skyway despliega un panel de Mailway: contenedor $c${PANEL_EXISTENTE_HOST:+, https://$PANEL_EXISTENTE_HOST}."
    if [ "$INTERACTIVO" != 1 ]; then
      fallo "deploy/.env no menciona ese panel. Para actualizarlo, indica MAILWAY_PANEL_SERVICIO=$servicio; para no tocarlo, MAILWAY_PANEL_SERVICIO=ninguno."
    fi
    if ! confirmar "¿Es el panel de esta instalación? Se actualizará ese, sin crear otro, conservando su clave maestra y sus datos." s; then
      PANEL_EXISTENTE_ENV=()
      PANEL_EXISTENTE_HOST=""
      PANEL_SIN_ADOPCION=1
      PANEL_RECHAZADO=$servicio
      info "No se toca ese panel."
      return 0
    fi
  fi
  PANEL_EXISTENTE_SERVICIO=$servicio
  PANEL_EXISTENTE_CONTENEDOR=$c
  ok "Se actualiza el panel que ya despliega Skyway (contenedor $c${PANEL_EXISTENTE_HOST:+, $PANEL_EXISTENTE_HOST}), sin crear otro."
}

# Repositorio de GitHub normalizado para compararlo (https://github.com/A/B.git,
# github.com/a/b y A/B son el mismo).
NORMALIZAR_REPO='def norm: ascii_downcase | sub("^\\s+"; "") | sub("\\s+$"; "") | sub("^git@github\\.com:"; "")
  | sub("^[a-z+]+://"; "") | sub("^www\\."; "") | sub("^github\\.com/"; "") | sub("/+$"; "") | sub("\\.git$"; "");'

# Decide qué servicio de Skyway es el panel y lo deja en PANEL_ADOPTADO:
#   1. el detectado por su contenedor (o indicado con MAILWAY_PANEL_SERVICIO);
#   2. si no, el único servicio git de cualquier proyecto que despliega el
#      repositorio de Mailway ($1), se llame como se llame.
# Si no hay ninguno, PANEL_ADOPTADO queda vacío y se usa (o crea) el proyecto
# «mailway» con el servicio «panel». Necesita el token de Skyway.
localizar_panel_en_skyway() {
  local repo=$1 proyectos id coincidencias="" n
  PANEL_ADOPTADO=""
  if [ "$PANEL_SIN_ADOPCION" = 1 ]; then return 0; fi
  if [ -n "$PANEL_EXISTENTE_SERVICIO" ]; then
    sky_api GET "/api/services/$PANEL_EXISTENTE_SERVICIO"
    case "$RESP_CODE" in
      200) ;;
      401) fallo "Skyway rechazó el token: no existe, ha caducado o se ha revocado." ;;
      *) fallo "No se pudo leer el servicio del panel en Skyway ($PANEL_EXISTENTE_SERVICIO): $(sky_error)." ;;
    esac
    # Red de seguridad: detectar_panel_existente ya descarta los de clientes
    # cuando la API responde a tiempo. Solo se acepta si se indicó a mano.
    if [ -n "$(campo_json '.project.workspace_id // empty')" ] && [ -z "${MAILWAY_PANEL_SERVICIO:-}" ]; then
      # Pasa si en Skyway se asigna el proyecto del panel a un cliente: sus
      # miembros verían sus variables (clave maestra, tokens). Se dice cuál y
      # cómo seguir, con la orden lista para copiar.
      local cliente_panel
      cliente_panel=$(campo_json '.project.client // empty')
      aviso "El proyecto «$(campo_json '.project.name // empty')» del panel está asignado a ${cliente_panel:+«$cliente_panel», }un cliente de Skyway."
      info "Si ese cliente eres tú (nadie más entra en él), sigue con:"
      info "  MAILWAY_PANEL_SERVICIO=$PANEL_EXISTENTE_SERVICIO mailway update -y --reaplicar"
      info "Si es de otra persona, quítale el cliente al proyecto en Skyway y repite «mailway update -y --reaplicar»."
      fallo "El panel detectado es de un proyecto de un cliente y no se toca. Si de verdad es el de esta instalación, indícalo con MAILWAY_PANEL_SERVICIO=$PANEL_EXISTENTE_SERVICIO."
    fi
    PANEL_ADOPTADO=$(campo_json '"\(.project.id) \(.project.slug) \(.service.id) \(.service.slug)"')
    return 0
  fi

  # Sin contenedor (parado y retirado): el único servicio git que despliega el
  # repositorio de Mailway en un proyecto propio (no de un cliente).
  sky_api GET /api/projects
  case "$RESP_CODE" in
    200) ;;
    401) fallo "Skyway rechazó el token: no existe, ha caducado o se ha revocado." ;;
    *) fallo "No se pudieron leer los proyectos de Skyway: $(sky_error)." ;;
  esac
  proyectos=$(campo_json '(.projects // [])[] | select((.workspace_id // "") == "") | .id')
  for id in $proyectos; do
    id_simple "$id" || continue
    sky_api GET "/api/projects/$id"
    [ "$RESP_CODE" = "200" ] || continue
    # $(…) quita los saltos de línea finales: se añade uno por proyecto.
    coincidencias+=$(campo_json --arg r "$repo" "$NORMALIZAR_REPO"'
      .project as $p | (.services // [])[]
      | select(.type == "git" and ((.config.repoUrl // "") | norm) == ($r | norm))
      | "\($p.id) \($p.slug) \(.id) \(.slug)"')$'\n'
  done
  n=$(printf '%s' "$coincidencias" | grep -c . || true)
  if [ "$n" -gt 1 ]; then
    aviso "Hay varios servicios en Skyway que despliegan $repo:"
    printf '%s' "$coincidencias" | while read -r _ proyecto id servicio; do
      if [ -n "$id" ]; then info "servicio «$servicio» del proyecto «$proyecto» (id $id)"; fi
    done
    fallo "Indica el del panel con MAILWAY_PANEL_SERVICIO=<id del servicio> y vuelve a ejecutar."
  fi
  [ "$n" = 1 ] || return 0

  # Antes de tocarlo: es el que nombra deploy/.env (contenedor o dominio), o
  # lo confirma quien instala.
  local candidato p_slug s_id s_slug
  candidato=$(printf '%s' "$coincidencias" | grep -m 1 .)
  read -r _ p_slug s_id s_slug <<<"$candidato"
  id_simple "$s_id" || fallo "Respuesta inesperada de Skyway al leer los servicios."
  sky_api GET "/api/services/$s_id"
  [ "$RESP_CODE" = "200" ] || fallo "No se pudo leer el servicio del panel en Skyway ($s_id): $(sky_error)."
  if [ "http://skyway-$p_slug-$s_slug:4100" != "$(leer_env MAILWAY_PANEL_INTERNAL_URL)" ] &&
    [ -z "$(campo_json --arg d "$(leer_env PANEL_HOSTNAME)" '(.service.config.domains // [])[] | select(. == $d and $d != "")')" ]; then
    info "Skyway despliega $repo en el servicio «$(campo_json '.service.name // empty')» del proyecto «$(campo_json '.project.name // empty')»."
    if [ "$INTERACTIVO" != 1 ]; then
      fallo "deploy/.env no menciona ese servicio. Para actualizarlo, indica MAILWAY_PANEL_SERVICIO=$s_id; para no tocarlo, MAILWAY_PANEL_SERVICIO=ninguno."
    fi
    if ! confirmar "¿Es el panel de esta instalación? Se actualizará ese, sin crear otro, conservando su clave maestra y sus datos." s; then
      PANEL_SIN_ADOPCION=1
      PANEL_RECHAZADO=$s_id
      info "No se toca ese servicio."
      return 0
    fi
  fi
  PANEL_ADOPTADO=$candidato
  return 0
}

desplegar_en_skyway() {
  titulo "Panel en Skyway"
  local url_indicada=${SKYWAY_URL:+1}
  if [ "$SKYWAY_URL_AUTOMATICA" = 1 ]; then url_indicada=""; fi
  SKYWAY_URL=${SKYWAY_URL:-http://127.0.0.1:4000}
  SKYWAY_URL=${SKYWAY_URL%/}
  coincide "$SKYWAY_URL" '^https?://[][A-Za-z0-9.:-]+(/[A-Za-z0-9._~/-]*)?$' ||
    fallo "SKYWAY_URL no es una dirección válida: «$SKYWAY_URL» (p. ej. http://127.0.0.1:4000)."
  # Sin token: si Skyway corre en este servidor, uno temporal creado desde su
  # terminal (caduca en 60 minutos y se revoca al terminar). Si no, se pide.
  # El token temporal puede existir ya (lo crea detectar_panel_existente para
  # saber de quién es un panel): entonces no se pregunta nada.
  if [ -z "$SKY_TOKEN_TEMPORAL_ID" ] && { [ -n "${SKYWAY_TOKEN:-}" ] || ! crear_token_temporal_skyway; }; then
    if [ "$INTERACTIVO" = 1 ] && [ -z "${SKYWAY_TOKEN:-}" ]; then
      info "Con un token de API de Skyway (Mi perfil → Tokens de API, «sky_…») se despliega el panel"
      info "desde GitHub con su dominio, volumen y variables. Intro para hacerlo a mano después."
    fi
    preguntar_secreto SKYWAY_TOKEN "Token de API de Skyway" "${SKYWAY_TOKEN:-}"
  fi
  if [ -z "$SKYWAY_TOKEN" ]; then
    info "Omitido. Variables del panel para crearlo a mano: consulta el final de deploy/.env.example."
    return 0
  fi
  coincide "$SKYWAY_TOKEN" '^sky_[A-Za-z0-9_-]{8,200}$' ||
    fallo "El token de Skyway no es válido: debe empezar por «sky_» (Mi perfil → Tokens de API)."

  sky_api GET /api/health
  if [ "$RESP_CODE" != "200" ] && [ -z "$url_indicada" ] && skyway_por_ip_del_contenedor; then
    info "Skyway no publica su API en 127.0.0.1:4000: se usa la de su contenedor ($SKYWAY_URL)."
  fi
  if [ "$RESP_CODE" != "200" ]; then
    # Con el token temporal nadie ha pedido desplegar el panel: como sin
    # token, se omite y la instalación sigue (motor y webmail ya están en
    # marcha). Con un token indicado, sí es un error.
    if [ -n "$SKY_TOKEN_TEMPORAL_ID" ]; then
      revocar_token_temporal_skyway
      RESUMEN_SKYWAY="omitido: Skyway no responde en $SKYWAY_URL"
      aviso "Skyway no responde en $SKYWAY_URL: no se despliega el panel. Indica su API con SKYWAY_URL y repite con --actualizar, o crea el panel a mano (variables al final de deploy/.env.example)."
      return 0
    fi
    fallo "Skyway no responde en $SKYWAY_URL (variable SKYWAY_URL)."
  fi
  SKYWAY_VERSION=$(campo_json '.version // empty')
  ok "Skyway ${SKYWAY_VERSION:-(versión desconocida)} en $SKYWAY_URL"

  local repo rama
  repo=${MAILWAY_REPO:-https://github.com/NkrowOne/Mailway}
  rama=${MAILWAY_RAMA:-main}
  if tiene_control "$repo$rama"; then fallo "MAILWAY_REPO o MAILWAY_RAMA contienen caracteres de control."; fi

  # El panel que Skyway ya despliega (aunque se creara a mano con otro nombre)
  # se actualiza; solo sin él se usa o crea el proyecto «mailway».
  local proyecto proyecto_id proyecto_slug servicio="" servicio_id servicio_slug
  localizar_panel_en_skyway "$repo"
  if [ -n "$PANEL_ADOPTADO" ]; then
    read -r proyecto_id proyecto_slug servicio_id servicio_slug <<<"$PANEL_ADOPTADO"
    if ! id_simple "$proyecto_id" || ! id_simple "$proyecto_slug" || ! id_simple "$servicio_id" ||
      ! id_simple "$servicio_slug"; then
      fallo "Respuesta inesperada de Skyway al leer el servicio del panel."
    fi
    servicio="$servicio_id $servicio_slug"
    ok "Se actualiza el panel que ya despliega Skyway (servicio «$servicio_slug» del proyecto «$proyecto_slug»)."
  else
    local nombre_proyecto
    nombre_proyecto=${MAILWAY_PROYECTO:-mailway}
    if tiene_control "$nombre_proyecto" || [ "${#nombre_proyecto}" -gt 60 ]; then
      fallo "Nombre de proyecto no válido (variable MAILWAY_PROYECTO): hasta 60 caracteres, sin caracteres de control."
    fi
    sky_api GET /api/projects
    [ "$RESP_CODE" = "200" ] || fallo "No se pudieron leer los proyectos de Skyway: $(sky_error)."
    proyecto=$(campo_json --arg n "$nombre_proyecto" \
      'first((.projects // [])[] | select((.workspace_id // "") == "" and (.slug == $n or .name == $n))) | "\(.id) \(.slug)"')
    if [ -z "$proyecto" ]; then
      sky_api POST /api/projects "{\"name\":\"$(json_escape "$nombre_proyecto")\"}"
      [ "$RESP_CODE" = "201" ] || [ "$RESP_CODE" = "200" ] ||
        fallo "No se pudo crear el proyecto en Skyway: $(sky_error). Usa un token de un administrador o propietario."
      proyecto=$(campo_json '.project | "\(.id) \(.slug)"')
      ok "Proyecto «$nombre_proyecto» creado en Skyway."
    else
      ok "Proyecto «$nombre_proyecto» ya existe en Skyway."
    fi
    read -r proyecto_id proyecto_slug <<<"$proyecto"
    if ! id_simple "$proyecto_id" || ! id_simple "$proyecto_slug"; then
      fallo "Respuesta inesperada de Skyway al leer el proyecto."
    fi
    sky_api GET "/api/projects/$proyecto_id"
    [ "$RESP_CODE" = "200" ] || fallo "No se pudo leer el proyecto de Skyway: $(sky_error)."
    # Un proyecto de un cliente nunca: se busca, y se vuelve a comprobar aquí.
    [ -z "$(campo_json '.project.workspace_id // empty')" ] ||
      fallo "El proyecto «$nombre_proyecto» de Skyway es de un cliente: elige otro con MAILWAY_PROYECTO=<nombre>."
    servicio=$(campo_json 'first((.services // [])[] | select(.name == "panel" and .type == "git")) | "\(.id) \(.slug)"')
    if [ -n "$servicio" ]; then
      if [ "${servicio%% *}" = "$PANEL_RECHAZADO" ]; then
        fallo "El servicio «panel» del proyecto «$nombre_proyecto» es el que has dicho que no es de esta instalación: elige otro proyecto con MAILWAY_PROYECTO=<nombre>."
      fi
      [ -n "$(campo_json --arg r "$repo" "$NORMALIZAR_REPO"'(.services // [])[] | select(.name == "panel" and .type == "git" and ((.config.repoUrl // "") | norm) == ($r | norm)) | .id')" ] ||
        fallo "El servicio «panel» del proyecto «$nombre_proyecto» no despliega $repo: elige otro proyecto con MAILWAY_PROYECTO=<nombre>."
    fi
  fi

  # Sin MAILWAY_SMTP_ALLOW_SELF_SIGNED: el panel verifica el certificado del
  # SMTP interno contra el nombre del servidor de correo.
  local variables
  variables=$(env_json \
    "STALWART_URL=http://mailway-mail:8080" \
    "STALWART_ADMIN_USER=admin" \
    "STALWART_ADMIN_PASSWORD=$STALWART_ADMIN_PASSWORD" \
    "STALWART_SMTP_HOST=mailway-mail" \
    "STALWART_SMTP_PORT=587" \
    "MAILWAY_SECRET=$MAILWAY_SECRET" \
    "MAILWAY_SETUP_TOKEN=$MAILWAY_SETUP_TOKEN" \
    "MAILWAY_TRAEFIK_TOKEN=$MAILWAY_TRAEFIK_TOKEN" \
    "MAILWAY_WEBMAIL_TOKEN=$MAILWAY_WEBMAIL_TOKEN" \
    "MAILWAY_MAIL_HOSTNAME=$MAIL_HOSTNAME" \
    "MAILWAY_PUBLIC_IP=$IP_PUBLICA" \
    "MAILWAY_WEBMAIL_URL=https://$WEBMAIL_HOSTNAME" \
    "MAILWAY_PANEL_URL=https://$PANEL_HOSTNAME" \
    "MAILWAY_ENGINE_TRUSTED_NETWORK=$INTERNAL_SUBNET")
  [ -n "$variables" ] || fallo "No se pudieron preparar las variables del panel."

  local despliegue_inicial
  if [ -z "$servicio" ]; then
    local cuerpo
    cuerpo=$(printf '{"type":"git","name":"panel","repoUrl":"%s","branch":"%s","port":4100,"domains":["%s"],"autoDeploy":true,"env":%s}' \
      "$(json_escape "$repo")" "$(json_escape "$rama")" "$PANEL_HOSTNAME" "$variables")
    sky_api POST "/api/projects/$proyecto_id/services" "$cuerpo"
    [ "$RESP_CODE" = "201" ] || [ "$RESP_CODE" = "200" ] ||
      fallo "No se pudo crear el servicio del panel: $(sky_error)."
    servicio=$(campo_json '.service | "\(.id) \(.slug)"')
    despliegue_inicial=$(campo_json '.deployment.id // empty')
    # El alta despliega al instante, aún sin volumen: ese despliegue se
    # cancela y se repite con /data persistente.
    if id_simple "$despliegue_inicial"; then sky_api POST "/api/deployments/$despliegue_inicial/cancel"; fi
    ok "Servicio «panel» creado (repositorio $repo, rama $rama)."
  else
    # Variables: se fusionan con las existentes (PUT reemplaza la lista entera).
    read -r servicio_id servicio_slug <<<"$servicio"
    id_simple "$servicio_id" || fallo "Respuesta inesperada de Skyway al leer el servicio del panel."
    sky_api GET "/api/services/$servicio_id/env"
    [ "$RESP_CODE" = "200" ] || fallo "No se pudieron leer las variables del panel: $(sky_error)."
    local fusion retirar=false
    # Instalaciones anteriores desactivaban la verificación del certificado
    # del SMTP interno; con el certificado ya configurado deja de hacer falta.
    if [ "$CERT_CONFIGURADO" = 1 ]; then retirar=true; fi
    # La clave maestra y el token de Traefik de un panel que ya existe no se
    # tocan nunca: si están en sus variables se conservan, y si no (un panel
    # anterior a la 1.0 los guarda en /data y en su base de datos) no se
    # añaden. Con otra clave perdería sus secretos y sus tokens; con otro
    # token, quien consulta sus rutas de Traefik dejaría de tener acceso.
    fusion=$(printf '%s\n%s' "$RESP_BODY" "$variables" | jqr -s -c --argjson retirar "$retirar" \
      '(.[0].vars // {}) as $antes | {vars: (reduce ("MAILWAY_SECRET", "MAILWAY_TRAEFIK_TOKEN") as $k
        ($antes + .[1] | if $retirar then del(.MAILWAY_SMTP_ALLOW_SELF_SIGNED) else . end;
          if ($antes | has($k)) then .[$k] = $antes[$k] else del(.[$k]) end))}' \
      2>/dev/null || true)
    [ -n "$fusion" ] || fallo "Respuesta inesperada de Skyway al leer las variables del panel."
    # deploy/.env debe guardar lo que de verdad usa el panel (o nada), no un
    # valor propio que alguien podría copiar después a sus variables.
    local clave_real token_real cambios=0
    clave_real=$(clave_maestra_valida "$(campo_json '.vars.MAILWAY_SECRET // empty')")
    if [ -z "$clave_real" ]; then clave_real=$(clave_maestra_del_panel "skyway-$proyecto_slug-$servicio_slug"); fi
    if [ "$clave_real" != "$MAILWAY_SECRET" ]; then
      if [ -n "$clave_real" ] && [ -n "$MAILWAY_SECRET" ]; then
        aviso "La clave maestra del panel no coincide con la de deploy/.env: se conserva la del panel."
      fi
      MAILWAY_SECRET=$clave_real
      cambios=1
    fi
    token_real=$(campo_json '.vars.MAILWAY_TRAEFIK_TOKEN // empty')
    if [ -n "$token_real" ]; then TRAEFIK_TOKEN_PROPIO=1; else TRAEFIK_TOKEN_PROPIO=0; fi
    if [ "$token_real" != "$MAILWAY_TRAEFIK_TOKEN" ]; then
      MAILWAY_TRAEFIK_TOKEN=$token_real
      cambios=1
    fi
    if [ "$retirar" = true ] && [ -n "$(campo_json '.vars.MAILWAY_SMTP_ALLOW_SELF_SIGNED // empty')" ]; then
      info "Se retira MAILWAY_SMTP_ALLOW_SELF_SIGNED: el motor ya tiene certificado y el panel lo verifica."
    fi
    sky_api PUT "/api/services/$servicio_id/env" "$fusion"
    [ "$RESP_CODE" = "200" ] || fallo "No se pudieron actualizar las variables del panel: $(sky_error)."
    ok "Servicio «$servicio_slug» ya existe: variables actualizadas."
    if [ "$cambios" = 1 ]; then escribir_env; fi
  fi
  read -r servicio_id servicio_slug <<<"$servicio"
  if ! id_simple "$servicio_id" || ! id_simple "$servicio_slug"; then
    fallo "Respuesta inesperada de Skyway al leer el servicio del panel."
  fi
  PANEL_CONTENEDOR="skyway-$proyecto_slug-$servicio_slug"
  PANEL_SERVICIO_ID=$servicio_id
  PANEL_PROYECTO_ID=$proyecto_id

  # Volumen /data (sin él, la base de datos del panel se perdería en cada
  # despliegue), comprobación de salud y dominio. Se parte de la
  # configuración actual: PATCH sustituye listas enteras y no deben perderse
  # volúmenes o dominios que se hayan añadido a mano. domainsBase son los
  # dominios leídos: si cambian entre la lectura y el PATCH, Skyway no
  # devuelve los quitados (y solo así aplica su DNS automático a los nuevos).
  local parche
  sky_api GET "/api/services/$servicio_id"
  [ "$RESP_CODE" = "200" ] || fallo "No se pudo leer el servicio del panel: $(sky_error)."
  parche=$(campo_json -c --arg d "$PANEL_HOSTNAME" '.service.config as $c | {config: {
      volumes: (($c.volumes // []) | map({containerPath}) | if any(.[]; .containerPath == "/data") then . else . + [{containerPath: "/data"}] end),
      healthcheckPath: ($c.healthcheckPath // "/api/health"),
      domains: (($c.domains // []) | if any(.[]; . == $d) then . else . + [$d] end)
    }, domainsBase: ($c.domains // [])}')
  [ -n "$parche" ] || fallo "Respuesta inesperada de Skyway al leer el servicio del panel."
  sky_api PATCH "/api/services/$servicio_id" "$parche"
  [ "$RESP_CODE" = "200" ] || fallo "No se pudo configurar el volumen del panel: $(sky_error)."
  ok "Volumen /data, comprobación /api/health y dominio $PANEL_HOSTNAME configurados."

  sky_api GET /api/domains/config
  if [ "$RESP_CODE" = "200" ] && [ "$(campo_json '.tls')" != "true" ]; then
    aviso "Skyway no tiene correo de Let's Encrypt: el panel no tendrá HTTPS. Configúralo en Skyway → Ajustes → Dominios."
  fi

  sky_api POST "/api/services/$servicio_id/deploy" '{}'
  [ "$RESP_CODE" = "202" ] || [ "$RESP_CODE" = "200" ] || fallo "No se pudo lanzar el despliegue del panel: $(sky_error)."
  local despliegue estado t=0
  despliegue=$(campo_json '.deployment.id // empty')
  id_simple "$despliegue" || fallo "Respuesta inesperada de Skyway al lanzar el despliegue."
  info "Desplegando el panel (compila desde GitHub; puede tardar varios minutos)…"
  while [ "$t" -lt 1500 ]; do
    sleep 10
    t=$((t + 10))
    sky_api GET "/api/deployments/$despliegue"
    estado=$(campo_json '.deployment.status // empty')
    case "$estado" in
      success)
        RESUMEN_SKYWAY="desplegado ($PANEL_CONTENEDOR)"
        ok "Panel desplegado ($PANEL_CONTENEDOR)."
        return 0
        ;;
      failed | canceled)
        RESUMEN_SKYWAY="despliegue fallido: revisa el registro en Skyway"
        aviso "El despliegue del panel terminó en «$estado». Revisa el registro del despliegue en Skyway (¿acceso de Skyway al repositorio de GitHub?)."
        return 0
        ;;
    esac
  done
  RESUMEN_SKYWAY="desplegando (consulta Skyway)"
  aviso "El despliegue sigue en curso; consulta su estado en Skyway."
}

env_json() {
  local primero=1 par
  printf '{'
  for par in "$@"; do
    if [ "$primero" = 0 ]; then printf ','; fi
    primero=0
    printf '"%s":"%s"' "${par%%=*}" "$(json_escape "${par#*=}")"
  done
  printf '}'
}

# ------------------------------------------------------ emparejado con Skyway --
#
# El panel y Skyway se emparejan con dos herramientas de terminal, sin red de
# entrada y sin que ningún secreto pase por argumentos: quien ejecuta esto ya
# es root en el servidor.
#   - Skyway: node server/dist/tools/token.js (token sky_ temporal) y
#     node server/dist/tools/mailway.js conectar (lee el token mwt_ por la
#     entrada estándar y lo guarda igual que Ajustes → Correo (Mailway)).
#   - Panel: node server/dist/tools/emparejar.js (administrador, puesta en
#     marcha y token de gestión «Skyway»).
#   - Cloudflare: node server/dist/tools/cloudflare.js conectar, en el panel y
#     en Skyway (lee el token de Cloudflare por la entrada estándar).

# Las capturas de =~ quedan en BASH_REMATCH: tras extraer un secreto, una
# coincidencia inocua las sustituye (hasta bash 5.1 no se puede vaciar a mano).
olvidar_coincidencias() { coincide x x; }

# ¿Existe y está en marcha ese contenedor? (--type: una imagen o una red con
# el mismo nombre no cuentan).
en_marcha() { [ "$(docker inspect --type container -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]; }

# Muestra como avisos lo que una herramienta escribió en su salida de errores
# y lo deja anotado en HERRAMIENTA_CON_AVISOS.
mostrar_errores_herramienta() {
  local linea
  [ -n "$ERR_TMP" ] && [ -f "$ERR_TMP" ] || return 0
  while IFS= read -r linea || [ -n "$linea" ]; do
    linea=${linea#Aviso: }
    if [ -n "$linea" ]; then
      aviso "$linea"
      HERRAMIENTA_CON_AVISOS=1
    fi
  done <"$ERR_TMP"
  rm -f "$ERR_TMP"
  ERR_TMP=""
}

# Fichero para la salida de errores de una herramienta (no lleva secretos).
preparar_errores_herramienta() {
  ERR_TMP=$(mktemp)
  HERRAMIENTA_CON_AVISOS=0
}

# Token de API temporal de Skyway, creado con su herramienta de terminal si
# Skyway corre en este servidor (contenedor «skyway»). Caduca en 60 minutos y
# al_salir lo revoca al terminar, también si la instalación falla.
crear_token_temporal_skyway() {
  local salida="" id="" token="" re_id='"id":"([A-Za-z0-9_-]{1,100})"' re_token='"token":"(sky_[A-Za-z0-9_-]{8,200})"'
  en_marcha skyway || return 1
  if ! docker exec skyway test -f server/dist/tools/token.js 2>/dev/null; then
    info "Esta versión de Skyway no crea tokens desde el servidor: indica uno de Mi perfil → Tokens de API (o actualiza Skyway)."
    return 1
  fi
  preparar_errores_herramienta
  if ! salida=$(docker exec skyway node server/dist/tools/token.js crear \
    --nombre "Instalador de Mailway" --caduca-min 60 </dev/null 2>"$ERR_TMP"); then
    mostrar_errores_herramienta
    aviso "Skyway no ha podido crear un token temporal."
    return 1
  fi
  mostrar_errores_herramienta
  # Se extrae con bash: el JSON lleva el token y no pasa por ningún otro programa.
  if [[ $salida =~ $re_id ]]; then id=${BASH_REMATCH[1]}; fi
  if [[ $salida =~ $re_token ]]; then token=${BASH_REMATCH[1]}; fi
  salida=""
  olvidar_coincidencias
  if [ -z "$id" ] || [ -z "$token" ]; then
    aviso "Respuesta inesperada de la herramienta de tokens de Skyway."
    return 1
  fi
  SKY_TOKEN_TEMPORAL_ID=$id
  SKYWAY_TOKEN=$token
  ok "Token temporal de Skyway creado (caduca en 60 minutos y se revoca al terminar)."
}

revocar_token_temporal_skyway() {
  [ -n "$SKY_TOKEN_TEMPORAL_ID" ] || return 0
  local id=$SKY_TOKEN_TEMPORAL_ID
  SKY_TOKEN_TEMPORAL_ID=""
  SKYWAY_TOKEN=""
  if docker exec skyway node server/dist/tools/token.js revocar --id "$id" </dev/null >/dev/null 2>&1; then
    ok "Token temporal de Skyway revocado."
  else
    aviso "No se pudo revocar el token temporal de Skyway «Instalador de Mailway»: caduca en una hora, o revócalo en Skyway → Mi perfil → Tokens de API."
  fi
}

# Deja constancia de por qué no se ha emparejado y de cómo repetirlo.
aviso_emparejado() {
  RESUMEN_EMPAREJADO="pendiente: $1"
  aviso "$1"
  aviso "Cuando esté resuelto, repite solo el emparejado: sudo bash deploy/instalar.sh --emparejar"
}

# ¿Está Skyway conectado con OTRO panel de Mailway? Entonces no se toca: eso
# solo lo cambia --emparejar. Con este panel (o sin conexión) se empareja
# siempre: la herramienta del panel retoma lo que hubiera quedado pendiente de
# la puesta en marcha (el motor, si no respondía en la ejecución anterior) y
# renovar el token no hace daño, porque «conectar» guarda el nuevo. Necesita
# el token de Skyway (se consulta su API); sin él, se empareja.
skyway_con_otro_panel() {
  [ -n "${SKYWAY_TOKEN:-}" ] || return 1
  local servicio url
  sky_api GET /api/mailway/config
  if [ "$RESP_CODE" != "200" ] || [ "$(campo_json '.configured')" != "true" ]; then return 1; fi
  servicio=$(campo_json '.serviceId // empty')
  url=$(campo_json '.baseUrl // empty' | tr -d '[:cntrl:]')
  if [ "$servicio" = "$PANEL_SERVICIO_ID" ] || [ "${url%/}" = "https://$PANEL_HOSTNAME" ]; then return 1; fi
  titulo "Emparejado del panel con Skyway"
  RESUMEN_EMPAREJADO="sin cambios: Skyway ya está conectado con otro panel de Mailway"
  aviso "Skyway ya está conectado con otro panel de Mailway (${url:-otro servicio}): no se cambia."
  aviso "Para conectarlo con este panel: sudo bash deploy/instalar.sh --emparejar"
  return 0
}

# ------------------------------------------ cuenta de Cloudflare del operador --
#
# El token de Cloudflare que se da al instalar se guarda también en el panel,
# como cuenta de la INSTANCIA, y en Skyway: desde entonces, los dominios que
# da de alta el administrador (de correo en el panel o desde Skyway, y de
# servicios en Skyway) configuran su DNS solos, sin modificar los registros
# que ya existan. Nunca lo usa una acción de un cliente. El token va siempre
# por la entrada estándar de la herramienta de cada uno: como argumento se
# vería en «ps» y en el registro de Docker. No se escribe en deploy/.env, así
# que --actualizar y --emparejar no lo tienen y conservan lo ya conectado.

# Sin token en esta ejecución: lo que haya conectado se conserva.
cloudflare_sin_token() {
  [ -z "$CF_TOKEN" ] || return 1
  if [ "$ACTUALIZAR" = 1 ] || [ "$EMPAREJAR" = 1 ]; then
    RESUMEN_CF_PANEL="sin cambios: esta ejecución no tiene el token (no se guarda en deploy/.env); si el panel ya tenía una cuenta conectada, la conserva"
    info "Cloudflare: esta ejecución no tiene el token; si el panel ya tenía una cuenta conectada, la conserva."
    # --emparejar no pasa por el paso de Cloudflare (no verifica el token ni
    # toca el DNS): quien lo exporta espera que se use, y se le dice dónde.
    if [ "$EMPAREJAR" = 1 ] && [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
      info "--emparejar no usa CLOUDFLARE_API_TOKEN: para conectar o cambiar el token de Cloudflare, repite con --actualizar."
    fi
  fi
  return 0
}

# Guarda el token como cuenta de Cloudflare de la instancia en el panel (que
# debe estar sano). Nunca interrumpe la instalación: un fallo queda en el
# resumen y se explica cómo conectarla a mano.
#   conectar_cloudflare_en_panel <contenedor del panel>
conectar_cloudflare_en_panel() {
  local contenedor=$1 salida="" etiqueta="" zonas="" creada="" sustituida=""
  local re_etiqueta='"label":"([^"\\[:cntrl:]]{1,80})"' re_zonas='"zones":([0-9]{1,6})' re_creada='"creada":(true|false)'
  local re_sustituida='"sustituida":(true|false)'
  local a_mano="conéctala en el panel, en Conexiones → Cloudflare, con el ámbito «Toda la instancia»."
  if cloudflare_sin_token; then return 0; fi
  if ! docker exec "$contenedor" test -f server/dist/tools/cloudflare.js 2>/dev/null; then
    RESUMEN_CF_PANEL="pendiente: el panel desplegado no guarda la cuenta desde el servidor"
    aviso "El panel desplegado no puede guardar la cuenta de Cloudflare desde el servidor: $a_mano"
    return 0
  fi
  # Como el usuario del panel («node»): lo que toque en /data debe seguir siendo suyo.
  preparar_errores_herramienta
  if ! salida=$(printf '%s' "$CF_TOKEN" | docker exec -i -u node "$contenedor" node server/dist/tools/cloudflare.js conectar \
    --nombre "Instalador de Mailway" 2>"$ERR_TMP"); then
    mostrar_errores_herramienta
    RESUMEN_CF_PANEL="pendiente: el panel no ha podido guardar la cuenta"
    aviso "El panel no ha podido guardar la cuenta de Cloudflare: $a_mano"
    return 0
  fi
  mostrar_errores_herramienta
  if [[ $salida =~ $re_etiqueta ]]; then etiqueta=${BASH_REMATCH[1]}; fi
  if [[ $salida =~ $re_zonas ]]; then zonas=${BASH_REMATCH[1]}; fi
  if [[ $salida =~ $re_creada ]]; then creada=${BASH_REMATCH[1]}; fi
  if [[ $salida =~ $re_sustituida ]]; then sustituida=${BASH_REMATCH[1]}; fi
  salida=""
  if [ -z "$creada" ]; then
    RESUMEN_CF_PANEL="pendiente: respuesta inesperada de la herramienta del panel"
    aviso "Respuesta inesperada de la herramienta de Cloudflare del panel: comprueba en Conexiones → Cloudflare que la cuenta está conectada."
    return 0
  fi
  CF_PANEL_CONECTADA=1
  if [ "$creada" = true ]; then
    RESUMEN_CF_PANEL="cuenta de la instancia conectada («${etiqueta:-Cloudflare}», ${zonas:-?} zonas)"
  elif [ "$sustituida" = true ]; then
    RESUMEN_CF_PANEL="token de la cuenta de la instancia sustituido por el nuevo («${etiqueta:-Cloudflare}», ${zonas:-?} zonas)"
  else
    RESUMEN_CF_PANEL="cuenta de la instancia ya conectada («${etiqueta:-Cloudflare}», ${zonas:-?} zonas)"
  fi
  ok "Cloudflare en el panel: $RESUMEN_CF_PANEL. Los dominios que des de alta como administrador configuran su DNS solos."
}

# Instalación autónoma: el panel es mailway-panel y se espera a que esté sano.
conectar_cloudflare_autonoma() {
  titulo "Cuenta de Cloudflare del panel"
  if cloudflare_sin_token; then
    if [ -z "$RESUMEN_CF_PANEL" ]; then info "Sin token de Cloudflare: no hay cuenta que conectar."; fi
    return 0
  fi
  if ! esperar_sano mailway-panel 120; then
    RESUMEN_CF_PANEL="pendiente: el panel no está sano"
    aviso "El panel (mailway-panel) no está sano: conecta la cuenta de Cloudflare en Conexiones → Cloudflare cuando arranque."
    return 0
  fi
  conectar_cloudflare_en_panel mailway-panel
}

# Junto a Skyway: la cuenta del panel no depende del emparejado (que se omite
# si Skyway está conectado con otro panel, si Skyway no tiene su herramienta o
# si la del panel falla): con el panel desplegado y sano, recibe el token
# igual. Va aparte también para no mezclar sus avisos con los de la puesta en
# marcha, que el emparejado resume por su cuenta.
conectar_cloudflare_junto_a_skyway() {
  if cloudflare_sin_token; then return 0; fi
  titulo "Cuenta de Cloudflare del panel"
  if [ -z "$PANEL_CONTENEDOR" ]; then
    RESUMEN_CF_PANEL="pendiente: no se ha localizado el panel desplegado en Skyway"
    aviso "No se ha localizado el panel desplegado en Skyway: conecta la cuenta de Cloudflare en Conexiones → Cloudflare."
    return 0
  fi
  if ! esperar_sano "$PANEL_CONTENEDOR" 180; then
    RESUMEN_CF_PANEL="pendiente: el panel no está sano"
    aviso "El panel ($PANEL_CONTENEDOR) no está sano: conecta la cuenta de Cloudflare en Conexiones → Cloudflare cuando arranque."
    return 0
  fi
  conectar_cloudflare_en_panel "$PANEL_CONTENEDOR"
}

# Guarda el token en Skyway para los dominios de servicios del administrador.
# La herramienta llegó con una versión de Skyway posterior: si no está, se
# avisa y se sigue.
conectar_cloudflare_en_skyway() {
  if [ -z "$CF_TOKEN" ]; then
    if [ "$ACTUALIZAR" = 1 ]; then
      RESUMEN_CF_SKYWAY="sin cambios: esta ejecución no tiene el token; si Skyway ya tenía uno guardado, lo conserva"
    fi
    return 0
  fi
  titulo "Cloudflare en Skyway"
  if ! en_marcha skyway; then
    RESUMEN_CF_SKYWAY="sin cambios: Skyway no corre en este servidor como el contenedor «skyway»"
    info "Skyway no corre en este servidor como el contenedor «skyway»: no se le pasa el token de Cloudflare."
    return 0
  fi
  if ! docker exec skyway test -f server/dist/tools/cloudflare.js 2>/dev/null; then
    RESUMEN_CF_SKYWAY="pendiente: esta versión de Skyway no guarda el token desde el servidor"
    aviso "Esta versión de Skyway no guarda el token de Cloudflare desde el servidor: actualiza Skyway y repite la instalación para que el DNS de los dominios de tus servicios se configure solo."
    return 0
  fi
  preparar_errores_herramienta
  if ! printf '%s' "$CF_TOKEN" | docker exec -i skyway node server/dist/tools/cloudflare.js conectar >/dev/null 2>"$ERR_TMP"; then
    mostrar_errores_herramienta
    RESUMEN_CF_SKYWAY="pendiente: Skyway no ha podido guardar el token"
    aviso "Skyway no ha podido guardar el token de Cloudflare (motivo arriba). El resto de la instalación no se ve afectado."
    return 0
  fi
  mostrar_errores_herramienta
  RESUMEN_CF_SKYWAY="token guardado: los dominios de servicios que des de alta como administrador configuran su DNS solos"
  ok "Token de Cloudflare guardado en Skyway."
}

# Empareja el panel con Skyway: la herramienta del panel crea (si falta) el
# administrador, completa la puesta en marcha y emite el token de gestión
# «Skyway», que pasa por la entrada estándar a la herramienta de Skyway. Nunca
# interrumpe la instalación: si algo falla, avisa y explica cómo repetirlo.
emparejar_con_skyway() {
  titulo "Emparejado del panel con Skyway"
  local salida="" conexion="" token="" correo="" clave="" version marca
  local re_token='"token":"(mwt_[0-9a-f]{8}_[A-Za-z0-9_-]{43})"'
  local re_correo='"adminEmail":"([^"\\]{3,254})"' re_clave='"adminPassword":"([A-Za-z0-9_-]{10,200})"'
  local puesta
  if [ -z "$PANEL_CONTENEDOR" ] || ! id_simple "$PANEL_SERVICIO_ID" || ! id_simple "$PANEL_PROYECTO_ID"; then
    aviso_emparejado "No se conoce el servicio del panel en Skyway."
    return 0
  fi
  if ! en_marcha skyway; then
    aviso_emparejado "Skyway no corre en este servidor como el contenedor «skyway»: conecta Mailway en Skyway → Ajustes → Correo (Mailway) (sección 4.1 de docs/DESPLIEGUE-SKYWAY.md)."
    return 0
  fi
  if ! docker exec skyway test -f server/dist/tools/mailway.js 2>/dev/null; then
    aviso_emparejado "Esta versión de Skyway no conecta Mailway desde el servidor: actualiza Skyway o conéctalo en Ajustes → Correo (Mailway)."
    return 0
  fi
  info "Esperando a que el panel ($PANEL_CONTENEDOR) esté sano…"
  if ! esperar_sano "$PANEL_CONTENEDOR" 180; then
    aviso_emparejado "El panel ($PANEL_CONTENEDOR) no está en marcha y sano. Revisa: docker logs $PANEL_CONTENEDOR"
    return 0
  fi
  if ! docker exec "$PANEL_CONTENEDOR" test -f server/dist/tools/emparejar.js 2>/dev/null; then
    aviso_emparejado "El panel desplegado no incluye la herramienta de emparejado: despliega la versión actual de Mailway en Skyway."
    return 0
  fi

  # Como el usuario del panel («node»): lo que toque en /data debe seguir siendo suyo.
  preparar_errores_herramienta
  if ! salida=$(docker exec -i -u node "$PANEL_CONTENEDOR" node server/dist/tools/emparejar.js \
    --email "$ADMIN_EMAIL" </dev/null 2>"$ERR_TMP"); then
    mostrar_errores_herramienta
    aviso_emparejado "La herramienta de emparejado del panel ha fallado."
    return 0
  fi
  mostrar_errores_herramienta
  # Se extrae con bash: el JSON lleva secretos y no pasa por ningún otro programa.
  if [[ $salida =~ $re_token ]]; then token=${BASH_REMATCH[1]}; fi
  if [[ $salida =~ $re_correo ]]; then correo=${BASH_REMATCH[1]}; fi
  if [[ $salida =~ $re_clave ]]; then clave=${BASH_REMATCH[1]}; fi
  salida=""
  olvidar_coincidencias
  # El correo no se vuelve a validar como dirección: es el de una cuenta que
  # el panel ya admitió (puede llevar, por ejemplo, un apóstrofo) y, a estas
  # alturas, el token «Skyway» anterior ya está revocado. La expresión ya
  # excluye comillas y barras; basta con que se pueda mostrar.
  if [ -z "$token" ] || [ -z "$correo" ] || tiene_control "$correo"; then
    token=""
    aviso_emparejado "Respuesta inesperada de la herramienta de emparejado del panel."
    return 0
  fi
  # Desde aquí la cuenta existe: su contraseña (si es nueva) se muestra en el
  # resumen aunque lo siguiente falle, porque no hay otra forma de saberla.
  EMPAREJADO_ADMIN_EMAIL=$correo
  EMPAREJADO_ADMIN_PASSWORD=$clave
  clave=""
  if [ -n "$EMPAREJADO_ADMIN_PASSWORD" ]; then
    ok "Cuenta de administración del panel creada ($correo); la contraseña aparece en el resumen."
  else
    ok "El panel ya tenía cuenta de administración ($correo)."
  fi
  # Los avisos de la herramienta (arriba) dicen qué ha quedado pendiente: el
  # asistente del panel lo retoma al entrar y --emparejar lo vuelve a intentar.
  if [ "$HERRAMIENTA_CON_AVISOS" = 1 ]; then
    puesta="puesta en marcha del panel con avisos"
    aviso "Puesta en marcha del panel completada con avisos (arriba) y token de gestión «Skyway» emitido. Lo pendiente se retoma al entrar en el panel o repitiendo: sudo bash deploy/instalar.sh --emparejar"
  else
    puesta=""
    ok "Puesta en marcha del panel completada con el entorno y token de gestión «Skyway» emitido."
  fi

  preparar_errores_herramienta
  if ! conexion=$(printf '%s' "$token" | docker exec -i skyway node server/dist/tools/mailway.js conectar \
    --servicio "$PANEL_SERVICIO_ID" --proyecto "$PANEL_PROYECTO_ID" --url "https://$PANEL_HOSTNAME" 2>"$ERR_TMP"); then
    token=""
    mostrar_errores_herramienta
    aviso_emparejado "Skyway no ha podido guardar la conexión con el panel."
    return 0
  fi
  token=""
  mostrar_errores_herramienta
  version=$(printf '%s' "$conexion" | jqr -r '.version // empty' 2>/dev/null | tr -d '[:cntrl:]' || true)
  marca=$(printf '%s' "$conexion" | jqr -r '.brandName // empty' 2>/dev/null | tr -d '[:cntrl:]' || true)
  EMPAREJADO_OK=1
  RESUMEN_EMPAREJADO="Skyway conectado con el panel (Mailway ${version:-?}${marca:+, «$marca»})"
  ok "$RESUMEN_EMPAREJADO."
  if [ -n "$puesta" ]; then RESUMEN_EMPAREJADO+="; $puesta"; fi
}

# Paso final de la instalación junto a Skyway: solo si el panel se ha
# desplegado y Skyway no está conectado con otro panel de Mailway.
emparejar_al_terminar() {
  if [ -z "$PANEL_CONTENEDOR" ]; then return 0; fi
  if skyway_con_otro_panel; then return 0; fi
  emparejar_con_skyway
}

# --emparejar: repite solo el emparejado con la configuración de deploy/.env.
# El contenedor del panel sale de MAILWAY_PANEL_INTERNAL_URL y su servicio y
# proyecto, de las etiquetas que Skyway pone a sus contenedores.
emparejar_solo() {
  [ -f "$ENV_FILE" ] || fallo "No existe $ENV_FILE: Mailway no está instalado aquí (sudo bash deploy/instalar.sh)."
  tiene docker || fallo "Falta Docker."
  docker info >/dev/null 2>&1 || fallo "No se puede hablar con Docker. Ejecuta como root (sudo) o con un usuario del grupo docker."
  if [ "$(leer_env MAILWAY_INSTALACION)" = autonoma ]; then
    fallo "Esta instalación es autónoma (sin Skyway): no hay nada que emparejar."
  fi
  PANEL_HOSTNAME=$(leer_env PANEL_HOSTNAME)
  host_valido "$PANEL_HOSTNAME" || fallo "PANEL_HOSTNAME no es válido en $ENV_FILE."
  local le interna re_panel='^http://(skyway-[a-z0-9][a-z0-9_.-]*):[0-9]{1,5}$'
  le=$(leer_env LETSENCRYPT_EMAIL)
  elegir_correo_admin "$le"
  interna=$(leer_env MAILWAY_PANEL_INTERNAL_URL)
  PANEL_CONTENEDOR=skyway-mailway-panel
  if [[ $interna =~ $re_panel ]]; then PANEL_CONTENEDOR=${BASH_REMATCH[1]}; fi
  docker inspect --type container "$PANEL_CONTENEDOR" >/dev/null 2>&1 ||
    fallo "No existe el contenedor del panel ($PANEL_CONTENEDOR). Despliégalo con el instalador completo: sudo bash deploy/instalar.sh"
  PANEL_SERVICIO_ID=$(docker inspect --type container -f '{{index .Config.Labels "skyway.service"}}' "$PANEL_CONTENEDOR" 2>/dev/null || true)
  PANEL_PROYECTO_ID=$(docker inspect --type container -f '{{index .Config.Labels "skyway.project"}}' "$PANEL_CONTENEDOR" 2>/dev/null || true)
  if ! id_simple "$PANEL_SERVICIO_ID" || ! id_simple "$PANEL_PROYECTO_ID"; then
    fallo "El contenedor $PANEL_CONTENEDOR no lo gestiona Skyway (le faltan sus etiquetas skyway.service y skyway.project)."
  fi
  info "Panel: $PANEL_CONTENEDOR (https://$PANEL_HOSTNAME)"
  emparejar_con_skyway
  conectar_cloudflare_junto_a_skyway
  titulo "Resumen"
  printf '\n'
  info "Emparejado con Skyway: $RESUMEN_EMPAREJADO"
  if [ -n "$RESUMEN_CF_PANEL" ]; then info "Cloudflare (panel): $RESUMEN_CF_PANEL"; fi
  resumen_administrador
  [ "$EMPAREJADO_OK" = 1 ]
}

# Comillas simples de YAML y «$» doblado (Compose interpola los dólares).
yaml_literal() {
  local s=$1
  s=${s//\'/\'\'}
  s=${s//\$/\$\$}
  printf "'%s'" "$s"
}

# Primera línea de los ficheros de la carpeta de Skyway que genera este
# instalador: así se reconocen al actualizar.
MARCA_OVERRIDE="# Generado por el instalador de Mailway"

confirmar_traefik() { [ "${MAILWAY_TRAEFIK_PROVEEDOR:-}" = 1 ] || confirmar "$1" s; }

# ¿Es de Mailway el override de Traefik de la carpeta de Skyway? El que genera
# este instalador lleva MARCA_OVERRIDE en la primera línea. El que se copiaba
# a mano de Ajustes → Marca blanca con la guía 0.x («# docker-compose.override.yml
# — en la carpeta de Skyway.») no la lleva, pero sí el proveedor HTTP del
# panel (/api/traefik/config) o su cabecera X-Mailway-Token.
override_de_mailway() {
  [[ $(head -n 1 "$1") == "$MARCA_OVERRIDE"* ]] || grep -Eq '/api/traefik/config|X-Mailway-Token' "$1"
}

# Parámetros con los que corre ahora el Traefik de Skyway (JSON).
argumentos_traefik() { docker inspect -f '{{json .Config.Cmd}}' skyway-traefik 2>/dev/null || printf '[]'; }

recrear_traefik() {
  local salida
  # Sin la LETSENCRYPT_EMAIL del instalador: Traefik debe tomar la del .env
  # de Skyway.
  if ! salida=$(cd "$SKYWAY_DIR" && env -u LETSENCRYPT_EMAIL docker compose up -d traefik 2>&1); then
    printf '%s\n' "$salida" >&2
    aviso "Traefik no se pudo recrear. Ejecuta «docker compose up -d traefik» en $SKYWAY_DIR."
    return 1
  fi
}

# Proveedor HTTP de Traefik: sirve las rutas de los dominios de los clientes
# (webmail de marca blanca y autoconfiguración de dispositivos).
configurar_proveedor_traefik() {
  titulo "Dominios de los clientes en Traefik"
  if [ "${MAILWAY_TRAEFIK_PROVEEDOR:-}" = 0 ]; then
    info "Omitido (MAILWAY_TRAEFIK_PROVEEDOR=0)."
    return 0
  fi
  local argumentos override="" compose_skyway=""
  argumentos=$(argumentos_traefik)
  if [ -n "$SKYWAY_DIR" ] && [ -f "$SKYWAY_DIR/docker-compose.yml" ]; then
    compose_skyway="$SKYWAY_DIR/docker-compose.yml"
    override="$SKYWAY_DIR/docker-compose.override.yml"
  fi
  if [ -z "$SKYWAY_VERSION" ]; then
    SKYWAY_VERSION=$(curl -fsS --max-time 5 "${SKYWAY_URL:-http://127.0.0.1:4000}/api/health" 2>/dev/null |
      jqr -r '.version // empty' 2>/dev/null || true)
  fi

  # Skyway 0.34 o posterior trae en su propio compose el proveedor HTTP que
  # lee las rutas de Mailway a través de Skyway (que las filtra). Instalar
  # además el fichero de Mailway sustituiría el «command» de Traefik por uno
  # con los flags antiguos: no se instala nada.
  if { [ -n "$compose_skyway" ] && grep -q 'api/traefik/mailway' "$compose_skyway"; } ||
    printf '%s' "$argumentos" | grep -q 'api/traefik/mailway' || version_ge "$SKYWAY_VERSION" 0.34.0; then
    traefik_con_puente "$argumentos" "$compose_skyway" "$override"
    return 0
  fi

  if printf '%s' "$argumentos" | grep -q 'providers.http.endpoint'; then
    ok "El Traefik de Skyway ya consulta un proveedor HTTP."
    return 0
  fi
  if [ -z "$compose_skyway" ]; then
    aviso "No se encontró la carpeta de Skyway: configura el proveedor con deploy/skyway-traefik-override.yml."
    return 0
  fi
  if [ -f "$override" ]; then
    aviso "Ya existe $override y no se modifica. Añade a mano las líneas de deploy/skyway-traefik-override.yml."
    return 0
  fi
  # El panel de una instalación anterior guarda su propio token de Traefik en
  # su base de datos: con el de deploy/.env, Traefik recibiría un 401 en cada
  # consulta. El bloque con el token bueno lo muestra el propio panel.
  if [ "${TRAEFIK_TOKEN_PROPIO:-1}" = 0 ]; then
    aviso "El panel usa su propio token de Traefik, que el instalador no conoce: no se genera $override."
    aviso "Copia el bloque de Ajustes → Rutas de Traefik del panel (antes, Ajustes → Marca blanca) en $override y ejecuta «docker compose up -d traefik» en $SKYWAY_DIR."
    return 0
  fi
  confirmar_traefik "¿Configurar el Traefik de Skyway para los dominios de los clientes? Traefik se reinicia unos segundos." ||
    { info "Omitido."; return 0; }

  # Skyway anterior a la 0.34: Traefik consulta directamente al panel, con
  # el token de Traefik del panel.
  local endpoint cabecera umask_previa
  endpoint="http://${PANEL_CONTENEDOR:-skyway-mailway-panel}:4100/api/traefik/config"
  cabecera="--providers.http.headers.X-Mailway-Token=$MAILWAY_TRAEFIK_TOKEN"
  umask_previa=$(umask)
  umask 077
  {
    printf '%s el %s.\n' "$MARCA_OVERRIDE" "$(date -u '+%Y-%m-%d')"
    printf '# Compose REEMPLAZA «command»: se repiten los flags actuales de Traefik y se\n'
    printf '# añade el proveedor HTTP de Mailway. Solo para Skyway anterior a la 0.34: al\n'
    printf '# actualizar Skyway, ejecuta deploy/instalar.sh --actualizar y este fichero se\n'
    printf '# retirará (Skyway 0.34 ya lee por sí mismo las rutas de Mailway).\n'
    printf 'services:\n  traefik:\n    command:\n'
    printf '%s' "$argumentos" | jqr -r '.[]' | while IFS= read -r arg; do
      printf '      - %s\n' "$(yaml_literal "$arg")"
    done
    printf '      - %s\n' "$(yaml_literal "--providers.http.endpoint=$endpoint")"
    printf '      - %s\n' "'--providers.http.pollInterval=15s'"
    printf '      - %s\n' "'--providers.http.pollTimeout=10s'"
    printf '      - %s\n' "$(yaml_literal "$cabecera")"
  } >"$override"
  chmod 600 "$override"
  umask "$umask_previa"
  if ! recrear_traefik; then
    fallo "Traefik no arrancó con $override. Bórralo y ejecuta «docker compose up -d traefik» en $SKYWAY_DIR."
  fi
  ok "Traefik consulta $endpoint."
}

# Skyway con el puente de Mailway: solo hay que retirar el override de
# Mailway que dejó una instalación anterior (el del instalador o el copiado a
# mano con la guía 0.x) y asegurarse de que Traefik corre con la
# configuración de Skyway. El «ok» final sale de los parámetros con los que
# corre Traefik, no de que se haya recreado.
traefik_con_puente() {
  local argumentos=$1 compose_skyway=$2 override=$3 queda_override=0
  if [ -n "$override" ] && [ -f "$override" ]; then
    if override_de_mailway "$override"; then
      if confirmar_traefik "Skyway ya lee las rutas de Mailway y $override (de una instalación anterior de Mailway) sobra. ¿Retirarlo y recrear Traefik?"; then
        mv "$override" "$override.mailway-retirado"
        ok "Retirado $override (se conserva como $override.mailway-retirado)."
        if [[ $(head -n 1 "$override.mailway-retirado") != "$MARCA_OVERRIDE"* ]]; then
          info "Si añadiste en él otros ajustes propios, recupéralos de esa copia."
        fi
        recrear_traefik || return 0
        argumentos=$(argumentos_traefik)
      else
        queda_override=1
        aviso "Se mantiene $override: fija los flags antiguos de Traefik y deja sin efecto el puente de Skyway. Bórralo cuando puedas."
      fi
    elif grep -q 'command' "$override"; then
      aviso "$override redefine opciones de Traefik: comprueba que no sustituye el «command» de Skyway ni añade otro proveedor HTTP."
    fi
  fi
  # Recrear Traefik con el override de Mailway aún en su sitio no cambiaría nada.
  if [ "$queda_override" = 0 ] && ! printf '%s' "$argumentos" | grep -q 'api/traefik/mailway' &&
    [ -n "$compose_skyway" ] && grep -q 'api/traefik/mailway' "$compose_skyway" &&
    confirmar_traefik "El Traefik de Skyway aún no usa la configuración actual de Skyway. ¿Recrearlo ahora?"; then
    recrear_traefik || return 0
    argumentos=$(argumentos_traefik)
  fi
  if ! printf '%s' "$argumentos" | grep -q 'api/traefik/mailway'; then
    aviso "El Traefik de Skyway no lee las rutas de Mailway: sus parámetros no incluyen el proveedor de Skyway (api/traefik/mailway)."
    if [ -n "$override" ] && [ -f "$override" ] && grep -q 'command' "$override"; then
      aviso "Los sustituye el «command» de $override: retíralo y ejecuta «docker compose up -d traefik» en $SKYWAY_DIR."
    else
      aviso "Ejecuta «docker compose up -d traefik» en la carpeta de Skyway y comprueba que Skyway es la 0.34 o posterior."
    fi
    return 0
  fi
  ok "Skyway sirve a Traefik las rutas de Mailway: no hace falta ningún fichero adicional."
  info "Las lee a través de la conexión con el panel que deja el emparejado (siguiente paso)."
}

# ---------------------------------------------------------------- resumen --

# Cuenta de administración del panel que ha dejado el emparejado. La
# contraseña (solo si se acaba de crear) se muestra aquí una vez y se olvida:
# no está en deploy/.env ni en ningún registro.
resumen_administrador() {
  [ -n "$EMPAREJADO_ADMIN_EMAIL" ] || return 0
  info "Administración del panel: $EMPAREJADO_ADMIN_EMAIL"
  if [ -n "$EMPAREJADO_ADMIN_PASSWORD" ]; then
    info "Contraseña:          $EMPAREJADO_ADMIN_PASSWORD"
    info "  Se muestra solo esta vez y no se guarda en ningún sitio: guárdala en un lugar seguro"
    info "  o cámbiala al entrar en el panel (Mi cuenta → Cambiar contraseña)."
    EMPAREJADO_ADMIN_PASSWORD=""
  fi
}

resumen() {
  titulo "Resumen"
  local copia volumen paso=0
  if [ "$MOTOR" = "$MOTOR_016" ]; then
    # La configuración (config.json) y los datos van en dos volúmenes: los dos
    # en la misma copia, con el motor parado.
    copia="docker stop mailway-mail && docker run --rm -v $(volumen_016_etc):/origen/etc:ro -v $(volumen_016_datos):/origen/datos:ro -v /root/copias:/destino alpine tar czf /destino/mailway-correo-\$(date +%F).tar.gz -C /origen . ; docker start mailway-mail"
  else
    volumen=$(volumen_015)
    copia="docker stop mailway-mail && docker run --rm -v $volumen:/origen:ro -v /root/copias:/destino alpine tar czf /destino/mailway-correo-\$(date +%F).tar.gz -C /origen . ; docker start mailway-mail"
  fi
  printf '\n'
  # Con la cuenta de administración ya creada, el enlace de puesta en marcha
  # (y su token) no sirven de nada: no se muestran.
  if [ -n "$EMPAREJADO_ADMIN_EMAIL" ]; then
    info "Panel:               https://$PANEL_HOSTNAME"
  else
    info "Panel:               https://$PANEL_HOSTNAME/setup?token=$MAILWAY_SETUP_TOKEN"
  fi
  info "Webmail:             https://$WEBMAIL_HOSTNAME"
  if [ "$MOTOR" = "$MOTOR_016" ]; then
    # En el nombre público, Traefik solo deja pasar lo que usan los programas
    # de correo: la administración y el autoservicio del motor no se publican.
    info "Motor de correo:     Stalwart 0.16; se administra desde el panel (su web no se publica en $MAIL_HOSTNAME)"
  else
    info "Web del motor:       https://$MAIL_HOSTNAME (usuario admin; contraseña en deploy/.env)"
  fi
  if [ -z "$EMPAREJADO_ADMIN_EMAIL" ]; then info "Token de puesta en marcha: $MAILWAY_SETUP_TOKEN"; fi
  if [ "$CON_SKYWAY" = 1 ]; then
    info "Panel en Skyway:     $RESUMEN_SKYWAY"
    info "Emparejado con Skyway: $RESUMEN_EMPAREJADO"
  fi
  if [ "$CON_SKYWAY" = 0 ] && [ "$USAR_PROXY_PROPIO" = 0 ]; then
    info "Sin proxy propio:    panel en 127.0.0.1:4100 y webmail en 127.0.0.1:8000; ponles delante un proxy con TLS."
  fi
  info "DNS de la plataforma: $RESUMEN_DNS"
  if [ -n "$RESUMEN_CF_PANEL" ]; then info "Cloudflare (panel):  $RESUMEN_CF_PANEL"; fi
  if [ "$CON_SKYWAY" = 1 ] && [ -n "$RESUMEN_CF_SKYWAY" ]; then info "Cloudflare (Skyway): $RESUMEN_CF_SKYWAY"; fi
  info "DNS inverso (PTR):   $RESUMEN_PTR"
  info "Puerto 25 de salida: $RESUMEN_P25"
  info "Certificado IMAP/SMTP: $RESUMEN_CERT"
  if [ "$MOTOR" = "$MOTOR_016" ] && [ -n "$RESUMEN_AJUSTES" ]; then info "Ajustes de Mailway en el motor: $RESUMEN_AJUSTES"; fi
  printf '\n'
  if [ "$MOTOR" = "$MOTOR_015" ]; then
    info "Motor de correo: Stalwart 0.15, que deja de recibir parches de seguridad el $FIN_SOPORTE_015_TEXTO."
    info "  Para pasar a la 0.16 (unos minutos sin correo; vuelve atrás sola si algo falla): sudo mailway migrar-motor"
    printf '\n'
  fi
  if [ "$CERT_CONFIGURADO" = 0 ]; then
    info "Mientras el motor no tenga un certificado válido para $MAIL_HOSTNAME, la API de envío del panel"
    info "(que lo verifica) y los programas de correo mostrarán errores de certificado."
    printf '\n'
  fi
  info "Copia de seguridad del correo (detiene el motor unos segundos: copiar su base de datos en marcha"
  info "puede dejarla incoherente):"
  info "  $copia"
  printf '\n'
  info "Actualizar Mailway (git pull y reaplicar):        mailway update -y"
  info "Parches probados cada noche, con vuelta atrás:     sudo mailway auto-update on"
  info "Diagnóstico en cualquier momento (no cambia nada): mailway comprobar"
  info "Prueba de acceso a un buzón desde el webmail:      mailway probar-acceso"
  printf '\n'
  if [ -n "$EMPAREJADO_ADMIN_EMAIL" ]; then
    resumen_administrador
    printf '\n'
  fi
  info "Siguientes pasos:"
  if [ -n "$EMPAREJADO_ADMIN_EMAIL" ]; then
    info "  $((paso += 1)). Entra en el panel con la cuenta de administración de arriba."
  else
    info "  $((paso += 1)). Abre el panel con el enlace de arriba y completa la puesta en marcha."
  fi
  # Con la cuenta conectada en esta ejecución, no se manda conectarla a mano.
  # Sin el token (--actualizar), esta ejecución no sabe si la hay: se pide
  # comprobarlo, sin darla por hecha.
  if [ "$CF_PANEL_CONECTADA" = 0 ]; then
    case "$RESUMEN_CF_PANEL" in
      pendiente*) info "  $((paso += 1)). En Conexiones → Cloudflare, conecta la cuenta de la instancia (ámbito «Toda la instancia»)." ;;
      "sin cambios"*) info "  $((paso += 1)). En Conexiones → Cloudflare, comprueba que hay una cuenta conectada para publicar el DNS de los dominios de los clientes (si no, conéctala)." ;;
      *) info "  $((paso += 1)). En Conexiones → Cloudflare, conecta una cuenta para publicar el DNS de los dominios de los clientes." ;;
    esac
  fi
  info "  $((paso += 1)). En Ajustes → Servidor de correo, comprueba el certificado y el nombre del servidor."
  if [ "$CON_SKYWAY" = 1 ] && [ "$EMPAREJADO_OK" = 0 ] && [ -n "$PANEL_CONTENEDOR" ]; then
    info "  $((paso += 1)). Empareja Skyway con el panel: sudo bash deploy/instalar.sh --emparejar"
    info "     (o a mano, en Skyway → Ajustes → Correo (Mailway): sección 4.1 de docs/DESPLIEGUE-SKYWAY.md)."
  fi
}

# ---------------------------------------- cambio de motor (0.15 → 0.16) --
#
# --migrar-motor pasa un servidor de Stalwart 0.15 a la 0.16 con el
# procedimiento oficial de Stalwart (UPGRADING/v0_16.md) adaptado a Mailway:
# una ventana corta sin correo y sin tocar nunca el volumen de la 0.15, que es
# a la vez la copia de seguridad y la vuelta atrás.
#   1. Comprobaciones, sin cambiar nada: el panel y su herramienta del motor,
#      la 0.15 sana y su contraseña (una sola petición), la cola de salida, el
#      espacio en disco, las imágenes, el script oficial (con su sha256) y el
#      compose con la 0.16.
#   2. Panel en mantenimiento (no cambia nada del motor mientras dura) y copia
#      en el panel del hash de la contraseña de cada buzón: la 0.16 ya no los
#      devuelve y el panel las comprueba en local.
#   3. Volcado y conversión con el script oficial, con la 0.15 aún en marcha.
#   4. Ventana sin correo: se paran el webmail, el extractor y la 0.15, y sus
#      datos se copian a dos volúmenes nuevos, con fecha, para la 0.16.
#   5. La 0.16 en modo recuperación (solo el 8080, sin puertos públicos):
#      «stalwart-cli apply» del plan, exigiendo 0 fallos, y su registro de
#      eventos en la salida estándar.
#   6. Primer arranque normal, aún sin puertos públicos: el panel aplica los
#      ajustes de Mailway (también las suspensiones) y, si hace falta, se
#      reinicia y se repite; el extractor pone el certificado y se comprueba
#      todo: dominios, buzones, alias, DKIM, escuchas y el certificado
#      servido en 993, 465 y 587.
#   7. El motor definitivo con los puertos públicos (MAILWAY_MOTOR=stalwart-0.16
#      en deploy/.env), el webmail y el extractor, y la comprobación de
#      --comprobar.
#   8. Tareas del panel tras migrar y fin del mantenimiento.
# Cualquier fallo antes de que pase la comprobación del paso 7 vuelve solo a la
# 0.15 (volver_a_015): su volumen está como estaba. Lo de la 0.16 se queda en
# sus volúmenes con fecha, para revisarlo, y una migración nueva nunca los
# reutiliza: crea otros.
#
# En modo recuperación no se aplica ningún ajuste: si allí se crea una escucha,
# el registro de eventos o los ajustes de autenticación, el primer arranque
# normal ya no crea los suyos por defecto (se queda sin escuchar en 8080, 25,
# 465 ni 993, o sin los roles de los usuarios). Por eso los ajustes de Mailway
# llegan con el motor ya arrancado, en el paso 6, salvo el registro de
# eventos, que se crea a propósito para que no se cree el de /var/log.

# Script oficial de conversión de Stalwart, fijado al commit de la v0.16.25 y
# comprobado con su sha256. Su licencia (AGPL-3.0 o SEL) no deja incluirlo en
# el repositorio: se descarga al migrar. Sus dependencias (requests y las
# suyas) van igual: ruedas de Python puro, fijadas y con su sha256, que el
# ayudante importa directamente del .whl (sin pip ni red dentro del
# contenedor). Formato: «URL sha256».
MIGRAR016_SCRIPT="https://raw.githubusercontent.com/stalwartlabs/stalwart/3f657330c0f49a015a3a372fb59669b5cccbca6d/resources/scripts/migrate_v016.py ebc7c2cc8b3d9378476523ee5fd76c39b1bc0e788a890ff17b507b03c0757458"
MIGRAR016_DEPENDENCIAS=(
  "https://files.pythonhosted.org/packages/a0/f4/c67b0b3f1b9245e8d266f0f112c500d50e5b4e83cb6f3b71b6528104182a/requests-2.34.2-py3-none-any.whl 2a0d60c172f83ac6ab31e4554906c0f3b3588d37b5cb939b1c061f4907e278e0"
  "https://files.pythonhosted.org/packages/92/9d/c4e665119135114480843e7ab388fa94d8480650450e6f8e26b70d323a4c/urllib3-2.8.0-py3-none-any.whl 0cf3cae568d36aa9576b28dfb35f11328f1cb974ca7647d9475ebb86c75ac6e3"
  "https://files.pythonhosted.org/packages/0b/a7/71ac2cff56fec219ed242bb11b8efb69fcc4bec75db06fb7bfe35de520e6/certifi-2026.7.22-py3-none-any.whl 62f22742b58a1a33014a2b6b706588a8d7e2a88ae7bd1a6ebe8c992928483775"
  "https://files.pythonhosted.org/packages/58/a2/bb081bab032533a855d44de1d56f8e8426114ff1ba5d1f07a438a0a654f8/idna-3.20-py3-none-any.whl ab7ae7122974553370f0bdb919e1a960b2cd1bc1ef0276416d896db81c14582c"
  "https://files.pythonhosted.org/packages/cc/61/d01fc49b8dea277640b55a9e15960dbca9fdc8c9fde18e572d39c59f4019/charset_normalizer-3.5.1-py3-none-any.whl 6df0ec430f9a831772c23ca5a224cba36517a58a84bb32c32bb59a9fa67c47f6"
)

# Contenedores temporales de la migración: comparten con el motor la IP fija
# y el alias mailway-mail en la red interna (y el alias en la de Traefik),
# para que el panel, el extractor y las herramientas lo encuentren donde
# siempre, pero no publican ningún puerto en el host.
CONTENEDOR_RECUPERACION="mailway-mail-016-recuperacion"
CONTENEDOR_PREVIO="mailway-mail-016-previo"

# Estado de la migración en curso, para la vuelta atrás (ver al_salir):
#   ""         sin migración, o terminada;
#   preparada  aún no se ha parado nada (basta con quitar el mantenimiento);
#   parado     la 0.15 está parada: hay que volver a ella;
#   abierto    la 0.16 ya tiene los puertos públicos: también hay que volver.
MIG_FASE=""
MIG_SELLO=""
MIG_DIR=""
MIG_REGISTRO=""
MIG_ETC=""
MIG_DATOS=""
MIG_ENV_ANTES=""
MIG_ENV_CONSERVAR=0
MIG_EXTRACTOR=0
MIG_MANTENIMIENTO=0
MIG_CERT_015=0
# Con 1, la comprobación final de la migración no cuenta como incidencia el
# certificado de IMAP y SMTP: la 0.15 tampoco servía uno válido, y migrar no
# lo empeora (lo dice igualmente).
TOLERAR_CERTIFICADO=0
MIG_HORA_PARADA=""
MIG_HORA_APERTURA=""
PANEL_MOTOR=""
RED_BORDE=""
IMAGEN_016=""
IMAGEN_CLI=""
IMAGEN_PYTHON=""

# Lo que necesitan las órdenes del motor, leído de deploy/.env sin preguntar.
cargar_instalacion_motor() {
  [ -f "$ENV_FILE" ] || fallo "No existe $ENV_FILE: Mailway no está instalado aquí (sudo bash deploy/instalar.sh)."
  tiene docker || fallo "Falta Docker."
  docker info >/dev/null 2>&1 || fallo "No se puede hablar con Docker. Ejecuta como root (sudo) o con un usuario del grupo docker."
  docker compose version >/dev/null 2>&1 || fallo "Falta Docker Compose v2 («docker compose»)."
  case "$(leer_env MAILWAY_INSTALACION)" in
    autonoma) CON_SKYWAY=0 ;;
    '') if docker inspect --type container mailway-panel >/dev/null 2>&1; then CON_SKYWAY=0; fi ;;
  esac
  MAIL_HOSTNAME=$(leer_env MAIL_HOSTNAME)
  host_valido "$MAIL_HOSTNAME" || fallo "MAIL_HOSTNAME no es válido en $ENV_FILE."
  STALWART_ADMIN_PASSWORD=$(leer_env STALWART_ADMIN_PASSWORD)
  [ -n "$STALWART_ADMIN_PASSWORD" ] || fallo "$ENV_FILE no guarda STALWART_ADMIN_PASSWORD, la contraseña del motor."
  INTERNAL_SUBNET=$(leer_env MAILWAY_INTERNAL_SUBNET)
  INTERNAL_SUBNET=${INTERNAL_SUBNET:-10.203.53.0/24}
  MAIL_INTERNAL_IP=$(leer_env MAILWAY_MAIL_INTERNAL_IP)
  MAIL_INTERNAL_IP=${MAIL_INTERNAL_IP:-10.203.53.10}
  TRAEFIK_ACME_VOLUME=$(leer_env TRAEFIK_ACME_VOLUME)
  MAILWAY_MAIL_VOLUME=$(leer_env MAILWAY_MAIL_VOLUME)
  MAILWAY_STALWART_ETC_VOLUME=$(leer_env MAILWAY_STALWART_ETC_VOLUME)
  MAILWAY_STALWART_DATA_VOLUME=$(leer_env MAILWAY_STALWART_DATA_VOLUME)
  MAILWAY_MOTOR_MIGRADO=$(leer_env MAILWAY_MOTOR_MIGRADO)
  MOTOR=$(motor_configurado)
  PANEL_MOTOR=$(contenedor_panel_conocido)
  if [ "$CON_SKYWAY" = 1 ]; then
    RED_BORDE=skyway-edge
    USAR_PROXY_PROPIO=0
  else
    RED_BORDE=mailway-edge
    USAR_PROXY_PROPIO=0
    if docker inspect --type container mailway-proxy >/dev/null 2>&1; then USAR_PROXY_PROPIO=1; fi
  fi
  IMAGEN_016=$(imagen_compose "$COMPOSE_MOTOR_016" 'stalwartlabs/stalwart:')
  IMAGEN_CLI=$(imagen_compose "$COMPOSE_MOTOR_016" 'stalwartlabs/cli:')
  IMAGEN_PYTHON=$(imagen_compose "$COMPOSE_MAIL" 'python:')
  if [ -z "$IMAGEN_016" ] || [ -z "$IMAGEN_CLI" ] || [ -z "$IMAGEN_PYTHON" ]; then
    fallo "No se encuentran las imágenes del motor 0.16, de su CLI o de Python en los compose de deploy/."
  fi
}

# La misma cerradura que «mailway update»: ni la actualización automática ni
# otra orden del motor pueden cruzarse con esta. Sin flock, se sigue sin ella.
tomar_cerrojo_motor() {
  tiene flock || return 0
  { exec 9>>"$DEPLOY_DIR/.actualizacion.lock"; } 2>/dev/null || return 0
  flock -n 9 || fallo "Hay una actualización de Mailway u otra orden del motor en curso: espera a que termine y vuelve a intentarlo."
}

# Carpeta de trabajo (permisos 700) y registro de la orden: todo lo que se
# muestra va también al fichero. Nada de lo que se muestra lleva secretos; el
# volcado y el plan sí, y se quedan en la carpeta con permisos 600 solo
# mientras hacen falta (ver limpiar_trabajo_migracion).
#   preparar_registro_motor <nombre de la orden>
preparar_registro_motor() {
  local base=${MAILWAY_MIGRACION_DIR:-$DEPLOY_DIR/.migracion-motor} umask_previa
  umask_previa=$(umask)
  umask 077
  mkdir -p "$base" || fallo "No se puede crear la carpeta de trabajo $base."
  chmod 700 "$base"
  MIG_SELLO=$(date -u +%Y%m%d-%H%M%S)
  MIG_DIR="$base/$1-$MIG_SELLO"
  mkdir "$MIG_DIR" || fallo "No se puede crear la carpeta de trabajo $MIG_DIR."
  umask "$umask_previa"
  MIG_REGISTRO="$MIG_DIR/registro.log"
  # Si la terminal desaparece (una sesión SSH que se corta), tee sigue
  # escribiendo el registro en lugar de terminar y llevarse la orden con él.
  if tee --output-error=warn </dev/null >/dev/null 2>&1; then
    exec > >(tee -a --output-error=warn "$MIG_REGISTRO") 2>&1
  else
    exec > >(tee -a "$MIG_REGISTRO") 2>&1
  fi
  # Sin colores: el registro se lee después con cualquier editor.
  C_TIT=""
  C_OK=""
  C_AV=""
  C_ER=""
  C_0=""
  info "Registro: $MIG_REGISTRO"
}

# Borra de la carpeta de trabajo lo que lleva secretos (volcado, plan, copia de
# deploy/.env y dependencias): se queda el registro, el resumen y lo que el
# script no pudo migrar. MAILWAY_MIGRACION_CONSERVAR=1 lo deja todo.
limpiar_trabajo_migracion() {
  [ -n "$MIG_DIR" ] && [ -d "$MIG_DIR" ] || return 0
  if [ "${MAILWAY_MIGRACION_CONSERVAR:-0}" = 1 ]; then
    aviso "Se conservan en $MIG_DIR el volcado y el plan, con contraseñas cifradas y claves DKIM: bórralos cuando ya no hagan falta."
    return 0
  fi
  rm -rf "$MIG_DIR/dependencias"
  rm -f "$MIG_DIR/settings.json" "$MIG_DIR/principals.json" "$MIG_DIR/export.json" "$MIG_DIR/migrate_v016.py"
  # La copia de deploy/.env se queda si la vuelta atrás no pudo restaurarla.
  if [ "$MIG_ENV_CONSERVAR" = 0 ]; then rm -f "$MIG_DIR/env-antes"; fi
}

# Ayudante de la migración (deploy/motor/migracion.py) en un contenedor
# efímero con la imagen de Python de los compose: en la red interna, sin
# capacidades y con todo en solo lectura salvo la carpeta de trabajo. La
# contraseña del motor va por su entrada estándar. Su línea JSON queda en
# HM_SALIDA (se lee con hm_campo) y su texto (también el del script oficial)
# se muestra como información. Corre con el mismo usuario que la orden: la
# carpeta de trabajo es suya (700, ficheros 600) y, sin capacidades, ni el
# root del contenedor puede leerla si no es su dueño (con sudo, los dos son
# root; con un usuario del grupo docker, como en la CI, no).
#   ayudante <orden> [opciones]
ayudante() {
  local codigo=0 linea
  local -a extra=()
  if [ -n "${MAILWAY_TLS_CA_FILE:-}" ]; then extra=(-v "$MAILWAY_TLS_CA_FILE:/prueba/ca.pem:ro"); fi
  preparar_errores_herramienta
  HM_SALIDA=$(printf '%s\n' "$STALWART_ADMIN_PASSWORD" | docker run --rm -i --network mailway-internal \
    --read-only --tmpfs /tmp:size=64m --cap-drop ALL --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" \
    -v "$MIG_DIR:/trabajo" -v "$DEPLOY_DIR/motor:/mailway:ro" ${extra[@]+"${extra[@]}"} \
    "$IMAGEN_PYTHON" python -I -B /mailway/migracion.py "$@" 2>"$ERR_TMP") || codigo=$?
  while IFS= read -r linea || [ -n "$linea" ]; do
    if [ -n "$linea" ]; then info "${linea#Aviso: }"; fi
  done <"$ERR_TMP"
  rm -f "$ERR_TMP"
  ERR_TMP=""
  HM_SALIDA=$(printf '%s\n' "$HM_SALIDA" | sed -n '$p')
  return "$codigo"
}

# Descarga una URL fijada y comprueba su sha256 antes de dejarla en su sitio.
#   descargar_verificado <url> <sha256> <destino>
descargar_verificado() {
  local suma
  if ! curl -fsSL --max-time 180 -o "$3.parcial" "$1"; then
    rm -f "$3.parcial"
    fallo "No se pudo descargar $1. Comprueba la conexión del servidor y vuelve a intentarlo."
  fi
  suma=$(sha256sum "$3.parcial" | cut -d' ' -f1)
  if [ "$suma" != "$2" ]; then
    rm -f "$3.parcial"
    fallo "$1 no es el fichero esperado (sha256 $suma, se esperaba $2): no se usa."
  fi
  mv "$3.parcial" "$3"
}

# Últimas líneas del registro de un motor, sin colores (no llevan secretos).
mostrar_registro_motor() {
  local linea
  while IFS= read -r linea; do
    info "  $linea"
  done < <(docker logs --tail "${2:-20}" "$1" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-300 || true)
}

# Con MAILWAY_TLS_CA_FILE (solo pruebas), el ayudante verifica también contra
# esa CA (la monta en /prueba/ca.pem).
CA_PRUEBAS=()

comprobaciones_migracion() {
  titulo "Comprobaciones previas (no cambian nada)"
  if [ -n "${MAILWAY_TLS_CA_FILE:-}" ]; then CA_PRUEBAS=(--ca /prueba/ca.pem); fi
  local cmd cola datos libre necesario linea imagen dep url suma
  local maximo=${MAILWAY_MIGRACION_COLA_MAX:-50}
  for cmd in curl sha256sum timeout; do
    tiene "$cmd" || fallo "Falta $cmd en el servidor."
  done
  case "$maximo" in '' | *[!0-9]*) fallo "MAILWAY_MIGRACION_COLA_MAX debe ser un número de mensajes." ;; esac

  # Motor 0.15 en marcha y sano, y su contraseña: UNA sola petición
  # autenticada (cada contraseña incorrecta cuenta para el bloqueo
  # automático), la de la cola de salida, que hace falta igualmente.
  case "$(docker inspect --type container -f '{{.Config.Image}}' mailway-mail 2>/dev/null || true)" in
    *stalwart:v0.15*) ;;
    *) fallo "El contenedor mailway-mail no ejecuta Stalwart 0.15: no hay nada que migrar (o está a medias; revisa sudo mailway comprobar)." ;;
  esac
  [ "$(estado_contenedor mailway-mail)" = healthy ] ||
    fallo "El motor 0.15 no está en marcha y sano: arréglalo antes de migrar (sudo mailway comprobar)."
  docker image inspect "$IMAGEN_CURL" >/dev/null 2>&1 || docker pull -q "$IMAGEN_CURL" >/dev/null ||
    fallo "No se pudo descargar la imagen $IMAGEN_CURL."
  RESP_BODY=$(motor_api GET '/api/queue/messages?page=1&limit=1&values=1' 2>/dev/null || true)
  cola=$(campo_json '.data.total // empty')
  if [ -z "$cola" ]; then
    if printf '%s' "$RESP_BODY" | grep -Eq '"status": *40[13]'; then
      fallo "El motor 0.15 rechaza la contraseña de $ENV_FILE (STALWART_ADMIN_PASSWORD). No se reintenta: cada intento cuenta para su bloqueo automático."
    fi
    fallo "La gestión del motor 0.15 no responde por la red interna. Revisa: docker logs mailway-mail"
  fi
  RESP_BODY=""
  ok "Stalwart 0.15 en marcha y sano; la contraseña de $ENV_FILE es la vigente."
  if [ "$cola" -gt "$maximo" ]; then
    fallo "Hay $cola mensajes en la cola de salida: suele ser un problema de entrega que conviene resolver antes (Resumen → Tu servicio en el panel). Pasan a la 0.16, pero para migrar igualmente: MAILWAY_MIGRACION_COLA_MAX=$cola."
  elif [ "$cola" -gt 0 ]; then
    info "Hay $cola mensajes en la cola de salida: pasan a la 0.16, que los sigue reintentando."
  else
    ok "Cola de salida vacía."
  fi

  # El panel y su herramienta del motor.
  en_marcha "$PANEL_MOTOR" || fallo "El panel ($PANEL_MOTOR) no está en marcha: la migración lo necesita (mantenimiento, contraseñas y ajustes de la 0.16)."
  panel_tiene_herramienta_motor "$PANEL_MOTOR" ||
    fallo "El panel desplegado ($PANEL_MOTOR) no tiene la herramienta del motor (server/dist/tools/motor.js): despliega antes la versión actual de Mailway (sudo mailway update -y)."
  herramienta_motor "$PANEL_MOTOR" 120 estado || fallo "La herramienta del motor del panel ha fallado: $(hm_campo '.error // "sin detalle"')."
  [ "$(hm_campo '.ok')" = true ] || fallo "La herramienta del motor del panel ha respondido algo inesperado."
  case "$(hm_campo '.api // empty')" in
    rest015) ;;
    *) fallo "El panel no ve un Stalwart 0.15 en el motor (ve «$(hm_campo '.api // "nada"')»): no se puede migrar así." ;;
  esac
  ok "Buzones en el panel: $(hm_campo '.buzones.total // "?"'); con su contraseña ya copiada: $(hm_campo '.buzones.conHash // "?"')."
  if [ "$(hm_campo '.mantenimiento.activo')" = true ]; then
    aviso "El panel ya estaba en mantenimiento (¿una migración interrumpida?): se renueva y se quita al terminar."
  fi

  # Certificado: con la 0.16 sale siempre del Traefik (con el extractor).
  if [ "$CON_SKYWAY" = 1 ] && { [ -z "$TRAEFIK_ACME_VOLUME" ] || ! docker volume inspect "$TRAEFIK_ACME_VOLUME" >/dev/null 2>&1; }; then
    fallo "Con Stalwart 0.16 el certificado de IMAP y SMTP sale del Traefik de Skyway y no se encuentra su volumen (TRAEFIK_ACME_VOLUME en $ENV_FILE). Corrígelo con sudo mailway update -y --reaplicar y vuelve a intentarlo."
  fi
  if [ "$CON_SKYWAY" = 0 ] && [ "$USAR_PROXY_PROPIO" = 0 ]; then
    fallo "Con Stalwart 0.16 el certificado de IMAP y SMTP sale del Traefik propio (perfil proxy), y esta instalación no lo tiene: la 0.16 serviría un certificado autofirmado. Sección 7 de docs/DESPLIEGUE-SKYWAY.md."
  fi
  if en_marcha mailway-certs-dumper; then MIG_EXTRACTOR=1; fi

  # Espacio: una copia de los datos de la 0.15 y margen (la 0.16 reorganiza
  # parte de la base de datos al arrancar).
  for imagen in "$IMAGEN_PYTHON" "$IMAGEN_016" "$IMAGEN_CLI"; do
    docker image inspect "$imagen" >/dev/null 2>&1 || docker pull -q "$imagen" >/dev/null ||
      fallo "No se pudo descargar la imagen $imagen."
  done
  ok "Imágenes descargadas: $IMAGEN_016, $IMAGEN_CLI y $IMAGEN_PYTHON."
  linea=$(docker run --rm --network none -v "$(volumen_015):/v:ro" "$IMAGEN_PYTHON" \
    sh -c 'du -sk /v/data | cut -f1; df -Pk /v | awk "NR == 2 {print \$4}"' 2>/dev/null | tr '\n' ' ' || true)
  read -r datos libre <<<"$linea"
  case "$datos$libre" in '' | *[!0-9]*) fallo "No se pudo medir el volumen de la 0.15 ($(volumen_015)): ¿existe y tiene la carpeta data?" ;; esac
  necesario=$((datos * 12 / 10 + 1048576))
  if [ "$libre" -lt "$necesario" ]; then
    fallo "No hay espacio: los datos de la 0.15 ocupan $((datos / 1024)) MiB y la copia necesita unos $((necesario / 1024)) MiB libres; hay $((libre / 1024)) MiB."
  fi
  ok "Espacio: datos de $((datos / 1024)) MiB y $((libre / 1024)) MiB libres."

  # Script oficial y dependencias, fijados y con su sha256.
  mkdir -p "$MIG_DIR/dependencias"
  read -r url suma <<<"$MIGRAR016_SCRIPT"
  descargar_verificado "$url" "$suma" "$MIG_DIR/migrate_v016.py"
  for dep in "${MIGRAR016_DEPENDENCIAS[@]}"; do
    read -r url suma <<<"$dep"
    descargar_verificado "$url" "$suma" "$MIG_DIR/dependencias/${url##*/}"
  done
  ok "Script oficial de conversión y sus dependencias descargados y comprobados (sha256)."

  # Volúmenes nuevos de la 0.16 (con fecha: nunca se reutiliza uno anterior)
  # y el compose de la 0.16 con ellos.
  MIG_ETC="mailway-stalwart-etc-$MIG_SELLO"
  MIG_DATOS="mailway-stalwart-data-$MIG_SELLO"
  if docker volume inspect "$MIG_ETC" >/dev/null 2>&1 || docker volume inspect "$MIG_DATOS" >/dev/null 2>&1; then
    fallo "Ya existen los volúmenes $MIG_ETC o $MIG_DATOS: espera un segundo y vuelve a intentarlo."
  fi
  MOTOR=$MOTOR_016 MAILWAY_STALWART_ETC_VOLUME=$MIG_ETC MAILWAY_STALWART_DATA_VOLUME=$MIG_DATOS compose config -q ||
    fallo "El compose con Stalwart 0.16 no es válido (arriba el motivo): no se ha cambiado nada."

  # El certificado que sirve ahora la 0.15: si es válido, la 0.16 tendrá que
  # servir uno igual de válido antes de abrir los puertos.
  if ayudante tls --host mailway-mail --nombre "$MAIL_HOSTNAME" ${CA_PRUEBAS[@]+"${CA_PRUEBAS[@]}"}; then
    MIG_CERT_015=1
    ok "La 0.15 sirve un certificado válido para $MAIL_HOSTNAME en 993, 465 y 587: la 0.16 tendrá que servirlo igual."
  else
    aviso "La 0.15 no sirve ahora un certificado válido para $MAIL_HOSTNAME en 993, 465 y 587 ($(hm_campo '[.puertos // {} | to_entries[] | select(.value.ok | not) | "\(.key): \(.value.error)"] | join("; ")')): no se le exigirá a la 0.16."
  fi
}

confirmar_migracion() {
  titulo "Qué va a pasar"
  info "1. El panel entra en mantenimiento y copia la contraseña de cada buzón (la 0.15 sigue en marcha)."
  info "2. Se vuelcan y convierten los datos del motor con el script oficial de Stalwart."
  info "3. Ventana sin correo (unos minutos; la copia de los datos es lo más largo): se paran el webmail"
  info "   y la 0.15, cuyo volumen ($(volumen_015)) no se toca: es la copia de seguridad y la vuelta atrás."
  info "   El correo que llegue mientras tanto no se pierde: los servidores remitentes lo reintentan."
  info "4. La 0.16 arranca primero sin puertos públicos; se aplican los ajustes de Mailway, el certificado"
  info "   y se comprueba todo. Solo entonces se abren los puertos y se repite la comprobación."
  info "5. Si algo falla antes de terminar, vuelve sola a la 0.15."
  info "Después: las contraseñas de aplicación de dispositivos y servicios dejan de valer y hay que crearlas"
  info "de nuevo (el panel avisa a los titulares; Skyway vuelve a conectar sus servicios solo); las claves"
  info "de API del panel siguen funcionando."
  if [ "$SIN_CONFIRMAR" = 1 ]; then return 0; fi
  [ "$INTERACTIVO" = 1 ] || fallo "Sin terminal no se puede confirmar: añade -y (sudo mailway migrar-motor -y)."
  confirmar "¿Migrar ahora a Stalwart 0.16?" n || fallo "Migración cancelada: no se ha cambiado nada."
}

activar_mantenimiento() {
  herramienta_motor "$PANEL_MOTOR" 120 mantenimiento on --minutos "${MAILWAY_MIGRACION_MINUTOS:-120}" ||
    fallo "El panel no ha podido entrar en mantenimiento: $(hm_campo '.error // "sin detalle"'). No se ha cambiado nada."
  [ "$(hm_campo '.activo')" = true ] || fallo "El panel no confirma el modo mantenimiento. No se ha cambiado nada."
  MIG_MANTENIMIENTO=1
  ok "Panel en mantenimiento: mientras dura, nada del panel cambia el motor. Se quita al terminar; si la orden se cortara, caduca solo (ahora, a las $(hora_de_ms "$(hm_campo '.hasta // empty')"))."
}

# Prolonga el mantenimiento al empezar cada paso largo: con muchos datos, la
# migración puede durar más que el plazo con el que se activó, y al caducar
# el panel volvería a cambiar el motor (también el temporal). Si no puede, lo
# dice y sigue: el plazo inicial suele bastar.
renovar_mantenimiento() {
  [ "$MIG_MANTENIMIENTO" = 1 ] || return 0
  herramienta_motor "$PANEL_MOTOR" 120 mantenimiento on --minutos "${MAILWAY_MIGRACION_MINUTOS:-120}" >/dev/null 2>&1 ||
    aviso "No se pudo prolongar el mantenimiento del panel (caduca a la hora prevista)."
  return 0
}

# Quita el mantenimiento del panel si lo puso esta orden. Devuelve 1 si no
# puede (lo explica: caduca solo, pero mejor quitarlo).
desactivar_mantenimiento() {
  [ "$MIG_MANTENIMIENTO" = 1 ] || return 0
  # Un solo intento: si falla, se explica cómo quitarlo a mano.
  MIG_MANTENIMIENTO=0
  if herramienta_motor "$PANEL_MOTOR" 120 mantenimiento off && [ "$(hm_campo '.activo')" = false ]; then
    ok "Panel fuera de mantenimiento."
    return 0
  fi
  aviso "El panel sigue en mantenimiento (caduca solo). Para quitarlo ya: docker exec -u node $PANEL_MOTOR node server/dist/tools/motor.js mantenimiento off"
  return 1
}

capturar_contrasenas() {
  local codigo=0 fallidos
  info "Copiando en el panel la contraseña (hash) de cada buzón: la 0.16 ya no las devuelve…"
  herramienta_motor "$PANEL_MOTOR" 3600 capturar || codigo=$?
  fallidos=$(hm_campo '(.fallidos // []) | length')
  if [ "$codigo" != 0 ] || [ "$(hm_campo '.ok')" != true ] || [ "${fallidos:-0}" != 0 ]; then
    fallo "El panel no ha podido copiar la contraseña de todos los buzones (${fallidos:-?} sin copiar: $(hm_campo '(.fallidos // []) | map(if type == "string" then . else (.email // .buzon // tostring) end) | join(", ")' | cut -c1-300)): sin ellas no podría comprobarlas con la 0.16. No se ha cambiado nada del motor."
  fi
  ok "Contraseñas copiadas en el panel (nuevas: $(hm_campo '.capturados // 0'); ya estaban: $(hm_campo '.yaEstaban // 0'))."
}

volcar_y_convertir() {
  titulo "Volcado y conversión (la 0.15 sigue en marcha)"
  ayudante volcar --url http://mailway-mail:8080 ||
    fallo "El volcado del motor 0.15 ha fallado: $(hm_campo '.error // "sin detalle"'). No se ha cambiado nada del motor."
  ok "Volcado de la 0.15 (dominios: $(hm_campo '.dominios'); buzones: $(hm_campo '.buzones'), suspendidos: $(hm_campo '.suspendidos'); alias: $(hm_campo '.alias'); firmas DKIM: $(hm_campo '.dkim'))."
  ayudante convertir --nombre "$MAIL_HOSTNAME" ||
    fallo "La conversión ha fallado: $(hm_campo '.error // "sin detalle"'). No se ha cambiado nada del motor."
  ok "Plan de la 0.16 (operaciones: $(hm_campo '.operaciones'); $(hm_campo '.crear // {} | to_entries | map("\(.key): \(.value)") | join(", ")'))."
  if [ -s "$MIG_DIR/sin-migrar.txt" ]; then
    info "Ajustes de la 0.15 que el script no migra (los de Mailway los vuelve a aplicar el panel): $MIG_DIR/sin-migrar.txt"
  fi
}

parar_015() {
  titulo "Ventana sin correo: parada de la 0.15"
  # Desde aquí, cualquier fallo vuelve a la 0.15 (al_salir).
  MIG_FASE=parado
  MIG_HORA_PARADA=$(date '+%H:%M')
  if en_marcha mailway-webmail; then docker stop -t 30 mailway-webmail >/dev/null; fi
  if en_marcha mailway-certs-dumper; then docker stop -t 30 mailway-certs-dumper >/dev/null; fi
  # Con tiempo: RocksDB debe quedar cerrada limpia antes de copiarla.
  docker stop -t 120 mailway-mail >/dev/null
  ok "Webmail, extractor y motor 0.15 parados ($MIG_HORA_PARADA)."
}

# Copia de los datos de la 0.15 a los volúmenes nuevos de la 0.16 (la 0.15 se
# monta en solo lectura) y config.json propio: RocksDB en /var/lib/stalwart,
# la misma ruta que una instalación nueva. El del script copia la ruta de la
# 0.15 (…/data), que no coincidiría con la copia. Todo para el usuario 2000,
# con el que corre la 0.16. Se comprueba que la copia tiene los mismos ficheros
# y bytes que el original.
copiar_datos_015() {
  local par
  titulo "Copia de los datos para la 0.16"
  # Con las etiquetas de Compose del proyecto y del volumen que sustituyen:
  # así Compose los usa como suyos, sin avisar de que ya existían.
  for par in "mailway-stalwart-etc $MIG_ETC" "mailway-stalwart-data $MIG_DATOS"; do
    docker volume create --label com.docker.compose.project=mailway \
      --label "com.docker.compose.volume=${par% *}" "${par#* }" >/dev/null ||
      fallo "No se pudo crear el volumen ${par#* }."
  done
  info "Copiando $(volumen_015) a $MIG_DATOS…"
  docker run --rm --network none -v "$(volumen_015):/origen:ro" -v "$MIG_DATOS:/destino" -v "$MIG_ETC:/etc-destino" \
    "$IMAGEN_PYTHON" sh -euc '
      cp -a /origen/data/. /destino/
      chown -R 2000:2000 /destino
      printf "%s\n" "{\"@type\":\"RocksDb\",\"path\":\"/var/lib/stalwart\"}" >/etc-destino/config.json
      chown 2000:2000 /etc-destino /etc-destino/config.json
      chmod 0640 /etc-destino/config.json
      python - <<"PY"
import os
def medir(raiz):
    n = b = 0
    for carpeta, _, ficheros in os.walk(raiz):
        for f in ficheros:
            n += 1
            b += os.lstat(os.path.join(carpeta, f)).st_size
    return n, b
o, d = medir("/origen/data"), medir("/destino")
print("origen", *o, "copia", *d)
raise SystemExit(0 if o == d else 1)
PY' >"$MIG_DIR/copia.txt" 2>&1 ||
    fallo "La copia de los datos ha fallado: $(tr '\n' ' ' <"$MIG_DIR/copia.txt" | cut -c1-300)"
  ok "Datos copiados y comprobados (ficheros: $(cut -d' ' -f2 "$MIG_DIR/copia.txt")); config.json propio en $MIG_ETC."
}

# Arranca un motor 0.16 temporal sobre los volúmenes nuevos, sin puertos
# publicados, en la red interna con la IP y el alias del motor.
#   arrancar_motor_temporal <nombre> <recuperacion|previo>
arrancar_motor_temporal() {
  local nombre=$1 modo=$2
  local -a extra=()
  docker rm -f "$nombre" >/dev/null 2>&1 || true
  if [ "$modo" = recuperacion ]; then
    extra=(-e STALWART_RECOVERY_MODE=1)
  else
    extra=(-v mailway-mail-certs:/opt/stalwart/certs:ro)
  fi
  STALWART_RECOVERY_ADMIN="admin:$STALWART_ADMIN_PASSWORD" docker run -d --name "$nombre" --hostname "$MAIL_HOSTNAME" \
    -e STALWART_RECOVERY_ADMIN "${extra[@]}" \
    -v "$MIG_ETC:/etc/stalwart" -v "$MIG_DATOS:/var/lib/stalwart" \
    --network mailway-internal --ip "$MAIL_INTERNAL_IP" --network-alias mailway-mail \
    --label "mailway.migracion=$modo" "$IMAGEN_016" >/dev/null ||
    fallo "No se pudo arrancar el motor 0.16 temporal ($nombre)."
  # El panel (junto a Skyway) llega al motor por la red de Traefik.
  docker network connect --alias mailway-mail "$RED_BORDE" "$nombre" >/dev/null 2>&1 ||
    fallo "No se pudo conectar $nombre a la red $RED_BORDE."
}

recuperacion_016() {
  local codigo=0 linea
  titulo "Stalwart 0.16 en modo recuperación (sin puertos de correo)"
  arrancar_motor_temporal "$CONTENEDOR_RECUPERACION" recuperacion
  # Al arrancar prepara los datos de la 0.15 (borra lo que ya no vale, migra
  # el modelo del antispam): no responde hasta terminar. Si el contenedor se
  # para, no se espera más.
  if ! esperar_motor_016 "$CONTENEDOR_RECUPERACION" 1800 live; then
    mostrar_registro_motor "$CONTENEDOR_RECUPERACION" 30
    fallo "La 0.16 no ha terminado de preparar los datos de la 0.15 (registro arriba)."
  fi
  ok "La 0.16 ha preparado los datos de la 0.15 (modo recuperación)."
  info "Aplicando el plan con stalwart-cli apply…"
  STALWART_PASSWORD=$STALWART_ADMIN_PASSWORD docker run --rm -i --network mailway-internal \
    -e STALWART_URL=http://mailway-mail:8080 -e STALWART_USER=admin -e STALWART_PASSWORD \
    "$IMAGEN_CLI" apply --stdin --no-color <"$MIG_DIR/export.json" >"$MIG_DIR/apply.log" 2>&1 || codigo=$?
  while IFS= read -r linea; do info "  $linea"; done < <(cut -c1-300 "$MIG_DIR/apply.log")
  if [ "$codigo" != 0 ] || ! grep -q '(0 failed)' "$MIG_DIR/apply.log"; then
    # Nunca se borra una cuenta para repetirlo: borraría su correo. Lo creado
    # se queda en los volúmenes de este intento.
    fallo "stalwart-cli apply no ha terminado sin fallos (código $codigo)."
  fi
  ok "Directorio de la 0.16 creado: dominios, buzones (con su contraseña), alias y firmas DKIM."
  ayudante recuperacion --url http://mailway-mail:8080 ||
    fallo "No se pudo dejar el registro de eventos del motor en la salida estándar: $(hm_campo '.error // "sin detalle"')."
  docker stop -t 60 "$CONTENEDOR_RECUPERACION" >/dev/null || true
  docker rm -f "$CONTENEDOR_RECUPERACION" >/dev/null 2>&1 || true
}

# Primer arranque normal, sin puertos publicados: la 0.16 crea sus escuchas y
# roles por defecto; el panel aplica los ajustes de Mailway (suspensiones
# incluidas: antes de abrir ningún puerto); el extractor, el certificado; y se
# comprueba todo antes de abrir.
previo_016() {
  titulo "Primer arranque de la 0.16, aún sin puertos públicos"
  arrancar_motor_temporal "$CONTENEDOR_PREVIO" previo
  if ! esperar_motor_016 "$CONTENEDOR_PREVIO" 300 ready; then
    mostrar_registro_motor "$CONTENEDOR_PREVIO" 30
    fallo "La 0.16 no arranca con los datos migrados (registro arriba)."
  fi
  ok "Stalwart 0.16 en marcha con los datos migrados."
  titulo "Ajustes de Mailway en la 0.16"
  provisionar_motor "$PANEL_MOTOR" "$CONTENEDOR_PREVIO" ||
    fallo "El panel no ha dejado la 0.16 con los ajustes de Mailway (detalle arriba)."

  titulo "Certificado de IMAP y SMTP en la 0.16"
  info "El extractor lleva a la 0.16 el certificado de Traefik para $MAIL_HOSTNAME…"
  compose_q --profile tls up -d --no-deps --force-recreate certs-dumper ||
    fallo "No se pudo arrancar el extractor del certificado."
  if esperar_extractor 240; then
    ok "El extractor confirma el certificado servido por la 0.16."
  elif [ "$MIG_CERT_015" = 1 ]; then
    fallo "El extractor no ha conseguido que la 0.16 sirva el certificado. Estado: $(docker exec mailway-certs-dumper python /app/extractor.py estado 2>&1 | head -n 3 | tr '\n' ' ')"
  else
    aviso "El extractor aún no confirma el certificado (la 0.15 tampoco servía uno válido)."
  fi
  if ayudante tls --host mailway-mail --nombre "$MAIL_HOSTNAME" ${CA_PRUEBAS[@]+"${CA_PRUEBAS[@]}"}; then
    ok "La 0.16 sirve en 993, 465 y 587 (STARTTLS) el mismo certificado válido para $MAIL_HOSTNAME."
  elif [ "$MIG_CERT_015" = 1 ]; then
    fallo "La 0.16 no sirve un certificado válido para $MAIL_HOSTNAME en 993, 465 y 587: $(hm_campo '[.puertos // {} | to_entries[] | select(.value.ok | not) | "\(.key): \(.value.error)"] | join("; ")') $(hm_campo '.error // empty')"
  else
    aviso "La 0.16 no sirve un certificado válido en 993, 465 y 587 (tampoco la 0.15): revísalo después con sudo mailway comprobar."
  fi

  titulo "Comprobación de los datos migrados"
  ayudante comprobar --url http://mailway-mail:8080 --nombre "$MAIL_HOSTNAME" ||
    fallo "La 0.16 no tiene todo lo de la 0.15: $(hm_campo '((.problemas // []) | join(" ")) + (.error // "")' | cut -c1-600)"
  ok "En la 0.16 está todo lo de la 0.15 (dominios: $(hm_campo '.recuento.dominios'); buzones: $(hm_campo '.recuento.buzones'); alias: $(hm_campo '.recuento.alias'); firmas DKIM: $(hm_campo '.recuento.dkim')), con sus escuchas y el nombre del servidor."
  docker stop -t 60 "$CONTENEDOR_PREVIO" >/dev/null || true
  docker rm -f "$CONTENEDOR_PREVIO" >/dev/null 2>&1 || true
}

definitivo_016() {
  titulo "Stalwart 0.16 con los puertos públicos"
  MIG_ENV_ANTES="$MIG_DIR/env-antes"
  cp -p "$ENV_FILE" "$MIG_ENV_ANTES"
  MAILWAY_STALWART_ETC_VOLUME=$MIG_ETC
  MAILWAY_STALWART_DATA_VOLUME=$MIG_DATOS
  MAILWAY_MOTOR_MIGRADO=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  fijar_en_env MAILWAY_MOTOR "$MOTOR_016" MAILWAY_STALWART_ETC_VOLUME "$MIG_ETC" \
    MAILWAY_STALWART_DATA_VOLUME "$MIG_DATOS" MAILWAY_MOTOR_MIGRADO "$MAILWAY_MOTOR_MIGRADO"
  MOTOR=$MOTOR_016
  MIG_FASE=abierto
  MIG_HORA_APERTURA=$(date '+%H:%M')
  compose_q up -d mailway-mail || fallo "Compose no ha podido arrancar el motor 0.16."
  if ! { esperar_motor_016 mailway-mail 300 ready && esperar_sano mailway-mail 180; }; then
    fallo "El motor 0.16 definitivo no arranca. Revisa: docker logs mailway-mail"
  fi
  ok "Stalwart 0.16 en marcha con los puertos de correo ($MIG_HORA_APERTURA)."
  provisionar_motor "$PANEL_MOTOR" mailway-mail || fallo "El panel no confirma los ajustes de Mailway en el motor definitivo."
  compose_q up -d --remove-orphans || fallo "Compose no ha podido arrancar el webmail."
  compose_q --profile tls up -d certs-dumper || fallo "No se pudo arrancar el extractor del certificado."
  esperar_sano mailway-webmail 180 || fallo "El webmail no vuelve a estar sano. Revisa: docker logs mailway-webmail"
  titulo "Comprobación final (la de sudo mailway comprobar)"
  if [ "$MIG_CERT_015" = 0 ]; then TOLERAR_CERTIFICADO=1; fi
  comprobar_instalacion || fallo "La comprobación final no pasa (detalle arriba)."
  TOLERAR_CERTIFICADO=0
}

# Vuelta atrás automática (desde al_salir, ante cualquier fallo con la 0.15
# parada): fuera los motores temporales y el 0.16, deploy/.env como estaba,
# la 0.15 sobre su volumen de siempre, el webmail y el extractor como estaban
# y el panel fuera de mantenimiento. No se interrumpe con Ctrl+C. Devuelve 1
# si no lo consigue todo (lo explica).
volver_a_015() {
  local fallos=0 abierto=0
  trap '' INT TERM
  set +e
  if [ "$MIG_FASE" = abierto ]; then abierto=1; fi
  MIG_FASE=""
  printf '\n'
  titulo "Vuelta atrás: Stalwart 0.15"
  docker rm -f "$CONTENEDOR_RECUPERACION" "$CONTENEDOR_PREVIO" >/dev/null 2>&1
  if [ -n "$MIG_ENV_ANTES" ] && [ -f "$MIG_ENV_ANTES" ]; then
    if cp -p "$MIG_ENV_ANTES" "$ENV_FILE.vuelta" && mv "$ENV_FILE.vuelta" "$ENV_FILE"; then
      ok "deploy/.env como estaba antes de migrar."
    else
      aviso "No se pudo devolver deploy/.env a como estaba: su copia está en $MIG_ENV_ANTES (cópiala a $ENV_FILE)."
      MIG_ENV_CONSERVAR=1
      fallos=$((fallos + 1))
    fi
  fi
  MOTOR=$MOTOR_015
  MAILWAY_STALWART_ETC_VOLUME=$(leer_env MAILWAY_STALWART_ETC_VOLUME)
  MAILWAY_STALWART_DATA_VOLUME=$(leer_env MAILWAY_STALWART_DATA_VOLUME)
  if [ "$abierto" = 1 ]; then docker stop -t 60 mailway-mail >/dev/null 2>&1; fi
  if compose_q up -d mailway-mail && esperar_sano mailway-mail 240 && [ "$(estado_contenedor mailway-mail)" = healthy ]; then
    ok "Stalwart 0.15 en marcha sobre su volumen de siempre ($(volumen_015))."
  else
    aviso "La 0.15 no vuelve a estar sana. Revisa: docker logs mailway-mail"
    fallos=$((fallos + 1))
  fi
  compose_q up -d --remove-orphans || fallos=$((fallos + 1))
  if [ "$MIG_EXTRACTOR" = 1 ]; then
    compose_q --profile tls up -d --force-recreate certs-dumper || fallos=$((fallos + 1))
  else
    # Antes de migrar no estaba (la 0.15 usaba su propio ACME): fuera.
    docker rm -f mailway-certs-dumper >/dev/null 2>&1
  fi
  if esperar_sano mailway-webmail 180; then ok "Webmail en marcha."; else aviso "El webmail aún no está sano. Revisa: docker logs mailway-webmail"; fi
  desactivar_mantenimiento || fallos=$((fallos + 1))
  limpiar_trabajo_migracion
  printf '\n'
  if [ "$abierto" = 1 ]; then
    aviso "La 0.16 llegó a abrir los puertos a las $MIG_HORA_APERTURA: el correo que llegara desde entonces está en su volumen ($MIG_DATOS), no en la 0.15."
  fi
  info "Lo creado por este intento se conserva para revisarlo (volúmenes $MIG_ETC y $MIG_DATOS) y nunca se reutiliza."
  info "Para borrarlo cuando ya no haga falta: docker volume rm $MIG_ETC $MIG_DATOS"
  info "Registro completo: $MIG_REGISTRO"
  if [ "$fallos" = 0 ]; then
    aviso "La migración no se ha completado y el servidor ha vuelto a Stalwart 0.15, con sus datos de siempre (motivo arriba)."
    return 0
  fi
  aviso "La migración no se ha completado y la vuelta a la 0.15 tampoco del todo ($fallos incidencias arriba)."
  aviso "El volumen de la 0.15 está intacto. A mano: sudo bash deploy/instalar.sh --actualizar (con MAILWAY_MOTOR=$MOTOR_015 en deploy/.env) y sudo mailway comprobar."
  return 1
}

migrar_motor() {
  cargar_instalacion_motor
  [ "$MOTOR" = "$MOTOR_015" ] || fallo "Este servidor ya usa Stalwart 0.16: no hay nada que migrar."
  tomar_cerrojo_motor
  preparar_registro_motor migracion-motor
  titulo "Cambio de motor: Stalwart 0.15 → 0.16"
  comprobaciones_migracion
  confirmar_migracion
  # Confirmada, una sesión SSH que se corta ya no la interrumpe: sigue (o
  # vuelve atrás) sola, con todo en el registro.
  trap '' HUP
  MIG_FASE=preparada
  titulo "Panel"
  activar_mantenimiento
  capturar_contrasenas
  volcar_y_convertir
  parar_015
  copiar_datos_015
  renovar_mantenimiento
  recuperacion_016
  renovar_mantenimiento
  previo_016
  renovar_mantenimiento
  definitivo_016
  MIG_FASE=""
  titulo "Tareas del panel tras migrar"
  if herramienta_motor "$PANEL_MOTOR" 3600 tras-migrar && [ "$(hm_campo '.ok')" = true ]; then
    ok "Credenciales internas renovadas: $(hm_campo '.credencialesInternas.renovadas // 0'); contraseñas de aplicación invalidadas: $(hm_campo '.contrasenasInvalidadas // 0'); titulares avisados: $(hm_campo '.avisados // 0')."
  else
    aviso "Las tareas del panel tras migrar no han terminado: el motor ya está migrado y funciona. Repítelas (son idempotentes): docker exec -u node $PANEL_MOTOR node server/dist/tools/motor.js tras-migrar"
  fi
  desactivar_mantenimiento || true
  limpiar_trabajo_migracion
  titulo "Migración terminada"
  ok "Stalwart 0.16 en marcha desde las $MIG_HORA_APERTURA (sin correo desde las $MIG_HORA_PARADA)."
  info "El volumen de la 0.15 ($(volumen_015)) sigue intacto: es la vuelta atrás (sudo mailway revertir-motor)."
  info "Cuando lleves unos días sin problemas, retíralo para liberar espacio: sudo mailway retirar-motor-anterior"
  info "Los titulares tienen que crear de nuevo sus contraseñas de aplicación (el panel les avisa)."
  info "Registro: $MIG_REGISTRO"
}

# --revertir-motor: de vuelta a la 0.15 tras una migración terminada. Los
# volúmenes de la 0.16 no se tocan (se puede volver a migrar después, a unos
# nuevos). Con el panel: mantenimiento mientras dura, sus ajustes y la
# comprobación de lo que conoce («provisionar», que también reaplica las
# suspensiones) y sus tareas de cambio de motor («tras-migrar»: renueva en la
# 0.15 las credenciales SMTP internas de las claves de API y los formularios
# creadas con la 0.16).
revertir_motor() {
  local vol panel_listo=0
  cargar_instalacion_motor
  [ "$MOTOR" = "$MOTOR_016" ] || fallo "Este servidor usa Stalwart 0.15: no hay nada que revertir."
  [ -n "$MAILWAY_MOTOR_MIGRADO" ] ||
    fallo "Esta instalación no viene de una migración (empezó con Stalwart 0.16): no hay una 0.15 a la que volver."
  vol=$(volumen_015)
  docker volume inspect "$vol" >/dev/null 2>&1 ||
    fallo "Ya no existe el volumen de la 0.15 ($vol): se retiró y no se puede volver a ella."
  tomar_cerrojo_motor
  preparar_registro_motor revertir-motor
  titulo "Vuelta a Stalwart 0.15"
  aviso "El correo recibido desde la migración ($MAILWAY_MOTOR_MIGRADO) se queda en el volumen de la 0.16 ($(volumen_016_datos)): con la 0.15 no se verá."
  aviso "Lo que se haya creado o cambiado en el panel desde entonces (buzones, alias, contraseñas) no está en la 0.15; las contraseñas de aplicación de la 0.16 no valen allí y las anteriores vuelven a valer."
  if [ "$SIN_CONFIRMAR" = 0 ]; then
    [ "$INTERACTIVO" = 1 ] || fallo "Sin terminal no se puede confirmar: añade -y (sudo mailway revertir-motor -y)."
    confirmar "¿Volver a Stalwart 0.15?" n || fallo "Cancelado: no se ha cambiado nada."
  fi
  trap '' HUP
  if en_marcha "$PANEL_MOTOR" && panel_tiene_herramienta_motor "$PANEL_MOTOR"; then
    panel_listo=1
    if herramienta_motor "$PANEL_MOTOR" 120 mantenimiento on --minutos 60 && [ "$(hm_campo '.activo')" = true ]; then
      MIG_MANTENIMIENTO=1
    else
      aviso "El panel no ha entrado en mantenimiento: se sigue igualmente."
    fi
  else
    aviso "El panel ($PANEL_MOTOR) no está en marcha o no tiene la herramienta del motor: al terminar, repite con él en marcha «provisionar» y «tras-migrar» (docker exec -u node <panel> node server/dist/tools/motor.js …)."
  fi
  if en_marcha mailway-webmail; then docker stop -t 30 mailway-webmail >/dev/null; fi
  if en_marcha mailway-certs-dumper; then docker stop -t 30 mailway-certs-dumper >/dev/null; fi
  docker stop -t 120 mailway-mail >/dev/null 2>&1 || true
  fijar_en_env MAILWAY_MOTOR "$MOTOR_015"
  MOTOR=$MOTOR_015
  if ! { compose_q up -d mailway-mail && esperar_sano mailway-mail 240 && [ "$(estado_contenedor mailway-mail)" = healthy ]; }; then
    fallo "La 0.15 no arranca. Revisa: docker logs mailway-mail. Para seguir con la 0.16 (sus volúmenes no se han tocado): MAILWAY_MOTOR=$MOTOR_016 en $ENV_FILE y sudo mailway update -y --reaplicar."
  fi
  fijar_en_env MAILWAY_MOTOR_MIGRADO ""
  MAILWAY_MOTOR_MIGRADO=""
  ok "Stalwart 0.15 en marcha sobre su volumen ($vol)."
  compose_q up -d --remove-orphans || aviso "Compose no ha podido arrancar el webmail."
  if [ "$CON_SKYWAY" = 0 ] && [ "$USAR_PROXY_PROPIO" = 0 ]; then
    :
  elif [ "$CON_SKYWAY" = 1 ] && [ -z "$TRAEFIK_ACME_VOLUME" ]; then
    :
  else
    # Si la 0.15 usa su propio ACME, el extractor no hace nada.
    arrancar_extractor || aviso "No se pudo arrancar el extractor del certificado."
  fi
  esperar_sano mailway-webmail 180 || aviso "El webmail aún no está sano. Revisa: docker logs mailway-webmail"
  if [ "$panel_listo" = 1 ]; then
    titulo "Panel"
    if herramienta_motor "$PANEL_MOTOR" 900 provisionar && [ "$(hm_campo '.ok')" = true ]; then
      ok "El panel ha aplicado sus ajustes y confirma que la 0.15 tiene todo lo que él conoce."
    else
      explicar_provisionar
      aviso "Lo creado en el panel después de migrar no está en la 0.15: hay que darlo de alta de nuevo."
    fi
    if herramienta_motor "$PANEL_MOTOR" 3600 tras-migrar && [ "$(hm_campo '.ok')" = true ]; then
      ok "Credenciales internas renovadas en la 0.15: $(hm_campo '.credencialesInternas.renovadas // 0'); contraseñas de aplicación de la 0.16 invalidadas: $(hm_campo '.contrasenasInvalidadas // 0'); de la 0.15 que vuelven a valer: $(hm_campo '.contrasenasRecuperadas // 0')."
    else
      aviso "Las tareas del panel tras volver no han terminado. Repítelas (son idempotentes): docker exec -u node $PANEL_MOTOR node server/dist/tools/motor.js tras-migrar"
    fi
  fi
  desactivar_mantenimiento || true
  titulo "Comprobación"
  comprobar_instalacion || aviso "La comprobación tiene incidencias (arriba)."
  info "Los volúmenes de la 0.16 se conservan ($(volumen_016_etc), $(volumen_016_datos)). Para volver a la 0.16, migra de nuevo: sudo mailway migrar-motor"
  info "Registro: $MIG_REGISTRO"
}

# --retirar-motor-anterior: borra el volumen de la 0.15, que la migración
# conserva como vuelta atrás. Exige escribir su nombre (o, sin terminal, -y y
# MAILWAY_RETIRAR_VOLUMEN con ese nombre).
retirar_motor_anterior() {
  local vol usado tamano respuesta="" restos
  cargar_instalacion_motor
  [ "$MOTOR" = "$MOTOR_016" ] || fallo "Este servidor sigue con Stalwart 0.15: su volumen es el que usa el motor."
  vol=$(volumen_015)
  if ! docker volume inspect "$vol" >/dev/null 2>&1; then
    info "No queda ningún volumen de la 0.15 ($vol)."
  else
    usado=$(docker ps -a --filter "volume=$vol" --format '{{.Names}}') ||
      fallo "No se puede preguntar a Docker qué contenedores usan $vol: no se borra."
    [ -z "$usado" ] || fallo "El volumen $vol lo usa el contenedor $(printf '%s' "$usado" | tr '\n' ' '): no se borra."
    tamano=$(docker run --rm --network none -v "$vol:/v:ro" "$IMAGEN_PYTHON" du -sh /v 2>/dev/null | cut -f1 || true)
    titulo "Retirar el volumen de Stalwart 0.15"
    info "Volumen: $vol (${tamano:-tamaño desconocido}). Migración a la 0.16: ${MAILWAY_MOTOR_MIGRADO:-sin fecha registrada}."
    info "Sin él ya no se puede volver a la 0.15. Si quieres guardar antes una copia:"
    info "  docker run --rm -v $vol:/origen:ro -v /root/copias:/destino alpine tar czf /destino/mailway-0.15-\$(date +%F).tar.gz -C /origen ."
    if [ "$SIN_CONFIRMAR" = 1 ]; then
      [ "${MAILWAY_RETIRAR_VOLUMEN:-}" = "$vol" ] ||
        fallo "Con -y hay que indicar también el volumen: MAILWAY_RETIRAR_VOLUMEN=$vol"
    else
      [ "$INTERACTIVO" = 1 ] || fallo "Sin terminal: -y y MAILWAY_RETIRAR_VOLUMEN=$vol."
      read -r -p "   Escribe el nombre del volumen para borrarlo ($vol): " respuesta || true
      [ "$respuesta" = "$vol" ] || fallo "No coincide: no se ha borrado nada."
    fi
    docker volume rm "$vol" >/dev/null || fallo "Docker no ha podido borrar $vol."
    fijar_en_env MAILWAY_MAIL_VOLUME ""
    ok "Volumen de Stalwart 0.15 retirado ($vol)."
  fi
  # Intentos de migración que volvieron atrás: se dicen, no se borran.
  restos=$(docker volume ls -q --filter label=com.docker.compose.project=mailway |
    grep -E '^mailway-stalwart-(etc|data)-[0-9]{8}-[0-9]{6}$' |
    grep -vx -e "$(volumen_016_etc)" -e "$(volumen_016_datos)" | paste -sd ' ' - || true)
  if [ -n "$restos" ]; then
    info "Quedan volúmenes de intentos de migración que volvieron atrás: $restos"
    info "  Cuando ya no hagan falta: docker volume rm $restos"
  fi
}

# ------------------------------------------------------------ diagnóstico --

# Datos que necesita el diagnóstico, leídos de deploy/.env sin preguntar nada.
preparar_diagnostico() {
  [ -f "$ENV_FILE" ] || fallo "No existe $ENV_FILE: Mailway no está instalado aquí (sudo bash deploy/instalar.sh)."
  tiene docker || fallo "Falta Docker."
  docker info >/dev/null 2>&1 || fallo "No se puede hablar con Docker. Ejecuta como root (sudo) o con un usuario del grupo docker."
  case "$(leer_env MAILWAY_INSTALACION)" in
    autonoma) CON_SKYWAY=0 ;;
    '') if docker inspect mailway-panel >/dev/null 2>&1; then CON_SKYWAY=0; fi ;;
  esac
  MAIL_HOSTNAME=$(leer_env MAIL_HOSTNAME)
  host_valido "$MAIL_HOSTNAME" || fallo "MAIL_HOSTNAME no es válido en $ENV_FILE."
  STALWART_ADMIN_PASSWORD=${STALWART_ADMIN_PASSWORD:-$(leer_env STALWART_ADMIN_PASSWORD)}
  INTERNAL_SUBNET=$(leer_env MAILWAY_INTERNAL_SUBNET)
  INTERNAL_SUBNET=${INTERNAL_SUBNET:-10.203.53.0/24}
  MOTOR=$(motor_configurado)
}

# Muestra la salida de una comprobación hecha dentro de un contenedor con el
# formato del instalador: «OK: …» → [ok], «FALLO: …» → [aviso].
mostrar_resultado() {
  local linea
  while IFS= read -r linea; do
    case "$linea" in
      'OK: '*) ok "${linea#OK: }" ;;
      'FALLO: '*) aviso "${linea#FALLO: }" ;;
      '') ;;
      *) info "$linea" ;;
    esac
  done
}

# Ejecuta una comprobación, muestra su resultado y devuelve su código.
ejecutar_comprobacion() {
  local salida codigo=0
  salida=$("$@" 2>&1) || codigo=$?
  printf '%s\n' "$salida" | mostrar_resultado
  return "$codigo"
}

# Ajustes del motor 0.16 que necesita Mailway, con UNA sola petición JMAP
# autenticada (cada contraseña incorrecta cuenta para el bloqueo automático):
# nombre del servidor, X-Forwarded-For, exención de la red interna, la escucha
# del 587 con STARTTLS y el certificado. Devuelve el número de incidencias.
comprobar_motor_016() {
  local incidencias=0 nombre certificado
  jmap_motor "$(jmap_cuerpo '[["x:SystemSettings/get",{"ids":["singleton"],"properties":["defaultHostname","defaultCertificateId"]},"s"],["x:Http/get",{"ids":["singleton"],"properties":["useXForwarded"]},"h"],["x:AllowedIp/query",{},"aq"],["x:AllowedIp/get",{"#ids":{"resultOf":"aq","name":"x:AllowedIp/query","path":"/ids"},"properties":["address"]},"a"],["x:NetworkListener/query",{},"lq"],["x:NetworkListener/get",{"#ids":{"resultOf":"lq","name":"x:NetworkListener/query","path":"/ids"},"properties":["protocol","bind","tlsImplicit"]},"l"],["x:Certificate/query",{},"cq"],["x:Certificate/get",{"#ids":{"resultOf":"cq","name":"x:Certificate/query","path":"/ids"},"properties":["subjectAlternativeNames","notValidAfter"]},"c"]]')"
  case "$RESP_CODE" in
    200) ;;
    401 | 403)
      aviso "El motor rechaza la contraseña de administración de $ENV_FILE (STALWART_ADMIN_PASSWORD). No se reintenta."
      return 1
      ;;
    *)
      aviso "La gestión del motor no responde por la red interna (HTTP $RESP_CODE). Revisa: docker logs mailway-mail"
      return 1
      ;;
  esac
  if [ -n "$(jmap_error)" ]; then
    aviso "El motor rechazó la consulta de sus ajustes: $(jmap_error)."
    return 1
  fi
  nombre=$(campo_json '.methodResponses[0][1].list[0].defaultHostname // empty')
  if [ "$nombre" = "$MAIL_HOSTNAME" ]; then
    ok "Nombre del servidor: $MAIL_HOSTNAME."
  else
    aviso "El motor se identifica como «${nombre:-sin nombre}», no como $MAIL_HOSTNAME: faltan los ajustes de Mailway (sudo mailway update -y --reaplicar)."
    incidencias=$((incidencias + 1))
  fi
  if [ -n "$(campo_json --arg r "$INTERNAL_SUBNET" '(.methodResponses[3][1].list // [])[] | select(.address == $r) | .address')" ]; then
    ok "La red interna $INTERNAL_SUBNET está exenta del bloqueo automático."
  else
    aviso "Falta la exención de $INTERNAL_SUBNET: los fallos de contraseña del webmail acabarían bloqueándolo. Aplica los ajustes de Mailway (sudo mailway update -y --reaplicar)."
    incidencias=$((incidencias + 1))
  fi
  if [ "$(campo_json '.methodResponses[1][1].list[0].useXForwarded // false')" = true ]; then
    ok "El motor toma la IP real de X-Forwarded-For (detrás de Traefik)."
  else
    aviso "El motor no usa X-Forwarded-For: un escáner que pase por Traefik bloquearía la IP de Traefik. Aplica los ajustes de Mailway (sudo mailway update -y --reaplicar)."
    incidencias=$((incidencias + 1))
  fi
  if [ -n "$(campo_json '(.methodResponses[5][1].list // [])[] | select(.protocol == "smtp" and (.tlsImplicit | not) and ((.bind // {}) | keys | any(endswith(":587")))) | .protocol')" ]; then
    if puerto_abierto_motor mailway-mail 587; then
      ok "Envío por 587 con STARTTLS disponible."
    else
      aviso "El 587 está en los ajustes del motor, pero no escucha hasta reiniciarlo: docker restart mailway-mail"
      incidencias=$((incidencias + 1))
    fi
  else
    aviso "El motor no escucha en 587 (STARTTLS), que usan la API de envío, Skyway y los programas de correo. Aplica los ajustes de Mailway (sudo mailway update -y --reaplicar)."
    incidencias=$((incidencias + 1))
  fi
  # Un comodín (*.dominio) también cubre el nombre del servidor.
  certificado=$(campo_json --arg n "$MAIL_HOSTNAME" '(.methodResponses[0][1].list[0].defaultCertificateId // "") as $d | (.methodResponses[7][1].list // [])[] | select(.id == $d) | ((.subjectAlternativeNames // {}) | if type == "object" then keys else . end | any(. as $s | $s == $n or (($s | startswith("*.")) and ($s[2:] == ($n | sub("^[^.]+[.]"; "")))))) as $cubre | "\(if $cubre then "para \($n)" else "de otro nombre" end), válido hasta \(.notValidAfter)"')
  if [ -n "$certificado" ]; then
    info "Certificado: el de Traefik, que mantiene el extractor (perfil tls); $certificado."
  else
    aviso "El motor no tiene certificado por defecto y sirve uno autofirmado: lo pone el extractor del certificado (perfil tls; sección 5.2 de docs/DESPLIEGUE-SKYWAY.md)."
    if [ "$TOLERAR_CERTIFICADO" = 1 ]; then
      info "No impide la migración: la 0.15 tampoco servía un certificado válido."
    else
      incidencias=$((incidencias + 1))
    fi
  fi
  return "$incidencias"
}

# --comprobar: diagnóstico de solo lectura. Hace una sola petición
# autenticada a la API del motor: cada contraseña incorrecta cuenta para su
# bloqueo automático.
comprobar_instalacion() {
  local fallos=0 c estado extractor respuesta nombre contenedores=(mailway-mail mailway-webmail)
  if [ "$CON_SKYWAY" = 0 ]; then contenedores+=(mailway-panel); fi

  titulo "Contenedores"
  for c in "${contenedores[@]}"; do
    estado=$(estado_contenedor "$c")
    case "$estado" in
      healthy) ok "$c: en marcha y sano." ;;
      ausente)
        aviso "$c: no existe. Vuelve a ejecutar el instalador (sudo bash deploy/instalar.sh --actualizar)."
        fallos=$((fallos + 1))
        ;;
      *)
        aviso "$c: $estado. Revisa: docker logs $c"
        fallos=$((fallos + 1))
        ;;
    esac
  done
  extractor=$(estado_contenedor mailway-certs-dumper)
  if [ "$extractor" = ausente ]; then
    info "Extractor del certificado (perfil tls): no está en marcha; solo hace falta si el motor usa el certificado de Traefik."
  fi

  titulo "Motor de correo ($(nombre_motor "$MOTOR"))"
  case "$MOTOR:$(docker inspect --type container -f '{{.Config.Image}}' mailway-mail 2>/dev/null || true)" in
    "$MOTOR_016":*stalwart:v0.15* | "$MOTOR_015":*stalwart:v0.16*)
      aviso "deploy/.env dice $(nombre_motor "$MOTOR"), pero el contenedor mailway-mail ejecuta otra versión: repite sudo mailway update -y --reaplicar."
      fallos=$((fallos + 1))
      ;;
  esac
  if [ "$MOTOR" = "$MOTOR_015" ]; then aviso_fin_soporte_015; fi
  if [ "$MOTOR" = "$MOTOR_016" ]; then
    if [ "$(estado_contenedor mailway-mail)" = healthy ]; then
      comprobar_motor_016 || fallos=$((fallos + $?))
    else
      info "El motor no está sano: no se consulta su API."
    fi
  elif [ "$(estado_contenedor mailway-mail)" = healthy ]; then
    respuesta=$(motor_api GET "/api/settings/keys?keys=server.hostname,server.allowed-ip.$INTERNAL_SUBNET,acme.mailway.directory,certificate.mailway.cert,certificate.default.cert" 2>/dev/null || true)
    if ! printf '%s' "$respuesta" | grep -q '"data"'; then
      if printf '%s' "$respuesta" | grep -Eq '"status": *40[13]'; then
        aviso "El motor rechaza la contraseña de administración de $ENV_FILE (STALWART_ADMIN_PASSWORD). No se reintenta."
      else
        aviso "La API de gestión del motor no responde por la red interna. Revisa: docker logs mailway-mail"
      fi
      fallos=$((fallos + 1))
    else
      nombre=$(printf '%s' "$respuesta" | jqr -r '.data["server.hostname"] // empty' 2>/dev/null || true)
      if [ "$nombre" = "$MAIL_HOSTNAME" ]; then
        ok "Nombre del servidor: $MAIL_HOSTNAME."
      else
        aviso "El motor se identifica como «${nombre:-sin nombre}», no como $MAIL_HOSTNAME: aplica los ajustes recomendados (Ajustes → Servidor de correo)."
        fallos=$((fallos + 1))
      fi
      if printf '%s' "$respuesta" | grep -Fq "\"server.allowed-ip.$INTERNAL_SUBNET\""; then
        ok "La red interna $INTERNAL_SUBNET está exenta del bloqueo automático."
      else
        aviso "Falta la exención de $INTERNAL_SUBNET: los fallos de contraseña del webmail acabarían bloqueándolo. Aplica los ajustes recomendados."
        fallos=$((fallos + 1))
      fi
      if printf '%s' "$respuesta" | grep -q '"acme.mailway.directory"'; then
        info "Certificado: Let's Encrypt emitido por el propio motor (ACME)."
      elif printf '%s' "$respuesta" | grep -q '"certificate.mailway.cert"'; then
        info "Certificado: el de Traefik, que mantiene el extractor (perfil tls)."
      elif printf '%s' "$respuesta" | grep -q '"certificate.default.cert"'; then
        info "Certificado: configurado a mano en el motor."
      else
        aviso "El motor no tiene ningún certificado configurado y sirve uno autofirmado (sección 5 de docs/DESPLIEGUE-SKYWAY.md)."
        fallos=$((fallos + 1))
      fi
    fi
  else
    info "El motor no está sano: no se consulta su API."
  fi

  titulo "Certificado público de IMAP y SMTP"
  if [ "$(estado_contenedor mailway-webmail)" = healthy ]; then
    # Se verifica desde el webmail, por la red interna y con el nombre público
    # (SNI): es el mismo certificado que ven los programas de correo.
    if ! ejecutar_comprobacion docker exec -u www-data mailway-webmail php "$COMPROBAR_PHP" certificado "$MAIL_HOSTNAME"; then
      if [ "$TOLERAR_CERTIFICADO" = 1 ]; then
        info "No impide la migración: la 0.15 tampoco servía un certificado válido."
      else
        fallos=$((fallos + 1))
      fi
    fi
    titulo "Webmail"
    ejecutar_comprobacion docker exec -u www-data mailway-webmail php "$COMPROBAR_PHP" conexion ||
      fallos=$((fallos + 1))
    info "Inicio de sesión real con un buzón: sudo bash deploy/instalar.sh --probar-acceso"
  else
    info "Se comprueba desde el webmail, que no está en marcha."
  fi

  if [ "$extractor" != ausente ]; then
    titulo "Extractor del certificado (perfil tls)"
    if ! ejecutar_comprobacion docker exec mailway-certs-dumper python /app/extractor.py estado; then
      if [ "$TOLERAR_CERTIFICADO" = 1 ]; then
        info "No impide la migración: la 0.15 tampoco servía un certificado válido."
      else
        fallos=$((fallos + 1))
      fi
    fi
  fi

  titulo "Resultado"
  if [ "$fallos" = 0 ]; then
    ok "Todo correcto. Quedan fuera el DNS público, el PTR, los puertos vistos desde Internet y la entrega a otros servidores (sección 12.1 de docs/DESPLIEGUE-SKYWAY.md)."
    return 0
  fi
  aviso "$fallos comprobaciones con incidencias (detalle arriba)."
  return 1
}

# --probar-acceso: un inicio de sesión real desde el webmail, con la
# biblioteca IMAP de Roundcube, y la apertura de la bandeja de entrada.
probar_acceso() {
  titulo "Prueba de acceso a un buzón desde el webmail"
  if [ "$(estado_contenedor mailway-webmail)" != healthy ]; then
    fallo "El webmail (mailway-webmail) no está en marcha y sano. Revisa: sudo bash deploy/instalar.sh --comprobar"
  fi
  local correo="" clave="" salida codigo=0
  if [ -t 0 ]; then
    info "Se hace un único intento: cada contraseña incorrecta cuenta para el bloqueo automático del"
    info "motor. La contraseña no se muestra, no se guarda y no queda en el historial."
    read -r -p "   Dirección del buzón: " correo || true
    IFS= read -r -s -p "   Contraseña: " clave || true
    printf '\n'
  else
    # Sin terminal (p. ej. la CI): dirección y contraseña en dos líneas.
    IFS= read -r correo || true
    IFS= read -r clave || true
  fi
  correo=$(printf '%s' "$correo" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
  coincide "$correo" '^[^@[:space:][:cntrl:]]+@[a-z0-9.-]+\.[a-z0-9-]{2,}$' ||
    fallo "«$correo» no es una dirección de correo."
  [ -n "$clave" ] || fallo "No se ha indicado la contraseña."
  if tiene_control "$clave"; then
    clave=""
    fallo "La contraseña contiene caracteres de control."
  fi
  # La contraseña viaja por la entrada estándar del contenedor: printf es
  # interno de bash, así que no aparece en la lista de procesos ni en argumentos.
  salida=$(printf '%s\n%s\n' "$correo" "$clave" |
    docker exec -i -u www-data mailway-webmail php "$COMPROBAR_PHP" acceso 2>&1) || codigo=$?
  clave=""
  printf '%s\n' "$salida" | mostrar_resultado
  return "$codigo"
}

# ------------------------------------------------------------------ main --

main() {
  printf '%sInstalador de Mailway %s%s\n' "$C_TIT" "$VERSION_INSTALADOR" "$C_0"
  if [ "$MIGRAR_MOTOR" = 1 ]; then
    migrar_motor
    exit 0
  fi
  if [ "$REVERTIR_MOTOR" = 1 ]; then
    revertir_motor
    exit 0
  fi
  if [ "$RETIRAR_MOTOR_ANTERIOR" = 1 ]; then
    retirar_motor_anterior
    exit 0
  fi
  if [ "$EMPAREJAR" = 1 ]; then
    info "Emparejado del panel con Skyway (configuración de deploy/.env)."
    if emparejar_solo; then exit 0; fi
    exit 1
  fi
  if [ "$COMPROBAR" = 1 ] || [ "$PROBAR_ACCESO" = 1 ]; then
    preparar_diagnostico
    if [ "$CON_SKYWAY" = 1 ]; then info "Modo: junto a Skyway."; else info "Modo: instalación autónoma (sin Skyway)."; fi
    if [ "$COMPROBAR" = 1 ]; then
      if comprobar_instalacion; then exit 0; fi
    elif probar_acceso; then
      exit 0
    fi
    exit 1
  fi
  # La actualización mantiene el modo con el que se instaló. Los deploy/.env
  # anteriores a la 1.0 no lo guardan: solo la instalación autónoma tiene el
  # contenedor mailway-panel (con Skyway, el panel es skyway-<proyecto>-panel).
  if [ "$ACTUALIZAR" = 1 ]; then
    case "$(leer_env MAILWAY_INSTALACION)" in
      autonoma) CON_SKYWAY=0 ;;
      '') if docker inspect mailway-panel >/dev/null 2>&1; then CON_SKYWAY=0; fi ;;
    esac
  fi
  if [ "$CON_SKYWAY" = 1 ]; then info "Modo: junto a Skyway."; else info "Modo: instalación autónoma (sin Skyway)."; fi
  if [ "$ACTUALIZAR" = 1 ]; then info "Actualización: se reutiliza deploy/.env sin preguntas."; fi

  comprobaciones_previas
  detectar_panel_existente
  recoger_datos
  migrar_instalacion_anterior
  elegir_motor
  preparar_secretos

  USAR_PROXY_PROPIO=0
  if [ "$CON_SKYWAY" = 0 ]; then
    if puerto_ocupado_por_otro 80 || puerto_ocupado_por_otro 443; then
      aviso "Los puertos 80/443 están ocupados: no se levanta el Traefik propio."
    else
      USAR_PROXY_PROPIO=1
    fi
  fi

  PANEL_INTERNAL_URL=$(leer_env MAILWAY_PANEL_INTERNAL_URL)
  if ! coincide "$PANEL_INTERNAL_URL" '^http://[a-z0-9][a-z0-9_.-]*:[0-9]{1,5}$'; then PANEL_INTERNAL_URL=""; fi
  if [ "$CON_SKYWAY" = 0 ]; then PANEL_INTERNAL_URL="http://mailway-panel:4100"; fi
  if [ -z "$PANEL_INTERNAL_URL" ] && [ -n "$PANEL_EXISTENTE_CONTENEDOR" ]; then
    PANEL_INTERNAL_URL="http://$PANEL_EXISTENTE_CONTENEDOR:4100"
  fi
  # El nombre por defecto puede ser el de un cliente (un proyecto suyo con el
  # slug «mailway»): el webmail le mandaría las contraseñas que se cambian
  # hasta que desplegar_en_skyway lo corrija. Mientras, a ninguna parte.
  if [ -z "$PANEL_INTERNAL_URL" ] && [ "$CON_SKYWAY" = 1 ] && contenedor_de_cliente skyway-mailway-panel; then
    PANEL_INTERNAL_URL="http://panel-pendiente.invalid:4100"
  fi
  PANEL_INTERNAL_URL=${PANEL_INTERNAL_URL:-http://skyway-mailway-panel:4100}

  escribir_env
  configurar_cloudflare
  esperar_dns
  comprobar_ptr
  levantar_servicios
  configurar_motor
  if [ "$CON_SKYWAY" = 0 ]; then
    if [ "$MOTOR" = "$MOTOR_016" ]; then aplicar_ajustes_mailway mailway-panel; fi
    conectar_cloudflare_autonoma
  fi

  if [ "$CON_SKYWAY" = 1 ]; then
    desplegar_en_skyway
    # El complemento de contraseña del webmail llama al panel por dentro.
    if [ -n "$PANEL_CONTENEDOR" ] && [ "http://$PANEL_CONTENEDOR:4100" != "$PANEL_INTERNAL_URL" ]; then
      PANEL_INTERNAL_URL="http://$PANEL_CONTENEDOR:4100"
      escribir_env
      compose_q up -d mailway-webmail
      ok "Webmail enlazado con el panel ($PANEL_INTERNAL_URL)."
    fi
    configurar_proveedor_traefik
    # Lo último que puede fallar: así la contraseña del administrador que
    # crea el emparejado llega al resumen sin que nada la interrumpa.
    emparejar_al_terminar
    # Con Stalwart 0.16, los ajustes de Mailway en el motor los aplica el
    # panel con su herramienta del motor, que necesita la puesta en marcha
    # del panel: la hace el emparejado. Nunca interrumpe la instalación.
    if [ "$MOTOR" = "$MOTOR_016" ]; then aplicar_ajustes_mailway "${PANEL_CONTENEDOR:-$(contenedor_panel_conocido)}"; fi
    conectar_cloudflare_junto_a_skyway
    conectar_cloudflare_en_skyway
    revocar_token_temporal_skyway
  fi

  # Orden «mailway» (update, comprobar…) en el PATH para las próximas veces.
  bash "$DEPLOY_DIR/mailway.sh" instalar-comando || true

  resumen
}

main
