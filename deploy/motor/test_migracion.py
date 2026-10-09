"""Pruebas del ayudante de la migración a Stalwart 0.16 (deploy/motor/migracion.py).

Sin Docker ni red: un servidor JMAP de laboratorio en 127.0.0.1 que responde
como Stalwart 0.16 a lo que pregunta el ayudante, y un «script oficial»
simulado en la carpeta de trabajo para el volcado y la conversión.

    python3 -m unittest discover -s deploy/motor -v
"""
from __future__ import annotations

import base64
import io
import json
import os
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import migracion

CLAVE = 'clave-del-motor-que-no-debe-salir'
NOMBRE = 'mail.ejemplo.test'

AJUSTES_015 = {
    'server.hostname': NOMBRE,
    'signature.ed25519-a.ejemplo.test.domain': 'a.ejemplo.test',
    'signature.ed25519-a.ejemplo.test.selector': '202610e',
    'signature.ed25519-a.ejemplo.test.algorithm': 'ed25519-sha256',
    'signature.rsa-a.ejemplo.test.domain': 'a.ejemplo.test',
    'signature.rsa-a.ejemplo.test.selector': '202610r',
    'signature.rsa-a.ejemplo.test.algorithm': 'rsa-sha256',
    'signature.viejo.domain': 'b.ejemplo.test',
    'signature.viejo.selector': 'antiguo',
    'signature.viejo.algorithm': 'rsa-sha1',
    'signature.rsa-a.ejemplo.test.private-key': '-----BEGIN RSA PRIVATE KEY-----\nsecreto\n',
}
PRINCIPALES_015 = [
    {'type': 'domain', 'name': 'a.ejemplo.test'},
    {'type': 'domain', 'name': 'B.Ejemplo.Test'},
    {'type': 'individual', 'name': 'ana@a.ejemplo.test', 'roles': ['user'], 'secrets': ['$6$sal$hash']},
    {'type': 'individual', 'name': 'eva@b.ejemplo.test', 'roles': [], 'secrets': ['$6$sal$hash']},
    {'type': 'list', 'name': 'ventas@a.ejemplo.test', 'members': ['ana@a.ejemplo.test']},
]


class Resumen(unittest.TestCase):
    def test_lo_que_debe_aparecer_en_la_016(self):
        r = migracion.resumen_015(AJUSTES_015, PRINCIPALES_015)
        self.assertEqual(r['dominios'], ['a.ejemplo.test', 'b.ejemplo.test'])
        self.assertEqual(r['buzones'], ['ana@a.ejemplo.test', 'eva@b.ejemplo.test'])
        self.assertEqual(r['alias'], ['ventas@a.ejemplo.test'])
        self.assertEqual(r['suspendidos'], ['eva@b.ejemplo.test'])
        self.assertEqual(r['nombre'], NOMBRE)

    def test_suspendidos_de_las_dos_formas(self):
        principales = [
            {'type': 'individual', 'name': 'ana@a.ejemplo.test', 'roles': ['user'], 'disabledPermissions': []},
            {'type': 'individual', 'name': 'eva@a.ejemplo.test', 'roles': []},
            {'type': 'individual', 'name': 'leo@a.ejemplo.test', 'roles': ['user'],
             'disabledPermissions': ['authenticate', 'authenticate-oauth']},
        ]
        r = migracion.resumen_015({}, principales)
        self.assertEqual(r['suspendidos'], ['eva@a.ejemplo.test', 'leo@a.ejemplo.test'])

    def test_selectores_dkim_sin_rsa_sha1_ni_claves(self):
        r = migracion.resumen_015(AJUSTES_015, PRINCIPALES_015)
        self.assertEqual(r['dkim'], [['a.ejemplo.test', '202610e'], ['a.ejemplo.test', '202610r']])
        self.assertNotIn('secreto', json.dumps(r))


