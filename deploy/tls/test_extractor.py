"""Pruebas del extractor del certificado (deploy/tls/extractor.py).

Sin Docker ni red: un motor de laboratorio (API de gestión 0.15 o 0.16 y dos
escuchas TLS en 127.0.0.1 que se comportan como Stalwart al recargar) y
certificados generados con openssl en una carpeta temporal.

    python3 -m unittest discover -s deploy/tls -v

No hace falta ser root: el «grupo del motor» 0.16 es un grupo propio del
usuario que ejecuta las pruebas (2000 si es root) y la falta de la capacidad
CHOWN se simula inyectando la función que cambia el grupo. Solo la prueba de
las capacidades mínimas necesita root (y setpriv); sin ellos se omite.
"""
from __future__ import annotations

import base64
import datetime as dt
import errno
import io
import json
import os
import shutil
import socketserver
import ssl
import stat
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from unittest import mock

import extractor
from laboratorio import Laboratorio, Par, acme_json


def _gid_de_pruebas() -> int:
    """Grupo que hace de grupo del motor 0.16: sin ser root solo se puede dar uno propio."""
    if os.geteuid() == 0:
        return extractor.GID_MOTOR_016
    propios = [g for g in os.getgroups() if g != os.getegid()]
    return propios[0] if propios else os.getegid()


GID_MOTOR = _gid_de_pruebas()
# ¿Cambia de verdad el grupo al pasar a 0.16? (sin grupos secundarios ni root, no)
CAMBIO_REAL = GID_MOTOR != os.getegid()
# Un grupo que no es ni el del proceso ni el del motor de las pruebas (otro
# motor, o uno que sin CHOWN no se puede dar).
GID_AJENO = next(g for g in (2000, 2001, 2002) if g not in (os.getegid(), GID_MOTOR))

HOST = 'mail.example.com'
CLAVE = 'clave-de-pruebas-que-no-debe-salir-en-el-registro'
SECRETO_ACME = 'token-de-cloudflare-que-no-debe-salir'
RUTA_MOTOR = '/opt/stalwart/certs'
REFERENCIA = {
    'certificate.mailway.cert': f'%{{file:{RUTA_MOTOR}/{HOST}/cert.pem}}%',
    'certificate.mailway.private-key': f'%{{file:{RUTA_MOTOR}/{HOST}/key.pem}}%',
    'certificate.mailway.default': 'true',
}
OTRO = 'web.otra-empresa.test'
NOMBRES = {
    'exacto': [HOST],
    'renovado': [HOST],
    'comodin': ['*.example.com', 'example.com'],
    'empate': [HOST],
    'caducado': [HOST],
    'futuro': [HOST],
    'otro': [OTRO],
    'subdominio': ['*.mail.example.com'],
    'rsa': [HOST],
    'pkcs8': [HOST],
}

_CARPETA: tempfile.TemporaryDirectory
LAB: Laboratorio
PARES: dict = {}


def setUpModule():
    global _CARPETA, LAB
    _CARPETA = tempfile.TemporaryDirectory()
    LAB = Laboratorio(Path(_CARPETA.name))
    ahora = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    dia = dt.timedelta(days=1)
    PARES.update({
        'exacto': LAB.emitir('exacto', NOMBRES['exacto'], hasta=20 * dia),
        'renovado': LAB.emitir('renovado', NOMBRES['renovado'], hasta=80 * dia),
        'comodin': LAB.emitir('comodin', NOMBRES['comodin'], desde=ahora - dia, hasta=ahora + 60 * dia),
        'empate': LAB.emitir('empate', NOMBRES['empate'], desde=ahora - dia, hasta=ahora + 60 * dia),
        'caducado': LAB.emitir('caducado', NOMBRES['caducado'], desde=-60 * dia, hasta=-30 * dia),
        'futuro': LAB.emitir('futuro', NOMBRES['futuro'], desde=5 * dia, hasta=90 * dia),
        'otro': LAB.emitir('otro', NOMBRES['otro'], hasta=90 * dia),
        'subdominio': LAB.emitir('subdominio', NOMBRES['subdominio'], hasta=90 * dia),
        'rsa': LAB.emitir('rsa', NOMBRES['rsa'], hasta=70 * dia, tipo='rsa'),
        'pkcs8': LAB.emitir('pkcs8', NOMBRES['pkcs8'], hasta=75 * dia, tipo='pkcs8'),
        'autofirmado': LAB.autofirmado('autofirmado', ['localhost']),
    })


def tearDownModule():
    _CARPETA.cleanup()


def linea_de_clave(par: Par) -> bytes:
    """Una línea del cuerpo base64 de la clave privada (para buscarla en ficheros y registros)."""
    return par.clave.splitlines()[2]


