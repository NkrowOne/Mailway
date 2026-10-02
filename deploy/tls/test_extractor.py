"""Pruebas del extractor del certificado (deploy/tls/extractor.py).

Sin Docker ni red: un motor de laboratorio (API de gestión y dos escuchas TLS
en 127.0.0.1 que se comportan como Stalwart al recargar) y certificados
generados con openssl en una carpeta temporal.

    python3 -m unittest discover -s deploy/tls -v
"""
from __future__ import annotations

import base64
import datetime as dt
import io
import json
import os
import socketserver
import ssl
import stat
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import extractor
from laboratorio import Laboratorio, Par, acme_json

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
    """API de gestión y escuchas TLS que imitan a Stalwart 0.15.

    Al recargar lee <volumen>/<HOST>/cert.pem y key.pem (siguiendo el enlace),
    como hace el motor con certificate.mailway; mientras no recarga, sigue
    sirviendo lo que tenía en memoria.
    """

    def __init__(self, volumen: Path):
        self.volumen = volumen
        self.ajustes = dict(REFERENCIA)
        self.peticiones: list = []
        self.recargas = 0
        self.forzar_codigo = None
        self.errores_recarga = None
        self.recarga_sin_efecto = False
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

            def do_GET(self):  # noqa: N802 (API de http.server)
                url = urllib.parse.urlsplit(self.path)
                motor.peticiones.append(url.path)
                if motor.forzar_codigo:
                    return self.responder(motor.forzar_codigo, {'status': motor.forzar_codigo, 'title': 'Unauthorized'})
                if self.headers.get('Authorization') != esperado:
                    return self.responder(401, {'status': 401, 'title': 'Unauthorized'})
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
            fichero_estado=self.raiz / 'estado' / 'estado.json')
        self.ext = extractor.Extractor(self.cfg, reloj=lambda: self.tiempo, dormir=lambda segundos: None,
                                       salida=self.registro)

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
        self.assertNotIn(CLAVE, repr(cfg))


if __name__ == '__main__':
    unittest.main()
