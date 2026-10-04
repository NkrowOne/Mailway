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
  4. escribe solo ese par, de forma atómica, donde lo lee certificate.mailway:
     <volumen>/<MAIL_HOSTNAME>/cert.pem y key.pem;
  5. si cambió, pide al motor GET /api/reload/certificate, comprueba el
     certificado que sirve en 993 y 465 y, si no es el nuevo, vuelve al par
     anterior;
  6. no hace nada si el motor obtiene su propio certificado por ACME (si
     conserva además certificate.mailway, solo mantiene esos ficheros al día,
     sin recargar el motor).

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
import hashlib
import http.client
import json
import os
import re
import secrets
import shutil
import socket
import ssl
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
_PEM = re.compile(rb'-----BEGIN ([A-Z0-9 ]+)-----\r?\n.*?\r?\n-----END \1-----', re.S)
_HOST = re.compile(r'(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?')


class ConfiguracionInvalida(Exception):
    """Falta o es incorrecta una variable de entorno."""


class ParNoValido(Exception):
    """El par certificado/clave no sirve para MAIL_HOSTNAME (el mensaje dice por qué)."""


class AcmeIlegible(Exception):
    """El acme.json de Traefik no existe o no se puede interpretar."""


class ErrorMotor(Exception):
    """La API del motor respondió algo inesperado."""


class MotorNoDisponible(ErrorMotor):
    """No se pudo conectar con la API del motor."""


class ErrorAutenticacion(ErrorMotor):
    """La API del motor rechazó las credenciales (401) o el permiso (403)."""

    def __init__(self, codigo: int):
        super().__init__(f'HTTP {codigo}')
        self.codigo = codigo


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


class Volumen:
    """Volumen de certificados del motor: él lo monta en /opt/stalwart/certs y este servicio en /output.

    Estructura:
      .mailway-tls/<versión>/cert.pem   cadena de certificados (0644)
      .mailway-tls/<versión>/key.pem    clave privada (0600)
      <MAIL_HOSTNAME> -> .mailway-tls/<versión>   (enlace relativo)

    La ruta que lee el motor (<MAIL_HOSTNAME>/cert.pem y key.pem) es la misma
    que escribía el volcado antiguo: las instalaciones existentes no tienen
    que cambiar la configuración del motor.
    """

    def __init__(self, base: Path, host: str):
        self.base = base
        self.host = host
        self.privado = base / PRIVADO
        self.enlace = base / host
        # Entradas de otro nombre que el motor aún usa (certificate.mailway
        # apunta a ellas tras cambiar MAIL_HOSTNAME, hasta que el instalador
        # lo traslada): no se purgan ni se poda la versión a la que apuntan.
        # None = no se sabe qué usa el motor (su API no responde): no se toca
        # ningún enlace, que solo pueden ser pares de este servicio.
        self.proteger: Optional[set] = set()

    def preparar(self) -> None:
        if not self.base.is_dir():
            raise OSError(f'No existe {self.base}: ¿está montado el volumen de certificados del motor?')
        self.privado.mkdir(mode=0o700, exist_ok=True)
        os.chmod(self.privado, 0o700)
        # Restos de una escritura interrumpida (nunca los usa el motor).
        for entrada in self.privado.iterdir():
            if entrada.name.startswith('.tmp-'):
                _retirar(entrada)
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
            _escribir_fichero(temporal / 'key.pem', clave, 0o600)
            os.chmod(temporal, 0o700)
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

    def _protegida(self, entrada: Path) -> bool:
        if self.proteger is None:
            return entrada.is_symlink()
        return entrada.name in self.proteger

    def versiones_protegidas(self) -> set:
        """Versiones a las que apuntan los enlaces que el motor aún puede usar."""
        versiones = set()
        if not self.base.is_dir():
            return versiones
        for entrada in self.base.iterdir():
            if entrada.name == self.host or not entrada.is_symlink() or not self._protegida(entrada):
                continue
            destino = os.readlink(entrada)
            nombre = destino.rsplit('/', 1)[-1]
            if destino == f'{PRIVADO}/{nombre}' and VERSION.fullmatch(nombre):
                versiones.add(nombre)
        return versiones

    def podar(self, conservar: set) -> None:
        conservar = set(conservar) | self.versiones_protegidas()
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
            if entrada.name in (PRIVADO, self.host, 'lost+found') or self._protegida(entrada):
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
    # Entrada del volumen a la que apunta certificate.mailway si es la de OTRO
    # nombre con la misma estructura (<ruta del motor>/<nombre>/cert.pem y
    # key.pem): la del nombre anterior tras cambiar MAIL_HOSTNAME.
    referido: Optional[str] = None