class MotorDeLaboratorio:
    """API de gestión y escuchas TLS que imitan a Stalwart 0.15 o, con api='0.16', a 0.16.

    0.15: al recargar lee <volumen>/<HOST>/cert.pem y key.pem (siguiendo el
    enlace), como hace el motor con certificate.mailway; mientras no recarga,
    sigue sirviendo lo que tenía en memoria. Su /jmap/session responde 200 sin
    urn:stalwart:jmap, como el 0.15.5 real.

    0.16: API JMAP con Certificate, SystemSettings y Action. Lee los ficheros
    de los Certificate de tipo File como lo haría la imagen oficial, que no es
    dueña de nada ni root: solo con los permisos de «otros» o los del grupo
    self.gid. Como el 0.16 real, una recarga con errores deja de servir el
    certificado que falló (pasa al autofirmado).
    """

    def __init__(self, volumen: Path, api: str = extractor.MOTOR_015):
        self.volumen = volumen
        self.api_motor = api
        self.ajustes = dict(REFERENCIA)
        self.peticiones: list = []
        self.recargas = 0
        self.forzar_codigo = None
        self.errores_recarga = None
        self.recarga_sin_efecto = False
        self.sesion_404 = False
        # 0.16
        self.gid = GID_MOTOR
        self.certificados: dict = {}
        self.por_defecto: Optional[str] = None
        self.metodos: list = []
        self.errores_016: list = []   # errores forzados de las próximas recargas (uno por recarga)
        self._ids = 0
        self.contexto = self._contexto(PARES['autofirmado'].ruta_cadena, PARES['autofirmado'].ruta_clave)
        self.tls = [self._escucha(), self._escucha()]
        self.api = self._api()

    @staticmethod
    def _contexto(cert, clave) -> ssl.SSLContext:
        contexto = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        contexto.load_cert_chain(cert, clave)
        return contexto

    def cargar_volumen(self) -> None:
        self.contexto = self._contexto(self.volumen / HOST / 'cert.pem', self.volumen / HOST / 'key.pem')

    def sirve(self) -> str:
        sondeo = extractor.sondear('127.0.0.1', self.tls[0].server_address[1], HOST,
                                   ssl.create_default_context(cafile=str(LAB.ca)))
        return sondeo.huella if sondeo.verificado else ''

    # -- 0.16

    def legible(self, ruta: Path) -> bool:
        """¿Puede leer «ruta» el motor 0.16 (ni dueño ni root, con el grupo self.gid)?"""
        base = self.volumen.resolve()
        real = ruta.resolve()
        if base not in real.parents:
            return False

        def permite(datos, bit_grupo, bit_otros):
            return bool(datos.st_mode & bit_otros or (datos.st_gid == self.gid and datos.st_mode & bit_grupo))

        tramo = base
        for parte in real.relative_to(base).parts[:-1]:
            if not permite(tramo.stat(), stat.S_IXGRP, stat.S_IXOTH):
                return False
            tramo = tramo / parte
        return permite(tramo.stat(), stat.S_IXGRP, stat.S_IXOTH) and permite(real.stat(), stat.S_IRGRP, stat.S_IROTH)

    def _fichero(self, ruta_motor: str) -> Path:
        """Ruta en el volumen de una ruta del motor; OSError como los que da el motor al leerla."""
        if not ruta_motor.startswith(RUTA_MOTOR + '/'):
            raise FileNotFoundError(errno.ENOENT, 'No such file or directory')
        ruta = self.volumen / ruta_motor[len(RUTA_MOTOR) + 1:]
        if not ruta.exists():
            raise FileNotFoundError(errno.ENOENT, 'No such file or directory')
        if not self.legible(ruta):
            raise PermissionError(errno.EACCES, 'Permission denied')
        return ruta

    def _leer(self, valor: dict) -> Path:
        try:
            return self._fichero(valor['filePath'])
        except OSError as error:
            raise ValueError(f"Failed to read secret from file '{valor['filePath']}': {error.strerror} "
                             f'(os error {error.errno})') from None

    def _cargar_016(self) -> Optional[dict]:
        """Recarga como 0.16: primer error (o None) y el certificado que pasa a servirse."""
        primero = None
        servidos = {}
        for ident, objeto in self.certificados.items():
            try:
                if '_par' in objeto:
                    servidos[ident] = self._contexto(objeto['_par'].ruta_cadena, objeto['_par'].ruta_clave)
                else:
                    servidos[ident] = self._contexto(self._leer(objeto['certificate']),
                                                     self._leer(objeto['privateKey']))
            except (ValueError, ssl.SSLError) as error:
                primero = primero or {'type': 'validationFailed', 'description': str(error),
                                      'objectId': {'object': 'Certificate', 'id': ident}}
        if self.errores_016:
            primero = self.errores_016.pop(0)
            if primero['objectId']['id'] in servidos:
                del servidos[primero['objectId']['id']]
        ganador = next((i for i, o in self.certificados.items() if o.get('_gana') and i in servidos), None)
        elegido = ganador or (self.por_defecto if self.por_defecto in servidos else None)
        self.contexto = servidos[elegido] if elegido else self._contexto(PARES['autofirmado'].ruta_cadena,
                                                                          PARES['autofirmado'].ruta_clave)
        return primero

    def ajeno(self, par: Par, gana: bool = False) -> str:
        """Otro Certificate del motor (de texto, como los que deja la migración oficial)."""
        self._ids += 1
        ident = f'ajeno{self._ids}'
        self.certificados[ident] = {'certificate': {'@type': 'Text', 'value': par.cadena.decode()},
                                    'privateKey': {'@type': 'Text', 'secret': '****'},
                                    'subjectAlternativeNames': {HOST: True}, '_par': par, '_gana': gana}
        return ident

    def jmap(self, peticion: dict) -> list:
        creados: dict = {}
        respuestas = []
        for nombre, argumentos, llamada in peticion['methodCalls']:
            self.metodos.append(nombre)
            respuestas.append(self._metodo(nombre, argumentos, creados) + [llamada])
        return respuestas

    def _metodo(self, nombre: str, argumentos: dict, creados: dict) -> list:
        if nombre == 'x:Certificate/get':
            lista = [{'id': i, **{k: v for k, v in o.items() if not k.startswith('_')}}
                     for i, o in self.certificados.items()]
            return [nombre, {'list': lista, 'notFound': []}]
        if nombre == 'x:SystemSettings/get':
            return [nombre, {'list': [{'id': 'singleton', 'defaultCertificateId': self.por_defecto}], 'notFound': []}]
        if nombre == 'x:Certificate/set':
            resultado = {}
            for clave, objeto in (argumentos.get('create') or {}).items():
                try:
                    self._leer(objeto['certificate'])
                except ValueError as error:
                    resultado.setdefault('notCreated', {})[clave] = {
                        'type': 'invalidProperties', 'description': f'Failed to read certificate: {error}',
                        'properties': ['certificate']}
                    continue
                self._ids += 1
                ident = f'cert{self._ids}'
                self.certificados[ident] = {**objeto, 'subjectAlternativeNames': {HOST: True}}
                creados[clave] = ident
                resultado.setdefault('created', {})[clave] = {'id': ident}
            return [nombre, resultado]
        if nombre == 'x:SystemSettings/set':
            valor = argumentos['update']['singleton']['defaultCertificateId']
            if valor.startswith('#'):
                if valor[1:] not in creados:
                    return ['error', {'type': 'invalidResultReference',
                                      'description': f'Id reference "{valor[1:]}" not found.'}]
                valor = creados[valor[1:]]
            if valor not in self.certificados:
                return [nombre, {'notUpdated': {'singleton': {
                    'type': 'invalidForeignKey', 'objectId': {'object': 'Certificate', 'id': valor}}}}]
            self.por_defecto = valor
            return [nombre, {'updated': {'singleton': None}}]
        if nombre == 'x:Action/set':
            self.recargas += 1
            if self.recarga_sin_efecto:
                return [nombre, {'created': {'recarga': {'id': 'r'}}}]
            error = self._cargar_016()
            if error:
                return [nombre, {'notCreated': {'recarga': error}}]
            return [nombre, {'created': {'recarga': {'id': 'r'}}}]
        return ['error', {'type': 'unknownMethod'}]

    # -- servidores

    def _escucha(self, puerto: int = 0):
        motor = self

        class Manejador(socketserver.BaseRequestHandler):
            def handle(self):
                try:
                    with motor.contexto.wrap_socket(self.request, server_side=True) as segura:
                        segura.sendall(b'* OK laboratorio\r\n')
                except (OSError, ssl.SSLError):
                    pass

        class Servidor(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        servidor = Servidor(('127.0.0.1', puerto), Manejador)
        threading.Thread(target=servidor.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True).start()
        return servidor

    def _api(self):
        motor = self
        esperado = 'Basic ' + base64.b64encode(f'admin:{CLAVE}'.encode()).decode()
        sesion = {'capabilities': {'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {}},
                  'accounts': {'d333333': {'name': 'admin', 'accountCapabilities': {'urn:ietf:params:jmap:mail': {}}}},
                  'primaryAccounts': {'urn:ietf:params:jmap:mail': 'd333333'}, 'username': 'admin'}

        class Manejador(BaseHTTPRequestHandler):
            def log_message(self, *argumentos):
                pass

            def responder(self, codigo, cuerpo):
                datos = json.dumps(cuerpo).encode()
                self.send_response(codigo)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(datos)))
                self.end_headers()
                self.wfile.write(datos)

            def autorizado(self, url) -> bool:
                motor.peticiones.append(url.path)
                if motor.forzar_codigo:
                    self.responder(motor.forzar_codigo, {'status': motor.forzar_codigo, 'title': 'Unauthorized'})
                    return False
                if self.headers.get('Authorization') != esperado:
                    self.responder(401, {'status': 401, 'title': 'Unauthorized'})
                    return False
                return True

            def do_POST(self):  # noqa: N802 (API de http.server)
                url = urllib.parse.urlsplit(self.path)
                cuerpo = self.rfile.read(int(self.headers.get('Content-Length') or 0))
                if not self.autorizado(url):
                    return None
                if url.path != '/jmap' or motor.api_motor != extractor.MOTOR_016:
                    return self.responder(404, {'status': 404, 'title': 'Not Found'})
                if self.headers.get('Content-Type') != 'application/json':
                    return self.responder(400, {'status': 400, 'title': 'Not JSON'})
                peticion = json.loads(cuerpo)
                assert peticion['using'] == extractor.USO_JMAP
                return self.responder(200, {'methodResponses': motor.jmap(peticion), 'sessionState': '0'})

            def do_GET(self):  # noqa: N802 (API de http.server)
                url = urllib.parse.urlsplit(self.path)
                if not self.autorizado(url):
                    return None
                if url.path == '/jmap/session':
                    if motor.sesion_404:
                        return self.responder(404, {'status': 404, 'title': 'Not Found'})
                    datos = json.loads(json.dumps(sesion))
                    if motor.api_motor == extractor.MOTOR_016:
                        datos['primaryAccounts'][extractor.CAPACIDAD_016] = 'd333333'
                        datos['accounts']['d333333']['accountCapabilities'][extractor.CAPACIDAD_016] = {}
                    return self.responder(200, datos)
                if motor.api_motor != extractor.MOTOR_015:
                    return self.responder(404, {'status': 404, 'title': 'Not Found'})
                if url.path == '/api/settings/keys':
                    consulta = urllib.parse.parse_qs(url.query)
                    claves = consulta.get('keys', [''])[0].split(',')
                    datos = {k: motor.ajustes[k] for k in claves if k in motor.ajustes}
                    for prefijo in filter(None, consulta.get('prefixes', [''])[0].split(',')):
                        datos.update({k: v for k, v in motor.ajustes.items() if k.startswith(prefijo + '.')})
                    return self.responder(200, {'data': datos})
                if url.path == '/api/reload/certificate':
                    motor.recargas += 1
                    if motor.errores_recarga:
                        return self.responder(200, {'data': {'warnings': {}, 'errors': motor.errores_recarga}})
                    usa_ficheros = all(motor.ajustes.get(k) == v for k, v in REFERENCIA.items())
                    if usa_ficheros and not motor.recarga_sin_efecto:
                        try:
                            motor.cargar_volumen()
                        except (OSError, ssl.SSLError):
                            return self.responder(200, {'data': {'warnings': {}, 'errors': {
                                'certificate.mailway': {'type': 'build', 'error': 'No certificates found.'}}}})
                    return self.responder(200, {'data': {'warnings': {}, 'errors': {}}})
                return self.responder(404, {'status': 404, 'title': 'Not Found'})

        servidor = ThreadingHTTPServer(('127.0.0.1', 0), Manejador)
        threading.Thread(target=servidor.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True).start()
        return servidor

    def parar_tls(self) -> None:
        """El motor deja de escuchar en 993 y 465 (parado o reiniciándose)."""
        for servidor in self.tls:
            servidor.shutdown()
            servidor.server_close()

    def arrancar_tls(self) -> None:
        """Arranca de nuevo en los mismos puertos y, como Stalwart, lee los ficheros."""
        self.cargar_volumen()
        self.tls = [self._escucha(s.server_address[1]) for s in self.tls]

    def cerrar(self) -> None:
        for servidor in (*self.tls, self.api):
            servidor.shutdown()
            servidor.server_close()


