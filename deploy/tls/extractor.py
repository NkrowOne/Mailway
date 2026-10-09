#!/usr/bin/env python3
"""Extractor del certificado de IMAP/SMTP del motor de Mailway (perfil «tls»).

Sustituye al volcado de traefik-certs-dumper, que copiaba al volumen del motor
las claves privadas de TODOS los dominios de Traefik (también las de las demás
webs de Skyway). Este servicio:

  1. lee el acme.json de Traefik en solo lectura;
  2. elige para MAIL_HOSTNAME el certificado exacto o comodín con la caducidad
     más lejana (el par que ya está en el volumen también compite, así nunca
     se cambia uno vigente por otro que caduca antes);
  3. lo valida en local ANTES de escribir nada: vigente, válido para
     MAIL_HOSTNAME y con la clave privada que corresponde al certificado;
  4. escribe solo ese par, de forma atómica, donde lo lee el motor:
     <volumen>/<MAIL_HOSTNAME>/cert.pem y key.pem;
  5. si cambió, pide al motor que recargue sus certificados, comprueba el que
     sirve en 993 y 465 y, si no es el nuevo, vuelve al par anterior.

Sirve para las dos API de gestión de Stalwart y en cada pasada detecta cuál
tiene delante (GET /jmap/session autenticado: solo la sesión de 0.16 anuncia
urn:stalwart:jmap), porque el motor puede migrarse con el extractor en marcha.
Las credenciales son STALWART_ADMIN_USER y STALWART_ADMIN_PASSWORD: con 0.15,
las del administrador de respaldo; con 0.16, las de STALWART_RECOVERY_ADMIN.

  - Stalwart 0.15 (API REST en /api). El motor corre como root y lee el par
    por certificate.mailway (%{file:…}%), que configura deploy/instalar.sh;
    este servicio solo pide GET /api/reload/certificate. No hace nada si el
    motor obtiene su propio certificado por ACME (si conserva además
    certificate.mailway, solo mantiene esos ficheros al día, sin recargarlo).
  - Stalwart 0.16 (API JMAP en /jmap). Ya no existen las macros %{file:…}%:
    este servicio da de alta, si falta, un objeto Certificate de tipo File con
    las mismas rutas, lo deja como SystemSettings.defaultCertificateId (el que
    reciben los clientes sin SNI, como el webmail) y recarga con x:Action
    ReloadTlsCertificates. Aquí no hay atajo de ACME: Mailway usa el
    certificado de Traefik.

La imagen de 0.16 corre como el usuario stalwart (UID/GID 2000), no como root.
Con ese motor, las carpetas del par quedan root:<grupo del motor> 0750 y la
clave root:<grupo del motor> 0640: solo la leen root y el motor. root sigue
siendo el dueño de todo, así que rota, poda, vuelve atrás y relee el par sin
DAC_OVERRIDE ni FOWNER; asignar el grupo es lo único que exige una capacidad,
CHOWN. El grupo es MAILWAY_TLS_GID_MOTOR (2000 por defecto, el de la imagen
oficial). Con 0.15 todo vuelve a ser solo de root (0700 y 0600).

Ante un 401/403 de la API del motor no reintenta en bucle: cada contraseña
incorrecta cuenta para el bloqueo automático de Stalwart. Nunca registra
secretos: ni la contraseña, ni claves privadas, ni el contenido de acme.json o
de los ajustes del motor (los de ACME guardan, por ejemplo, el token de
Cloudflare).

Solo usa la biblioteca estándar de Python.

Uso:
  python extractor.py            servicio (bucle; es la orden del contenedor)
  python extractor.py salud      comprobación de salud del contenedor (0 = sano)
  python extractor.py estado     estado legible (lo usa instalar.sh --comprobar)
  python extractor.py purgar     retira del volumen todo lo que no es el par
                                 de MAIL_HOSTNAME (restos del volcado antiguo)
"""
from __future__ import annotations

import base64
import binascii
import errno
import hashlib
import http.client
import json
import os
import posixpath
import re
import secrets
import shutil
import socket
import ssl
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping, Optional, TextIO

# Identificador del certificado en el motor (certificate.<ID>.*): el mismo que
# configuran deploy/instalar.sh y la sección 5.2 de DESPLIEGUE-SKYWAY.md.
ID_CERTIFICADO = 'mailway'
# Carpeta propia dentro del volumen: versiones inmutables de cada par. El
# nombre del servidor es un enlace simbólico a una de ellas, y cambiar el
# enlace es atómico: el motor nunca ve el certificado de un par y la clave de
# otro.
PRIVADO = '.mailway-tls'
VERSION = re.compile(r'[0-9a-f]{24}')
# Extensiones de lo que escribía el volcado antiguo (y cualquier volcado de
# certificados): solo eso se retira del volumen; lo demás no se toca.
EXTENSIONES_VOLCADO = ('.pem', '.crt', '.key', '.cer')
MAX_RESPUESTA = 1 << 20
TIPOS_CLAVE = ('PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY')
# Versiones de la API de gestión del motor.
MOTOR_015 = '0.15'   # REST en /api
MOTOR_016 = '0.16'   # JMAP en /jmap
# Capacidad JMAP de los objetos de gestión: solo la anuncia 0.16.
CAPACIDAD_016 = 'urn:stalwart:jmap'
USO_JMAP = ['urn:ietf:params:jmap:core', CAPACIDAD_016]
# Grupo con el que corre la imagen oficial de 0.16 (usuario stalwart, 2000:2000).
GID_MOTOR_016 = 2000
# Id JMAP (RFC 8620, 1.2): solo estos se aceptan del motor; acaban en el registro.
_ID_JMAP = re.compile(r'[A-Za-z0-9_-]{1,255}')
_PEM = re.compile(rb'-----BEGIN ([A-Z0-9 ]+)-----\r?\n.*?\r?\n-----END \1-----', re.S)
_HOST = re.compile(r'(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?')


class ConfiguracionInvalida(Exception):
    """Falta o es incorrecta una variable de entorno."""


class ParNoValido(Exception):
    """El par certificado/clave no sirve para MAIL_HOSTNAME (el mensaje dice por qué)."""


class AcmeIlegible(Exception):
    """El acme.json de Traefik no existe o no se puede interpretar."""


class ErrorMotor(Exception):
    """La API del motor respondió algo inesperado (codigo: el estado HTTP, si lo hubo)."""

    def __init__(self, mensaje: str = '', codigo: Optional[int] = None):
        super().__init__(mensaje)
        self.codigo = codigo


class MotorNoDisponible(ErrorMotor):
    """No se pudo conectar con la API del motor."""


class ErrorAutenticacion(ErrorMotor):
    """La API del motor rechazó las credenciales (401) o el permiso (403)."""

    def __init__(self, codigo: int):
        super().__init__(f'HTTP {codigo}', codigo)


class CertificadoRechazado(ErrorMotor):
    """El motor 0.16 no admite el objeto Certificate o el certificado por defecto (el mensaje dice por qué)."""


# --------------------------------------------------------------- configuración


def normalizar_host(valor: str) -> str:
    host = (valor or '').strip().lower().rstrip('.')
    if not _HOST.fullmatch(host):
        raise ConfiguracionInvalida(f'MAIL_HOSTNAME no es un nombre de servidor válido: «{valor}».')
    return host


def _numero(entorno: Mapping[str, str], nombre: str, defecto: float, minimo: float) -> float:
    valor = entorno.get(nombre, '').strip()
    if not valor:
        return defecto
    try:
        numero = float(valor)
    except ValueError:
        raise ConfiguracionInvalida(f'{nombre} debe ser un número de segundos.') from None
    if numero < minimo:
        raise ConfiguracionInvalida(f'{nombre} debe valer al menos {minimo:g}.')
    return numero