def _entrada_referida(cert: object, clave: object, ruta_motor: str) -> Optional[str]:
    """Nombre de la entrada del volumen que usan certificate.mailway.cert y private-key, si es una sola."""
    if not isinstance(cert, str) or not isinstance(clave, str):
        return None
    patron = re.compile(r'%\{file:' + re.escape(ruta_motor.rstrip('/')) + r'/([^/{}%]+)/(cert|key)\.pem\}%')
    en_cert, en_clave = patron.fullmatch(cert.strip()), patron.fullmatch(clave.strip())
    if not en_cert or not en_clave or en_cert.group(2) != 'cert' or en_clave.group(2) != 'key':
        return None
    nombre = en_cert.group(1)
    if nombre != en_clave.group(1) or nombre in (PRIVADO, '.', '..') or nombre.startswith('.'):
        return None
    return nombre


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


class Motor:
    """Cliente mínimo de la API de gestión de Stalwart 0.15 (solo lecturas y recargas)."""

    def __init__(self, url: str, usuario: str, clave: str, espera: float = 15.0):
        self.url = url.rstrip('/')
        self._autorizacion = 'Basic ' + base64.b64encode(f'{usuario}:{clave}'.encode()).decode()
        # Sin proxies del entorno: la credencial solo va a la red interna.
        self._abridor = urllib.request.build_opener(urllib.request.ProxyHandler({}), _SinRedireccion())
        self.espera = espera

    def _pedir(self, ruta: str) -> object:
        peticion = urllib.request.Request(
            self.url + ruta, headers={'Authorization': self._autorizacion, 'Accept': 'application/json'})
        try:
            with self._abridor.open(peticion, timeout=self.espera) as respuesta:
                cuerpo = respuesta.read(MAX_RESPUESTA + 1)
        except urllib.error.HTTPError as error:
            codigo = error.code
            try:
                error.close()
            except Exception:  # noqa: BLE001 — solo se libera la conexión
                pass
            if codigo in (401, 403):
                raise ErrorAutenticacion(codigo) from None
            raise ErrorMotor(f'la API respondió HTTP {codigo}') from None
        except (urllib.error.URLError, OSError, http.client.HTTPException) as error:
            motivo = getattr(error, 'reason', error)
            raise MotorNoDisponible(f'sin conexión con {self.url}: {type(motivo).__name__}') from None
        if len(cuerpo) > MAX_RESPUESTA:
            raise ErrorMotor('respuesta demasiado grande')
        try:
            datos = json.loads(cuerpo)
        except ValueError:
            raise ErrorMotor('la API no devolvió JSON') from None
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
        referido = None if referencia else _entrada_referida(cert, clave, ruta_motor)
        return AjustesMotor(referencia=referencia, referencia_otra=cert is not None and not referencia, acme=acme,
                            referido=referido)

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
                 salida: Optional[TextIO] = None):
        self.cfg = cfg
        self.motor = motor or Motor(cfg.url_motor, cfg.usuario, cfg.clave)
        self.volumen = Volumen(cfg.salida, cfg.host)
        self.reloj = reloj
        self.dormir = dormir
        self._salida = salida
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
                f'deploy/.env (debe ser la vigente del usuario «{self.cfg.usuario}» del motor) y recrea este servicio. '
                f'No se volverá a intentar hasta dentro de {minutos} min: cada contraseña incorrecta cuenta para el '
                'bloqueo automático del motor.')
        else:
            self._mensaje_bloqueo = (
                f'El usuario «{self.cfg.usuario}» no tiene permiso para leer los ajustes o recargar los certificados '
                f'del motor (HTTP {error.codigo}). Usa el administrador del motor. No se volverá a intentar hasta '
                f'dentro de {minutos} min.')

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

    def _recargar_y_comprobar(self, candidato: Candidato) -> tuple:
        errores = self.motor.recargar()
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
        ajustes, problema = self._consultar_motor(ahora)
        # Tras cambiar MAIL_HOSTNAME, el motor sigue con el par del nombre
        # anterior hasta que el instalador lo traslada al nuevo: si se
        # purgara, su siguiente recarga o arranque fallaría sin certificado.
        if ajustes is None:
            self.volumen.proteger = None
        else:
            self.volumen.proteger = {ajustes.referido} if ajustes.referido and ajustes.referido != host else set()

        if ajustes and ajustes.acme and not ajustes.referencia:
            self._purgar()
            self._fijar(True, 'acme', 'El motor obtiene su propio certificado por ACME: este servicio no tiene nada que hacer.')
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
            anterior = self.volumen.instalar(mejor)
            if cambio:
                self.registrar(f'Certificado de {host} escrito en el volumen del motor ({mejor.describir(ahora)}).')

        if ajustes is None:
            codigo, mensaje = problema
            self._fijar(False, codigo, mensaje, mejor)
            return
        if not ajustes.referencia:
            if ajustes.referido:
                self._fijar(False, 'sin_referencia',
                            f'El motor aún usa el certificado de {ajustes.referido} (certificate.mailway), que se '
                            f'conserva. deploy/instalar.sh --actualizar lo pasa al de {host}; a mano, sigue la '
                            'sección 5.2 de docs/DESPLIEGUE-SKYWAY.md.', mejor)
                return
            falta = ('certificate.mailway apunta a otros ficheros' if ajustes.referencia_otra
                     else 'falta certificate.mailway')
            self._fijar(False, 'sin_referencia',
                        f'El motor aún no usa este certificado ({falta}). deploy/instalar.sh lo configura; a mano, '
                        'sigue la sección 5.2 de docs/DESPLIEGUE-SKYWAY.md.', mejor)
            return
        if ajustes.acme:
            self.volumen.podar({mejor.version})
            self._fijar(True, 'acme_y_fichero',
                        'El motor usa su propio ACME y conserva certificate.mailway: los ficheros se mantienen al día '
                        'sin recargar el motor.', mejor)
            return

        sirve, detalle, caido = self._comprobar_servido(mejor.huella)
        if not sirve and caido:
            self._motor_sin_tls(detalle, mejor)
            return
        if not sirve:
            if not cambio and self.recarga_sin_efecto.get(mejor.huella, 0) > ahora:
                self._fijar(False, 'no_servido',
                            f'El motor no sirve el certificado de {host} aunque se le pidió recargarlo ({detalle}). '
                            'Revisa su registro (docker logs mailway-mail) o reinícialo: docker restart mailway-mail.',
                            mejor)
                return
            try:
                sirve, detalle, caido = self._recargar_y_comprobar(mejor)
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
            self._fijar(False, 'no_servido', f'El motor no sirve el certificado de {host}: {detalle}.', mejor)
            return
        self.volumen.volver(anterior)
        self.rechazados[mejor.huella] = ahora + self.cfg.espera_rechazo
        reintento = time.strftime('%H:%M', time.gmtime(ahora + self.cfg.espera_rechazo))
        try:
            # Lo que cuenta es lo que sirve después, no la respuesta de la
            # recarga: si el motor no llegó a cargar el par nuevo, sigue con el
            # anterior en memoria aunque la recarga informe de errores.
            self.motor.recargar()
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
                    f'{reintento} UTC.', previo)

    # -- bucle del servicio

    def servir(self) -> None:
        try:
            self.volumen.preparar()
        except OSError as error:
            # Cada pasada lo vuelve a intentar y deja el motivo en el estado.
            self.registrar(f'No se puede preparar el volumen de certificados del motor ({error}).')
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