class Base(unittest.TestCase):
    def setUp(self):
        temporal = tempfile.TemporaryDirectory()
        self.addCleanup(temporal.cleanup)
        self.raiz = Path(temporal.name)
        self.volumen = self.raiz / 'volumen'
        self.volumen.mkdir()
        self.acme = self.raiz / 'acme.json'
        self.motor = MotorDeLaboratorio(self.volumen)
        self.addCleanup(self.motor.cerrar)
        self.tiempo = time.time()
        self.registro = io.StringIO()
        self.cfg = extractor.Configuracion(
            host=HOST, acme_json=self.acme, salida=self.volumen, ruta_motor=RUTA_MOTOR,
            url_motor=f'http://127.0.0.1:{self.motor.api.server_port}', usuario='admin', clave=CLAVE,
            destino_tls='127.0.0.1', puertos=tuple(s.server_address[1] for s in self.motor.tls),
            ca_pruebas=str(LAB.ca), intervalo=1, comprobacion=600, espera_auth=3600, espera_rechazo=21600,
            fichero_estado=self.raiz / 'estado' / 'estado.json', gid_motor=GID_MOTOR)
        self.ext = self.nuevo_extractor()

    def nuevo_extractor(self, **opciones) -> extractor.Extractor:
        return extractor.Extractor(self.cfg, reloj=lambda: self.tiempo, dormir=lambda segundos: None,
                                   salida=self.registro, **opciones)

    def escribir_acme(self, *nombres: str, extra: tuple = ()) -> None:
        entradas = [(PARES[n], NOMBRES[n]) for n in nombres] + list(extra)
        self.acme.write_text(acme_json(entradas))

    def enlazado(self) -> str:
        """Huella del par al que apunta hoy <HOST> en el volumen."""
        return extractor.huella_de((self.volumen / HOST / 'cert.pem').read_bytes())

    def versiones(self) -> list:
        return sorted(p.name for p in (self.volumen / extractor.PRIVADO).iterdir())

    def registro_y_estado(self) -> str:
        texto = self.registro.getvalue()
        if self.cfg.fichero_estado.exists():
            texto += self.cfg.fichero_estado.read_text()
        return texto

    def permisos(self, ruta: Path) -> tuple:
        """(modo, grupo) sin seguir enlaces."""
        datos = os.lstat(ruta)
        return stat.S_IMODE(datos.st_mode), datos.st_gid

    def version_enlazada(self) -> Path:
        return (self.volumen / HOST).resolve()

    def assert_permisos_016(self) -> None:
        """Clave y carpetas del grupo del motor; nada legible por «otros»; la clave, solo root y el motor."""
        version = self.version_enlazada()
        self.assertEqual(self.permisos(self.volumen / extractor.PRIVADO), (0o750, GID_MOTOR))
        self.assertEqual(self.permisos(version), (0o750, GID_MOTOR))
        self.assertEqual(self.permisos(version / 'key.pem'), (0o640, GID_MOTOR))
        self.assertEqual(self.permisos(version / 'cert.pem')[0], 0o644)
        self.assertTrue(self.motor.legible(self.volumen / HOST / 'key.pem'))

    def assert_permisos_015(self) -> None:
        """Como hasta ahora: todo solo de root (aquí, del usuario de las pruebas)."""
        version = self.version_enlazada()
        self.assertEqual(self.permisos(self.volumen / extractor.PRIVADO), (0o700, os.getegid()))
        self.assertEqual(self.permisos(version), (0o700, os.getegid()))
        self.assertEqual(self.permisos(version / 'key.pem'), (0o600, os.getegid()))
        self.assertFalse(self.motor.legible(self.volumen / HOST / 'key.pem'))


class Eleccion(Base):
    def test_elige_el_de_caducidad_mas_lejana_sea_exacto_o_comodin(self):
        self.escribir_acme('otro', 'exacto', 'comodin')
        validos, descartes = extractor.candidatos_acme(self.acme, HOST)
        self.assertEqual(descartes, [])
        # El de otro dominio ni siquiera es candidato.
        self.assertEqual({c.huella for c in validos}, {PARES['exacto'].huella, PARES['comodin'].huella})
        mejor = extractor.elegir(validos)
        self.assertEqual(mejor.huella, PARES['comodin'].huella)
        self.assertTrue(mejor.comodin)

    def test_a_igual_caducidad_prefiere_el_exacto(self):
        self.escribir_acme('comodin', 'empate')
        validos, _ = extractor.candidatos_acme(self.acme, HOST)
        self.assertEqual(len(validos), 2)
        self.assertEqual(extractor.elegir(validos).huella, PARES['empate'].huella)

    def test_descarta_lo_que_no_vale_antes_de_escribir(self):
        cambiada = Par('cambiada', PARES['exacto'].cadena, PARES['renovado'].clave, Path('-'), Path('-'))
        roto = {'domain': {'main': HOST}, 'certificate': '%%%', 'key': '%%%'}
        self.escribir_acme('caducado', 'futuro', 'subdominio', extra=((cambiada, [HOST]),))
        datos = json.loads(self.acme.read_text())
        datos['le']['Certificates'].append(roto)
        self.acme.write_text(json.dumps(datos))
        validos, descartes = extractor.candidatos_acme(self.acme, HOST)
        self.assertEqual(validos, [])
        texto = '\n'.join(descartes)
        for motivo in ('ha caducado', 'aún no es válido', 'no corresponde al certificado', 'base64'):
            self.assertIn(motivo, texto)
        # *.mail.example.com no cubre mail.example.com: no llega a ser candidato.
        self.assertEqual(len(descartes), 4)

        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'sin_certificado')
        self.assertFalse((self.volumen / HOST).exists())
        self.assertEqual(self.motor.recargas, 0)

    def test_formatos_de_clave_de_traefik(self):
        # En orden de caducidad creciente: el extractor nunca cambia el par en
        # uso por otro que caduca antes.
        for nombre, cabecera in (('exacto', b'EC PRIVATE KEY'), ('rsa', b'RSA PRIVATE KEY'),
                                 ('pkcs8', b'BEGIN PRIVATE KEY')):
            with self.subTest(nombre):
                self.escribir_acme(nombre)
                self.ext.pasada()
                self.assertTrue(self.ext.estado.ok, self.ext.estado.mensaje)
                self.assertIn(cabecera, (self.volumen / HOST / 'key.pem').read_bytes())
                self.assertEqual(self.motor.sirve(), PARES[nombre].huella)

    def test_clave_cifrada_se_descarta(self):
        cifrada = self.raiz / 'cifrada.key'
        subprocess.run(['openssl', 'pkcs8', '-topk8', '-in', str(PARES['exacto'].ruta_clave), '-out', str(cifrada),
                        '-passout', 'pass:x'], check=True, capture_output=True)
        par = Par('cifrada', PARES['exacto'].cadena, cifrada.read_bytes(), Path('-'), Path('-'))
        self.escribir_acme(extra=((par, [HOST]),))
        validos, descartes = extractor.candidatos_acme(self.acme, HOST)
        self.assertEqual(validos, [])
        self.assertIn('cifrada', descartes[0])