@dataclass
class Configuracion:
    host: str
    acme_json: Path
    salida: Path
    ruta_motor: str
    url_motor: str
    usuario: str
    clave: str = field(repr=False)
    destino_tls: str
    puertos: tuple
    ca_pruebas: Optional[str]
    intervalo: float
    comprobacion: float
    espera_auth: float
    espera_rechazo: float
    fichero_estado: Path
    # Grupo con el que corre el motor 0.16: el único, además de root, que lee la clave.
    gid_motor: int = GID_MOTOR_016

    @classmethod
    def desde_entorno(cls, entorno: Mapping[str, str], con_clave: bool = True) -> 'Configuracion':
        host = normalizar_host(entorno.get('MAIL_HOSTNAME', ''))
        url = entorno.get('STALWART_URL', 'http://mailway-mail:8080').strip().rstrip('/')
        partes = urllib.parse.urlsplit(url)
        if partes.scheme not in ('http', 'https') or not partes.hostname:
            raise ConfiguracionInvalida('STALWART_URL debe ser una URL http(s):// de la API del motor.')
        clave = ''
        if con_clave:
            fichero = entorno.get('STALWART_ADMIN_PASSWORD_FILE', '').strip()
            try:
                clave = Path(fichero).read_text().strip() if fichero else entorno.get('STALWART_ADMIN_PASSWORD', '')
            except OSError:
                raise ConfiguracionInvalida('No se puede leer STALWART_ADMIN_PASSWORD_FILE.') from None
            if not clave:
                raise ConfiguracionInvalida(
                    'Falta STALWART_ADMIN_PASSWORD: la contraseña vigente del administrador del motor.')
        try:
            puertos = tuple(int(p) for p in entorno.get('MAILWAY_TLS_PUERTOS', '993,465').split(',') if p.strip())
        except ValueError:
            raise ConfiguracionInvalida('MAILWAY_TLS_PUERTOS debe ser una lista de puertos (p. ej. 993,465).') from None
        if not puertos or any(not 0 < p < 65536 for p in puertos):
            raise ConfiguracionInvalida('MAILWAY_TLS_PUERTOS debe ser una lista de puertos (p. ej. 993,465).')
        try:
            gid_motor = int(entorno.get('MAILWAY_TLS_GID_MOTOR', '').strip() or GID_MOTOR_016)
        except ValueError:
            gid_motor = -1
        # (2^32 - 1 es el «sin cambio» de chown: no es un grupo.)
        if not 0 <= gid_motor < 0xFFFFFFFF:
            raise ConfiguracionInvalida(
                'MAILWAY_TLS_GID_MOTOR debe ser el número del grupo con el que corre el motor (2000 en la imagen '
                'oficial de Stalwart 0.16).')
        return cls(
            host=host,
            acme_json=Path(entorno.get('MAILWAY_ACME_JSON', '/traefik/acme.json')),
            salida=Path(entorno.get('MAILWAY_TLS_SALIDA', '/output')),
            ruta_motor=entorno.get('MAILWAY_TLS_RUTA_MOTOR', '/opt/stalwart/certs').rstrip('/'),
            url_motor=url,
            usuario=entorno.get('STALWART_ADMIN_USER', 'admin') or 'admin',
            clave=clave,
            destino_tls=entorno.get('MAILWAY_TLS_DESTINO', '').strip() or partes.hostname,
            puertos=puertos,
            # Solo para pruebas: CA de laboratorio con la que verificar lo que
            # sirve el motor. En producción se usan las del sistema.
            ca_pruebas=entorno.get('MAILWAY_TLS_CA_FILE', '').strip() or None,
            intervalo=_numero(entorno, 'MAILWAY_TLS_INTERVALO', 30, 1),
            comprobacion=_numero(entorno, 'MAILWAY_TLS_COMPROBACION', 600, 1),
            espera_auth=_numero(entorno, 'MAILWAY_TLS_ESPERA_AUTH', 3600, 1),
            espera_rechazo=_numero(entorno, 'MAILWAY_TLS_ESPERA_RECHAZO', 21600, 1),
            fichero_estado=Path(entorno.get('MAILWAY_TLS_ESTADO', '/tmp/mailway-tls/estado.json')),
            gid_motor=gid_motor,
        )


# ------------------------------------------------------------ certificados


def bloques_pem(datos: bytes) -> list:
    """Bloques PEM (tipo, texto) en el orden en que aparecen."""
    return [(m.group(1).decode('ascii'), m.group(0)) for m in _PEM.finditer(datos)]


def normalizar_par(cert: bytes, clave: bytes) -> tuple:
    """Deja solo la cadena de certificados y la clave privada.

    El motor lee la clave con el primer bloque PEM del fichero: si hubiera
    otro antes (p. ej. «EC PARAMETERS»), la rechazaría aunque la validación
    local hubiera pasado. Así se escribe exactamente lo que se ha validado.
    """
    certificados = [b for tipo, b in bloques_pem(cert) if tipo == 'CERTIFICATE']
    if not certificados:
        raise ParNoValido('no contiene ningún certificado PEM')
    claves = [(tipo, b) for tipo, b in bloques_pem(clave) if tipo.endswith('PRIVATE KEY')]
    if not claves:
        raise ParNoValido('no contiene ninguna clave privada PEM')
    tipo, bloque = claves[0]
    if tipo not in TIPOS_CLAVE or b'ENCRYPTED' in bloque:
        raise ParNoValido('la clave privada está cifrada o tiene un formato que el motor no admite')

    def limpio(b: bytes) -> bytes:
        return b.replace(b'\r\n', b'\n').strip() + b'\n'

    return b''.join(limpio(c) for c in certificados), limpio(bloque)


def version_de(cert: bytes, clave: bytes) -> str:
    return hashlib.sha256(cert + b'\0' + clave).hexdigest()[:24]


def huella_de(cert: bytes) -> str:
    """SHA-256 del certificado final (DER): lo que se compara con lo servido."""
    hoja = bloques_pem(cert)[0][1].decode('ascii')
    return hashlib.sha256(ssl.PEM_cert_to_DER_cert(hoja)).hexdigest()


def _nombre_emisor(emisor) -> str:
    campos = {}
    for rdn in emisor or ():
        for clave, valor in rdn:
            campos.setdefault(clave, valor)
    partes = [campos.get('organizationName'), campos.get('commonName')]
    return ' '.join(p for p in partes if p) or 'desconocido'


def _apreton_en_memoria(servidor: ssl.SSLContext, cliente: ssl.SSLContext, host: str) -> dict:
    """Negociación TLS completa entre dos contextos, sin red."""
    c_entrada, c_salida = ssl.MemoryBIO(), ssl.MemoryBIO()
    s_entrada, s_salida = ssl.MemoryBIO(), ssl.MemoryBIO()
    lado_cliente = cliente.wrap_bio(c_entrada, c_salida, server_hostname=host)
    lado_servidor = servidor.wrap_bio(s_entrada, s_salida, server_side=True)
    hecho_cliente = hecho_servidor = False
    for _ in range(50):
        if not hecho_cliente:
            try:
                lado_cliente.do_handshake()
                hecho_cliente = True
            except ssl.SSLWantReadError:
                pass
        s_entrada.write(c_salida.read())
        if not hecho_servidor:
            try:
                lado_servidor.do_handshake()
                hecho_servidor = True
            except ssl.SSLWantReadError:
                pass
        c_entrada.write(s_salida.read())
        if hecho_cliente and hecho_servidor:
            return lado_cliente.getpeercert()
    raise ParNoValido('la prueba TLS local no terminó')


@dataclass
class Candidato:
    cert: bytes = field(repr=False)
    clave: bytes = field(repr=False)
    huella: str
    caduca: float
    emisor: str
    comodin: bool
    origen: str

    @property
    def version(self) -> str:
        return version_de(self.cert, self.clave)

    def describir(self, ahora: Optional[float] = None) -> str:
        ahora = time.time() if ahora is None else ahora
        dias = int((self.caduca - ahora) // 86400)
        fecha = time.strftime('%Y-%m-%d', time.gmtime(self.caduca))
        tipo = 'comodín, ' if self.comodin else ''
        return f'{tipo}emisor {self.emisor}, caduca el {fecha}, dentro de {dias} {"día" if dias == 1 else "días"}'

    def resumen(self) -> dict:
        return {
            'huella': self.huella[:16],
            'caduca': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(self.caduca)),
            'emisor': self.emisor,
            'comodin': self.comodin,
        }


def validar_par(cert: bytes, clave: bytes, host: str, origen: str = '') -> Candidato:
    """Valida el par en local con OpenSSL, sin red y antes de escribir nada.

    Se carga el par en un contexto de servidor (OpenSSL comprueba que la clave
    corresponde al certificado) y se negocia TLS en memoria con un cliente que
    confía solo en ese certificado: así OpenSSL verifica también que está
    vigente y que vale para MAIL_HOSTNAME, con las mismas reglas de comodín
    que un programa de correo.
    """
    cert, clave = normalizar_par(cert, clave)
    hoja = bloques_pem(cert)[0][1].decode('ascii')
    temporal = tempfile.mkdtemp(prefix='par-')
    try:
        ruta_cert = os.path.join(temporal, 'cert.pem')
        ruta_clave = os.path.join(temporal, 'key.pem')
        _escribir_fichero(Path(ruta_cert), cert, 0o600)
        _escribir_fichero(Path(ruta_clave), clave, 0o600)
        servidor = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        try:
            # La contraseña ficticia evita que OpenSSL la pida por la terminal
            # si llegara una clave cifrada: la carga falla y el par se descarta.
            servidor.load_cert_chain(ruta_cert, ruta_clave, password=b'-')
        except ssl.SSLError as error:
            if 'KEY_VALUES_MISMATCH' in str(error):
                raise ParNoValido('la clave privada no corresponde al certificado') from None
            raise ParNoValido(f'OpenSSL no puede cargar el par ({error.reason or "error"})') from None
    finally:
        shutil.rmtree(temporal, ignore_errors=True)
    cliente = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    cliente.load_verify_locations(cadata=hoja)
    cliente.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
    try:
        datos = _apreton_en_memoria(servidor, cliente, host)
    except ssl.SSLCertVerificationError as error:
        motivos = {
            9: 'aún no es válido',
            10: 'ha caducado',
            62: f'no es válido para {host}',
        }
        raise ParNoValido(motivos.get(error.verify_code, error.verify_message or 'no es válido')) from None
    except ssl.SSLError as error:
        raise ParNoValido(f'la prueba TLS local falló ({error.reason or "error"})') from None
    exactos = [valor.lower() for tipo, valor in datos.get('subjectAltName', ()) if tipo == 'DNS']
    return Candidato(
        cert=cert,
        clave=clave,
        huella=huella_de(cert),
        caduca=ssl.cert_time_to_seconds(datos['notAfter']),
        emisor=_nombre_emisor(datos.get('issuer')),
        comodin=host not in exactos,
        origen=origen,
    )