class Plan(unittest.TestCase):
    def plan(self):
        return [
            {'@type': 'create', 'object': 'Domain', 'value': {'create-0': {'name': 'a.ejemplo.test'}}},
            {'@type': 'create', 'object': 'Account', 'value': {'restore-3': {'name': 'ana', 'domainId': '#create-0'}}},
            {'@type': 'update', 'object': 'SystemSettings', 'value': {'defaultDomainId': '#create-0', 'defaultHostname': ''}},
        ]

    def test_nombre_y_dominio_reservado(self):
        plan = migracion.ajustar_plan(self.plan(), 'Mail.Ejemplo.Test.')
        reservado = plan[0]
        self.assertEqual(reservado['object'], 'Domain')
        valor = reservado['value']['mailway-reservado']
        self.assertEqual(valor['name'], NOMBRE)
        # Como el del arranque inicial: sin DKIM, DNS ni certificado automáticos.
        for campo in ('dkimManagement', 'dnsManagement', 'certificateManagement'):
            self.assertEqual(valor[campo], {'@type': 'Manual'})
        ajustes = [op for op in plan if op['object'] == 'SystemSettings'][0]['value']
        self.assertEqual(ajustes['defaultHostname'], NOMBRE)
        self.assertEqual(ajustes['defaultDomainId'], '#mailway-reservado')
        self.assertEqual(migracion.recuento_plan(plan), {'Domain': 2, 'Account': 1})

    def test_si_el_dominio_reservado_ya_existe_lo_reutiliza(self):
        plan = self.plan()
        plan[0]['value']['create-9'] = {'name': NOMBRE}
        plan = migracion.ajustar_plan(plan, NOMBRE)
        self.assertEqual(migracion.recuento_plan(plan), {'Domain': 2, 'Account': 1})
        ajustes = [op for op in plan if op['object'] == 'SystemSettings'][0]['value']
        self.assertEqual(ajustes['defaultDomainId'], '#create-9')

    def test_sin_ajustes_del_sistema_los_anade(self):
        plan = migracion.ajustar_plan(self.plan()[:2], NOMBRE)
        self.assertEqual(plan[-1], {'@type': 'update', 'object': 'SystemSettings',
                                    'value': {'defaultHostname': NOMBRE, 'defaultDomainId': '#mailway-reservado'}})

    def test_sin_nombre_no_sigue(self):
        with self.assertRaises(migracion.Problema):
            migracion.ajustar_plan(self.plan(), '  ')


def estado_bueno():
    return {
        'dominios': ['a.ejemplo.test', 'b.ejemplo.test', NOMBRE],
        'buzones': ['ana@a.ejemplo.test', 'eva@b.ejemplo.test'],
        'alias': ['ventas@a.ejemplo.test'],
        'dkim': [['a.ejemplo.test', '202610e'], ['a.ejemplo.test', '202610r']],
        'escuchas': [{'protocolo': p, 'puerto': n, 'implicito': i} for p, n, i in migracion.ESCUCHAS],
        'nombre': NOMBRE,
    }


class Comparacion(unittest.TestCase):
    def setUp(self):
        self.resumen = migracion.resumen_015(AJUSTES_015, PRINCIPALES_015)

    def test_todo_en_su_sitio(self):
        self.assertEqual(migracion.comparar(self.resumen, estado_bueno(), NOMBRE), ([], []))

    def test_lo_que_falta_impide_seguir(self):
        estado = estado_bueno()
        estado['buzones'].remove('eva@b.ejemplo.test')
        estado['alias'] = []
        estado['dkim'] = [['a.ejemplo.test', '202610e']]
        estado['escuchas'] = [e for e in estado['escuchas'] if e['puerto'] != 587]
        estado['nombre'] = 'otro.test'
        problemas, _ = migracion.comparar(self.resumen, estado, NOMBRE)
        self.assertIn('Falta el buzón eva@b.ejemplo.test.', problemas)
        self.assertIn('Falta el alias ventas@a.ejemplo.test.', problemas)
        self.assertIn('Falta la firma DKIM 202610r de a.ejemplo.test.', problemas)
        self.assertIn('Falta la escucha smtp en 587 (STARTTLS).', problemas)
        self.assertIn(f'El motor se identifica como «otro.test», no como {NOMBRE}.', problemas)

    def test_escucha_con_otro_tls_no_vale(self):
        estado = estado_bueno()
        for e in estado['escuchas']:
            if e['puerto'] == 993:
                e['implicito'] = False
        problemas, _ = migracion.comparar(self.resumen, estado, NOMBRE)
        self.assertEqual(problemas, ['Falta la escucha imap en 993 (TLS implícito).'])

    def test_firma_nueva_es_un_aviso_salvo_en_el_dominio_reservado(self):
        estado = estado_bueno()
        estado['dkim'] += [['b.ejemplo.test', 'v1-ed25519-20261009'], [NOMBRE, 'v1-rsa-20261009']]
        problemas, avisos = migracion.comparar(self.resumen, estado, NOMBRE)
        self.assertEqual(problemas, [])
        self.assertEqual(len(avisos), 1)
        self.assertIn('v1-ed25519-20261009 en b.ejemplo.test', avisos[0])