class VolumenDelMotor(Base):
    def test_solo_escribe_el_par_del_servidor_y_ninguna_clave_ajena(self):
        self.escribir_acme('otro', 'exacto')
        self.ext.pasada()
        self.assertTrue(self.ext.estado.ok, self.ext.estado.mensaje)
        self.assertEqual(sorted(os.listdir(self.volumen)), sorted([extractor.PRIVADO, HOST]))
        enlace = self.volumen / HOST
        self.assertTrue(enlace.is_symlink())
        self.assertEqual(os.readlink(enlace), f'{extractor.PRIVADO}/{self.versiones()[0]}')
        cert, clave = extractor.normalizar_par(PARES['exacto'].cadena, PARES['exacto'].clave)
        self.assertEqual((enlace / 'cert.pem').read_bytes(), cert)
        self.assertEqual((enlace / 'key.pem').read_bytes(), clave)
        self.assertEqual(stat.S_IMODE((enlace / 'key.pem').stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.volumen / extractor.PRIVADO).stat().st_mode), 0o700)
        contenido = b''.join(p.read_bytes() for p in self.volumen.rglob('*') if p.is_file())
        self.assertNotIn(linea_de_clave(PARES['otro']), contenido)

    def test_migra_el_volcado_antiguo_y_retira_las_claves_de_otros_dominios(self):
        # Lo que dejaba traefik-certs-dumper: una carpeta por dominio con su clave.
        for nombre, par in ((HOST, PARES['exacto']), (OTRO, PARES['otro'])):
            carpeta = self.volumen / nombre
            carpeta.mkdir()
            (carpeta / 'cert.pem').write_bytes(par.cadena)
            (carpeta / 'key.pem').write_bytes(par.clave)
        (self.volumen / 'otra.example.net.key').write_bytes(PARES['otro'].clave)
        (self.volumen / 'LEEME.txt').write_text('nota del operador')
        self.motor.cargar_volumen()
        self.assertEqual(self.motor.sirve(), PARES['exacto'].huella)

        self.escribir_acme('otro', 'renovado')
        self.ext.pasada()
        self.assertTrue(self.ext.estado.ok, self.ext.estado.mensaje)
        self.assertTrue((self.volumen / HOST).is_symlink())
        self.assertFalse((self.volumen / OTRO).exists())
        self.assertFalse((self.volumen / 'otra.example.net.key').exists())
        self.assertTrue((self.volumen / 'LEEME.txt').exists())
        self.assertEqual(self.motor.sirve(), PARES['renovado'].huella)
        self.assertEqual(self.motor.recargas, 1)
        self.assertEqual(len(self.versiones()), 1)
        self.assertIn('restos del volcado anterior', self.registro.getvalue())

    def test_el_mismo_par_del_volcado_antiguo_se_migra_sin_recargar(self):
        carpeta = self.volumen / HOST
        carpeta.mkdir()
        (carpeta / 'cert.pem').write_bytes(PARES['exacto'].cadena)
        (carpeta / 'key.pem').write_bytes(PARES['exacto'].clave)
        self.motor.cargar_volumen()
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.assertTrue(self.ext.estado.ok, self.ext.estado.mensaje)
        self.assertTrue((self.volumen / HOST).is_symlink())
        self.assertEqual(self.motor.recargas, 0)

    def test_nunca_cambia_un_par_vigente_por_otro_que_caduca_antes(self):
        self.escribir_acme('renovado')
        self.ext.pasada()
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.assertEqual(self.enlazado(), PARES['renovado'].huella)
        self.assertEqual(self.motor.recargas, 1)


VIEJO = 'mail.anterior.example.com'


class CambioDeNombre(Base):
    """MAIL_HOSTNAME cambia: el motor sigue con el par del nombre anterior hasta que el instalador lo traslada."""

    def setUp(self):
        super().setUp()
        # Lo que dejó el extractor con el nombre anterior, y el motor usándolo.
        anterior = extractor.validar_par(PARES['exacto'].cadena, PARES['exacto'].clave, HOST, 'prueba')
        extractor.Volumen(self.volumen, VIEJO).instalar(anterior)
        self.motor.ajustes = {
            'certificate.mailway.cert': f'%{{file:{RUTA_MOTOR}/{VIEJO}/cert.pem}}%',
            'certificate.mailway.private-key': f'%{{file:{RUTA_MOTOR}/{VIEJO}/key.pem}}%',
            'certificate.mailway.default': 'true',
        }
        self.escribir_acme('renovado')

    def test_no_retira_el_par_que_usa_el_motor(self):
        self.ext.pasada()
        self.assertTrue((self.volumen / VIEJO / 'cert.pem').exists(), 'el motor lo vuelve a leer en cada recarga')
        self.assertTrue((self.volumen / HOST / 'cert.pem').exists(), 'el del nombre nuevo queda listo')
        self.assertEqual(len(self.versiones()), 2)
        self.assertEqual(self.ext.estado.codigo, 'sin_referencia')
        self.assertIn(f'aún usa el certificado de {VIEJO}', self.ext.estado.mensaje)
        self.assertEqual(self.motor.recargas, 0)

    def test_con_la_api_caida_no_retira_ningun_enlace(self):
        self.motor.api.shutdown()
        self.motor.api.server_close()
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'motor')
        self.assertTrue((self.volumen / VIEJO / 'cert.pem').exists())

    def test_trasladado_al_nombre_nuevo_retira_el_anterior(self):
        self.ext.pasada()
        self.motor.ajustes = dict(REFERENCIA)  # lo que hace deploy/instalar.sh
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.assertFalse((self.volumen / VIEJO).exists(), 'ya no lo usa nadie')
        self.assertEqual(len(self.versiones()), 1)
        self.assertEqual(self.motor.sirve(), PARES['renovado'].huella)

    def test_con_el_acme_del_motor_prepara_el_par_nuevo_para_trasladarlo(self):
        # Instalación que empezó con el extractor y añadió después un token de
        # Cloudflare: el ACME del motor ya emite para el nombre nuevo, pero
        # certificate.mailway sigue en el par del anterior, que nadie renueva.
        acme = {'acme.mailway.directory': 'https://acme-v02.api.letsencrypt.org/directory',
                'acme.mailway.domains.0': HOST}
        self.motor.ajustes.update(acme)
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'sin_referencia', 'no es «nada que hacer»: el par anterior caducaría')
        self.assertFalse(self.ext.estado.ok)
        self.assertIn(f'aún usa el certificado de {VIEJO}', self.ext.estado.mensaje)
        self.assertTrue((self.volumen / HOST / 'cert.pem').exists(), 'el instalador lo traslada en cuanto existe')
        self.assertTrue((self.volumen / VIEJO / 'cert.pem').exists())
        self.assertEqual(self.motor.recargas, 0)
        self.motor.ajustes = {**REFERENCIA, **acme}  # lo que hace deploy/instalar.sh
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'acme_y_fichero', self.ext.estado.mensaje)
        self.assertFalse((self.volumen / VIEJO).exists(), 'ya no lo usa nadie')

    def test_una_referencia_ajena_a_la_estructura_no_protege_nada(self):
        self.motor.ajustes['certificate.mailway.private-key'] = '%{file:/etc/stalwart/clave.pem}%'
        self.ext.pasada()
        self.assertFalse((self.volumen / VIEJO).exists())