def cubre(nombre: str, host: str) -> bool:
    """¿Sirve un certificado emitido para «nombre» al servidor «host»?"""
    nombre = nombre.strip().lower().rstrip('.')
    if nombre == host:
        return True
    return nombre.startswith('*.') and '.' in host and host.split('.', 1)[1] == nombre[2:]


def leer_acme(ruta: Path) -> list:
    """Entradas (resolutor, certificado) del acme.json de Traefik v2/v3."""
    try:
        datos = json.loads(ruta.read_bytes())
    except FileNotFoundError:
        raise AcmeIlegible(f'No existe {ruta}: ¿está montado el volumen de certificados de Traefik?') from None
    except (OSError, ValueError):
        # Traefik reescribe el fichero entero: una lectura a medias se repite
        # en la siguiente pasada, nunca se sustituye un par que funciona.
        raise AcmeIlegible(f'No se puede interpretar {ruta} (¿se está escribiendo?).') from None
    if not isinstance(datos, dict):
        raise AcmeIlegible(f'{ruta} no tiene el formato de Traefik.')
    entradas = []
    for resolutor, contenido in datos.items():
        if not isinstance(contenido, dict):
            continue
        for item in contenido.get('Certificates') or []:
            if isinstance(item, dict):
                entradas.append((str(resolutor), item))
    return entradas


def _nombres_acme(item: dict) -> list:
    dominio = item.get('domain') if isinstance(item.get('domain'), dict) else {}
    nombres = [dominio.get('main'), *(dominio.get('sans') or [])]
    return [n.strip().lower().rstrip('.') for n in nombres if isinstance(n, str) and n.strip()]


def candidatos_acme(ruta: Path, host: str) -> tuple:
    """Certificados válidos para el servidor y motivos de los descartados.

    Las entradas de otros dominios se ignoran sin decodificar siquiera su
    clave: este servicio no debe tocar las claves de las demás webs.
    """
    validos, descartes = [], []
    for resolutor, item in leer_acme(ruta):
        nombres = _nombres_acme(item)
        if not any(cubre(n, host) for n in nombres):
            continue
        origen = f'resolutor «{resolutor}» ({nombres[0]})'
        try:
            cert = base64.b64decode(item.get('certificate') or '', validate=True)
            clave = base64.b64decode(item.get('key') or '', validate=True)
            validos.append(validar_par(cert, clave, host, origen))
        except (binascii.Error, ValueError, TypeError):
            descartes.append(f'{origen}: el contenido no es base64 válido')
        except ParNoValido as motivo:
            descartes.append(f'{origen}: {motivo}')
    return validos, descartes


def elegir(candidatos: list) -> Optional[Candidato]:
    """El de caducidad más lejana; a igualdad, el exacto antes que el comodín."""
    if not candidatos:
        return None
    return max(candidatos, key=lambda c: (c.caduca, not c.comodin, c.version))


# ---------------------------------------------------------------- ficheros


def _escribir_fichero(ruta: Path, datos: bytes, modo: int) -> None:
    descriptor = os.open(ruta, os.O_WRONLY | os.O_CREAT | os.O_EXCL, modo)
    with os.fdopen(descriptor, 'wb') as fichero:
        fichero.write(datos)
        fichero.flush()
        os.fsync(fichero.fileno())
    os.chmod(ruta, modo)


