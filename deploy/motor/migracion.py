#!/usr/bin/env python3
"""Ayudante de «instalar.sh --migrar-motor» (Stalwart 0.15 → 0.16).

Lo ejecuta el instalador dentro de un contenedor efímero con la imagen de
Python de los compose, en la red interna (mailway-internal), con la carpeta de
trabajo de la migración en /trabajo y esta carpeta en /mailway (solo lectura):

    python -I -B /mailway/migracion.py <orden> [opciones]

Órdenes:

  volcar --url URL           Vuelca ajustes y principales del motor 0.15 con
                             el script oficial (migrate_v016.py dump). La
                             contraseña del administrador llega por la entrada
                             estándar: nunca en los argumentos.
  convertir --nombre HOST    Convierte el volcado (migrate_v016.py convert) y
                             ajusta el plan para Mailway: nombre del servidor y
                             dominio reservado de la instancia (el mismo que en
                             una instalación nueva). Exige RocksDB.
  recuperacion --url URL     En modo recuperación, tras «apply»: registro de
                             eventos en la salida estándar (sin él, el primer
                             arranque normal crea uno en /var/log/stalwart).
  comprobar --url URL --nombre HOST
                             Compara el motor 0.16 con el volcado de la 0.15:
                             dominios, buzones, alias, selectores DKIM,
                             nombre del servidor y escuchas.
  tls --host HOST --nombre HOST [--ca FICHERO]
                             Certificado servido en 993 y 465 (TLS implícito)
                             y 587 (STARTTLS): cadena, nombre y huella.

Cada orden escribe UNA línea JSON en la salida estándar ({"ok": …}); el texto
para las personas va a la de errores. Código 0 si todo va bien, 1 si hay un
problema y 2 si el uso es incorrecto. Nunca escribe contraseñas, hashes ni
claves privadas fuera de /trabajo (el volcado y el plan las contienen y
quedan con permisos 600).

Las dependencias del script oficial (requests, urllib3…) son ruedas de Python
puro que el instalador descarga con su sha256 en /trabajo/dependencias: se
importan directamente del .whl, sin pip ni acceso a Internet desde aquí.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import importlib.util
import json
import os
import re
import socket
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

TRABAJO = Path(os.environ.get('MAILWAY_MIGRACION_TRABAJO', '/trabajo'))
USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap']
# Escuchas que necesita Mailway en la 0.16: (protocolo, puerto, TLS implícito).
# 587 con STARTTLS la crea el panel (motor.js provisionar); las demás son las
# que la 0.16 crea en su primer arranque normal.
ESCUCHAS = [
    ('smtp', 25, False),
    ('smtp', 465, True),
    ('smtp', 587, False),
    ('imap', 993, True),
    ('manageSieve', 4190, False),
    ('http', 8080, False),
]
DESCRIPCION_RESERVADO = 'Dominio reservado del servidor de correo (Mailway)'


class Problema(Exception):
    """Error explicado para la persona que migra (sin secretos)."""


def avisar(texto: str) -> None:
    print(texto, file=sys.stderr, flush=True)


def responder(datos: dict, codigo: int = 0) -> int:
    print(json.dumps(datos, ensure_ascii=False, sort_keys=True), flush=True)
    return codigo


def leer_clave() -> str:
    clave = sys.stdin.readline().rstrip('\n')
    if not clave:
        raise Problema('No ha llegado la contraseña del motor por la entrada estándar.')
    return clave


def escribir_json(ruta: Path, datos) -> None:
    ruta.write_text(json.dumps(datos, ensure_ascii=False, indent=1, sort_keys=True) + '\n', encoding='utf-8')
    ruta.chmod(0o600)


# ----------------------------------------------------------- script oficial --

def explicar_aviso(linea: str) -> str | None:
    """Un aviso conocido del script oficial, explicado; None si no aporta nada."""
    # Los «tenants» son de la edición Enterprise de Stalwart: en la que usa
    # Mailway no hay ninguno que migrar.
    if "skipping principal type 'tenant'" in linea and 'Enterprise feature' in linea:
        return None
    # Certificados de ficheros (el que mantenía el extractor, u otro puesto a
    # mano): sus ficheros no están en este contenedor, y con la 0.16 el
    # certificado de IMAP y SMTP siempre lo pone el extractor.
    encontrado = re.match(r'\s*warning: skipping certificate\.([^:]+): could not resolve value', linea)
    if encontrado:
        return (f'   El certificado «{encontrado.group(1)}» de la 0.15 no se copia: con la 0.16, el de IMAP y SMTP '
                'lo pone el extractor desde Traefik.')
    return linea


class AvisosExplicados:
    """Salida de errores del script oficial, línea a línea y con sus avisos conocidos explicados."""

    def __init__(self, destino):
        self.destino = destino
        self.pendiente = ''

    def write(self, texto: str) -> int:
        self.pendiente += texto
        while '\n' in self.pendiente:
            linea, self.pendiente = self.pendiente.split('\n', 1)
            self._escribir(linea)
        return len(texto)

    def _escribir(self, linea: str) -> None:
        explicada = explicar_aviso(linea)
        if explicada is not None:
            self.destino.write(explicada + '\n')

    def flush(self) -> None:
        if self.pendiente:
            linea, self.pendiente = self.pendiente, ''
            self._escribir(linea)
        self.destino.flush()


@contextlib.contextmanager
def avisos_explicados():
    original = sys.stderr
    sys.stderr = AvisosExplicados(original)
    try:
        yield
    finally:
        sys.stderr.flush()
        sys.stderr = original


def cargar_script():
    """migrate_v016.py con sus dependencias (ruedas) en la ruta de importación."""
    dependencias = TRABAJO / 'dependencias'
    for rueda in sorted(dependencias.glob('*.whl')):
        sys.path.insert(0, str(rueda))
    spec = importlib.util.spec_from_file_location('migrate_v016', TRABAJO / 'migrate_v016.py')
    if spec is None or spec.loader is None:
        raise Problema('No se encuentra el script de conversión (migrate_v016.py).')
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


def principal_nombre(p: dict) -> str:
    v = p.get('name')
    if isinstance(v, str):
        return v
    if isinstance(v, list) and v:
        return str(v[0])
    return ''


def suspendido_015(principal: dict) -> bool:
    """¿Buzón suspendido en la 0.15? Sin el permiso de autenticarse (como
    suspende el panel) o sin el rol «user» (como suspendían sus versiones
    anteriores, si su corrección única aún no se ha hecho)."""
    return ('authenticate' in (principal.get('disabledPermissions') or [])
            or 'user' not in (principal.get('roles') or []))


def resumen_015(ajustes: dict, principales: list) -> dict:
    """Lo que debe aparecer en la 0.16: dominios, buzones, alias y firmas DKIM.

    Los selectores salen de signature.<id>.{domain,selector}. Las firmas
    rsa-sha1 no pasan a la 0.16 (el script las descarta): no se exigen.
    """
    dominios = sorted({principal_nombre(p).lower() for p in principales if p.get('type') == 'domain'} - {''})
    buzones = sorted({principal_nombre(p).lower() for p in principales if p.get('type') == 'individual'} - {''})
    alias = sorted({principal_nombre(p).lower() for p in principales if p.get('type') == 'list'} - {''})
    suspendidos = sorted(principal_nombre(p).lower() for p in principales
                         if p.get('type') == 'individual' and suspendido_015(p))
    firmas: dict[str, dict] = {}
    for clave, valor in ajustes.items():
        if not clave.startswith('signature.'):
            continue
        partes = clave.split('.')
        # signature.<id>.<campo>: el id puede llevar puntos (rsa-cliente.com).
        campo = partes[-1]
        ident = '.'.join(partes[1:-1])
        if campo in ('domain', 'selector', 'algorithm'):
            firmas.setdefault(ident, {})[campo] = str(valor)
    dkim = sorted({(f['domain'].lower(), f['selector']) for f in firmas.values()
                   if f.get('domain') and f.get('selector') and f.get('algorithm', '').lower() != 'rsa-sha1'})
    return {
        'dominios': dominios,
        'buzones': buzones,
        'alias': alias,
        'suspendidos': suspendidos,
        'dkim': [list(par) for par in dkim],
        'nombre': str(ajustes.get('server.hostname', '')),
    }


def ajustar_plan(operaciones: list[dict], nombre: str) -> list[dict]:
    """Ajusta el plan de «apply» para Mailway.

    - SystemSettings.defaultHostname: el nombre del servidor de correo. El
      script copia server.hostname; si la 0.15 no lo tenía, queda vacío y
      «apply» falla a mitad (invalidPatch) con el directorio ya creado.
    - Dominio por defecto: un dominio reservado con el nombre del servidor,
      sin DKIM, DNS ni certificado automáticos, como el que crea el arranque
      inicial de una instalación nueva. El script elige el dominio más
      frecuente, que suele ser el de un cliente, y el motor no deja borrar
      el dominio por defecto (objectIsLinked).
    """
    nombre = nombre.strip().lower().rstrip('.')
    if not nombre:
        raise Problema('Falta el nombre del servidor de correo (MAIL_HOSTNAME).')
    ref_reservado = None
    for op in operaciones:
        if op.get('@type') == 'create' and op.get('object') == 'Domain':
            for ref, valor in (op.get('value') or {}).items():
                if str(valor.get('name', '')).lower().rstrip('.') == nombre:
                    ref_reservado = ref
    if ref_reservado is None:
        ref_reservado = 'mailway-reservado'
        nuevo = {'@type': 'create', 'object': 'Domain', 'value': {ref_reservado: {
            'name': nombre,
            'description': DESCRIPCION_RESERVADO,
            'dkimManagement': {'@type': 'Manual'},
            'dnsManagement': {'@type': 'Manual'},
            'certificateManagement': {'@type': 'Manual'},
        }}}
        # Delante de todo: las demás operaciones no dependen de él.
        operaciones = [nuevo, *operaciones]
    ajustes = None
    for op in operaciones:
        if op.get('@type') == 'update' and op.get('object') == 'SystemSettings':
            ajustes = op
    if ajustes is None:
        ajustes = {'@type': 'update', 'object': 'SystemSettings', 'value': {}}
        operaciones = [*operaciones, ajustes]
    ajustes['value']['defaultHostname'] = nombre
    ajustes['value']['defaultDomainId'] = '#' + ref_reservado
    return operaciones


def recuento_plan(operaciones: list[dict]) -> dict:
    recuento: dict[str, int] = {}
    for op in operaciones:
        if op.get('@type') == 'create':
            recuento[op['object']] = recuento.get(op['object'], 0) + len(op.get('value') or {})
    return recuento


def orden_volcar(args) -> int:
    clave = leer_clave()
    script = cargar_script()
    with avisos_explicados():
        codigo = script.main(['dump', '--url', args.url, '--username', 'admin', '--password', clave,
                              '--settings', str(TRABAJO / 'settings.json'),
                              '--principals', str(TRABAJO / 'principals.json')])
    clave = ''
    if codigo != 0:
        raise Problema(f'El volcado del motor 0.15 ha fallado (código {codigo}).')
    for fichero in ('settings.json', 'principals.json'):
        (TRABAJO / fichero).chmod(0o600)
    ajustes = json.loads((TRABAJO / 'settings.json').read_text(encoding='utf-8'))
    principales = json.loads((TRABAJO / 'principals.json').read_text(encoding='utf-8'))
    resumen = resumen_015(ajustes, principales)
    escribir_json(TRABAJO / 'resumen-015.json', resumen)
    return responder({'ok': True, 'dominios': len(resumen['dominios']), 'buzones': len(resumen['buzones']),
                      'alias': len(resumen['alias']), 'suspendidos': len(resumen['suspendidos']),
                      'dkim': len(resumen['dkim'])})


def orden_convertir(args) -> int:
    script = cargar_script()
    with avisos_explicados():
        codigo = script.main(['convert', '--settings', str(TRABAJO / 'settings.json'),
                              '--principals', str(TRABAJO / 'principals.json'),
                              '--config', str(TRABAJO / 'config-script.json'),
                              '--output', str(TRABAJO / 'export-script.json'),
                              '--unmigrated-output', str(TRABAJO / 'sin-migrar.txt'),
                              '--patch-paths', '/opt/stalwart=/var/lib/stalwart'])
    if codigo != 0:
        raise Problema(f'La conversión del volcado ha fallado (código {codigo}).')
    almacen = json.loads((TRABAJO / 'config-script.json').read_text(encoding='utf-8'))
    # Mailway solo despliega RocksDB en el volumen del motor; el instalador
    # escribe su propio config.json para esa ruta. Otro almacén (PostgreSQL…)
    # no es una instalación de Mailway y no se migra a ciegas.
    if almacen.get('@type') != 'RocksDb':
        raise Problema(f"El motor 0.15 usa el almacén «{almacen.get('@type')}», no RocksDB: "
                       'esta migración solo admite el de una instalación de Mailway.')
    operaciones = [json.loads(linea) for linea in
                   (TRABAJO / 'export-script.json').read_text(encoding='utf-8').splitlines() if linea.strip()]
    # El script reescribe las rutas de /opt/stalwart; una que quede apuntaría
    # a un sitio que no existe en la imagen 0.16 (y que el usuario 2000 no
    # puede crear).
    texto = json.dumps(operaciones)
    if '/opt/stalwart' in texto:
        raise Problema('El plan de la 0.16 aún contiene rutas de /opt/stalwart: no se puede aplicar tal cual.')
    operaciones = ajustar_plan(operaciones, args.nombre)
    with open(TRABAJO / 'export.json', 'w', encoding='utf-8') as salida:
        for op in operaciones:
            salida.write(json.dumps(op, ensure_ascii=False) + '\n')
    (TRABAJO / 'export.json').chmod(0o600)
    for fichero in ('export-script.json', 'config-script.json'):
        (TRABAJO / fichero).unlink(missing_ok=True)
    return responder({'ok': True, 'operaciones': len(operaciones), 'crear': recuento_plan(operaciones)})


# --------------------------------------------------------------------- JMAP --

class Jmap:
    def __init__(self, url: str, clave: str):
        self.url = url.rstrip('/') + '/jmap'
        self.cabecera = 'Basic ' + base64.b64encode(f'admin:{clave}'.encode()).decode()
        self.abridor = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def llamar(self, llamadas: list) -> list:
        peticion = urllib.request.Request(
            self.url, method='POST', data=json.dumps({'using': USING, 'methodCalls': llamadas}).encode(),
            headers={'Authorization': self.cabecera, 'Content-Type': 'application/json'})
        try:
            with self.abridor.open(peticion, timeout=60) as respuesta:
                datos = json.load(respuesta)
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise Problema(f'El motor 0.16 rechaza la credencial de administración (HTTP {error.code}).') from None
            raise Problema(f'El motor 0.16 respondió HTTP {error.code} a la petición JMAP.') from None
        except (urllib.error.URLError, OSError) as error:
            raise Problema(f'No se puede hablar con el motor 0.16: {error}') from None
        respuestas = datos.get('methodResponses') or []
        for nombre, cuerpo, _ in respuestas:
            if nombre == 'error':
                raise Problema(f"El motor 0.16 rechazó la petición: {cuerpo.get('type')} {cuerpo.get('description', '')}".strip())
        return respuestas

    def todos(self, objeto: str, propiedades: list[str]) -> list[dict]:
        """Todos los objetos de un tipo (query + get con referencia, por páginas)."""
        lista: list[dict] = []
        posicion = 0
        while True:
            respuestas = self.llamar([
                [f'x:{objeto}/query', {'position': posicion, 'limit': 500}, 'q'],
                [f'x:{objeto}/get', {'#ids': {'resultOf': 'q', 'name': f'x:{objeto}/query', 'path': '/ids'},
                                     'properties': propiedades}, 'g'],
            ])
            ids = respuestas[0][1].get('ids') or []
            lista.extend(respuestas[1][1].get('list') or [])
            if len(ids) < 500:
                return lista
            posicion += len(ids)


def orden_recuperacion(args) -> int:
    motor = Jmap(args.url, leer_clave())
    trazas = motor.todos('Tracer', ['@type'])
    creado = False
    if not any(t.get('@type') == 'Stdout' for t in trazas):
        respuesta = motor.llamar([['x:Tracer/set', {'create': {'salida': {
            '@type': 'Stdout', 'ansi': False, 'buffered': False, 'enable': True, 'level': 'info'}}}, 't']])
        if 'salida' not in (respuesta[0][1].get('created') or {}):
            raise Problema(f"El motor no ha creado el registro de eventos: {respuesta[0][1].get('notCreated')}")
        creado = True
    return responder({'ok': True, 'registroCreado': creado})


def comparar(resumen: dict, estado: dict, nombre: str) -> tuple[list[str], list[str]]:
    """Problemas (impiden seguir) y avisos de la 0.16 frente al volcado de la 0.15."""
    problemas: list[str] = []
    avisos: list[str] = []
    nombre = nombre.lower().rstrip('.')
    dominios = {d.lower() for d in estado['dominios']}
    for falta in sorted(set(resumen['dominios']) - dominios):
        problemas.append(f'Falta el dominio {falta}.')
    if nombre not in dominios:
        problemas.append(f'Falta el dominio reservado {nombre}.')
    buzones = {b.lower() for b in estado['buzones']}
    for falta in sorted(set(resumen['buzones']) - buzones):
        problemas.append(f'Falta el buzón {falta}.')
    alias = {a.lower() for a in estado['alias']}
    for falta in sorted(set(resumen['alias']) - alias):
        problemas.append(f'Falta el alias {falta}.')
    firmas = {(d.lower(), s) for d, s in estado['dkim']}
    antes = {(d, s) for d, s in resumen['dkim']}
    for dominio, selector in sorted(antes - firmas):
        problemas.append(f'Falta la firma DKIM {selector} de {dominio}.')
    for dominio, selector in sorted(firmas - antes):
        if dominio != nombre:
            avisos.append(f'Firma DKIM nueva {selector} en {dominio}: publica su registro antes de que la use '
                          '(la ficha del dominio en el panel la muestra).')
    if estado['nombre'].lower().rstrip('.') != nombre:
        problemas.append(f"El motor se identifica como «{estado['nombre']}», no como {nombre}.")
    for protocolo, puerto, implicito in ESCUCHAS:
        if not any(e['protocolo'] == protocolo and e['puerto'] == puerto and e['implicito'] == implicito
                   for e in estado['escuchas']):
            tipo = 'TLS implícito' if implicito else ('STARTTLS' if protocolo != 'http' else 'HTTP')
            problemas.append(f'Falta la escucha {protocolo} en {puerto} ({tipo}).')
    return problemas, avisos


def estado_016(motor: Jmap) -> dict:
    dominios = motor.todos('Domain', ['name'])
    por_id = {d['id']: str(d.get('name', '')).lower() for d in dominios}
    cuentas = motor.todos('Account', ['@type', 'emailAddress'])
    listas = motor.todos('MailingList', ['emailAddress'])
    firmas = motor.todos('DkimSignature', ['domainId', 'selector'])
    escuchas = motor.todos('NetworkListener', ['protocol', 'bind', 'tlsImplicit'])
    ajustes = motor.llamar([['x:SystemSettings/get', {'ids': ['singleton'], 'properties': ['defaultHostname']}, 's']])
    lista = ajustes[0][1].get('list') or [{}]
    puertos = []
    for e in escuchas:
        for direccion in (e.get('bind') or {}):
            try:
                puerto = int(str(direccion).rsplit(':', 1)[1])
            except (IndexError, ValueError):
                continue
            puertos.append({'protocolo': e.get('protocol'), 'puerto': puerto, 'implicito': bool(e.get('tlsImplicit'))})
    return {
        'dominios': sorted(por_id.values()),
        'buzones': sorted(str(c.get('emailAddress', '')).lower() for c in cuentas if c.get('@type') == 'User'),
        'alias': sorted(str(lista_.get('emailAddress', '')).lower() for lista_ in listas),
        'dkim': sorted([por_id.get(f.get('domainId'), '?'), f.get('selector', '')] for f in firmas),
        'escuchas': puertos,
        'nombre': str(lista[0].get('defaultHostname', '')),
    }


def orden_comprobar(args) -> int:
    motor = Jmap(args.url, leer_clave())
    resumen = json.loads((TRABAJO / 'resumen-015.json').read_text(encoding='utf-8'))
    estado = estado_016(motor)
    problemas, avisos = comparar(resumen, estado, args.nombre)
    for aviso in avisos:
        avisar('Aviso: ' + aviso)
    datos = {'ok': not problemas, 'problemas': problemas, 'avisos': avisos,
             'recuento': {'dominios': len(estado['dominios']), 'buzones': len(estado['buzones']),
                          'alias': len(estado['alias']), 'dkim': len(estado['dkim'])}}
    return responder(datos, 0 if not problemas else 1)


# ---------------------------------------------------------------------- TLS --

def sondear(host: str, puerto: int, nombre: str, contexto: ssl.SSLContext, starttls: bool) -> dict:
    try:
        conexion = socket.create_connection((host, puerto), timeout=15)
    except OSError as error:
        return {'ok': False, 'error': f'no conecta: {error}'}
    try:
        conexion.settimeout(15)
        if starttls:
            lector = conexion.makefile('rb')
            saludo = lector.readline()
            if not saludo.startswith(b'220'):
                return {'ok': False, 'error': 'el servidor SMTP no saluda con 220'}
            conexion.sendall(b'EHLO mailway-migracion\r\n')
            while True:
                linea = lector.readline()
                if not linea or linea[3:4] != b'-':
                    break
            conexion.sendall(b'STARTTLS\r\n')
            if not lector.readline().startswith(b'220'):
                return {'ok': False, 'error': 'el servidor no admite STARTTLS'}
        try:
            segura = contexto.wrap_socket(conexion, server_hostname=nombre)
        except ssl.SSLCertVerificationError as error:
            return {'ok': False, 'error': f'certificado no válido: {error.verify_message}'}
        except (ssl.SSLError, OSError) as error:
            return {'ok': False, 'error': f'TLS: {error}'}
        huella = hashlib.sha256(segura.getpeercert(True)).hexdigest()
        segura.close()
        return {'ok': True, 'huella': huella}
    finally:
        try:
            conexion.close()
        except OSError:
            pass


def orden_tls(args) -> int:
    contexto = ssl.create_default_context(cafile=args.ca) if args.ca else ssl.create_default_context()
    puertos = {str(p): sondear(args.host, p, args.nombre, contexto, starttls=(p == 587)) for p in (993, 465, 587)}
    huellas = {r['huella'] for r in puertos.values() if r.get('ok')}
    ok = all(r.get('ok') for r in puertos.values()) and len(huellas) == 1
    datos = {'ok': ok, 'puertos': puertos}
    if all(r.get('ok') for r in puertos.values()) and len(huellas) > 1:
        datos['error'] = 'los tres puertos no sirven el mismo certificado'
    return responder(datos, 0 if ok else 1)


def main(argv: list[str] | None = None) -> int:
    os.umask(0o077)
    analizador = argparse.ArgumentParser(description='Ayudante de la migración de Stalwart 0.15 a 0.16.')
    ordenes = analizador.add_subparsers(dest='orden', required=True)
    o = ordenes.add_parser('volcar')
    o.add_argument('--url', required=True)
    o = ordenes.add_parser('convertir')
    o.add_argument('--nombre', required=True)
    o = ordenes.add_parser('recuperacion')
    o.add_argument('--url', required=True)
    o = ordenes.add_parser('comprobar')
    o.add_argument('--url', required=True)
    o.add_argument('--nombre', required=True)
    o = ordenes.add_parser('tls')
    o.add_argument('--host', required=True)
    o.add_argument('--nombre', required=True)
    o.add_argument('--ca')
    try:
        args = analizador.parse_args(argv)
    except SystemExit as salida:
        return 2 if salida.code else 0
    try:
        return {'volcar': orden_volcar, 'convertir': orden_convertir, 'recuperacion': orden_recuperacion,
                'comprobar': orden_comprobar, 'tls': orden_tls}[args.orden](args)
    except Problema as problema:
        return responder({'ok': False, 'error': str(problema)}, 1)


if __name__ == '__main__':
    sys.exit(main())