class Motor(Base):
    def test_recarga_una_vez_y_comprueba_993_y_465(self):
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.assertEqual(self.motor.recargas, 1)
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.ext.pasada()
        self.assertEqual(self.motor.recargas, 1, 'sin cambios no se recarga')
        entorno = {'MAILWAY_TLS_ESTADO': str(self.cfg.fichero_estado)}
        self.assertEqual(extractor.salud(entorno), 0)

    def test_renovacion(self):
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.escribir_acme('renovado')
        self.ext.pasada()
        self.assertEqual(self.motor.recargas, 2)
        self.assertEqual(self.motor.sirve(), PARES['renovado'].huella)
        self.assertTrue(self.ext.estado.ok)
        self.assertEqual(len(self.versiones()), 1, 'tras comprobarlo solo queda el par en uso')

    def test_vuelve_al_anterior_si_el_motor_no_sirve_el_nuevo_y_no_insiste(self):
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.escribir_acme('renovado')
        self.motor.recarga_sin_efecto = True
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'vuelta_atras')
        self.assertFalse(self.ext.estado.ok)
        self.assertEqual(self.enlazado(), PARES['exacto'].huella)
        self.assertIn('vuelve a servirlo', self.ext.estado.mensaje)
        recargas = self.motor.recargas
        for _ in range(3):
            self.ext.pasada()
        self.assertEqual(self.motor.recargas, recargas, 'el par rechazado no se reintenta en bucle')
        self.assertEqual(self.ext.estado.codigo, 'renovacion_pendiente')
        self.assertFalse(self.ext.estado.ok)
        self.assertEqual(self.enlazado(), PARES['exacto'].huella)
        # Vencida la espera se vuelve a intentar.
        self.tiempo += self.cfg.espera_rechazo + 1
        self.motor.recarga_sin_efecto = False
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.assertEqual(self.motor.sirve(), PARES['renovado'].huella)

    def test_errores_de_la_recarga_vuelven_al_anterior(self):
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.escribir_acme('renovado')
        self.motor.errores_recarga = {'certificate.mailway': {'type': 'build', 'error': 'Failed to read certificates'},
                                      'certificate.otro': {'type': 'build', 'error': 'ajeno'}}
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'vuelta_atras')
        self.assertIn('Failed to read certificates', self.ext.estado.mensaje)
        self.assertNotIn('ajeno', self.ext.estado.mensaje)
        self.assertEqual(self.enlazado(), PARES['exacto'].huella)
        self.assertEqual(self.motor.sirve(), PARES['exacto'].huella)

    def test_sin_referencia_escribe_y_queda_pendiente_hasta_que_se_configura(self):
        self.motor.ajustes = {}
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'sin_referencia')
        self.assertTrue((self.volumen / HOST / 'cert.pem').exists())
        self.assertEqual(self.motor.recargas, 0)
        self.motor.ajustes = dict(REFERENCIA)
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.assertEqual(self.motor.recargas, 1)

    def test_motor_reiniciado_que_ya_sirve_el_par_no_se_recarga(self):
        self.motor.ajustes = {}
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.motor.ajustes = dict(REFERENCIA)
        self.motor.cargar_volumen()  # el motor arranca y lee los ficheros
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.assertEqual(self.motor.recargas, 0)

    def test_si_la_recarga_no_tiene_efecto_no_recarga_en_bucle(self):
        self.escribir_acme('exacto')
        self.motor.recarga_sin_efecto = True
        for _ in range(4):
            self.ext.pasada()
        self.assertEqual(self.motor.recargas, 1)
        self.assertEqual(self.ext.estado.codigo, 'no_servido')
        self.assertIn('docker restart mailway-mail', self.ext.estado.mensaje)

    def test_acme_del_motor_no_hace_nada(self):
        self.motor.ajustes = {'acme.mailway.directory': 'https://acme-v02.api.letsencrypt.org/directory',
                              'acme.mailway.domains.0': HOST, 'acme.mailway.secret': SECRETO_ACME,
                              'acme.mailway.contact.0': 'sistemas@example.com'}
        carpeta = self.volumen / OTRO
        carpeta.mkdir()
        (carpeta / 'key.pem').write_bytes(PARES['otro'].clave)
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'acme')
        self.assertTrue(self.ext.estado.ok)
        self.assertFalse((self.volumen / HOST).exists())
        self.assertFalse(carpeta.exists(), 'las claves ajenas se retiran igualmente')
        self.assertEqual(self.motor.recargas, 0)
        self.assertNotIn(SECRETO_ACME, self.registro_y_estado())

    def test_acme_de_otro_dominio_no_cuenta(self):
        self.motor.ajustes.update({'acme.otro.directory': 'https://acme.example/directory',
                                   'acme.otro.domains.0': 'mail.otra-empresa.test'})
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.assertEqual(self.motor.recargas, 1)

    def test_acme_y_certificate_mailway_mantiene_los_ficheros_sin_recargar(self):
        self.motor.ajustes.update({'acme.mailway.directory': 'https://acme-v02.api.letsencrypt.org/directory',
                                   'acme.mailway.domains.0': HOST})
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'acme_y_fichero')
        self.assertTrue(self.ext.estado.ok)
        self.assertEqual(self.enlazado(), PARES['exacto'].huella)
        self.assertEqual(self.motor.recargas, 0)

    def test_acme_json_ilegible_conserva_el_par(self):
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.acme.write_text('{"le": {"Certificates": [')
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'acme_json')
        self.assertEqual(self.enlazado(), PARES['exacto'].huella)
        self.assertEqual(self.motor.recargas, 1)

    def test_bucle_solo_repite_la_pasada_si_cambia_acme_json_o_vence_la_comprobacion(self):
        class Fin(Exception):
            pass

        vueltas = []
        pasadas = []
        pasada_real = self.ext.pasada

        def pasada():
            pasadas.append(self.tiempo)
            pasada_real()

        def dormir(segundos):
            if segundos != self.cfg.intervalo:
                return  # reintentos de la comprobación, no vueltas del bucle
            vueltas.append(segundos)
            self.tiempo += segundos
            if len(vueltas) == 3:
                self.escribir_acme('renovado')
            if len(vueltas) == 6:
                self.tiempo += self.cfg.comprobacion
            if len(vueltas) == 8:
                raise Fin

        self.escribir_acme('exacto')
        self.ext.pasada = pasada
        self.ext.dormir = dormir
        with self.assertRaises(Fin):
            self.ext.servir()
        # Arranque, cambio de acme.json y comprobación periódica: tres pasadas en ocho vueltas.
        self.assertEqual(len(pasadas), 3)
        self.assertEqual(self.motor.recargas, 2)
        self.assertEqual(self.motor.sirve(), PARES['renovado'].huella)
        self.assertTrue(json.loads(self.cfg.fichero_estado.read_text())['ok'])

    def test_motor_sin_tls_durante_la_renovacion_no_vuelve_atras(self):
        self.escribir_acme('exacto')
        self.ext.pasada()
        recargas = self.motor.recargas
        self.escribir_acme('renovado')
        self.motor.parar_tls()
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'motor')
        self.assertIn('no acepta conexiones TLS', self.ext.estado.mensaje)
        self.assertEqual(self.motor.recargas, recargas, 'sin TLS no se recarga')
        self.assertEqual(self.enlazado(), PARES['renovado'].huella, 'el par nuevo se queda para el arranque')
        self.assertEqual(self.ext.rechazados, {})
        self.motor.arrancar_tls()
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.assertEqual(self.motor.recargas, recargas)
        self.assertEqual(self.motor.sirve(), PARES['renovado'].huella)

    def test_api_caida(self):
        self.motor.api.shutdown()
        self.motor.api.server_close()
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'motor')
        self.assertTrue((self.volumen / HOST / 'cert.pem').exists(), 'el motor lo cargará al recargar o arrancar')

    def test_401_no_reintenta_en_bucle(self):
        self.escribir_acme('exacto')
        self.motor.forzar_codigo = 401
        for _ in range(5):
            self.ext.pasada()
        self.assertEqual(len(self.motor.peticiones), 1, 'un solo intento con la contraseña rechazada')
        self.assertEqual(self.ext.estado.codigo, 'autenticacion')
        self.assertIn('bloqueo automático', self.ext.estado.mensaje)
        self.assertIn('STALWART_ADMIN_PASSWORD', self.ext.estado.mensaje)
        self.assertEqual(self.registro.getvalue().count('HTTP 401'), 1, 'el aviso no se repite en cada pasada')
        self.assertTrue((self.volumen / HOST / 'cert.pem').exists())
        # Pasada la espera larga se vuelve a probar una vez.
        self.tiempo += self.cfg.espera_auth + 1
        self.motor.forzar_codigo = None
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)

    def test_403_tampoco_reintenta(self):
        self.escribir_acme('exacto')
        self.motor.forzar_codigo = 403
        self.ext.pasada()
        self.ext.pasada()
        self.assertEqual(len(self.motor.peticiones), 1)
        self.assertIn('permiso', self.ext.estado.mensaje)


def sin_chown(ruta, gid):
    """Lo que ve un root sin la capacidad CHOWN al dar a un fichero un grupo que no es suyo."""
    raise PermissionError(errno.EPERM, 'Operation not permitted', str(ruta))