def _fsync_dir(ruta: Path) -> None:
    descriptor = os.open(ruta, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _retirar(ruta: Path) -> None:
    """Borra un fichero, un enlace (nunca su destino) o una carpeta."""
    if ruta.is_dir() and not ruta.is_symlink():
        shutil.rmtree(ruta)
    else:
        ruta.unlink()


def _cambiar_grupo(ruta: Path, gid: int) -> None:
    """Cambia solo el grupo (sin seguir enlaces). A otro grupo que el propio exige CAP_CHOWN."""
    os.chown(ruta, -1, gid, follow_symlinks=False)


class Volumen:
    """Volumen de certificados del motor: él lo monta en /opt/stalwart/certs y este servicio en /output.

    Estructura:
      .mailway-tls/<versión>/cert.pem   cadena de certificados (0644)
      .mailway-tls/<versión>/key.pem    clave privada
      <MAIL_HOSTNAME> -> .mailway-tls/<versión>   (enlace relativo)

    La ruta que lee el motor (<MAIL_HOSTNAME>/cert.pem y key.pem) es la misma
    que escribía el volcado antiguo: las instalaciones existentes no tienen
    que cambiar la configuración del motor.

    Permisos (gid = grupo con el que corre el motor):
      gid None (0.15, el motor es root)   carpetas 0700 y clave 0600, de root
      gid N    (0.16, usuario stalwart)   carpetas y clave de root:N, 0750 y
                                          0640: solo root y el motor leen la clave
    root es siempre el dueño: escribe, poda y relee sin DAC_OVERRIDE ni FOWNER,
    y solo necesita CAP_CHOWN para dar el grupo al motor.
    """

    def __init__(self, base: Path, host: str, gid: Optional[int] = None,
                 cambiar_grupo: Optional[Callable[[Path, int], None]] = None):
        self.base = base
        self.host = host
        self.privado = base / PRIVADO
        self.enlace = base / host
        self.gid = gid
        # Inyectable en las pruebas: sin ser root no se puede dar un grupo cualquiera.
        self._cambiar_grupo = cambiar_grupo or _cambiar_grupo

    @property
    def modo_carpeta(self) -> int:
        return 0o700 if self.gid is None else 0o750

    @property
    def modo_clave(self) -> int:
        return 0o600 if self.gid is None else 0o640

    def gid_actual(self) -> Optional[int]:
        """Grupo para el que quedó preparado el volumen (None: solo root, como con 0.15)."""
        try:
            datos = os.lstat(self.privado)
        except OSError:
            return None
        if stat.S_ISDIR(datos.st_mode) and stat.S_IMODE(datos.st_mode) & 0o050 == 0o050:
            return datos.st_gid
        return None

    def _ajustar(self, ruta: Path, modo: int) -> None:
        """Deja «ruta» con el modo y el grupo que tocan sin abrirla de más en ningún momento.

        Hacia el motor 0.16 se cambia primero el grupo y después el modo: la
        clave no es legible por el grupo hasta que el grupo es el del motor. De
        vuelta a 0.15, al revés: primero se cierra el modo y después se
        devuelve el grupo (si falta CHOWN, ese grupo se queda ya sin permisos).
        """
        datos = os.lstat(ruta)
        if self.gid is not None:
            if datos.st_gid != self.gid:
                self._cambiar_grupo(ruta, self.gid)
            if stat.S_IMODE(datos.st_mode) != modo:
                os.chmod(ruta, modo)
            return
        if stat.S_IMODE(datos.st_mode) != modo:
            os.chmod(ruta, modo)
        if datos.st_gid != os.getegid():
            try:
                self._cambiar_grupo(ruta, os.getegid())
            except PermissionError:
                pass

    def _ajustar_version(self, carpeta: Path) -> None:
        # La clave antes que su carpeta: al abrir la carpeta al grupo del
        # motor, la clave ya tiene su grupo y su modo definitivos.
        clave = carpeta / 'key.pem'
        if clave.is_file() and not clave.is_symlink():
            self._ajustar(clave, self.modo_clave)
        self._ajustar(carpeta, self.modo_carpeta)

    def preparar(self) -> None:
        """Crea la carpeta privada y deja todo con los permisos del motor actual.

        Se llama en cada pasada: al migrar el motor de 0.15 a 0.16 (o al
        volver), los pares que ya están en el volumen cambian de permisos sin
        tener que reescribirlos.
        """
        if not self.base.is_dir():
            raise OSError(f'No existe {self.base}: ¿está montado el volumen de certificados del motor?')
        self.privado.mkdir(mode=0o700, exist_ok=True)
        # Primero la carpeta privada: al cerrarla (0.15) se cierra todo a la
        # vez y, al abrirla (0.16), cada versión sigue cerrada hasta ajustarla.
        self._ajustar(self.privado, self.modo_carpeta)
        for entrada in self.privado.iterdir():
            # Restos de una escritura interrumpida (nunca los usa el motor).
            if entrada.name.startswith('.tmp-'):
                _retirar(entrada)
            elif VERSION.fullmatch(entrada.name) and entrada.is_dir() and not entrada.is_symlink():
                self._ajustar_version(entrada)
        for entrada in self.base.iterdir():
            if entrada.name.startswith(f'.{self.host}.') and entrada.name.endswith('.tmp'):
                _retirar(entrada)

    def es_heredado(self) -> bool:
        """¿Queda la carpeta que escribía el volcado antiguo en lugar del enlace?"""
        return self.enlace.is_dir() and not self.enlace.is_symlink()

    def version_actual(self) -> Optional[str]:
        if not self.enlace.is_symlink():
            return None
        destino = os.readlink(self.enlace)
        nombre = destino.rsplit('/', 1)[-1]
        if destino == f'{PRIVADO}/{nombre}' and VERSION.fullmatch(nombre) and (self.privado / nombre).is_dir():
            return nombre
        return None

    def leer(self, version: Optional[str] = None) -> Optional[tuple]:
        """Par de una versión, o el que ve hoy el motor (también el heredado)."""
        carpeta = self.privado / version if version else self.enlace
        try:
            return (carpeta / 'cert.pem').read_bytes(), (carpeta / 'key.pem').read_bytes()
        except OSError:
            return None

    def _escribir_version(self, version: str, cert: bytes, clave: bytes) -> None:
        temporal = Path(tempfile.mkdtemp(prefix='.tmp-', dir=self.privado))
        try:
            _escribir_fichero(temporal / 'cert.pem', cert, 0o644)
            # La clave nace solo de root y pasa después al grupo del motor (si
            # lo hay). Todo se hace dentro de la carpeta temporal, de root y
            # 0700, antes de abrirla: el motor nunca ve una versión a medias.
            _escribir_fichero(temporal / 'key.pem', clave, 0o600)
            self._ajustar(temporal / 'key.pem', self.modo_clave)
            os.chmod(temporal, 0o700)
            self._ajustar(temporal, self.modo_carpeta)
            _fsync_dir(temporal)
            os.rename(temporal, self.privado / version)
        except BaseException:
            shutil.rmtree(temporal, ignore_errors=True)
            raise
        _fsync_dir(self.privado)

    def _apuntar(self, version: str) -> None:
        temporal = self.base / f'.{self.host}.{secrets.token_hex(4)}.tmp'
        os.symlink(f'{PRIVADO}/{version}', temporal)
        try:
            os.replace(temporal, self.enlace)
        except BaseException:
            temporal.unlink()
            raise
        _fsync_dir(self.base)

    def instalar(self, candidato: Candidato) -> Optional[str]:
        """Escribe el par y apunta a él. Devuelve la versión anterior, si la hay."""
        self.preparar()
        version = candidato.version
        if not (self.privado / version).is_dir():
            self._escribir_version(version, candidato.cert, candidato.clave)
        anterior = self.version_actual()
        apartado = None
        if self.es_heredado():
            # Se guarda el par del volcado antiguo como versión propia (con
            # permisos correctos) para poder volver a él, y se aparta la
            # carpeta: rename() no puede sustituir una carpeta por un enlace.
            par = self.leer()
            anterior = None
            if par:
                try:
                    cert, clave = normalizar_par(*par)
                    anterior = version_de(cert, clave)
                    if not (self.privado / anterior).is_dir():
                        self._escribir_version(anterior, cert, clave)
                except ParNoValido:
                    anterior = None
            apartado = self.privado / f'.tmp-heredado-{secrets.token_hex(4)}'
            os.rename(self.enlace, apartado)
        try:
            self._apuntar(version)
        except BaseException:
            if apartado is not None:
                os.rename(apartado, self.enlace)
            raise
        if apartado is not None:
            shutil.rmtree(apartado, ignore_errors=True)
        conservar = {version} | ({anterior} if anterior and anterior != version else set())
        self.podar(conservar)
        return anterior if anterior != version else None

    def volver(self, version: str) -> None:
        self._apuntar(version)

    def podar(self, conservar: set) -> None:
        for entrada in self.privado.iterdir():
            if entrada.name not in conservar and not entrada.name.startswith('.tmp-'):
                _retirar(entrada)

    def purgar_ajenos(self) -> tuple:
        """Retira del volumen lo que no es el par del servidor.

        El volcado antiguo dejaba aquí una carpeta por dominio de Traefik con su
        clave privada. Solo se borra lo que tiene esa forma (ficheros PEM, CRT,
        KEY o CER, sueltos o en una carpeta sin subcarpetas); cualquier otra
        cosa se deja y se informa.
        """
        retirados, desconocidos = 0, []
        if not self.base.is_dir():
            return retirados, desconocidos
        for entrada in sorted(self.base.iterdir()):
            if entrada.name in (PRIVADO, self.host, 'lost+found'):
                continue
            if self._parece_volcado(entrada):
                _retirar(entrada)
                retirados += 1
            else:
                desconocidos.append(entrada.name)
        return retirados, desconocidos

    @staticmethod
    def _parece_volcado(entrada: Path) -> bool:
        if entrada.is_symlink():
            return True
        if entrada.is_file():
            return entrada.suffix.lower() in EXTENSIONES_VOLCADO
        if entrada.is_dir():
            try:
                hijos = list(entrada.iterdir())
            except OSError:
                return False
            return bool(hijos) and all(
                h.is_file() and not h.is_symlink() and h.suffix.lower() in EXTENSIONES_VOLCADO for h in hijos)
        return False


# ------------------------------------------------------------------- motor


class _SinRedireccion(urllib.request.HTTPRedirectHandler):
    """Una redirección termina en error: la credencial nunca viaja a otro destino."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N802 (API de urllib)
        return None


@dataclass
class AjustesMotor:
    referencia: bool        # certificate.mailway apunta a los ficheros de este servicio
    referencia_otra: bool   # certificate.mailway existe, pero apunta a otros ficheros
    acme: bool              # el motor emite su propio certificado para MAIL_HOSTNAME


def _texto_corto(valor: object, limite: int = 160) -> str:
    texto = re.sub(r'-----BEGIN[^-]*-----.*?(-----END[^-]*-----|$)', '[…]', str(valor), flags=re.S)
    texto = re.sub(r'[A-Za-z0-9+/=_-]{40,}', '[…]', texto)
    texto = ' '.join(texto.split())
    return texto if len(texto) <= limite else texto[: limite - 1] + '…'


def acme_cubre(ajustes: Mapping[str, object], host: str) -> bool:
    """¿Hay en el motor un proveedor ACME cuyo dominio cubre al servidor?"""
    for clave in ajustes:
        encontrado = re.fullmatch(r'acme\.([^.]+)\.directory', clave)
        if not encontrado:
            continue
        prefijo = f'acme.{encontrado.group(1)}.domains'
        for nombre, valor in ajustes.items():
            if (nombre == prefijo or nombre.startswith(prefijo + '.')) and isinstance(valor, str) and cubre(valor, host):
                return True
    return False


def _anuncia_016(sesion: Mapping[str, object]) -> bool:
    """¿Anuncia la sesión JMAP la capacidad de gestión de 0.16?

    Va en primaryAccounts y en las capacidades de la cuenta, no en las
    generales de la sesión (comprobado con el motor 0.16.25 real).
    """
    listas = [sesion.get('capabilities'), sesion.get('primaryAccounts')]
    cuentas = sesion.get('accounts')
    if isinstance(cuentas, dict):
        listas += [c.get('accountCapabilities') for c in cuentas.values() if isinstance(c, dict)]
    return any(isinstance(lista, dict) and CAPACIDAD_016 in lista for lista in listas)


class _ClienteMotor:
    """Peticiones autenticadas a la API de gestión del motor, sin proxies ni redirecciones."""

    def __init__(self, url: str, usuario: str, clave: str, espera: float = 15.0):
        self.url = url.rstrip('/')
        self._autorizacion = 'Basic ' + base64.b64encode(f'{usuario}:{clave}'.encode()).decode()
        # Sin proxies del entorno: la credencial solo va a la red interna.
        self._abridor = urllib.request.build_opener(urllib.request.ProxyHandler({}), _SinRedireccion())
        self.espera = espera

    def _json(self, ruta: str, cuerpo: object = None) -> object:
        """GET de «ruta» o, con cuerpo, POST en JSON. Devuelve el JSON de la respuesta."""
        cabeceras = {'Authorization': self._autorizacion, 'Accept': 'application/json'}
        datos = None
        if cuerpo is not None:
            datos = json.dumps(cuerpo).encode()
            # 0.16 rechaza las peticiones JMAP sin este tipo (desde 0.16.10).
            cabeceras['Content-Type'] = 'application/json'
        peticion = urllib.request.Request(self.url + ruta, data=datos, headers=cabeceras)
        try:
            with self._abridor.open(peticion, timeout=self.espera) as respuesta:
                contenido = respuesta.read(MAX_RESPUESTA + 1)
        except urllib.error.HTTPError as error:
            codigo = error.code
            try:
                error.close()
            except Exception:  # noqa: BLE001 — solo se libera la conexión
                pass
            if codigo in (401, 403):
                raise ErrorAutenticacion(codigo) from None
            raise ErrorMotor(f'la API respondió HTTP {codigo}', codigo) from None
        except (urllib.error.URLError, OSError, http.client.HTTPException) as error:
            motivo = getattr(error, 'reason', error)
            raise MotorNoDisponible(f'sin conexión con {self.url}: {type(motivo).__name__}') from None
        if len(contenido) > MAX_RESPUESTA:
            raise ErrorMotor('respuesta demasiado grande')
        try:
            return json.loads(contenido)
        except ValueError:
            raise ErrorMotor('la API no devolvió JSON') from None

    def detectar(self) -> str:
        """API de gestión del motor: MOTOR_016 o MOTOR_015.

        Las dos versiones sirven GET /jmap/session (el JMAP del correo), y
        0.15.5 responde 200 también a su administrador de respaldo (comprobado
        con el motor real): lo que distingue a 0.16 es que la sesión
        autenticada anuncia urn:stalwart:jmap. Un 404 (sin JMAP) es 0.15.
        Va autenticada a propósito: con una contraseña incorrecta, este es el
        único intento (401) hasta que vence la espera larga.
        """
        try:
            sesion = self._json('/jmap/session')
        except ErrorMotor as error:
            if error.codigo == 404:
                return MOTOR_015
            raise
        if not isinstance(sesion, dict):
            raise ErrorMotor('respuesta inesperada de /jmap/session')
        return MOTOR_016 if _anuncia_016(sesion) else MOTOR_015


class Motor(_ClienteMotor):
    """Cliente mínimo de la API REST de gestión de Stalwart 0.15 (solo lecturas y recargas)."""

    def _pedir(self, ruta: str) -> object:
        datos = self._json(ruta)
        if isinstance(datos, dict) and 'data' in datos:
            return datos['data']
        # Stalwart 0.15 devuelve sus errores de gestión con HTTP 200 y
        # { "error": "<código>" }: el código es corto y no lleva valores.
        if isinstance(datos, dict) and isinstance(datos.get('error'), str):
            raise ErrorMotor(f'la API devolvió el error «{_texto_corto(datos["error"], 40)}»')
        raise ErrorMotor('respuesta inesperada de la API')

    def ajustes(self, host: str, ruta_motor: str) -> AjustesMotor:
        prefijo = f'certificate.{ID_CERTIFICADO}'
        datos = self._pedir(f'/api/settings/keys?keys={prefijo}.cert,{prefijo}.private-key&prefixes=acme')
        if not isinstance(datos, dict):
            raise ErrorMotor('respuesta inesperada al leer los ajustes')
        cert = datos.get(f'{prefijo}.cert')
        clave = datos.get(f'{prefijo}.private-key')
        esperado_cert = f'%{{file:{ruta_motor}/{host}/cert.pem}}%'
        esperado_clave = f'%{{file:{ruta_motor}/{host}/key.pem}}%'
        referencia = (isinstance(cert, str) and cert.strip() == esperado_cert
                      and isinstance(clave, str) and clave.strip() == esperado_clave)
        # Los ajustes de ACME guardan secretos (p. ej. el token de Cloudflare):
        # solo se mira qué dominios cubren y no se conservan ni se registran.
        acme = acme_cubre(datos, host)
        return AjustesMotor(referencia=referencia, referencia_otra=cert is not None and not referencia, acme=acme)

    def recargar(self) -> list:
        """GET /api/reload/certificate. Devuelve los errores del certificado propio."""
        datos = self._pedir('/api/reload/certificate')
        errores = datos.get('errors') if isinstance(datos, dict) else None
        if not isinstance(errores, dict):
            raise ErrorMotor('respuesta inesperada al recargar los certificados')
        propios = []
        for clave, valor in errores.items():
            if clave == f'certificate.{ID_CERTIFICADO}' or str(clave).startswith(f'certificate.{ID_CERTIFICADO}.'):
                detalle = valor.get('error') if isinstance(valor, dict) else valor
                propios.append(f'{clave}: {_texto_corto(detalle)}')
        return propios


@dataclass
class CertificadoMotor:
    """El objeto Certificate de este servicio en el motor 0.16."""
    id: str
    cambios: tuple = ()   # lo hecho en esta pasada: 'creado' y/o 'por_defecto'
    ajenos: tuple = ()    # otros Certificate que cubren el servidor y compiten por él


def _es_fichero(valor: object, ruta: str) -> bool:
    """¿Es un PublicText/SecretText de tipo File con esta ruta?"""
    return (isinstance(valor, dict) and valor.get('@type') == 'File' and isinstance(valor.get('filePath'), str)
            and posixpath.normpath(valor['filePath'].strip()) == posixpath.normpath(ruta))


def _error_de_objeto(error: object) -> str:
    """Motivo de un SetError, sin más datos que su descripción (lleva rutas, nunca contenido)."""
    if not isinstance(error, dict):
        return 'error desconocido'
    return _texto_corto(error.get('description') or error.get('type') or 'error desconocido')


class MotorJmap(_ClienteMotor):
    """Cliente mínimo de la API JMAP de gestión de Stalwart 0.16 (POST /jmap).

    Solo toca lo suyo: el Certificate de tipo File con las rutas de este
    servicio, SystemSettings.defaultCertificateId y la recarga de certificados.
    """

    def __init__(self, url: str, usuario: str, clave: str, espera: float = 15.0):
        super().__init__(url, usuario, clave, espera)
        # Primer error de la última recarga cuando es de OTRO objeto del motor.
        self.error_ajeno: Optional[str] = None

    def _llamar(self, llamadas: list) -> dict:
        datos = self._json('/jmap', {'using': USO_JMAP, 'methodCalls': llamadas})
        respuestas = datos.get('methodResponses') if isinstance(datos, dict) else None
        if not isinstance(respuestas, list):
            raise ErrorMotor('respuesta JMAP inesperada')
        resultado = {}
        for respuesta in respuestas:
            if (isinstance(respuesta, list) and len(respuesta) == 3 and isinstance(respuesta[0], str)
                    and isinstance(respuesta[1], dict) and isinstance(respuesta[2], str)):
                resultado.setdefault(respuesta[2], (respuesta[0], respuesta[1]))
        return resultado

    @staticmethod
    def _resultado(respuestas: dict, llamada: str) -> dict:
        """Argumentos de la respuesta a una llamada; los errores de método son excepciones (RFC 8620)."""
        nombre, argumentos = respuestas.get(llamada, (None, None))
        if nombre is None:
            raise ErrorMotor('respuesta JMAP incompleta')
        if nombre == 'error':
            tipo = argumentos.get('type')
            if tipo == 'forbidden':
                raise ErrorAutenticacion(403)
            raise ErrorMotor(f'la API devolvió el error JMAP «{_texto_corto(tipo, 40)}»')
        return argumentos

    @staticmethod
    def _comprobar_por_defecto(argumentos: dict) -> None:
        rechazo = (argumentos.get('notUpdated') or {}).get('singleton')
        if rechazo is not None:
            raise CertificadoRechazado('no se pudo fijar como certificado por defecto: ' + _error_de_objeto(rechazo))
        if 'singleton' not in (argumentos.get('updated') or {}):
            raise ErrorMotor('respuesta inesperada al fijar el certificado por defecto')

    def asegurar_certificado(self, host: str, ruta_cert: str, ruta_clave: str) -> CertificadoMotor:
        """Da de alta, si falta, el Certificate de tipo File con estas rutas y lo deja por defecto.

        Idempotente: con todo en su sitio es una sola petición de lectura. El
        motor lee el certificado al crear el objeto, así que los ficheros
        tienen que estar ya en el volumen y ser legibles por él. El certificado
        por defecto es el que reciben los clientes sin SNI o con un nombre que
        no está en ningún certificado (el webmail entra por «mailway-mail»).
        """
        respuestas = self._llamar([
            ['x:Certificate/get', {'ids': None, 'properties': ['certificate', 'privateKey',
                                                               'subjectAlternativeNames']}, 'c'],
            ['x:SystemSettings/get', {'ids': ['singleton'], 'properties': ['defaultCertificateId']}, 's'],
        ])
        lista = self._resultado(respuestas, 'c').get('list')
        sistema = self._resultado(respuestas, 's').get('list')
        if not isinstance(lista, list) or not isinstance(sistema, list):
            raise ErrorMotor('respuesta inesperada al leer los certificados del motor')
        certificados = [c for c in lista if isinstance(c, dict) and isinstance(c.get('id'), str)
                        and _ID_JMAP.fullmatch(c['id'])]
        propios = [c['id'] for c in certificados
                   if _es_fichero(c.get('certificate'), ruta_cert) and _es_fichero(c.get('privateKey'), ruta_clave)]
        ajenos = tuple(
            c['id'] for c in certificados
            if c['id'] not in propios and isinstance(c.get('subjectAlternativeNames'), dict)
            and any(cubre(n, host) for n in c['subjectAlternativeNames'] if isinstance(n, str)))
        por_defecto = sistema[0].get('defaultCertificateId') if sistema and isinstance(sistema[0], dict) else None
        if por_defecto in propios:
            return CertificadoMotor(por_defecto, (), ajenos)
        if propios:
            respuestas = self._llamar([['x:SystemSettings/set', {
                'update': {'singleton': {'defaultCertificateId': propios[0]}}}, 's']])
            self._comprobar_por_defecto(self._resultado(respuestas, 's'))
            return CertificadoMotor(propios[0], ('por_defecto',), ajenos)
        # Alta y certificado por defecto en la misma petición: «#mailway» es
        # el id que acaba de crear la llamada anterior.
        respuestas = self._llamar([
            ['x:Certificate/set', {'create': {'mailway': {
                'certificate': {'@type': 'File', 'filePath': ruta_cert},
                'privateKey': {'@type': 'File', 'filePath': ruta_clave}}}}, 'c'],
            ['x:SystemSettings/set', {'update': {'singleton': {'defaultCertificateId': '#mailway'}}}, 's'],
        ])
        alta = self._resultado(respuestas, 'c')
        rechazo = (alta.get('notCreated') or {}).get('mailway')
        if rechazo is not None:
            raise CertificadoRechazado(_error_de_objeto(rechazo))
        creado = (alta.get('created') or {}).get('mailway')
        ident = creado.get('id') if isinstance(creado, dict) else None
        if not isinstance(ident, str) or not _ID_JMAP.fullmatch(ident):
            raise ErrorMotor('respuesta inesperada al registrar el certificado')
        self._comprobar_por_defecto(self._resultado(respuestas, 's'))
        return CertificadoMotor(ident, ('creado', 'por_defecto'), ajenos)

    def recargar(self, id_propio: str) -> list:
        """x:Action ReloadTlsCertificates. Devuelve los errores del certificado propio.

        El motor solo informa del primer error de la recarga, con el objeto al
        que se refiere. Si es de otro objeto no cuenta (lo que decide es lo que
        se sirve después) y queda en error_ajeno para el registro. Ojo: tras
        una recarga con errores, 0.16 deja de servir el certificado que falló
        (pasa al autofirmado), no conserva el anterior en memoria como 0.15.
        """
        self.error_ajeno = None
        respuestas = self._llamar([['x:Action/set', {'create': {'recarga': {'@type': 'ReloadTlsCertificates'}}}, 'a']])
        argumentos = self._resultado(respuestas, 'a')
        if 'recarga' in (argumentos.get('created') or {}):
            return []
        rechazo = (argumentos.get('notCreated') or {}).get('recarga')
        if not isinstance(rechazo, dict):
            raise ErrorMotor('respuesta inesperada al recargar los certificados')
        objeto = rechazo.get('objectId') if isinstance(rechazo.get('objectId'), dict) else {}
        detalle = _error_de_objeto(rechazo)
        if objeto.get('object', 'Certificate') == 'Certificate' and objeto.get('id', id_propio) == id_propio:
            return [f'Certificate {id_propio}: {detalle}']
        self.error_ajeno = f'{_texto_corto(objeto.get("object"), 40)} {_texto_corto(objeto.get("id"), 40)}: {detalle}'
        return []


@dataclass
class Sondeo:
    huella: Optional[str]
    verificado: bool
    error: str = ''
    # False si ni siquiera hubo negociación TLS (motor parado o reiniciándose).
    conectado: bool = True


def sondear(destino: str, puerto: int, nombre: str, contexto: ssl.SSLContext, espera: float = 10.0) -> Sondeo:
    """Certificado que sirve el motor en un puerto TLS implícito, con SNI.

    Solo negocia TLS: no se autentica, así que no puede alimentar el bloqueo
    automático del motor.
    """
    try:
        with socket.create_connection((destino, puerto), timeout=espera) as conexion:
            with contexto.wrap_socket(conexion, server_hostname=nombre) as segura:
                return Sondeo(hashlib.sha256(segura.getpeercert(binary_form=True)).hexdigest(), True)
    except ssl.SSLCertVerificationError as error:
        motivo = error.verify_message or 'cadena no válida'
        servido = None
        sin_verificar = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        sin_verificar.check_hostname = False
        sin_verificar.verify_mode = ssl.CERT_NONE
        try:
            with socket.create_connection((destino, puerto), timeout=espera) as conexion:
                with sin_verificar.wrap_socket(conexion, server_hostname=nombre) as segura:
                    servido = hashlib.sha256(segura.getpeercert(binary_form=True)).hexdigest()
        except (OSError, ssl.SSLError):
            pass
        return Sondeo(servido, False, f'el certificado servido no es válido para {nombre} ({motivo})')
    except ssl.SSLError as error:
        return Sondeo(None, False, f'la negociación TLS falló ({error.reason or type(error).__name__})')
    except OSError as error:
        return Sondeo(None, False, f'sin conexión ({type(error).__name__})', conectado=False)


# --------------------------------------------------------------- extractor


@dataclass
class Estado:
    ok: bool
    codigo: str
    mensaje: str
    certificado: Optional[dict] = None


class Extractor:
    def __init__(self, cfg: Configuracion, motor: Optional[Motor] = None,
                 reloj: Callable[[], float] = time.time, dormir: Callable[[float], None] = time.sleep,
                 salida: Optional[TextIO] = None, motor16: Optional[MotorJmap] = None,
                 cambiar_grupo: Optional[Callable[[Path, int], None]] = None):
        self.cfg = cfg
        self.motor = motor or Motor(cfg.url_motor, cfg.usuario, cfg.clave)
        self.motor16 = motor16 or MotorJmap(cfg.url_motor, cfg.usuario, cfg.clave)
        self.volumen = Volumen(cfg.salida, cfg.host, cambiar_grupo=cambiar_grupo)
        self.reloj = reloj
        self.dormir = dormir
        self._salida = salida
        # API del motor detectada en la última pasada que pudo consultarlo.
        self.api: Optional[str] = None
        self.api_bloqueada_hasta = 0.0
        self._mensaje_bloqueo = ''
        # Huellas que el motor no llegó a servir: no se reintentan hasta que vence la espera.
        self.rechazados: dict = {}
        # Huellas para las que ya se pidió una recarga sin efecto (evita recargar en bucle).
        self.recarga_sin_efecto: dict = {}
        self.estado = Estado(False, 'inicio', 'Arrancando.')
        self._ya_dicho: set = set()
        self._ultimo: Optional[str] = None
        self._contexto: Optional[ssl.SSLContext] = None

    # -- registro y estado

    def registrar(self, texto: str) -> None:
        print(texto, file=self._salida or sys.stdout, flush=True)

    def _una_vez(self, texto: str) -> None:
        if texto not in self._ya_dicho:
            self._ya_dicho.add(texto)
            self.registrar(texto)

    def _fijar(self, ok: bool, codigo: str, mensaje: str, candidato: Optional[Candidato] = None) -> None:
        self.estado = Estado(ok, codigo, mensaje, candidato.resumen() if candidato else None)
        if mensaje != self._ultimo:
            self._ultimo = mensaje
            self.registrar(mensaje)
        self.guardar_estado()

    def guardar_estado(self) -> None:
        ruta = self.cfg.fichero_estado
        try:
            ruta.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            datos = {
                'ok': self.estado.ok,
                'codigo': self.estado.codigo,
                'mensaje': self.estado.mensaje,
                'certificado': self.estado.certificado,
                'host': self.cfg.host,
                'motor': self.api,
                'intervalo': self.cfg.intervalo,
                'actualizado': self.reloj(),
            }
            temporal = ruta.with_name(f'.{ruta.name}.{secrets.token_hex(4)}')
            temporal.write_text(json.dumps(datos, ensure_ascii=False))
            os.replace(temporal, ruta)
        except OSError:
            pass  # El estado es informativo: no debe tumbar el servicio.

    # -- motor

    def _contexto_verificacion(self) -> ssl.SSLContext:
        if self._contexto is None:
            self._contexto = (ssl.create_default_context(cafile=self.cfg.ca_pruebas) if self.cfg.ca_pruebas
                              else ssl.create_default_context())
        return self._contexto

    def _bloquear_api(self, error: ErrorAutenticacion, ahora: float) -> None:
        self.api_bloqueada_hasta = ahora + self.cfg.espera_auth
        minutos = max(1, round(self.cfg.espera_auth / 60))
        if error.codigo == 401:
            self._mensaje_bloqueo = (
                f'El motor rechaza la contraseña de administración (HTTP 401). Revisa STALWART_ADMIN_PASSWORD en '
                f'deploy/.env (debe ser la vigente del usuario «{self.cfg.usuario}» del motor; con Stalwart 0.16, la '
                f'de STALWART_RECOVERY_ADMIN) y recrea este servicio. No se volverá a intentar hasta dentro de '
                f'{minutos} min: cada contraseña incorrecta cuenta para el bloqueo automático del motor.')
        else:
            self._mensaje_bloqueo = (
                f'El usuario «{self.cfg.usuario}» no tiene permiso para leer los ajustes o recargar los certificados '
                f'del motor (HTTP {error.codigo}). Usa el administrador del motor. No se volverá a intentar hasta '
                f'dentro de {minutos} min.')

    def _detectar(self, ahora: float) -> tuple:
        """(API del motor o None, problema). Se repite en cada pasada: el motor puede migrar a 0.16 (o volver)."""
        if ahora < self.api_bloqueada_hasta:
            return None, ('autenticacion', self._mensaje_bloqueo)
        try:
            api = self.motor16.detectar()
        except ErrorAutenticacion as error:
            self._bloquear_api(error, ahora)
            return None, ('autenticacion', self._mensaje_bloqueo)
        except ErrorMotor as error:
            return None, ('motor', f'No se pudo consultar la API del motor ({error}); se reintentará.')
        if api != self.api:
            como = 'JMAP' if api == MOTOR_016 else 'REST'
            if self.api is None:
                self.registrar(f'Motor detectado: Stalwart {api} (API de gestión {como}).')
            else:
                self.registrar(f'El motor ha pasado de Stalwart {self.api} a {api} (API de gestión {como}): se '
                               'adaptan los permisos del volumen y la forma de aplicar el certificado.')
            self.api = api
        return api, None

    def _consultar_motor(self, ahora: float) -> tuple:
        if ahora < self.api_bloqueada_hasta:
            return None, ('autenticacion', self._mensaje_bloqueo)
        try:
            return self.motor.ajustes(self.cfg.host, self.cfg.ruta_motor), None
        except ErrorAutenticacion as error:
            self._bloquear_api(error, ahora)
            return None, ('autenticacion', self._mensaje_bloqueo)
        except ErrorMotor as error:
            return None, ('motor', f'No se pudo consultar la API del motor ({error}); se reintentará.')

    def _ruta_motor(self, fichero: str) -> str:
        """Ruta de un fichero del par tal como la ve el motor (el volumen montado en ruta_motor)."""
        return f'{self.cfg.ruta_motor}/{self.cfg.host}/{fichero}'

    def _certificado_016(self, ahora: float, candidato: Candidato) -> Optional[CertificadoMotor]:
        """Asegura el Certificate del motor 0.16; si no se puede, deja el estado y devuelve None."""
        host = self.cfg.host
        try:
            propio = self.motor16.asegurar_certificado(host, self._ruta_motor('cert.pem'), self._ruta_motor('key.pem'))
        except ErrorAutenticacion as error:
            self._bloquear_api(error, ahora)
            self._fijar(False, 'autenticacion', self._mensaje_bloqueo, candidato)
            return None
        except CertificadoRechazado as error:
            pista = ''
            if 'denied' in str(error) or 'os error 13' in str(error):
                pista = (f' El motor no puede leer los ficheros: comprueba que corre con el grupo '
                         f'{self.cfg.gid_motor} (MAILWAY_TLS_GID_MOTOR).')
            elif 'No such file' in str(error) or 'os error 2' in str(error):
                pista = (f' El motor no ve los ficheros: comprueba que monta el volumen de certificados en '
                         f'{self.cfg.ruta_motor} (MAILWAY_TLS_RUTA_MOTOR).')
            self._fijar(False, 'sin_referencia', f'El motor no admite el certificado de {host} ({error}).{pista} '
                                                 'Se reintentará.', candidato)
            return None
        except ErrorMotor as error:
            self._fijar(False, 'motor', f'No se pudo registrar el certificado en el motor ({error}); se reintentará.',
                        candidato)
            return None
        if 'creado' in propio.cambios:
            self.registrar(f'Certificado de {host} registrado en el motor (Certificate {propio.id}, leído de los '
                           'ficheros del volumen) como certificado por defecto.')
        elif 'por_defecto' in propio.cambios:
            self.registrar(f'El certificado de {host} (Certificate {propio.id}) pasa a ser el certificado por defecto '
                           'del motor.')
        return propio

    def _recargar_016(self, id_propio: str) -> list:
        errores = self.motor16.recargar(id_propio)
        if self.motor16.error_ajeno:
            self._una_vez(f'Al recargar, el motor informa de un error en otro de sus objetos ('
                          f'{self.motor16.error_ajeno}); no afecta al certificado de {self.cfg.host}.')
        return errores

    def _comprobar_servido(self, huella: str, reintentos: int = 0) -> tuple:
        """(lo sirve, detalle, sin conexión). «Sin conexión» = ningún puerto negoció TLS."""
        fallos, caidos = [], 0
        for puerto in self.cfg.puertos:
            sondeo = sondear(self.cfg.destino_tls, puerto, self.cfg.host, self._contexto_verificacion())
            for _ in range(reintentos):
                if sondeo.verificado and sondeo.huella == huella:
                    break
                self.dormir(2)
                sondeo = sondear(self.cfg.destino_tls, puerto, self.cfg.host, self._contexto_verificacion())
            if not sondeo.verificado:
                fallos.append(f'{puerto}: {sondeo.error}')
                caidos += not sondeo.conectado
            elif sondeo.huella != huella:
                fallos.append(f'{puerto}: sirve otro certificado')
        return not fallos, '; '.join(fallos), bool(fallos) and caidos == len(fallos)

    def _recargar_y_comprobar(self, candidato: Candidato, recargar: Callable[[], list]) -> tuple:
        errores = recargar()
        if errores:
            return False, 'el motor no pudo cargar el par: ' + '; '.join(errores), False
        return self._comprobar_servido(candidato.huella, reintentos=1)

    def _motor_sin_tls(self, detalle: str, candidato: Candidato) -> None:
        # Con el motor parado o reiniciándose no se recarga ni se vuelve atrás:
        # el par ya está en el volumen y el motor lo cargará al arrancar.
        self._fijar(False, 'motor', f'El motor no acepta conexiones TLS ({detalle}); se comprobará de nuevo en la '
                                    'siguiente pasada.', candidato)

    # -- volumen

    def _par_en_volumen(self, version: Optional[str] = None) -> Optional[Candidato]:
        par = self.volumen.leer(version)
        if not par:
            return None
        try:
            return validar_par(par[0], par[1], self.cfg.host, 'volumen del motor')
        except ParNoValido:
            return None

    def _preparar_volumen(self, api: Optional[str]) -> bool:
        """Permisos del volumen según el motor detectado. False si no se pudo (el estado dice por qué)."""
        if api == MOTOR_016:
            gid = self.cfg.gid_motor
        elif api == MOTOR_015:
            gid = None
        else:
            # Sin saber qué motor hay se respetan los permisos que ya tiene el
            # volumen: cerrarlos a ciegas dejaría a un 0.16 sin poder leer la clave.
            gid = self.volumen.gid_actual()
        self.volumen.gid = gid
        try:
            self.volumen.preparar()
        except PermissionError as error:
            self._sin_permisos(error)
            return False
        except OSError as error:
            self._fijar(False, 'volumen', f'No se puede preparar el volumen de certificados del motor ({error}); '
                                          'se reintentará.')
            return False
        return True

    def _sin_permisos(self, error: OSError) -> None:
        motivo = errno.errorcode.get(error.errno or 0, type(error).__name__)
        if self.volumen.gid is not None:
            mensaje = (f'No se puede dar al motor acceso a la clave privada ({motivo}). Stalwart 0.16 la lee con el '
                       f'grupo {self.volumen.gid} (MAILWAY_TLS_GID_MOTOR) y asignárselo exige que este servicio tenga '
                       'la capacidad CHOWN (cap_add: [CHOWN] en certs-dumper). Se conserva el certificado actual y se '
                       'reintentará.')
        else:
            mensaje = (f'No se pueden ajustar los permisos del volumen de certificados del motor ({motivo}); se '
                       'reintentará.')
        self._fijar(False, 'permisos', mensaje)

    def _purgar(self) -> None:
        retirados, desconocidos = self.volumen.purgar_ajenos()
        if retirados:
            self.registrar(
                f'Se han retirado del volumen del motor {retirados} entradas que no son el certificado de '
                f'{self.cfg.host} (restos del volcado anterior, con claves privadas de otros dominios).')
        for nombre in desconocidos:
            self._una_vez(f'El volumen del motor contiene «{nombre}», que no es un volcado de certificados: no se toca.')

    # -- pasada completa

    def pasada(self) -> None:
        ahora = self.reloj()
        host = self.cfg.host
        puertos = ' y '.join(str(p) for p in self.cfg.puertos)
        api, problema = self._detectar(ahora)
        ajustes = None
        if api == MOTOR_015:
            ajustes, problema = self._consultar_motor(ahora)
            if ajustes and ajustes.acme and not ajustes.referencia:
                self._purgar()
                self._fijar(True, 'acme', 'El motor obtiene su propio certificado por ACME: este servicio no tiene '
                                          'nada que hacer.')
                return

        if not self._preparar_volumen(api):
            return
        try:
            validos, descartes = candidatos_acme(self.cfg.acme_json, host)
        except AcmeIlegible as error:
            self._purgar()
            self._fijar(False, 'acme_json', f'{error} Se conserva el certificado actual y se reintentará.')
            return
        for motivo in descartes:
            self._una_vez(f'Se descarta un certificado del {motivo}.')

        actual = self._par_en_volumen()
        vigentes = [c for c in validos if self.rechazados.get(c.huella, 0) <= ahora]
        mejor = elegir(vigentes + ([actual] if actual else []))
        self._purgar()
        if mejor is None:
            self._fijar(False, 'sin_certificado',
                        f'Traefik aún no tiene un certificado válido para {host}. Comprueba que el DNS de {host} '
                        'apunta a este servidor y que Traefik puede emitirlo (puertos 80 y 443).')
            return
        # Un renovado que el motor no llegó a servir sigue pendiente aunque se
        # sirva bien el anterior: el estado no debe darse por bueno.
        pendiente = [c for c in validos if c not in vigentes and c.caduca > mejor.caduca]

        cambio = actual is None or mejor.version != actual.version
        anterior = None
        if cambio or self.volumen.es_heredado():
            try:
                anterior = self.volumen.instalar(mejor)
            except PermissionError as error:
                self._sin_permisos(error)
                return
            if cambio:
                self.registrar(f'Certificado de {host} escrito en el volumen del motor ({mejor.describir(ahora)}).')

        if problema:
            codigo, mensaje = problema
            self._fijar(False, codigo, mensaje, mejor)
            return
        forzar = False
        pista = ''
        if api == MOTOR_016:
            # 0.16: el propio servicio registra el certificado en el motor (ya
            # no hay macros %{file:…}% que configure el instalador).
            propio = self._certificado_016(ahora, mejor)
            if propio is None:
                return

            def recargar() -> list:
                return self._recargar_016(propio.id)

            # Un certificado recién registrado o fijado por defecto exige
            # recargar aunque el nombre ya se sirva bien: sin recarga, los
            # clientes sin SNI seguirían recibiendo el certificado anterior.
            forzar = bool(propio.cambios)
            if propio.ajenos:
                pista = (f' El motor tiene además otros certificados para {host} (Certificate '
                         f'{", ".join(propio.ajenos)}): sirve el que caduca más tarde; si no son de Mailway, '
                         'retíralos en la web del motor (Settings › TLS › Certificates).')
        else:
            if not ajustes.referencia:
                falta = ('certificate.mailway apunta a otros ficheros' if ajustes.referencia_otra
                         else 'falta certificate.mailway')
                self._fijar(False, 'sin_referencia',
                            f'El motor aún no usa este certificado ({falta}). deploy/instalar.sh lo configura; a '
                            'mano, sigue la sección 5.2 de docs/DESPLIEGUE-SKYWAY.md.', mejor)
                return
            if ajustes.acme:
                self.volumen.podar({mejor.version})
                self._fijar(True, 'acme_y_fichero',
                            'El motor usa su propio ACME y conserva certificate.mailway: los ficheros se mantienen al '
                            'día sin recargar el motor.', mejor)
                return
            recargar = self.motor.recargar

        sirve, detalle, caido = self._comprobar_servido(mejor.huella)
        if not sirve and caido:
            self._motor_sin_tls(detalle, mejor)
            return
        if not sirve or forzar:
            if not sirve and not cambio and not forzar and self.recarga_sin_efecto.get(mejor.huella, 0) > ahora:
                self._fijar(False, 'no_servido',
                            f'El motor no sirve el certificado de {host} aunque se le pidió recargarlo ({detalle}). '
                            'Revisa su registro (docker logs mailway-mail) o reinícialo: docker restart mailway-mail.'
                            + pista, mejor)
                return
            try:
                sirve, detalle, caido = self._recargar_y_comprobar(mejor, recargar)
            except ErrorAutenticacion as error:
                self._bloquear_api(error, ahora)
                self._fijar(False, 'autenticacion', self._mensaje_bloqueo, mejor)
                return
            except ErrorMotor as error:
                self._fijar(False, 'motor', f'No se pudo pedir al motor que recargue los certificados ({error}); '
                                            'se reintentará.', mejor)
                return
            if caido:
                self._motor_sin_tls(detalle, mejor)
                return
            if sirve:
                self.registrar(f'Certificado aplicado: el motor sirve el de {host} en {puertos}.')
            else:
                self.recarga_sin_efecto[mejor.huella] = ahora + self.cfg.espera_rechazo
        if sirve:
            self.recarga_sin_efecto.pop(mejor.huella, None)
            self.volumen.podar({mejor.version})
            if pendiente:
                reintento = time.strftime('%H:%M', time.gmtime(min(self.rechazados[c.huella] for c in pendiente)))
                self._fijar(False, 'renovacion_pendiente',
                            f'El motor sirve el certificado anterior de {host} ({mejor.describir(ahora)}); el renovado no '
                            f'se pudo aplicar y se reintentará a partir de las {reintento} UTC.', mejor)
            else:
                self._fijar(True, 'ok', f'El motor sirve en {puertos} el certificado de {host} '
                                        f'({mejor.describir(ahora)}).', mejor)
            return

        # El motor no sirve el par nuevo: se vuelve al anterior si sigue siendo válido.
        previo = self._par_en_volumen(anterior) if (cambio and anterior) else None
        if previo is None:
            self._fijar(False, 'no_servido', f'El motor no sirve el certificado de {host}: {detalle}.{pista}', mejor)
            return
        self.volumen.volver(anterior)
        self.rechazados[mejor.huella] = ahora + self.cfg.espera_rechazo
        reintento = time.strftime('%H:%M', time.gmtime(ahora + self.cfg.espera_rechazo))
        try:
            # Lo que cuenta es lo que sirve después, no la respuesta de la
            # recarga: 0.15 sigue con el par anterior en memoria si no llegó a
            # cargar el nuevo, y 0.16 (que tras un fallo pasa al autofirmado)
            # vuelve a leerlo ahora que el enlace apunta otra vez a él.
            recargar()
        except ErrorAutenticacion as error:
            self._bloquear_api(error, ahora)
        except ErrorMotor:
            pass
        restablecido = self._comprobar_servido(previo.huella, reintentos=1)[0]
        situacion = ('el motor vuelve a servirlo' if restablecido
                     else 'el motor tampoco lo sirve todavía; revisa su registro (docker logs mailway-mail)')
        self._fijar(False, 'vuelta_atras',
                    f'El motor no sirvió el certificado nuevo de {host} ({detalle}). Se ha vuelto al anterior '
                    f'({previo.describir(ahora)}) y {situacion}. El nuevo se reintentará a partir de las '
                    f'{reintento} UTC.{pista}', previo)

    # -- bucle del servicio

    def servir(self) -> None:
        # El volumen se prepara en cada pasada, ya con los permisos del motor
        # detectado: prepararlo aquí, a ciegas, cerraría a un motor 0.16 el
        # acceso a la clave hasta la primera pasada.
        self.registrar(f'Extractor del certificado de {self.cfg.host} en marcha: lee {self.cfg.acme_json} en solo '
                       'lectura y escribe en el volumen del motor únicamente el par de ese nombre.')
        firma_previa: object = ()
        proxima = 0.0
        while True:
            ahora = self.reloj()
            firma = _firma(self.cfg.acme_json)
            if firma != firma_previa or ahora >= proxima:
                try:
                    self.pasada()
                except Exception as error:  # noqa: BLE001 — el servicio no debe caer, y el detalle podría llevar datos
                    self._fijar(False, 'inesperado', f'Error inesperado ({type(error).__name__}); se reintentará.')
                firma_previa = firma
                proxima = ahora + (self.cfg.comprobacion if self.estado.ok else self.cfg.intervalo)
            else:
                self.guardar_estado()
            self.dormir(self.cfg.intervalo)


def _firma(ruta: Path) -> object:
    try:
        datos = ruta.stat()
        return datos.st_mtime_ns, datos.st_size, datos.st_ino
    except OSError:
        return None


# ------------------------------------------------------------- utilidades CLI


def _leer_estado(entorno: Mapping[str, str]) -> tuple:
    ruta = Path(entorno.get('MAILWAY_TLS_ESTADO', '/tmp/mailway-tls/estado.json'))
    try:
        datos = json.loads(ruta.read_text())
        edad = time.time() - float(datos['actualizado'])
        limite = 3 * float(datos.get('intervalo') or 30) + 120
        return datos, 0 <= edad <= limite
    except (OSError, ValueError, KeyError, TypeError):
        return None, False


def salud(entorno: Mapping[str, str]) -> int:
    datos, reciente = _leer_estado(entorno)
    return 0 if datos and reciente and datos.get('ok') is True else 1


def estado(entorno: Mapping[str, str]) -> int:
    datos, reciente = _leer_estado(entorno)
    if not datos:
        print('FALLO: El extractor aún no ha registrado su estado (acaba de arrancar o no está en marcha).')
        return 1
    correcto = datos.get('ok') is True and reciente
    print(('OK: ' if correcto else 'FALLO: ') + str(datos.get('mensaje', '')))
    certificado = datos.get('certificado')
    if isinstance(certificado, dict):
        tipo = 'comodín, ' if certificado.get('comodin') else ''
        print(f'Certificado en el volumen: {tipo}emisor {certificado.get("emisor")}, caduca '
              f'{certificado.get("caduca")}, huella {certificado.get("huella")}…')
    if datos.get('motor') in (MOTOR_015, MOTOR_016):
        como = 'JMAP' if datos['motor'] == MOTOR_016 else 'REST'
        print(f'Motor: Stalwart {datos["motor"]} (API de gestión {como}).')
    if not reciente:
        print('El estado no se ha actualizado recientemente: revisa «docker logs mailway-certs-dumper».')
    return 0 if correcto else 1


def main(argv: Optional[list] = None, entorno: Optional[Mapping[str, str]] = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    entorno = os.environ if entorno is None else entorno
    orden = argv[0] if argv else 'servicio'
    if orden == 'salud':
        return salud(entorno)
    if orden == 'estado':
        return estado(entorno)
    try:
        if orden == 'purgar':
            cfg = Configuracion.desde_entorno(entorno, con_clave=False)
            retirados, desconocidos = Volumen(cfg.salida, cfg.host).purgar_ajenos()
            print(f'OK: {retirados} entradas ajenas retiradas del volumen de certificados del motor.')
            for nombre in desconocidos:
                print(f'Se deja «{nombre}»: no es un volcado de certificados.')
            return 0
        if orden == 'servicio':
            Extractor(Configuracion.desde_entorno(entorno)).servir()
            return 0
    except ConfiguracionInvalida as error:
        print(f'Configuración no válida: {error}', file=sys.stderr, flush=True)
        if orden == 'servicio':
            # Sin esta pausa, la política de reinicio del contenedor repetiría
            # el mismo error sin descanso.
            time.sleep(300)
        return 2
    print('Uso: extractor.py [servicio | salud | estado | purgar]', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main())