class JmapDeLaboratorio(BaseHTTPRequestHandler):
    """Responde como Stalwart 0.16 a las peticiones del ayudante."""

    objetos: dict = {}
    creados: list = []
    peticiones: list = []

    def log_message(self, *args):  # sin ruido en la salida de las pruebas
        pass

    def do_POST(self):
        cuerpo = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        type(self).peticiones.append(cuerpo)
        esperado = 'Basic ' + base64.b64encode(f'admin:{CLAVE}'.encode()).decode()
        if self.headers.get('Authorization') != esperado:
            self.send_response(401)
            self.end_headers()
            return
        respuestas = []
        for nombre, argumentos, etiqueta in cuerpo['methodCalls']:
            objeto, metodo = nombre[2:].split('/')
            lista = type(self).objetos.get(objeto, [])
            if metodo == 'query':
                ids = [o['id'] for o in lista][argumentos.get('position', 0):][:argumentos.get('limit', 500)]
                respuestas.append([nombre, {'ids': ids}, etiqueta])
            elif metodo == 'get':
                respuestas.append([nombre, {'list': lista}, etiqueta])
            elif metodo == 'set':
                creados = {}
                for ref, valor in argumentos.get('create', {}).items():
                    type(self).creados.append((objeto, valor))
                    creados[ref] = {'id': 'nuevo'}
                respuestas.append([nombre, {'created': creados}, etiqueta])
        datos = json.dumps({'methodResponses': respuestas}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(datos)


class ConMotor(unittest.TestCase):
    def setUp(self):
        self.carpeta = tempfile.TemporaryDirectory()
        self.trabajo = Path(self.carpeta.name)
        JmapDeLaboratorio.objetos = {
            'Domain': [{'id': 'a', 'name': 'a.ejemplo.test'}, {'id': 'b', 'name': 'b.ejemplo.test'},
                       {'id': 'r', 'name': NOMBRE}],
            'Account': [{'id': '3', '@type': 'User', 'emailAddress': 'ana@a.ejemplo.test'},
                        {'id': '5', '@type': 'User', 'emailAddress': 'eva@b.ejemplo.test'}],
            'MailingList': [{'id': 'l', 'emailAddress': 'ventas@a.ejemplo.test'}],
            'DkimSignature': [{'id': 'k1', 'domainId': 'a', 'selector': '202610e'},
                              {'id': 'k2', 'domainId': 'a', 'selector': '202610r'}],
            'NetworkListener': [{'id': str(n), 'protocol': p, 'bind': {f'[::]:{n}': True}, 'tlsImplicit': i}
                                for p, n, i in migracion.ESCUCHAS],
            'SystemSettings': [{'id': 'singleton', 'defaultHostname': NOMBRE}],
            'Tracer': [],
        }
        JmapDeLaboratorio.creados = []
        JmapDeLaboratorio.peticiones = []
        self.servidor = ThreadingHTTPServer(('127.0.0.1', 0), JmapDeLaboratorio)
        threading.Thread(target=self.servidor.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.servidor.server_address[1]}'
        (self.trabajo / 'resumen-015.json').write_text(json.dumps(migracion.resumen_015(AJUSTES_015, PRINCIPALES_015)))
        self.parche = mock.patch.object(migracion, 'TRABAJO', self.trabajo)
        self.parche.start()

    def tearDown(self):
        self.parche.stop()
        self.servidor.shutdown()
        self.servidor.server_close()
        self.carpeta.cleanup()

    def ejecutar(self, *argumentos, entrada=CLAVE + '\n'):
        salida = io.StringIO()
        with mock.patch('sys.stdin', io.StringIO(entrada)), redirect_stdout(salida), \
                mock.patch('sys.stderr', io.StringIO()):
            codigo = migracion.main(list(argumentos))
        return codigo, json.loads(salida.getvalue())

    def test_comprobar_sin_diferencias(self):
        codigo, datos = self.ejecutar('comprobar', '--url', self.url, '--nombre', NOMBRE)
        self.assertEqual(codigo, 0, datos)
        self.assertEqual(datos['recuento'], {'dominios': 3, 'buzones': 2, 'alias': 1, 'dkim': 2})
        # Una sola petición por tipo de objeto: la credencial no se repite en vano.
        self.assertTrue(all(len(p['methodCalls']) <= 16 for p in JmapDeLaboratorio.peticiones))

    def test_comprobar_con_un_buzon_de_menos(self):
        JmapDeLaboratorio.objetos['Account'].pop()
        codigo, datos = self.ejecutar('comprobar', '--url', self.url, '--nombre', NOMBRE)
        self.assertEqual(codigo, 1)
        self.assertEqual(datos['problemas'], ['Falta el buzón eva@b.ejemplo.test.'])

    def test_credencial_rechazada(self):
        codigo, datos = self.ejecutar('comprobar', '--url', self.url, '--nombre', NOMBRE, entrada='otra\n')
        self.assertEqual(codigo, 1)
        self.assertIn('rechaza la credencial', datos['error'])
        self.assertNotIn('otra', json.dumps(datos))

    def test_sin_clave_no_hace_nada(self):
        codigo, datos = self.ejecutar('comprobar', '--url', self.url, '--nombre', NOMBRE, entrada='')
        self.assertEqual(codigo, 1)
        self.assertEqual(JmapDeLaboratorio.peticiones, [])

    def test_recuperacion_crea_el_registro_en_la_salida_estandar(self):
        codigo, datos = self.ejecutar('recuperacion', '--url', self.url)
        self.assertEqual((codigo, datos), (0, {'ok': True, 'registroCreado': True}))
        self.assertEqual(JmapDeLaboratorio.creados, [('Tracer', {'@type': 'Stdout', 'ansi': False, 'buffered': False,
                                                                'enable': True, 'level': 'info'})])

    def test_recuperacion_no_duplica_el_registro(self):
        JmapDeLaboratorio.objetos['Tracer'] = [{'id': 't', '@type': 'Stdout'}]
        codigo, datos = self.ejecutar('recuperacion', '--url', self.url)
        self.assertEqual((codigo, datos), (0, {'ok': True, 'registroCreado': False}))
        self.assertEqual(JmapDeLaboratorio.creados, [])

    def test_volcar_y_convertir_con_el_script_simulado(self):
        # Un migrate_v016.py mínimo que se comporta como el oficial: recibe la
        # contraseña como argumento (dentro del proceso) y escribe los ficheros.
        (self.trabajo / 'dependencias').mkdir()
        (self.trabajo / 'migrate_v016.py').write_text('''
import json, sys
AJUSTES = %r
PRINCIPALES = %r
def main(argv):
    a = dict(zip(argv[1::2], argv[2::2]))
    if argv[0] == 'dump':
        assert a['--password'] == %r
        json.dump(AJUSTES, open(a['--settings'], 'w'))
        json.dump(PRINCIPALES, open(a['--principals'], 'w'))
        return 0
    json.dump({'@type': 'RocksDb', 'path': '/var/lib/stalwart/data'}, open(a['--config'], 'w'))
    with open(a['--output'], 'w') as f:
        f.write(json.dumps({'@type': 'create', 'object': 'Domain', 'value': {'create-0': {'name': 'a.ejemplo.test'}}}) + '\\n')
        f.write(json.dumps({'@type': 'update', 'object': 'SystemSettings', 'value': {'defaultDomainId': '#create-0', 'defaultHostname': ''}}) + '\\n')
    open(a['--unmigrated-output'], 'w').write('# Unmigrated\\n')
    return 0
''' % (AJUSTES_015, PRINCIPALES_015, CLAVE))
        codigo, datos = self.ejecutar('volcar', '--url', self.url)
        self.assertEqual((codigo, datos['ok'], datos['buzones'], datos['suspendidos']), (0, True, 2, 1))
        self.assertNotIn(CLAVE, json.dumps(datos))
        self.assertEqual(oct((self.trabajo / 'settings.json').stat().st_mode & 0o777), '0o600')
        codigo, datos = self.ejecutar('convertir', '--nombre', NOMBRE)
        self.assertEqual(codigo, 0, datos)
        self.assertEqual(datos['crear'], {'Domain': 2})
        plan = [json.loads(l) for l in (self.trabajo / 'export.json').read_text().splitlines()]
        self.assertEqual(plan[-1]['value']['defaultHostname'], NOMBRE)
        self.assertFalse((self.trabajo / 'export-script.json').exists())

    def test_convertir_rechaza_otro_almacen(self):
        (self.trabajo / 'dependencias').mkdir()
        (self.trabajo / 'migrate_v016.py').write_text('''
import json
def main(argv):
    a = dict(zip(argv[1::2], argv[2::2]))
    json.dump({'@type': 'PostgreSql'}, open(a['--config'], 'w'))
    open(a['--output'], 'w').write('')
    return 0
''')
        codigo, datos = self.ejecutar('convertir', '--nombre', NOMBRE)
        self.assertEqual(codigo, 1)
        self.assertIn('PostgreSql', datos['error'])


class AvisosDelScript(unittest.TestCase):
    def filtrar(self, *escrituras: str) -> str:
        salida = io.StringIO()
        filtro = migracion.AvisosExplicados(salida)
        for texto in escrituras:
            filtro.write(texto)
        filtro.flush()
        return salida.getvalue()

    def test_el_progreso_pasa_tal_cual(self):
        self.assertEqual(self.filtrar('Fetching settings...\n', '  wrote 3 settings', ' keys\n'),
                         'Fetching settings...\n  wrote 3 settings keys\n')

    def test_sin_tenants_en_la_edicion_de_mailway(self):
        aviso = ("  WARN skipping principal type 'tenant': Server error on /api/principal: "
                 "{'error': 'unsupported', 'details': 'Enterprise feature'}\n")
        self.assertEqual(self.filtrar(aviso, 'found 6 principals\n'), 'found 6 principals\n')
        # Otro error con los tenants sí se ve.
        self.assertIn('Timeout', self.filtrar("  WARN skipping principal type 'tenant': Timeout\n"))

    def test_certificado_de_ficheros_explicado(self):
        texto = self.filtrar("warning: skipping certificate.mailway: could not resolve value: cannot read file "
                             "'/opt/stalwart/certs/mail.ejemplo.test/cert.pem'\n")
        self.assertIn('El certificado «mailway» de la 0.15 no se copia', texto)
        self.assertNotIn('/opt/stalwart/certs', texto)

    def test_sin_salto_de_linea_final_tambien_sale(self):
        self.assertEqual(self.filtrar('ultima linea'), 'ultima linea\n')


class Uso(unittest.TestCase):
    def test_orden_desconocida(self):
        with redirect_stdout(io.StringIO()), mock.patch('sys.stderr', io.StringIO()):
            self.assertEqual(migracion.main(['otra']), 2)


if __name__ == '__main__':
    unittest.main()