class Deteccion(Base):
    def detectar(self) -> str:
        return extractor.MotorJmap(self.cfg.url_motor, 'admin', CLAVE).detectar()

    def test_distingue_015_y_016_por_la_capacidad_de_la_sesion(self):
        # El 0.15.5 real responde 200 a /jmap/session, sin urn:stalwart:jmap.
        self.assertEqual(self.detectar(), extractor.MOTOR_015)
        self.motor.sesion_404 = True
        self.assertEqual(self.detectar(), extractor.MOTOR_015)
        self.motor.sesion_404 = False
        self.motor.api_motor = extractor.MOTOR_016
        self.assertEqual(self.detectar(), extractor.MOTOR_016)

    def test_la_capacidad_cuenta_en_cualquier_parte_de_la_sesion(self):
        capacidad = {extractor.CAPACIDAD_016: {}}
        for sesion, es_016 in (
                ({'capabilities': {'urn:ietf:params:jmap:core': {}}}, False),
                ({'capabilities': capacidad}, True),
                ({'capabilities': {}, 'primaryAccounts': {extractor.CAPACIDAD_016: 'a'}}, True),
                ({'capabilities': {}, 'accounts': {'a': {'accountCapabilities': capacidad}}}, True),
                ({'capabilities': {}, 'accounts': {'a': 'no es un objeto'}, 'primaryAccounts': None}, False)):
            with self.subTest(sesion=sesion):
                self.assertEqual(extractor._anuncia_016(sesion), es_016)

    def test_un_401_en_la_deteccion_es_el_unico_intento(self):
        self.motor.api_motor = extractor.MOTOR_016
        self.escribir_acme('exacto')
        self.motor.forzar_codigo = 401
        for _ in range(3):
            self.ext.pasada()
        self.assertEqual(self.motor.peticiones, ['/jmap/session'])
        self.assertEqual(self.ext.estado.codigo, 'autenticacion')
        self.assertIn('STALWART_RECOVERY_ADMIN', self.ext.estado.mensaje)
        self.assertIn('bloqueo automático', self.ext.estado.mensaje)
        # Sin saber qué motor hay, el par se escribe igual (con los permisos de siempre).
        self.assertTrue((self.volumen / HOST / 'cert.pem').exists())

    def test_migracion_de_015_a_016_y_vuelta_con_el_extractor_en_marcha(self):
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.assertEqual(self.ext.api, extractor.MOTOR_015)
        self.assert_permisos_015()

        # Se sustituye el motor por un 0.16 recién migrado: sin el certificado
        # (sirve el autofirmado) y sin poder leer la clave, que es de root.
        self.motor.api_motor = extractor.MOTOR_016
        self.motor.contexto = self.motor._contexto(PARES['autofirmado'].ruta_cadena, PARES['autofirmado'].ruta_clave)
        self.assertFalse(self.motor.legible(self.volumen / HOST / 'key.pem'))
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.assertEqual(self.ext.api, extractor.MOTOR_016)
        self.assert_permisos_016()
        self.assertEqual(self.motor.sirve(), PARES['exacto'].huella)
        self.assertEqual(len(self.versiones()), 1, 'el mismo par cambia de permisos sin reescribirse')
        self.assertIn('El motor ha pasado de Stalwart 0.15 a 0.16', self.registro.getvalue())

        # Vuelta atrás de la migración: el 0.15 lee como root y todo vuelve a ser solo de root.
        self.motor.api_motor = extractor.MOTOR_015
        recargas = self.motor.recargas
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.assert_permisos_015()
        self.assertEqual(self.motor.recargas, recargas)


class Motor016(Base):
    def setUp(self):
        super().setUp()
        self.motor.api_motor = extractor.MOTOR_016

    def propio(self) -> tuple:
        """(id, objeto) del Certificate de tipo File: tiene que haber exactamente uno."""
        propios = [(i, o) for i, o in self.motor.certificados.items() if o['certificate'].get('@type') == 'File']
        self.assertEqual(len(propios), 1, self.motor.certificados)
        return propios[0]

    def test_registra_el_certificado_lo_deja_por_defecto_y_recarga(self):
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.assertTrue(self.ext.estado.ok)
        ident, objeto = self.propio()
        self.assertEqual(objeto['certificate'], {'@type': 'File', 'filePath': f'{RUTA_MOTOR}/{HOST}/cert.pem'})
        self.assertEqual(objeto['privateKey'], {'@type': 'File', 'filePath': f'{RUTA_MOTOR}/{HOST}/key.pem'})
        self.assertEqual(self.motor.por_defecto, ident)
        self.assertEqual(self.motor.recargas, 1)
        self.assertEqual(self.motor.sirve(), PARES['exacto'].huella)
        self.assert_permisos_016()
        self.assertIn('Motor detectado: Stalwart 0.16', self.registro.getvalue())
        self.assertIn(f'Certificate {ident}', self.registro.getvalue())
        self.assertEqual(json.loads(self.cfg.fichero_estado.read_text())['motor'], extractor.MOTOR_016)
        self.assertEqual(extractor.salud({'MAILWAY_TLS_ESTADO': str(self.cfg.fichero_estado)}), 0)

    def test_idempotente(self):
        self.escribir_acme('exacto')
        self.ext.pasada()
        metodos = len(self.motor.metodos)
        for _ in range(3):
            self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.assertEqual(set(self.motor.metodos[metodos:]), {'x:Certificate/get', 'x:SystemSettings/get'},
                         'sin cambios, solo lecturas')
        self.assertEqual(self.motor.recargas, 1)
        self.propio()

    def test_certificado_que_ya_existe_pero_no_es_el_de_por_defecto(self):
        self.escribir_acme('exacto')
        self.ext.pasada()
        ident, _ = self.propio()
        # Otro certificado (de otro nombre: no compite) pasa a ser el de por defecto.
        self.motor.por_defecto = self.motor.ajeno(PARES['otro'])
        self.motor.certificados[self.motor.por_defecto]['subjectAlternativeNames'] = {OTRO: True}
        metodos = len(self.motor.metodos)
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.assertEqual(self.motor.por_defecto, ident)
        self.assertNotIn('x:Certificate/set', self.motor.metodos[metodos:], 'no se duplica el objeto')
        self.assertEqual(self.motor.recargas, 2, 'cambiar el de por defecto exige recargar')
        self.assertIn('pasa a ser el certificado por defecto', self.registro.getvalue())

    def test_renovacion(self):
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.escribir_acme('renovado')
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.assertEqual(self.motor.recargas, 2)
        self.assertEqual(self.motor.sirve(), PARES['renovado'].huella)
        self.assertEqual(len(self.versiones()), 1)
        self.propio()
        self.assert_permisos_016()

    def test_error_de_la_recarga_en_el_propio_vuelve_al_anterior(self):
        self.escribir_acme('exacto')
        self.ext.pasada()
        ident, _ = self.propio()
        self.escribir_acme('renovado')
        # Como el 0.16 real: el que falla deja de servirse (autofirmado) hasta otra recarga.
        self.motor.errores_016 = [{'type': 'validationFailed', 'description': 'Invalid certificate: prueba',
                                   'objectId': {'object': 'Certificate', 'id': ident}}]
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'vuelta_atras', self.ext.estado.mensaje)
        self.assertIn('Invalid certificate: prueba', self.ext.estado.mensaje)
        self.assertIn('vuelve a servirlo', self.ext.estado.mensaje)
        self.assertEqual(self.enlazado(), PARES['exacto'].huella)
        self.assertEqual(self.motor.sirve(), PARES['exacto'].huella)
        recargas = self.motor.recargas
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'renovacion_pendiente')
        self.assertEqual(self.motor.recargas, recargas, 'el par rechazado no se reintenta en bucle')

    def test_error_de_otro_objeto_en_la_recarga_no_cuenta(self):
        self.motor.errores_016 = [{'type': 'validationFailed', 'description': 'Failed to obtain certificate value',
                                   'objectId': {'object': 'Certificate', 'id': 'otro1'}}]
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.assertEqual(self.motor.sirve(), PARES['exacto'].huella)
        self.assertIn('Certificate otro1: Failed to obtain certificate value', self.registro.getvalue())

    def test_motor_que_no_puede_leer_los_ficheros(self):
        # El motor corre con otro grupo que el configurado en MAILWAY_TLS_GID_MOTOR.
        self.motor.gid = GID_AJENO
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'sin_referencia', self.ext.estado.mensaje)
        self.assertIn('Permission denied', self.ext.estado.mensaje)
        self.assertIn('MAILWAY_TLS_GID_MOTOR', self.ext.estado.mensaje)
        self.assertEqual(self.motor.certificados, {})
        self.assertEqual(self.motor.recargas, 0)
        self.assertTrue((self.volumen / HOST / 'cert.pem').exists())

    def test_motor_que_monta_el_volumen_en_otra_ruta(self):
        self.cfg.ruta_motor = '/var/lib/stalwart/certs'
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'sin_referencia', self.ext.estado.mensaje)
        self.assertIn('No such file or directory', self.ext.estado.mensaje)
        self.assertIn('/var/lib/stalwart/certs (MAILWAY_TLS_RUTA_MOTOR)', self.ext.estado.mensaje)
        self.assertEqual(self.motor.certificados, {})

    def test_otro_certificado_del_mismo_nombre_que_gana_se_menciona(self):
        ajeno = self.motor.ajeno(PARES['renovado'], gana=True)
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'no_servido', self.ext.estado.mensaje)
        self.assertIn(f'Certificate {ajeno}', self.ext.estado.mensaje)
        self.assertIn('Settings › TLS › Certificates', self.ext.estado.mensaje)

    def test_ids_mal_formados_del_motor_no_llegan_al_registro(self):
        raro = 'id raro <x>'
        self.motor.certificados[raro] = self.motor.certificados.pop(self.motor.ajeno(PARES['otro']))
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.assertNotIn(raro, self.registro_y_estado())

    def test_sin_conexion_con_la_api_respeta_los_permisos_del_volumen(self):
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.motor.api.shutdown()
        self.motor.api.server_close()
        self.escribir_acme('renovado')
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'motor')
        self.assertEqual(self.enlazado(), PARES['renovado'].huella)
        # Sin saber qué motor hay, el par nuevo se escribe para el mismo que antes.
        self.assert_permisos_016()

    def test_atajo_de_acme_no_se_aplica(self):
        # Con 0.16 no se leen ajustes REST de ACME: Mailway usa el certificado de Traefik.
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.assertNotIn('/api/settings/keys', self.motor.peticiones)


class Permisos(Base):
    def test_sin_chown_avisa_y_no_escribe_nada(self):
        self.motor.api_motor = extractor.MOTOR_016
        self.cfg.gid_motor = GID_AJENO
        ext = self.nuevo_extractor(cambiar_grupo=sin_chown)
        self.escribir_acme('exacto')
        ext.pasada()
        self.assertEqual(ext.estado.codigo, 'permisos', ext.estado.mensaje)
        for texto in ('EPERM', 'CHOWN', 'cap_add', 'MAILWAY_TLS_GID_MOTOR', str(GID_AJENO)):
            self.assertIn(texto, ext.estado.mensaje)
        self.assertFalse((self.volumen / HOST).exists())
        self.assertEqual(self.versiones(), [])
        self.assertEqual(self.motor.certificados, {})
        self.assertEqual(self.motor.recargas, 0)

    def test_sin_chown_tras_migrar_a_016_la_clave_sigue_cerrada(self):
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.motor.api_motor = extractor.MOTOR_016
        self.cfg.gid_motor = GID_AJENO
        ext = self.nuevo_extractor(cambiar_grupo=sin_chown)
        ext.pasada()
        self.assertEqual(ext.estado.codigo, 'permisos', ext.estado.mensaje)
        self.assert_permisos_015()
        self.assertEqual(self.enlazado(), PARES['exacto'].huella)

    def test_sin_chown_la_vuelta_a_015_cierra_igualmente(self):
        """Al volver a 0.15 sin CHOWN el grupo no se puede devolver, pero ya no tiene permisos."""
        self.motor.api_motor = extractor.MOTOR_016
        self.escribir_acme('exacto')
        self.ext.pasada()
        self.assertEqual(self.ext.estado.codigo, 'ok', self.ext.estado.mensaje)
        self.motor.api_motor = extractor.MOTOR_015
        ext = self.nuevo_extractor(cambiar_grupo=sin_chown)
        ext.pasada()
        self.assertEqual(ext.estado.codigo, 'ok', ext.estado.mensaje)
        version = self.version_enlazada()
        for ruta, modo in ((self.volumen / extractor.PRIVADO, 0o700), (version, 0o700), (version / 'key.pem', 0o600)):
            self.assertEqual(self.permisos(ruta)[0], modo, ruta)

    @unittest.skipUnless(CAMBIO_REAL, 'hace falta ser root o tener un grupo secundario')
    def test_orden_al_dar_y_al_devolver_el_grupo(self):
        """El grupo del motor llega antes de abrir el modo; al volver, el modo se cierra antes de devolverlo."""
        cambios = []

        def anotar(ruta, gid):
            cambios.append((ruta.name, gid, stat.S_IMODE(os.lstat(ruta).st_mode)))
            extractor._cambiar_grupo(ruta, gid)

        ext = self.nuevo_extractor(cambiar_grupo=anotar)
        self.escribir_acme('exacto')
        ext.pasada()
        self.assertEqual(cambios, [], 'con 0.15 no se toca el grupo')
        version = self.version_enlazada().name

        self.motor.api_motor = extractor.MOTOR_016
        ext.pasada()
        self.assertEqual(ext.estado.codigo, 'ok', ext.estado.mensaje)
        self.assertEqual(sorted(cambios), sorted([(extractor.PRIVADO, GID_MOTOR, 0o700), (version, GID_MOTOR, 0o700),
                                                  ('key.pem', GID_MOTOR, 0o600)]))
        cambios.clear()
        # Una versión nueva: la clave nace 0600 y cambia de grupo dentro de la carpeta temporal, aún 0700.
        self.escribir_acme('renovado')
        ext.pasada()
        self.assertEqual(ext.estado.codigo, 'ok', ext.estado.mensaje)
        self.assertEqual(sorted((n if n == 'key.pem' else 'carpeta', g, m) for n, g, m in cambios),
                         [('carpeta', GID_MOTOR, 0o700), ('key.pem', GID_MOTOR, 0o600)])
        self.assert_permisos_016()
        version = self.version_enlazada().name
        cambios.clear()

        self.motor.api_motor = extractor.MOTOR_015
        ext.pasada()
        self.assertEqual(ext.estado.codigo, 'ok', ext.estado.mensaje)
        egid = os.getegid()
        self.assertEqual(sorted(cambios), sorted([(extractor.PRIVADO, egid, 0o700), (version, egid, 0o700),
                                                  ('key.pem', egid, 0o600)]))
        self.assert_permisos_015()

    @unittest.skipUnless(os.geteuid() == 0 and shutil.which('setpriv'), 'hace falta ser root y tener setpriv')
    def test_root_con_solo_la_capacidad_chown_rota_vuelve_atras_y_poda(self):
        """Con cap_drop: ALL y solo CHOWN (sin DAC_OVERRIDE ni FOWNER) se puede todo; sin CHOWN, no."""
        programa = textwrap.dedent('''
            import sys
            from pathlib import Path
            sys.path.insert(0, sys.argv[1])
            import extractor
            base, host, gid = Path(sys.argv[2]), sys.argv[3], int(sys.argv[4])
            pares = [extractor.validar_par(Path(c).read_bytes(), Path(k).read_bytes(), host)
                     for c, k in zip(sys.argv[5::2], sys.argv[6::2])]
            volumen = extractor.Volumen(base, host, gid=gid)
            assert volumen.instalar(pares[0]) is None
            anterior = volumen.instalar(pares[1])
            assert anterior == pares[0].version, anterior
            volumen.volver(anterior)
            assert volumen.leer() == (pares[0].cert, pares[0].clave)
            volumen.podar({pares[0].version})
            assert volumen.leer(pares[0].version)[1] == pares[0].clave
            volumen.gid = None
            volumen.preparar()
            volumen.gid = gid
            volumen.preparar()
            print('correcto')
        ''')
        argumentos = [str(Path(extractor.__file__).parent), '', HOST, '2000']
        for nombre in ('exacto', 'renovado'):
            argumentos += [str(PARES[nombre].ruta_cadena), str(PARES[nombre].ruta_clave)]
        for capacidades, correcto in (('-all,+chown', True), ('-all', False)):
            with self.subTest(capacidades=capacidades):
                base = self.raiz / f'volumen{capacidades}'
                base.mkdir()
                argumentos[1] = str(base)
                resultado = subprocess.run(['setpriv', f'--bounding-set={capacidades}', sys.executable, '-c', programa,
                                            *argumentos], capture_output=True, text=True, timeout=60)
                if correcto:
                    self.assertEqual(resultado.returncode, 0, resultado.stderr)
                    self.assertIn('correcto', resultado.stdout)
                    clave = (base / HOST / 'key.pem').resolve()
                    self.assertEqual(self.permisos(clave), (0o640, 2000))
                    self.assertEqual(os.stat(clave).st_uid, 0)
                else:
                    self.assertNotEqual(resultado.returncode, 0)
                    self.assertIn('PermissionError', resultado.stderr)


class Seguridad(Base):
    def test_no_sigue_redirecciones_ni_usa_el_proxy_del_entorno(self):
        robado = []

        class Redireccion(BaseHTTPRequestHandler):
            def log_message(self, *argumentos):
                pass

            def do_GET(self):  # noqa: N802
                if self.path.startswith('/robado'):
                    robado.append(self.headers.get('Authorization'))
                    self.send_response(200)
                    self.end_headers()
                    return
                self.send_response(302)
                self.send_header('Location', f'http://127.0.0.1:{self.server.server_port}/robado')
                self.end_headers()

        servidor = ThreadingHTTPServer(('127.0.0.1', 0), Redireccion)
        threading.Thread(target=servidor.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True).start()
        self.addCleanup(servidor.server_close)
        self.addCleanup(servidor.shutdown)
        proxy = {'http_proxy': 'http://127.0.0.1:9', 'HTTP_PROXY': 'http://127.0.0.1:9', 'no_proxy': ''}
        with mock.patch.dict(os.environ, proxy):
            with self.assertRaises(extractor.ErrorMotor):
                extractor.Motor(f'http://127.0.0.1:{servidor.server_port}', 'admin', CLAVE).ajustes(HOST, RUTA_MOTOR)
            # Con un proxy en el entorno, la petición sigue yendo directa al motor.
            ajustes = extractor.Motor(self.cfg.url_motor, 'admin', CLAVE).ajustes(HOST, RUTA_MOTOR)
        self.assertEqual(robado, [])
        self.assertTrue(ajustes.referencia)

    def test_jmap_tampoco_sigue_redirecciones_ni_usa_el_proxy(self):
        robado = []

        class Redireccion(BaseHTTPRequestHandler):
            def log_message(self, *argumentos):
                pass

            def redirigir(self):
                if self.path.startswith('/robado'):
                    robado.append(self.headers.get('Authorization'))
                    self.send_response(200)
                    self.end_headers()
                    return
                # 307 conserva el método y el cuerpo: también el POST de JMAP.
                self.send_response(307)
                self.send_header('Location', f'http://127.0.0.1:{self.server.server_port}/robado')
                self.end_headers()

            do_GET = do_POST = redirigir  # noqa: N815

        servidor = ThreadingHTTPServer(('127.0.0.1', 0), Redireccion)
        threading.Thread(target=servidor.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True).start()
        self.addCleanup(servidor.server_close)
        self.addCleanup(servidor.shutdown)
        self.motor.api_motor = extractor.MOTOR_016
        proxy = {'http_proxy': 'http://127.0.0.1:9', 'HTTP_PROXY': 'http://127.0.0.1:9', 'no_proxy': ''}
        with mock.patch.dict(os.environ, proxy):
            ajeno = extractor.MotorJmap(f'http://127.0.0.1:{servidor.server_port}', 'admin', CLAVE)
            with self.assertRaises(extractor.ErrorMotor):
                ajeno.detectar()
            with self.assertRaises(extractor.ErrorMotor):
                ajeno.recargar('cert1')
            self.assertEqual(extractor.MotorJmap(self.cfg.url_motor, 'admin', CLAVE).detectar(), extractor.MOTOR_016)
        self.assertEqual(robado, [])

    def test_nunca_registra_secretos_con_016(self):
        self.motor.api_motor = extractor.MOTOR_016
        self.escribir_acme('otro', 'exacto')
        self.ext.pasada()
        ident = next(iter(self.motor.certificados))
        self.escribir_acme('renovado')
        self.motor.errores_016 = [{'type': 'validationFailed', 'description': 'Invalid certificate: ' + 'x' * 300,
                                   'objectId': {'object': 'Certificate', 'id': ident}}]
        self.ext.pasada()
        self.motor.gid = GID_AJENO
        self.motor.certificados.clear()
        self.ext.pasada()
        self.motor.forzar_codigo = 401
        self.tiempo += self.cfg.espera_rechazo + 1
        self.ext.pasada()
        texto = self.registro_y_estado()
        self.assertIn('Invalid certificate', texto)
        self.assertIn('Permission denied', texto)
        for secreto in (CLAVE, 'PRIVATE KEY', 'Basic ',
                        *(linea_de_clave(PARES[n]).decode() for n in ('exacto', 'renovado', 'otro'))):
            self.assertNotIn(secreto, texto)

    def test_nunca_registra_secretos(self):
        cambiada = Par('cambiada', PARES['exacto'].cadena, PARES['otro'].clave, Path('-'), Path('-'))
        self.motor.ajustes.update({'acme.otro.directory': 'https://acme.example/directory',
                                   'acme.otro.domains.0': 'mail.otra-empresa.test',
                                   'acme.otro.secret': SECRETO_ACME})
        self.escribir_acme('otro', 'exacto', extra=((cambiada, [HOST]),))
        self.ext.pasada()
        self.escribir_acme('renovado')
        self.motor.errores_recarga = {'certificate.mailway': {'type': 'build', 'error': 'x' * 200}}
        self.ext.pasada()
        self.motor.errores_recarga = None
        self.motor.forzar_codigo = 401
        self.tiempo += self.cfg.espera_rechazo + 1
        self.ext.pasada()
        texto = self.registro_y_estado()
        self.assertTrue(texto)
        for secreto in (CLAVE, SECRETO_ACME, 'PRIVATE KEY', 'Basic ',
                        *(linea_de_clave(PARES[n]).decode() for n in ('exacto', 'renovado', 'otro'))):
            self.assertNotIn(secreto, texto)
        self.assertNotIn(CLAVE, repr(self.cfg))


class Ordenes(unittest.TestCase):
    def setUp(self):
        temporal = tempfile.TemporaryDirectory()
        self.addCleanup(temporal.cleanup)
        self.raiz = Path(temporal.name)
        self.entorno = {'MAILWAY_TLS_ESTADO': str(self.raiz / 'estado.json'), 'MAIL_HOSTNAME': HOST,
                        'MAILWAY_TLS_SALIDA': str(self.raiz / 'volumen')}

    def escribir_estado(self, **datos):
        Path(self.entorno['MAILWAY_TLS_ESTADO']).write_text(json.dumps(
            {'ok': True, 'mensaje': 'Correcto.', 'intervalo': 30, 'actualizado': time.time(), **datos}))

    def test_salud_y_estado(self):
        salida = io.StringIO()
        with mock.patch('sys.stdout', salida):
            self.assertEqual(extractor.salud(self.entorno), 1)
            self.assertEqual(extractor.estado(self.entorno), 1)
            self.escribir_estado()
            self.assertEqual(extractor.salud(self.entorno), 0)
            self.assertEqual(extractor.estado(self.entorno), 0)
            self.escribir_estado(actualizado=time.time() - 3600)
            self.assertEqual(extractor.salud(self.entorno), 1)
            self.escribir_estado(ok=False)
            self.assertEqual(extractor.salud(self.entorno), 1)
            self.assertEqual(extractor.estado(self.entorno), 1)
        self.assertIn('OK: Correcto.', salida.getvalue())

    def test_estado_dice_que_motor_hay(self):
        for motor, texto in ((extractor.MOTOR_015, 'Stalwart 0.15 (API de gestión REST)'),
                             (extractor.MOTOR_016, 'Stalwart 0.16 (API de gestión JMAP)')):
            with self.subTest(motor=motor):
                self.escribir_estado(motor=motor)
                salida = io.StringIO()
                with mock.patch('sys.stdout', salida):
                    self.assertEqual(extractor.estado(self.entorno), 0)
                self.assertTrue(salida.getvalue().startswith('OK: Correcto.'),
                                'la primera línea sigue siendo el veredicto')
                self.assertIn(f'Motor: {texto}.', salida.getvalue())

    def test_purgar_retira_lo_ajeno_y_conserva_el_par_propio(self):
        volumen = self.raiz / 'volumen'
        (volumen / OTRO).mkdir(parents=True)
        (volumen / OTRO / 'key.pem').write_text('clave ajena')
        (volumen / HOST).mkdir()
        (volumen / HOST / 'cert.pem').write_text('propio')
        (volumen / 'datos').mkdir()
        (volumen / 'datos' / 'notas.txt').write_text('ajeno, pero no es un volcado')
        with mock.patch('sys.stdout', io.StringIO()):
            self.assertEqual(extractor.main(['purgar'], self.entorno), 0)
        self.assertFalse((volumen / OTRO).exists())
        self.assertTrue((volumen / HOST / 'cert.pem').exists())
        self.assertTrue((volumen / 'datos' / 'notas.txt').exists())

    def test_configuracion(self):
        with self.assertRaises(extractor.ConfiguracionInvalida):
            extractor.Configuracion.desde_entorno({'MAIL_HOSTNAME': 'mail_mal'})
        with self.assertRaises(extractor.ConfiguracionInvalida):
            extractor.Configuracion.desde_entorno({'MAIL_HOSTNAME': HOST})  # sin contraseña
        cfg = extractor.Configuracion.desde_entorno({'MAIL_HOSTNAME': 'Mail.Example.COM.',
                                                     'STALWART_ADMIN_PASSWORD': CLAVE})
        self.assertEqual(cfg.host, HOST)
        self.assertEqual(cfg.destino_tls, 'mailway-mail')
        self.assertEqual(cfg.puertos, (993, 465))
        self.assertEqual(cfg.gid_motor, 2000, 'el grupo de la imagen oficial de 0.16')
        self.assertNotIn(CLAVE, repr(cfg))
        base = {'MAIL_HOSTNAME': HOST, 'STALWART_ADMIN_PASSWORD': CLAVE}
        self.assertEqual(extractor.Configuracion.desde_entorno({**base, 'MAILWAY_TLS_GID_MOTOR': ' 0 '}).gid_motor, 0)
        for malo in ('stalwart', '-1', '4294967295', '2000:2000'):
            with self.subTest(gid=malo), self.assertRaises(extractor.ConfiguracionInvalida):
                extractor.Configuracion.desde_entorno({**base, 'MAILWAY_TLS_GID_MOTOR': malo})


if __name__ == '__main__':
    unittest.main()
