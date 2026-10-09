#!/usr/bin/env python3
"""Prueba de la pila de correo con contenedores reales (CI, máquina desechable).

Monta con el instalador (deploy/instalar.sh --actualizar) el motor, Roundcube
y el extractor del certificado (perfil «tls») con la topología de
deploy/docker-compose.mail.yml: red interna con subred fija, red skyway-edge y
un Traefik de Skyway simulado del que solo se usa su volumen de certificados
(acme.json con certificados de laboratorio). Tres modos:

  --motor stalwart-0.15   la pila con Stalwart 0.15 (las instalaciones de
                          antes de la 0.16): además, el extractor sustituye al
                          volcado antiguo (migra su carpeta, retira las claves
                          de otros dominios y deja solo el par del servidor).
  --motor stalwart-0.16   una instalación nueva con Stalwart 0.16: primer
                          arranque («bootstrap»), ajustes de Mailway con la
                          herramienta del motor del panel (simulada:
                          deploy/prueba-panel-motor.js), sin la cuenta admin@
                          del primer arranque, registro en docker logs, el 587
                          con STARTTLS y, con un Traefik real, las rutas del
                          nombre del servidor de correo (solo lo que necesitan
                          los programas de correo; la administración y el
                          autoservicio del motor, 403).
  --bulwark               la de --motor stalwart-0.16 más Bulwark activado con
                          «instalar.sh --activar-bulwark»: sus dos contenedores
                          sanos, solo en las redes internas y sin puertos
                          publicados; la API de administración solo por dentro
                          (404 por la pasarela); el acceso con un buzón por la
                          red exenta y el certificado del 443 interno; los
                          secretos generados una vez y nunca a la vista;
                          --comprobar y --estado-bulwark; una actualización no
                          lo recrea; desactivarlo conserva volúmenes y secretos
                          y activarlo de nuevo recupera la misma administración.
  --migracion             un servidor con Stalwart 0.15 y datos (dos dominios
                          con DKIM, buzones con su contraseña, uno suspendido,
                          un alias con un destino externo y un correo
                          entregado) pasa a la 0.16 con
                          «instalar.sh --migrar-motor -y»: primero un intento
                          que falla a propósito (vuelve solo a la 0.15 sin
                          perder nada), después la migración (el mismo correo
                          se lee por IMAP con la misma contraseña; alias,
                          firmas DKIM y suspensión intactos), --revertir-motor,
                          otra migración y --retirar-motor-anterior.

Con los dos motores, además, Traefik (proveedor Docker, con las etiquetas de
verdad) llega al motor por su pasarela (mailway-mail-gw): el servicio de
Traefik apunta a ella, las respuestas salen de ella y un X-Forwarded-For o un
Forwarded falsos no le llegan al motor (la pasarela anota la IP real).

En los dos primeros modos se comprueban además el certificado servido en 993 y
465 (cadena, nombre y huella), el inicio de sesión IMAP desde el webmail
(biblioteca de Roundcube) y desde fuera, la autenticación SMTP en 465 y 587
(STARTTLS) sin enviar correo, la pantalla de acceso del webmail, la renovación
y el paso a un certificado comodín aplicados por el extractor, y
deploy/instalar.sh --comprobar y --probar-acceso.

Credenciales desechables y dominios .test: nunca toca nada de producción. Se
niega a ejecutarse si encuentra restos de Mailway o de Skyway y exige
MAILWAY_PRUEBA_DESECHABLE=1 (lo define .github/workflows/stack.yml).

    MAILWAY_PRUEBA_DESECHABLE=1 python3 deploy/prueba-stack.py --motor stalwart-0.16

MAILWAY_PRUEBA_DIRECCION (127.0.0.1 por defecto) es la dirección en la que la
prueba encuentra los puertos publicados: otra permite ejecutarla contra un
Docker aislado (Docker dentro de Docker), cuyos puertos no están en el host.

MAILWAY_PRUEBA_PANEL_IMAGEN=<imagen del panel> usa el panel de verdad en lugar
del simulado y hace su puesta en marcha con emparejar.js, como el emparejado.
Su base no conoce los buzones de la prueba, así que en la migración no se
prueban ni el intento que falla ni la suspensión.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import http.client
import imaplib
import json
import os
import re
import secrets
import smtplib
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

DEPLOY = Path(__file__).resolve().parent
sys.path.insert(0, str(DEPLOY / 'tls'))
import extractor  # noqa: E402
from laboratorio import Laboratorio, acme_json  # noqa: E402

MOTOR_015 = 'stalwart-0.15'
MOTOR_016 = 'stalwart-0.16'
DOMINIO = 'mailway.test'
MAIL = f'mail.{DOMINIO}'
BUZON = f'prueba@{DOMINIO}'
OTRO = 'web.otra-empresa.test'
VOLUMEN_ACME = 'mailway-prueba-acme'
SUBRED = '10.203.53.0/24'
PANEL = 'skyway-mailway-panel'
TRAEFIK_RUTAS = 'mailway-prueba-traefik'
TEMPORALES = ('mailway-mail-016-recuperacion', 'mailway-mail-016-previo')
# Datos de la migración: un segundo dominio, un buzón suspendido y un alias
# con un destino externo.
DOMINIO_2 = 'segundo.test'
SEGUNDO = f'eva@{DOMINIO_2}'
SUSPENDIDO = f'suspendido@{DOMINIO}'
ALIAS = f'ventas@{DOMINIO}'
EXTERNO = 'fuera@ejemplo.org'

DIRECCION = os.environ.get('MAILWAY_PRUEBA_DIRECCION', '127.0.0.1')
PANEL_REAL = os.environ.get('MAILWAY_PRUEBA_PANEL_IMAGEN', '')
# Los puertos de la prueba se publican en 127.0.0.1, salvo que se llegue a
# ellos por otra dirección (un Docker aislado): entonces, en todas las suyas.
PUBLICAR = '127.0.0.1' if DIRECCION.startswith('127.') else '0.0.0.0'
API = f'http://{DIRECCION}:18080'
PUERTO_TRAEFIK = 18443


def imagen_de(fichero: str, patron: str) -> str:
    """Imagen con su versión exacta, leída de donde la mantiene Dependabot."""
    encontradas = re.findall(patron, (DEPLOY.parent / fichero).read_text(encoding='utf-8'), re.MULTILINE)
    if not encontradas:
        raise SystemExit(f'No se encuentra la imagen en {fichero}.')
    return encontradas[-1]


# La misma imagen que el extractor: una sola descarga para las tareas
# auxiliares. El panel simulado usa la imagen de Node del panel, y la prueba
# de las rutas, el Traefik del compose autónomo.
IMAGEN_AUX = imagen_de('deploy/docker-compose.mail.yml', r'^\s*image:\s*(python:\S+)\s*$')
IMAGEN_NODE = imagen_de('Dockerfile', r'^FROM\s+(node:\S+)')
IMAGEN_TRAEFIK = imagen_de('deploy/docker-compose.standalone.yml', r'^\s*image:\s*(traefik:\S+)\s*$')
SECRETOS: list = []


def registrar(texto: str) -> None:
    for secreto in SECRETOS:
        texto = texto.replace(secreto, '***')
    print(texto, flush=True)


def ocultar(*valores: str) -> None:
    SECRETOS.extend(valores)
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        for valor in valores:
            print(f'::add-mask::{valor}', flush=True)


def docker(*argumentos: str, entrada: str | None = None, comprobar: bool = True,
           entorno: dict | None = None) -> subprocess.CompletedProcess:
    resultado = subprocess.run(['docker', *argumentos], input=entrada, text=True, capture_output=True,
                               env={**os.environ, **(entorno or {})})
    if comprobar and resultado.returncode != 0:
        raise AssertionError(f'docker {argumentos[0]} falló ({resultado.returncode}): '
                             f'{(resultado.stderr or resultado.stdout).strip()[-600:]}')
    return resultado


class NoReintentar(AssertionError):
    """Fallo que no se repite: p. ej. una contraseña rechazada, que cuenta para el bloqueo automático."""


def esperar(funcion, que: str, segundos: float = 120, pausa: float = 3):
    """Repite la función hasta que devuelve algo verdadero."""
    limite = time.monotonic() + segundos
    ultimo = None
    while True:
        try:
            resultado = funcion()
            if resultado:
                return resultado
        except NoReintentar:
            raise
        except Exception as error:  # noqa: BLE001 — se reintenta y se informa al final
            ultimo = error
        if time.monotonic() > limite:
            raise AssertionError(f'Tiempo agotado esperando {que}' + (f': {ultimo}' if ultimo else '.'))
        time.sleep(pausa)


def comprobar_entorno() -> None:
    if os.environ.get('MAILWAY_PRUEBA_DESECHABLE') != '1':
        sys.exit('Esta prueba crea y BORRA contenedores, redes y volúmenes de Docker con los nombres de Mailway. '
                 'Solo se ejecuta en una máquina desechable (la CI): define MAILWAY_PRUEBA_DESECHABLE=1.')
    contenedores = docker('ps', '-a', '--format', '{{.Names}}').stdout.split()
    volumenes = docker('volume', 'ls', '--format', '{{.Name}}').stdout.split()
    redes = docker('network', 'ls', '--format', '{{.Name}}').stdout.split()
    restos = ([c for c in contenedores if c.startswith(('mailway-', 'skyway-'))]
              + [v for v in volumenes if v.startswith(('mailway-', 'deploy_mailway')) or 'letsencrypt' in v]
              + [r for r in redes if r in ('mailway-internal', 'skyway-edge', 'mailway-edge')])
    if restos:
        sys.exit(f'Hay restos de Mailway o de Skyway en este Docker ({", ".join(restos)}): la prueba no se ejecuta.')


def linea_de_clave(par) -> str:
    return par.clave.decode().splitlines()[2]


def cifrar(clave: str) -> str:
    """Hash $6$ (sha512-crypt), como los que guarda el panel en el motor."""
    return subprocess.run(['openssl', 'passwd', '-6', '-stdin'], input=clave, text=True, capture_output=True,
                          check=True).stdout.strip()


def carpetas_imap(sesion: imaplib.IMAP4) -> list[str]:
    """Nombres de todas las carpetas del buzón (respuesta a LIST), sin comillas."""
    _, lineas = sesion.list()
    nombres = []
    for linea in lineas or []:
        if not isinstance(linea, bytes):
            continue
        m = re.match(r'\([^)]*\) (?:"(?:[^"\\]|\\.)*"|NIL) (.+)$', linea.decode())
        if not m:
            continue
        nombre = m.group(1).strip()
        if len(nombre) >= 2 and nombre.startswith('"') and nombre.endswith('"'):
            nombre = re.sub(r'\\(.)', r'\1', nombre[1:-1])
        nombres.append(nombre)
    return nombres or ['INBOX']


def comillas_imap(valor: str) -> str:
    return '"' + valor.replace('\\', '\\\\').replace('"', '\\"') + '"'


def basica(usuario: str, clave: str) -> str:
    return 'Basic ' + base64.b64encode(f'{usuario}:{clave}'.encode()).decode()


class Pila:
    VACIO_015 = {'quota': 0, 'urls': [], 'memberOf': [], 'lists': [], 'members': [], 'enabledPermissions': [],
                 'disabledPermissions': [], 'externalMembers': []}

    def __init__(self, carpeta: Path, motor: str, con_panel: bool):
        self.carpeta = carpeta
        self.motor = motor
        self.con_panel = con_panel
        self.lab = Laboratorio(carpeta / 'pki')
        dia = dt.timedelta(days=1)
        self.antiguo = self.lab.emitir('antiguo', [MAIL], hasta=10 * dia)
        self.primero = self.lab.emitir('primero', [MAIL], hasta=40 * dia)
        self.renovado = self.lab.emitir('renovado', [MAIL], hasta=80 * dia, tipo='rsa')
        self.comodin = self.lab.emitir('comodin', [f'*.{DOMINIO}'], hasta=85 * dia)
        self.otro = self.lab.emitir('otro', [OTRO], hasta=90 * dia)
        self.clave_admin = secrets.token_hex(24)
        self.clave_buzon = 'Prueba ' + secrets.token_urlsafe(18)
        self.clave_segundo = 'Segundo ' + secrets.token_urlsafe(18)
        self.clave_suspendido = 'Suspendido ' + secrets.token_urlsafe(18)
        self.asunto = ''
        self.dkim_antes: set = set()
        valores = {
            'MAILWAY_INSTALACION': 'skyway',
            'MAILWAY_MOTOR': motor,
            'MAIL_HOSTNAME': MAIL,
            'WEBMAIL_HOSTNAME': f'webmail.{DOMINIO}',
            'PANEL_HOSTNAME': f'panel.{DOMINIO}',
            'MAILWAY_PUBLIC_IP': '192.0.2.10',
            'MAILWAY_BRAND': 'Webmail',
            'LETSENCRYPT_EMAIL': f'sistemas@{DOMINIO}',
            'STALWART_ADMIN_PASSWORD': self.clave_admin,
            'ROUNDCUBE_DES_KEY': secrets.token_hex(12),
            'MAILWAY_PANEL_URL': f'https://panel.{DOMINIO}',
            'MAILWAY_WEBMAIL_URL': f'https://webmail.{DOMINIO}',
            'MAILWAY_PANEL_INTERNAL_URL': f'http://{PANEL}:4100',
            'MAILWAY_SECRET': secrets.token_hex(32),
            'MAILWAY_SETUP_TOKEN': secrets.token_hex(16),
            'MAILWAY_TRAEFIK_TOKEN': secrets.token_hex(24),
            'MAILWAY_WEBMAIL_TOKEN': secrets.token_hex(24),
            'MAILWAY_INTERNAL_SUBNET': SUBRED,
            'MAILWAY_MAIL_INTERNAL_IP': '10.203.53.10',
        }
        ocultar(self.clave_admin, self.clave_buzon, self.clave_segundo, self.clave_suspendido, *(valores[k] for k in (
            'ROUNDCUBE_DES_KEY', 'MAILWAY_SECRET', 'MAILWAY_SETUP_TOKEN', 'MAILWAY_TRAEFIK_TOKEN',
            'MAILWAY_WEBMAIL_TOKEN')))
        self.env = carpeta / 'mailway.env'
        self.env.write_text(''.join(f"{clave}='{valor}'\n" for clave, valor in valores.items()))
        self.env.chmod(0o600)
        # Solo para la prueba: la CA de laboratorio para el extractor y el
        # diagnóstico del webmail, la API del motor publicada y un extractor
        # que mira el acme.json cada 3 segundos.
        ca = self.lab.ca
        self.extra = carpeta / 'compose.prueba.yml'
        self.extra.write_text(f"""services:
  mailway-mail:
    ports:
      - '{PUBLICAR}:18080:8080'
  mailway-webmail:
    environment:
      MAILWAY_TLS_CA_FILE: /prueba/ca.pem
    volumes:
      - {ca}:/prueba/ca.pem:ro
  certs-dumper:
    environment:
      MAILWAY_TLS_CA_FILE: /prueba/ca.pem
      MAILWAY_TLS_INTERVALO: '3'
    volumes:
      - {ca}:/prueba/ca.pem:ro
    healthcheck:
      interval: 5s
      start_period: 20s
  mailway-bulwark:
    environment:
      NODE_EXTRA_CA_CERTS: /prueba/ca.pem
    volumes:
      - {ca}:/prueba/ca.pem:ro
""")
        self.contexto = ssl.create_default_context(cafile=str(ca))
        self.estado_panel = carpeta / 'panel' / 'estado.json'
        self.migraciones = carpeta / 'migracion'
        # Se quitan (no se vacían) las variables que el instalador o Compose
        # tomarían del entorno antes que de deploy/.env: Compose da prioridad
        # al entorno, y una contraseña vacía haría fallar la interpolación.
        self.entorno = {clave: valor for clave, valor in os.environ.items() if clave not in (
            'STALWART_ADMIN_PASSWORD', 'SKYWAY_TOKEN', 'CLOUDFLARE_API_TOKEN', 'LETSENCRYPT_EMAIL', 'MAILWAY_DOMINIO',
            'MAILWAY_MAIL_HOST', 'MAILWAY_WEBMAIL_HOST', 'MAILWAY_PANEL_HOST', 'MAILWAY_IP', 'MAIL_HOSTNAME',
            'MAILWAY_MOTOR', 'MAILWAY_RETIRAR_VOLUMEN')}
        # La migración verifica también el certificado contra la CA de
        # laboratorio y deja su carpeta de trabajo con la prueba.
        self.entorno.update({'MAILWAY_ENV_FILE': str(self.env), 'MAILWAY_COMPOSE_EXTRA': str(self.extra),
                             'MAILWAY_ESPERA_DNS': '0', 'MAILWAY_TRAEFIK_PROVEEDOR': '0',
                             'MAILWAY_TLS_CA_FILE': str(ca), 'MAILWAY_MIGRACION_DIR': str(self.migraciones)})

    # -- preparación

    def escribir_acme(self, *entradas) -> None:
        (self.carpeta / 'acme.json').write_text(acme_json(list(entradas)))
        docker('run', '--rm', '-v', f'{VOLUMEN_ACME}:/le', '-v', f'{self.carpeta}:/fuente:ro', IMAGEN_AUX, 'sh', '-c',
               'cp /fuente/acme.json /le/.acme.json.tmp && chmod 600 /le/.acme.json.tmp '
               '&& mv /le/.acme.json.tmp /le/acme.json')

    def preparar(self, volcado_antiguo: bool) -> None:
        # Skyway simulado: su red y un «Traefik» que solo aporta el volumen.
        docker('network', 'create', 'skyway-edge')
        docker('volume', 'create', VOLUMEN_ACME)
        self.escribir_acme((self.otro, [OTRO]), (self.primero, [MAIL]))
        docker('run', '-d', '--name', 'skyway-traefik', '--network', 'skyway-edge',
               '-v', f'{VOLUMEN_ACME}:/letsencrypt', IMAGEN_AUX, 'sleep', '86400')
        if volcado_antiguo:
            # Lo que dejaba traefik-certs-dumper en el volumen del motor: una
            # carpeta por dominio de Traefik, con su clave privada.
            volcado = self.carpeta / 'volcado'
            for nombre, par in ((MAIL, self.antiguo), (OTRO, self.otro)):
                (volcado / nombre).mkdir(parents=True)
                (volcado / nombre / 'cert.pem').write_bytes(par.cadena)
                (volcado / nombre / 'key.pem').write_bytes(par.clave)
            docker('volume', 'create', '--label', 'com.docker.compose.project=mailway',
                   '--label', 'com.docker.compose.volume=mailway-mail-certs', 'mailway-mail-certs')
            docker('run', '--rm', '-v', 'mailway-mail-certs:/output', '-v', f'{volcado}:/fuente:ro', IMAGEN_AUX,
                   'sh', '-c', 'cp -R /fuente/. /output/')
            registrar('OK: preparado un Skyway simulado y el volcado antiguo (con la clave de otro dominio).')
        else:
            registrar('OK: preparado un Skyway simulado.')
        if self.con_panel:
            self.arrancar_panel()

    def arrancar_panel(self) -> None:
        """El panel de Skyway, simulado: Node con la herramienta del motor de prueba en su sitio."""
        self.estado_panel.parent.mkdir()
        self.estado_panel.parent.chmod(0o777)
        self.guardar_estado_panel({'dominios': [], 'buzones': [], 'alias': [], 'suspendidos': []})
        if PANEL_REAL:
            # El de verdad, con su base vacía y el motor del entorno.
            clave = secrets.token_hex(32)
            ocultar(clave)
            docker('run', '-d', '--name', PANEL, '--network', 'skyway-edge',
                   '-e', 'STALWART_URL=http://mailway-mail:8080', '-e', 'STALWART_ADMIN_USER=admin',
                   '-e', 'STALWART_ADMIN_PASSWORD', '-e', 'STALWART_SMTP_HOST=mailway-mail',
                   '-e', 'STALWART_SMTP_PORT=587', '-e', f'MAILWAY_MAIL_HOSTNAME={MAIL}',
                   '-e', f'MAILWAY_ENGINE_TRUSTED_NETWORK={SUBRED}', '-e', 'MAILWAY_SECRET',
                   '-v', 'mailway-prueba-panel:/data', PANEL_REAL,
                   entorno={'STALWART_ADMIN_PASSWORD': self.clave_admin, 'MAILWAY_SECRET': clave})
            registrar(f'OK: panel de verdad en marcha ({PANEL_REAL}).')
            return
        docker('run', '-d', '--name', PANEL, '--network', 'skyway-edge', '-w', '/app',
               '-e', 'STALWART_URL=http://mailway-mail:8080', '-e', 'STALWART_ADMIN_PASSWORD',
               '-e', f'MAILWAY_MAIL_HOSTNAME={MAIL}', '-e', f'MAILWAY_ENGINE_TRUSTED_NETWORK={SUBRED}',
               '-e', 'MAILWAY_PRUEBA_ESTADO=/app/datos/estado.json',
               '-v', f'{DEPLOY / "prueba-panel-motor.js"}:/app/server/dist/tools/motor.js:ro',
               '-v', f'{self.estado_panel.parent}:/app/datos', IMAGEN_NODE, 'sleep', '86400',
               entorno={'STALWART_ADMIN_PASSWORD': self.clave_admin})
        registrar('OK: panel simulado en marcha (herramienta del motor de prueba).')

    def poner_en_marcha_panel(self) -> None:
        """Con el panel de verdad: su puesta en marcha con el motor del entorno, la que hace el emparejado."""
        r = docker('exec', '-u', 'node', PANEL, 'node', 'server/dist/tools/emparejar.js', '--email',
                   f'sistemas@{DOMINIO}', comprobar=False)
        try:
            datos = json.loads(r.stdout.strip().splitlines()[-1])
        except (IndexError, ValueError):
            raise AssertionError(f'emparejar.js no ha respondido: {r.stderr.strip()[-600:]}') from None
        ocultar(*[v for v in (datos.get('adminPassword'), datos.get('token')) if v])
        registrar(r.stderr.strip())
        assert r.returncode == 0, 'emparejar.js ha fallado'
        registrar('OK: puesta en marcha del panel de verdad (emparejar.js), con el motor del entorno.')

    def guardar_estado_panel(self, estado: dict) -> None:
        # Con un temporal y un renombrado, como la herramienta simulada: el
        # fichero que deja ella es del usuario node del contenedor y, si la
        # prueba no corre como root (la CI), no se puede sobrescribir, pero sí
        # sustituir (la carpeta es 777).
        temporal = self.estado_panel.with_name('estado.json.prueba')
        temporal.write_text(json.dumps(estado, indent=2))
        temporal.chmod(0o666)
        os.replace(temporal, self.estado_panel)

    def leer_estado_panel(self) -> dict:
        return json.loads(self.estado_panel.read_text())

    def instalador(self, *argumentos: str, entorno: dict | None = None, codigo: int = 0) -> str:
        """Ejecuta deploy/instalar.sh (su salida, a la vista) y comprueba su código; devuelve lo que muestra."""
        registrar('== deploy/instalar.sh ' + ' '.join(argumentos))
        lineas = []
        with subprocess.Popen(['bash', str(DEPLOY / 'instalar.sh'), *argumentos], stdin=subprocess.DEVNULL,
                              env={**self.entorno, **(entorno or {})}, text=True, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT) as proceso:
            for linea in proceso.stdout:
                lineas.append(linea)
                registrar(linea.rstrip('\n'))
        if proceso.returncode != codigo:
            raise AssertionError(f'instalar.sh {" ".join(argumentos)} terminó con {proceso.returncode} '
                                 f'(se esperaba {codigo})')
        return ''.join(lineas)

    def instalar(self) -> str:
        return self.instalador('--actualizar')

    # -- utilidades

    def leer_env(self) -> dict:
        valores = {}
        for linea in self.env.read_text().splitlines():
            if '=' in linea and not linea.startswith('#'):
                clave, valor = linea.split('=', 1)
                valores[clave] = valor.strip("'\"")
        return valores

    def peticion(self, metodo: str, ruta: str, cuerpo=None, espera: float = 30):
        peticion = urllib.request.Request(
            API + ruta, method=metodo, data=None if cuerpo is None else json.dumps(cuerpo).encode(),
            headers={'Authorization': basica('admin', self.clave_admin), 'Content-Type': 'application/json'})
        # Sin el proxy del entorno: los puertos de la prueba son locales.
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(peticion, timeout=espera) as r:
            return json.load(r)

    def api(self, metodo: str, ruta: str, cuerpo=None):
        """API REST de gestión de Stalwart 0.15."""
        datos = self.peticion(metodo, ruta, cuerpo)
        if not isinstance(datos, dict) or 'data' not in datos:
            raise AssertionError(f'La API del motor respondió {datos}')
        return datos['data']

    def jmap(self, llamadas: list) -> dict:
        """Gestión de Stalwart 0.16 (JMAP): las respuestas por su identificador."""
        datos = self.peticion('POST', '/jmap', {'using': ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
                                                'methodCalls': llamadas}, espera=60)
        resultado = {}
        for nombre, argumentos, ident in datos['methodResponses']:
            if nombre == 'error':
                raise AssertionError(f'JMAP {ident}: {argumentos}')
            resultado[ident] = argumentos
        return resultado

    def lista_016(self, objeto: str, propiedades: list | None = None) -> list:
        return self.jmap([[f'x:{objeto}/get', {'ids': None, 'properties': propiedades}, 'g']])['g'].get('list') or []

    def servido(self, puerto: int) -> str:
        sondeo = extractor.sondear(DIRECCION, puerto, MAIL, self.contexto)
        if not sondeo.verificado:
            raise AssertionError(f'{puerto}: {sondeo.error}')
        return sondeo.huella

    def servido_587(self) -> str:
        """Certificado que sirve el 587 tras STARTTLS (verificado: cadena y nombre)."""
        with socket.create_connection((DIRECCION, 587), timeout=15) as conexion:
            lector = conexion.makefile('rb')
            assert lector.readline().startswith(b'220'), 'el 587 no saluda con 220'
            conexion.sendall(b'EHLO prueba.mailway.test\r\n')
            while True:
                linea = lector.readline()
                if not linea or linea[3:4] != b'-':
                    break
            conexion.sendall(b'STARTTLS\r\n')
            assert lector.readline().startswith(b'220'), 'el 587 no admite STARTTLS'
            with self.contexto.wrap_socket(conexion, server_hostname=MAIL) as segura:
                return hashlib.sha256(segura.getpeercert(binary_form=True)).hexdigest()

    def sirve(self, par, que: str, con_587: bool = False) -> None:
        def comprobar():
            return all(self.servido(p) == par.huella for p in (993, 465)) and (
                not con_587 or self.servido_587() == par.huella)
        puertos = '993, 465 y 587' if con_587 else '993 y 465'
        esperar(comprobar, f'que el motor sirva {que} en {puertos}', segundos=150)
        registrar(f'OK: el motor sirve {que} en {puertos} (cadena, nombre y huella).')

    def extractor_correcto(self, par) -> None:
        """Espera a que el extractor dé por bueno ESE par (su estado muestra el principio de la huella)."""
        def comprobar():
            r = docker('exec', 'mailway-certs-dumper', 'python', '/app/extractor.py', 'estado', comprobar=False)
            return r.stdout.strip() if r.returncode == 0 and par.huella[:16] in r.stdout else None
        registrar('OK: extractor → ' + esperar(comprobar, 'que el extractor dé el certificado por bueno').splitlines()[0])

    def acceso_webmail(self, clave: str):
        return docker('exec', '-i', '-u', 'www-data', 'mailway-webmail', 'php', '/opt/mailway/comprobar.php', 'acceso',
                      entrada=f'{BUZON}\n{clave}\n', comprobar=False)

    def imap(self, usuario: str, clave: str) -> imaplib.IMAP4_SSL:
        """Sesión IMAP en 993 con el certificado verificado; lanza IMAP4.error si el motor no deja entrar."""
        contexto = self.contexto

        class Imap(imaplib.IMAP4_SSL):
            def _create_socket(self, timeout):
                conexion = socket.create_connection((DIRECCION, self.port), timeout)
                return contexto.wrap_socket(conexion, server_hostname=MAIL)

        sesion = Imap(MAIL, 993, ssl_context=contexto, timeout=20)
        try:
            sesion.login(usuario, clave)
        except BaseException:
            sesion.shutdown()
            raise
        return sesion

    # -- comprobaciones

    def comprobar_volumen(self) -> None:
        listado = docker('exec', 'mailway-mail', 'ls', '-A', '/opt/stalwart/certs').stdout.split()
        assert sorted(listado) == sorted([extractor.PRIVADO, MAIL]), f'contenido inesperado del volumen: {listado}'
        docker('exec', 'mailway-mail', 'test', '-L', f'/opt/stalwart/certs/{MAIL}')
        ficheros = docker('exec', 'mailway-mail', 'find', '/opt/stalwart/certs/', '-type', 'f').stdout.split()
        assert len(ficheros) == 2, f'se esperaba solo cert.pem y key.pem: {ficheros}'
        contenido = docker('exec', 'mailway-mail', 'cat', *ficheros).stdout
        assert linea_de_clave(self.otro) not in contenido, 'la clave de otro dominio sigue en el volumen'
        assert linea_de_clave(self.antiguo) not in contenido, 'el par antiguo no se retiró tras comprobar el nuevo'
        registrar('OK: el volumen del motor solo contiene el par del servidor (sin claves de otros dominios ni el '
                  'par antiguo).')

    def crear_buzon(self) -> None:
        if self.motor == MOTOR_016:
            r = self.jmap([['x:Domain/set', {'create': {'d': {'name': DOMINIO}}}, 'd']])
            dominio = ((r['d'].get('created') or {}).get('d') or {}).get('id')
            assert dominio, f'el motor no creó el dominio: {r["d"]}'
            # Como lo crea el panel (driver de la 0.16).
            r = self.jmap([['x:Account/set', {'create': {'a': {
                '@type': 'User', 'name': BUZON.split('@')[0], 'domainId': dominio, 'description': 'Buzón de prueba',
                'credentials': {'0': {'@type': 'Password', 'secret': cifrar(self.clave_buzon)}},
                'quotas': {}, 'roles': {'@type': 'User'}, 'permissions': {'@type': 'Inherit'}, 'aliases': {},
                'encryptionAtRest': {'@type': 'Disabled'}, 'memberGroupIds': {}}}}, 'a']])
            assert 'a' in (r['a'].get('created') or {}), f'el motor no creó el buzón: {r["a"]}'
        else:
            self.crear_dominio_015(DOMINIO)
            self.crear_buzon_015(BUZON, self.clave_buzon)
        registrar(f'OK: buzón de prueba {BUZON} creado en el motor.')

    def crear_dominio_015(self, dominio: str) -> None:
        self.api('POST', '/api/principal', {'type': 'domain', 'name': dominio, 'description': 'Prueba',
                                            'secrets': [], 'emails': [], 'roles': [], **self.VACIO_015})

    def crear_buzon_015(self, email: str, clave: str, suspendido: bool = False) -> None:
        # Suspendido como lo deja el panel con la 0.15: sin los permisos de
        # autenticarse y con el rol «user», que es el que le deja recibir correo.
        sin_permisos = ['authenticate', 'authenticate-oauth'] if suspendido else []
        self.api('POST', '/api/principal', {'type': 'individual', 'name': email, 'description': f'Buzón {email}',
                                            'secrets': [cifrar(clave)], 'emails': [email], 'roles': ['user'],
                                            **self.VACIO_015, 'disabledPermissions': sin_permisos})

    def comprobar_imap_webmail(self) -> None:
        def entrar():
            r = self.acceso_webmail(self.clave_buzon)
            if r.returncode != 0 and 'rechazó' in r.stdout:
                raise NoReintentar(r.stdout.strip())
            return r.stdout.strip() if r.returncode == 0 else None
        registrar('OK: webmail → ' + esperar(entrar, 'el inicio de sesión desde el webmail', segundos=60))

    def comprobar_tema_webmail(self) -> None:
        """La pantalla de acceso, pedida dentro del contenedor, sale con Elastic y la marca de Mailway."""
        def pagina():
            r = docker('exec', 'mailway-webmail', 'php', '-r', 'echo @file_get_contents("http://127.0.0.1/");',
                       comprobar=False)
            return r.stdout if r.returncode == 0 and 'rcmloginuser' in r.stdout else None
        html = esperar(pagina, 'la pantalla de acceso del webmail', segundos=60)
        for marca, que in (('skins/elastic/styles/', 'la hoja de estilos de Elastic'),
                           ('plugins/mailway_theme/mailway.css', 'la capa visual de Mailway'),
                           ('plugins/mailway_theme/editor.js', 'el editor en modo oscuro'),
                           ('plugins/mailway_theme/logo.svg', 'el logotipo de Mailway'),
                           ('plugins/mailway_theme/favicon.svg', 'el icono de Mailway'),
                           ('id="mailway-portada"', 'la portada del acceso')):
            assert marca in html, f'falta {que} en la pantalla de acceso del webmail'
        registrar('OK: el webmail usa Elastic con la capa, el logotipo, el icono y la portada de Mailway.')

    def comprobar_contrasena_incorrecta(self) -> None:
        r = self.acceso_webmail('contraseña-incorrecta')
        assert r.returncode == 1 and 'rechazó' in r.stdout, r.stdout + r.stderr
        registrar('OK: el webmail rechaza una contraseña incorrecta (un solo intento).')

    def comprobar_imap_y_smtp_directos(self) -> None:
        contexto = self.contexto
        with self.imap(BUZON, self.clave_buzon) as sesion:
            tipo, _ = sesion.select('INBOX')
            assert tipo == 'OK', tipo
        registrar('OK: inicio de sesión IMAP en 993 y apertura de la bandeja de entrada.')

        class SmtpSsl(smtplib.SMTP_SSL):
            def _get_socket(self, host, port, timeout):
                conexion = socket.create_connection((DIRECCION, port), timeout)
                return contexto.wrap_socket(conexion, server_hostname=MAIL)

        class SmtpLocal(smtplib.SMTP):
            def _get_socket(self, host, port, timeout):
                return socket.create_connection((DIRECCION, port), timeout)

        with SmtpSsl(MAIL, 465, context=contexto, timeout=20) as smtp:
            smtp.ehlo()
            smtp.login(BUZON, self.clave_buzon)
        with SmtpLocal(MAIL, 587, timeout=20) as smtp:
            smtp.ehlo()
            smtp.starttls(context=contexto)
            smtp.ehlo()
            smtp.login(BUZON, self.clave_buzon)
        registrar('OK: autenticación SMTP en 465 (TLS) y 587 (STARTTLS), sin enviar correo.')

    def comprobar_instalador(self) -> None:
        self.instalador('--comprobar')
        registrar('== deploy/instalar.sh --probar-acceso')
        resultado = subprocess.run(['bash', str(DEPLOY / 'instalar.sh'), '--probar-acceso'],
                                   input=f'{BUZON}\n{self.clave_buzon}\n', text=True, capture_output=True,
                                   env=self.entorno)
        registrar(resultado.stdout + resultado.stderr)
        assert resultado.returncode == 0, 'instalar.sh --probar-acceso falló'
        assert self.clave_buzon not in resultado.stdout + resultado.stderr

    # -- Stalwart 0.16

    def comprobar_ajustes_016(self) -> None:
        """Lo que dejan el primer arranque (o la migración), el instalador y la herramienta del panel."""
        r = self.jmap([
            ['x:SystemSettings/get', {'ids': ['singleton'], 'properties': ['defaultHostname', 'defaultCertificateId']},
             's'],
            ['x:Http/get', {'ids': ['singleton'], 'properties': ['useXForwarded']}, 'h'],
            ['x:AllowedIp/get', {'ids': None, 'properties': ['address']}, 'a'],
            ['x:NetworkListener/get', {'ids': None, 'properties': ['protocol', 'bind', 'tlsImplicit']}, 'l'],
            ['x:Tracer/get', {'ids': None}, 't'],
            ['x:Account/get', {'ids': None, 'properties': ['emailAddress']}, 'c'],
        ])
        sistema = r['s']['list'][0]
        assert sistema.get('defaultHostname') == MAIL, sistema
        assert sistema.get('defaultCertificateId'), 'el motor no tiene certificado por defecto'
        assert r['h']['list'][0].get('useXForwarded') is True, r['h']
        assert any(ip.get('address') == SUBRED for ip in r['a']['list']), r['a']
        escuchas = {(e.get('protocol'), int(b.rsplit(':', 1)[1]), bool(e.get('tlsImplicit')))
                    for e in r['l']['list'] for b in (e.get('bind') or {})}
        for esperada in (('smtp', 25, False), ('smtp', 465, True), ('smtp', 587, False), ('imap', 993, True),
                         ('http', 8080, False)):
            assert esperada in escuchas, f'falta la escucha {esperada}: {sorted(escuchas)}'
        assert any(t.get('@type') == 'Stdout' and t.get('enable') is not False for t in r['t']['list']), r['t']
        cuentas = [c.get('emailAddress') for c in r['c']['list']]
        assert f'admin@{MAIL}' not in cuentas, f'sigue la cuenta del primer arranque: {cuentas}'
        registros = docker('logs', '--tail', '300', 'mailway-mail', comprobar=False)
        assert 'auth.success' in registros.stdout + registros.stderr, 'el motor no deja su registro en docker logs'
        registrar('OK: Stalwart 0.16 con su nombre, el certificado, X-Forwarded-For, la red interna exenta, el 587 '
                  'con STARTTLS, el registro en docker logs y sin la cuenta admin@ del primer arranque.')

    def comprobar_rutas(self) -> None:
        """Con un Traefik real (proveedor Docker y las etiquetas de verdad): el motor, por su pasarela.

        Con la 0.16, además, en el nombre del servidor de correo solo lo de los
        programas. Traefik conserva aquí el X-Forwarded-For que le llega
        (forwardedHeaders.insecure), como cuando confía en Cloudflare: la
        primera dirección la escribe el cliente y la pasarela no debe creerla.
        """
        carpeta = self.carpeta / 'traefik'
        carpeta.mkdir()
        (carpeta / 'cert.pem').write_bytes(self.primero.cadena)
        (carpeta / 'key.pem').write_bytes(self.primero.clave)
        (carpeta / 'tls.yml').write_text('tls:\n  stores:\n    default:\n      defaultCertificate:\n'
                                         '        certFile: /dinamico/cert.pem\n        keyFile: /dinamico/key.pem\n')
        for fichero in carpeta.iterdir():
            fichero.chmod(0o644)
        # El emisor «le» existe (las rutas lo nombran) pero no llega a ninguna
        # CA: Traefik sirve el certificado de laboratorio por defecto. Su API,
        # solo dentro del contenedor, para ver adónde lleva cada servicio.
        docker('run', '-d', '--name', TRAEFIK_RUTAS, '--network', 'skyway-edge',
               '-v', '/var/run/docker.sock:/var/run/docker.sock:ro', '-v', f'{carpeta}:/dinamico:ro',
               '-p', f'{PUBLICAR}:{PUERTO_TRAEFIK}:443', IMAGEN_TRAEFIK,
               '--entrypoints.web.address=:80', '--entrypoints.websecure.address=:443',
               '--entrypoints.websecure.forwardedHeaders.insecure=true', '--api.insecure=true',
               '--providers.docker=true', '--providers.docker.exposedbydefault=false',
               '--providers.docker.network=skyway-edge', '--providers.file.directory=/dinamico',
               f'--certificatesresolvers.le.acme.email=sistemas@{DOMINIO}',
               '--certificatesresolvers.le.acme.storage=/tmp/acme.json',
               '--certificatesresolvers.le.acme.caserver=https://127.0.0.1:9/directory',
               '--certificatesresolvers.le.acme.tlschallenge=true')

        def pedir(ruta: str, cuerpo: str | None = None, cabeceras: dict | None = None):
            conexion = http.client.HTTPSConnection(MAIL, PUERTO_TRAEFIK, context=self.contexto, timeout=10)
            # A la dirección de la prueba, con el nombre del servidor (SNI y Host).
            conexion.sock = self.contexto.wrap_socket(
                socket.create_connection((DIRECCION, PUERTO_TRAEFIK), timeout=10), server_hostname=MAIL)
            try:
                conexion.request('GET' if cuerpo is None else 'POST', ruta, body=cuerpo,
                                 headers={'Host': MAIL, 'Content-Type': 'application/json', **(cabeceras or {})})
                respuesta = conexion.getresponse()
                respuesta.read()
                return respuesta.status, {k.lower(): v for k, v in respuesta.getheaders()}
            finally:
                conexion.close()

        def codigo(ruta: str, cuerpo: str | None = None, cabeceras: dict | None = None) -> int:
            return pedir(ruta, cuerpo, cabeceras)[0]

        esperar(lambda: codigo('/healthz/live') == 200, 'que Traefik publique el motor', segundos=90)
        servicio = json.loads(docker('exec', TRAEFIK_RUTAS, 'wget', '-qO-',
                                     'http://127.0.0.1:8080/api/http/services/mailway-mail@docker').stdout)
        destinos = [s.get('url') for s in (servicio.get('loadBalancer') or {}).get('servers') or []]
        assert destinos == ['http://mailway-mail-gw:8080'], f'el servicio del motor en Traefik va a {destinos}'
        _, cabeceras = pedir('/healthz/live')
        assert cabeceras.get('server') == 'nginx', f'la respuesta no sale de la pasarela: {cabeceras}'
        registrar('OK: el servicio del motor en Traefik (etiquetas de verdad) es su pasarela, mailway-mail-gw, y '
                  'las respuestas salen de ella.')

        if self.motor == MOTOR_016:
            for ruta in ('/', '/admin', '/admin/', '/account', '/login', '/api/principal'):
                assert codigo(ruta) == 403, f'{ruta} no está bloqueada (HTTP {codigo(ruta)})'
            # JMAP pasa, pero sin credenciales el motor no hace nada.
            sin_credenciales = codigo('/jmap', '{"using":["urn:ietf:params:jmap:core"],"methodCalls":[]}')
            assert sin_credenciales == 401, f'POST /jmap sin credenciales: HTTP {sin_credenciales}'
            for ruta in ('/jmap/session', '/.well-known/jmap', '/.well-known/mta-sts.txt',
                         f'/mail/config-v1.1.xml?emailaddress={BUZON}', '/dav/card'):
                assert codigo(ruta) != 403, f'{ruta} está bloqueada'
            registrar('OK: Traefik deja pasar JMAP, los .well-known, DAV, la autoconfiguración y la salud del motor, '
                      'y responde 403 a su administración y a su autoservicio.')

        # Un cliente que dice venir de la red interna (exenta del bloqueo
        # automático) con X-Forwarded-For y con Forwarded (que el motor lee
        # antes). Traefik conserva su X-Forwarded-For y añade la IP real; la
        # pasarela entrega al motor solo esa (y la anota, al ser un acceso
        # rechazado). Un solo fallo: cuenta para el bloqueo de esa IP.
        falsa = '10.203.53.250'
        rechazo = codigo('/jmap/session', None, {'Authorization': basica('nadie@' + DOMINIO, 'mala'),
                                                 'X-Forwarded-For': falsa, 'Forwarded': f'for={falsa}'})
        assert rechazo == 401, f'acceso con una contraseña mala: HTTP {rechazo}'

        def anotado_en_pasarela():
            lineas = [json.loads(linea) for linea in docker('logs', 'mailway-mail-gw', comprobar=False).stdout.splitlines()
                      if linea.startswith('{') and '"/jmap/session"' in linea and '"estado":401' in linea]
            return lineas[-1] if lineas else None
        linea = esperar(anotado_en_pasarela, 'que la pasarela anote el acceso rechazado', segundos=30, pausa=1)
        traefik = docker('inspect', '-f', '{{(index .NetworkSettings.Networks "skyway-edge").IPAddress}}',
                         TRAEFIK_RUTAS).stdout.strip()
        assert linea['par'] == traefik, f'la pasarela no recibe la petición de Traefik: {linea}'
        assert linea['ip'] != falsa and not linea['ip'].startswith('10.203.53.'), \
            f'la pasarela ha creído el X-Forwarded-For del cliente: {linea}'
        registrar(f'OK: con un X-Forwarded-For y un Forwarded falsos, la pasarela entrega al motor la IP real '
                  f'({linea["ip"]}), no la de la red exenta.')

        if self.motor == MOTOR_016:
            # El motor anota el acceso correcto con la IP de quien conecta: la
            # pasarela, nunca Traefik (la IP reenviada solo aparece en sus
            # bloqueos; la de cada caso la prueba deploy/prueba-pasarela.sh).
            pasarela = docker('inspect', '-f', '{{(index .NetworkSettings.Networks "skyway-edge").IPAddress}}',
                              'mailway-mail-gw').stdout.strip()
            desde = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
            sesion = codigo('/jmap', '{"using":["urn:ietf:params:jmap:core"],"methodCalls":[]}',
                            {'Authorization': basica(BUZON, self.clave_buzon), 'Forwarded': f'for={falsa}'})
            assert sesion == 200, f'POST /jmap con el buzón de prueba: HTTP {sesion}'

            def anotado():
                r = docker('logs', '--since', desde, 'mailway-mail', comprobar=False)
                lineas = [linea for linea in (r.stdout + r.stderr).splitlines()
                          if 'auth.success' in linea and BUZON in linea]
                return lineas[-1] if lineas else None
            linea = esperar(anotado, 'que el motor anote el inicio de sesión', segundos=30, pausa=1)
            vista = re.search(r'remoteIp = ([0-9a-fA-F.:]+)', linea)
            assert vista and vista.group(1) == pasarela, f'el motor no recibe la conexión de la pasarela: {linea}'
            registrar(f'OK: el motor recibe las conexiones de la pasarela ({pasarela}), no de Traefik.')

    # -- Bulwark

    def en_red(self, red: str, guion: str, entorno: dict | None = None) -> dict:
        """Un guion de Python en un contenedor efímero en esa red; los secretos, por el entorno. Devuelve su JSON."""
        nombres = [arg for nombre in (entorno or {}) for arg in ('-e', nombre)]
        r = docker('run', '--rm', '-i', '--network', red, *nombres, IMAGEN_AUX, 'python', '-I', '-', entrada=guion,
                   entorno=entorno)
        return json.loads(r.stdout.strip().splitlines()[-1])

    def admin_bulwark(self) -> dict:
        """Como el panel: por la red de Traefik, directo a la API de administración (sin la pasarela)."""
        return self.en_red('skyway-edge', r"""
import json, os, urllib.request, urllib.error
abrir = urllib.request.build_opener(urllib.request.ProxyHandler({})).open
def pedir(metodo, ruta, cuerpo=None, galleta=None):
    peticion = urllib.request.Request('http://mailway-bulwark:3000' + ruta, method=metodo,
        data=None if cuerpo is None else json.dumps(cuerpo).encode(),
        headers={'Content-Type': 'application/json', **({'Cookie': galleta} if galleta else {})})
    try:
        with abrir(peticion, timeout=20) as r:
            return r.status, r.headers.get('Set-Cookie') or '', r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, '', e.read().decode()
estado, galleta, _ = pedir('POST', '/api/admin/auth', {'password': os.environ['CLAVE']})
config = pedir('GET', '/api/admin/config', galleta=galleta.split(';')[0])[0] if estado == 200 else 0
print(json.dumps({'acceso': estado, 'config': config}))
""", {'CLAVE': self.leer_env()['BULWARK_ADMIN_PASSWORD']})

    def subir_marca_bulwark(self) -> dict:
        """Como el panel: sube una imagen de marca (multipart) a la API de administración, sin la pasarela."""
        return self.en_red('skyway-edge', r"""
import hashlib, json, os, struct, urllib.request, urllib.error, uuid, zlib
abrir = urllib.request.build_opener(urllib.request.ProxyHandler({})).open
def trozo(tipo, datos):
    return struct.pack('>I', len(datos)) + tipo + datos + struct.pack('>I', zlib.crc32(tipo + datos))
# Un PNG de 16 x 16 de verdad (Bulwark lo sirve tal cual).
filas = b''.join(b'\x00' + b'\x0f\x76\x6e' * 16 for _ in range(16))
png = (b'\x89PNG\r\n\x1a\n' + trozo(b'IHDR', struct.pack('>IIBBBBB', 16, 16, 8, 2, 0, 0, 0))
       + trozo(b'IDAT', zlib.compress(filas)) + trozo(b'IEND', b''))
host = 'mw-' + hashlib.sha256(png).hexdigest()[:32]
def pedir(metodo, ruta, datos=None, tipo='application/json', galleta=None):
    peticion = urllib.request.Request('http://mailway-bulwark:3000' + ruta, method=metodo, data=datos,
        headers={'Content-Type': tipo, **({'Cookie': galleta} if galleta else {})})
    try:
        with abrir(peticion, timeout=20) as r:
            return r.status, r.headers.get('Set-Cookie') or '', r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, '', e.read().decode()
estado, galleta, _ = pedir('POST', '/api/admin/auth', json.dumps({'password': os.environ['CLAVE']}).encode())
subida = 0
if estado == 200:
    limite = uuid.uuid4().hex
    partes = []
    for nombre, valor in (('slot', 'faviconUrl'), ('host', host)):
        partes.append(f'--{limite}\r\nContent-Disposition: form-data; name="{nombre}"\r\n\r\n{valor}\r\n'.encode())
    partes.append(f'--{limite}\r\nContent-Disposition: form-data; name="file"; filename="favicon.png"\r\n'
                  'Content-Type: image/png\r\n\r\n'.encode() + png + b'\r\n')
    partes.append(f'--{limite}--\r\n'.encode())
    subida = pedir('POST', '/api/admin/branding', b''.join(partes), f'multipart/form-data; boundary={limite}',
                   galleta.split(';')[0])[0]
print(json.dumps({'acceso': estado, 'subida': subida, 'fichero': f'domain__{host}__faviconUrl.png',
                  'sha256': hashlib.sha256(png).hexdigest()}))
""", {'CLAVE': self.leer_env()['BULWARK_ADMIN_PASSWORD']})

    def marca_por_pasarela(self, fichero: str) -> dict:
        """Lo que haría un navegador por Traefik: la imagen de marca subida, por la pasarela de Bulwark."""
        return self.en_red('skyway-edge', r"""
import hashlib, json, os, urllib.request, urllib.error
abrir = urllib.request.build_opener(urllib.request.ProxyHandler({})).open
ruta = 'http://mailway-bulwark-gw:8080/api/admin/branding/' + os.environ['FICHERO']
def pedir(metodo, datos=None):
    peticion = urllib.request.Request(ruta, method=metodo, data=datos,
        headers={'Host': 'webmail.mailway.test', 'X-Forwarded-Proto': 'https'})
    try:
        with abrir(peticion, timeout=20) as r:
            return r.status, r.headers.get('Content-Type') or '', r.read()
    except urllib.error.HTTPError as e:
        return e.code, '', e.read()
estado, tipo, datos = pedir('GET')
print(json.dumps({'estado': estado, 'tipo': tipo, 'sha256': hashlib.sha256(datos).hexdigest(),
                  'cabeza': pedir('HEAD')[0], 'borrar': pedir('DELETE')[0], 'subir': pedir('POST', b'x')[0]}))
""", {'FICHERO': fichero})

    def por_pasarela_bulwark(self, clave: str) -> dict:
        """Lo que haría Traefik: a la pasarela de Bulwark con el nombre de un webmail."""
        return self.en_red('skyway-edge', r"""
import json, os, urllib.request, urllib.error
abrir = urllib.request.build_opener(urllib.request.ProxyHandler({})).open
def pedir(metodo, ruta, cuerpo=None):
    peticion = urllib.request.Request('http://mailway-bulwark-gw:8080' + ruta, method=metodo,
        data=None if cuerpo is None else json.dumps(cuerpo).encode(),
        headers={'Host': 'webmail.mailway.test', 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json'})
    try:
        with abrir(peticion, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
verifica = lambda clave: json.loads(pedir('POST', '/api/auth/verify', {
    'serverUrl': 'https://' + os.environ['MAIL'], 'username': os.environ['BUZON'], 'password': clave})[1]).get('result')
print(json.dumps({
    'salud': pedir('GET', '/api/health')[1],
    'admin': pedir('GET', '/api/admin/config')[0],
    'acceso_admin': pedir('POST', '/api/admin/auth', {'password': 'x'})[0],
    'buena': verifica(os.environ['CLAVE']),
    'mala': verifica('no-es-esta'),
}))
""", {'CLAVE': clave, 'MAIL': MAIL, 'BUZON': BUZON})

    def bulwark_sano(self) -> None:
        for contenedor in ('mailway-bulwark', 'mailway-bulwark-gw'):
            esperar(lambda c=contenedor: docker('inspect', '-f', '{{.State.Health.Status}}', c,
                                                comprobar=False).stdout.strip() == 'healthy',
                    f'que {contenedor} esté sano', segundos=180)

    def comprobar_bulwark(self) -> None:
        salida = self.instalador('--activar-bulwark')
        env = self.leer_env()
        sesion, admin = env.get('BULWARK_SESSION_SECRET', ''), env.get('BULWARK_ADMIN_PASSWORD', '')
        ocultar(*[v for v in (sesion, admin) if v])
        assert env.get('MAILWAY_BULWARK') == '1', env.get('MAILWAY_BULWARK')
        assert len(sesion) >= 32 and len(admin) >= 32, 'faltan los secretos de Bulwark en deploy/.env'
        assert sesion not in salida and admin not in salida, 'el instalador muestra un secreto de Bulwark'
        assert env.get('MAILWAY_BULWARK_URL') == 'http://mailway-bulwark:3000', env.get('MAILWAY_BULWARK_URL')
        assert env.get('MAILWAY_BULWARK_BACKEND_URL') == 'http://mailway-bulwark-gw:8080'
        self.bulwark_sano()
        registrar('OK: --activar-bulwark: Bulwark y su pasarela sanos, con sus dos secretos generados (sin '
                  'mostrarlos) y las direcciones del panel en deploy/.env.')

        def redes(contenedor: str) -> set:
            return set(json.loads(docker('inspect', '-f', '{{json .NetworkSettings.Networks}}', contenedor).stdout))

        def publicados(contenedor: str) -> str:
            return docker('inspect', '-f', '{{json .HostConfig.PortBindings}}', contenedor).stdout.strip()
        assert redes('mailway-bulwark') == {'mailway-internal', 'skyway-edge'}, redes('mailway-bulwark')
        assert redes('mailway-bulwark-gw') == {'skyway-edge'}, redes('mailway-bulwark-gw')
        for contenedor in ('mailway-bulwark', 'mailway-bulwark-gw'):
            assert publicados(contenedor) in ('{}', 'null'), f'{contenedor} publica puertos: {publicados(contenedor)}'
            assert docker('inspect', '-f', '{{.HostConfig.ReadonlyRootfs}}', contenedor).stdout.strip() == 'true'
        huella = docker('inspect', '-f', '{{index .Config.Labels "mailway.bulwark-gw-config"}}',
                        'mailway-bulwark-gw').stdout.strip()
        assert re.fullmatch(r'[0-9a-f]{16}', huella), f'sin la huella de la configuración de la pasarela: {huella!r}'
        registrar('OK: Bulwark solo en la red interna y la de Traefik, su pasarela solo en la de Traefik, sin '
                  'puertos publicados, con la raíz en solo lectura y la huella de su configuración.')

        datos = self.admin_bulwark()
        assert datos == {'acceso': 200, 'config': 200}, f'API de administración por dentro: {datos}'
        datos = self.por_pasarela_bulwark(self.clave_buzon)
        assert '"healthy"' in datos['salud'], datos
        assert datos['admin'] == 404 and datos['acceso_admin'] == 404, f'administración por la pasarela: {datos}'
        assert datos['buena'] == 'ok' and datos['mala'] == 'unauthorized', f'acceso con el buzón: {datos}'
        registrar('OK: la API de administración de Bulwark responde directamente (como al panel) y da 404 '
                  'por la pasarela; Bulwark comprueba el buzón por la red exenta y el 443 interno del motor '
                  '(contraseña buena «ok», mala «unauthorized»).')

        # La marca de cada cliente: el panel sube sus imágenes a /app/data/admin
        # (volumen mailway-bulwark-admin, escribible con la raíz en solo
        # lectura) y el navegador las lee por la pasarela, que no deja cambiarlas.
        marca = self.subir_marca_bulwark()
        assert marca['acceso'] == 200 and marca['subida'] == 200, f'subida de una imagen de marca: {marca}'
        leida = self.marca_por_pasarela(marca['fichero'])
        assert leida['estado'] == 200 and leida['tipo'].startswith('image/png') and leida['sha256'] == marca['sha256'], \
            f'la imagen de marca por la pasarela: {leida}'
        assert leida['cabeza'] == 200 and leida['borrar'] == 404 and leida['subir'] == 404, \
            f'métodos de la marca por la pasarela: {leida}'
        registrar('OK: el panel sube una imagen de marca a Bulwark (volumen de administración escribible) y la '
                  'pasarela la sirve con GET y HEAD, sin dejar borrarla ni sustituirla.')

        salida = self.instalador('--comprobar')
        for texto in ('Bulwark responde a través de su pasarela', 'Bulwark verifica el certificado de',
                      'El motor sirve HTTPS en su 443 interno'):
            assert texto in salida, f'--comprobar no dice «{texto}»'
        salida = self.instalador('--estado-bulwark', codigo=1)
        assert 'mailway-bulwark: en marcha y sano' in salida and 'mailway-bulwark-gw: en marcha y sano' in salida
        # El Skyway simulado no despliega el panel: no tiene sus variables, y se dice.
        assert 'no tiene las tres variables de Bulwark' in salida, '--estado-bulwark no mira el panel'
        registrar('OK: --comprobar revisa Bulwark (salud, certificado del 443 interno) y --estado-bulwark dice qué '
                  'falta en el panel.')

        antes = docker('inspect', '-f', '{{.Id}}', 'mailway-bulwark').stdout.strip()
        self.instalar()
        assert docker('inspect', '-f', '{{.Id}}', 'mailway-bulwark').stdout.strip() == antes, \
            'una actualización sin cambios recrea Bulwark'
        env = self.leer_env()
        assert (env.get('BULWARK_SESSION_SECRET'), env.get('BULWARK_ADMIN_PASSWORD')) == (sesion, admin), \
            'una actualización cambia los secretos de Bulwark'
        registrar('OK: una actualización conserva Bulwark (mismo contenedor) y sus secretos.')

        self.instalador('--desactivar-bulwark')
        for contenedor in ('mailway-bulwark', 'mailway-bulwark-gw'):
            assert docker('inspect', contenedor, comprobar=False).returncode != 0, f'{contenedor} sigue tras desactivarlo'
        for volumen in ('mailway-bulwark-ajustes', 'mailway-bulwark-admin', 'mailway-bulwark-estado'):
            assert docker('volume', 'inspect', volumen, comprobar=False).returncode == 0, f'se ha borrado {volumen}'
        env = self.leer_env()
        assert env.get('MAILWAY_BULWARK') == '0' and 'MAILWAY_BULWARK_URL' not in env, env.get('MAILWAY_BULWARK')
        assert (env.get('BULWARK_SESSION_SECRET'), env.get('BULWARK_ADMIN_PASSWORD')) == (sesion, admin)
        self.instalar()
        assert docker('inspect', 'mailway-bulwark', comprobar=False).returncode != 0, \
            'una actualización vuelve a levantar Bulwark desactivado'
        registrar('OK: --desactivar-bulwark retira sus contenedores y las direcciones del panel, y conserva sus '
                  'volúmenes y sus secretos; una actualización no lo vuelve a levantar.')

        self.instalador('--activar-bulwark')
        self.bulwark_sano()
        datos = self.admin_bulwark()
        assert datos == {'acceso': 200, 'config': 200}, f'API de administración tras reactivarlo: {datos}'
        leida = self.marca_por_pasarela(marca['fichero'])
        assert leida['estado'] == 200 and leida['sha256'] == marca['sha256'], f'la marca tras reactivarlo: {leida}'
        registrar('OK: activado de nuevo, Bulwark conserva su administración (la misma contraseña), la marca '
                  'subida y sus secretos.')

    # -- migración

    def sembrar_015(self) -> None:
        """Lo que tendría un servidor real: dos dominios con DKIM, buzones, uno suspendido y un alias externo."""
        self.crear_dominio_015(DOMINIO_2)
        for dominio in (DOMINIO, DOMINIO_2):
            for algoritmo in ('Ed25519', 'Rsa'):
                self.api('POST', '/api/dkim', {'id': None, 'algorithm': algoritmo, 'domain': dominio, 'selector': None})
        self.crear_buzon_015(SEGUNDO, self.clave_segundo)
        self.crear_buzon_015(SUSPENDIDO, self.clave_suspendido, suspendido=True)
        self.api('POST', '/api/principal', {'type': 'list', 'name': ALIAS, 'description': 'Alias', 'secrets': [],
                                            'emails': [ALIAS], 'roles': [],
                                            **{**self.VACIO_015, 'members': [BUZON], 'externalMembers': [EXTERNO]}})
        self.guardar_estado_panel({**self.leer_estado_panel(), 'dominios': [DOMINIO, DOMINIO_2],
                                   'buzones': [BUZON, SEGUNDO, SUSPENDIDO], 'alias': [ALIAS],
                                   'suspendidos': [SUSPENDIDO]})
        self.dkim_antes = self.dkim_015()
        assert len(self.dkim_antes) == 4, f'firmas DKIM de la 0.15: {sorted(self.dkim_antes)}'
        registrar(f'OK: 0.15 con {DOMINIO} y {DOMINIO_2} (4 firmas DKIM), 3 buzones (uno suspendido) y el alias '
                  f'{ALIAS} con un destino externo.')

    def dkim_015(self) -> set:
        items = self.api('GET', '/api/settings/list?prefix=signature&limit=1000').get('items') or {}
        if isinstance(items, list):
            items = {i.get('key'): i.get('value') for i in items}
        firmas: dict = {}
        for clave, valor in items.items():
            identificador, _, campo = clave.rpartition('.')
            if campo in ('domain', 'selector'):
                firmas.setdefault(identificador, {})[campo] = valor
        return {(f['domain'], f['selector']) for f in firmas.values() if 'domain' in f and 'selector' in f}

    def dkim_016(self) -> set:
        dominios = {d['id']: d.get('name') for d in self.lista_016('Domain', ['name'])}
        return {(dominios.get(f.get('domainId')), f.get('selector'))
                for f in self.lista_016('DkimSignature', ['domainId', 'selector'])}

    def entregar(self) -> None:
        """Un correo de fuera, por el 25, al buzón de prueba."""
        self.asunto = 'Migracion ' + secrets.token_hex(6)

        class SmtpLocal(smtplib.SMTP):
            def _get_socket(self, host, port, timeout):
                return socket.create_connection((DIRECCION, port), timeout)

        with SmtpLocal(MAIL, 25, timeout=120) as smtp:
            smtp.ehlo('remitente.example')
            smtp.sendmail('alguien@remitente.example', [BUZON],
                          f'From: alguien@remitente.example\r\nTo: {BUZON}\r\nSubject: {self.asunto}\r\n'
                          f'Message-ID: <{self.asunto.replace(" ", ".")}@remitente.example>\r\n\r\n'
                          f'Cuerpo de {self.asunto}\r\n')
        esperar(self.correo_entregado, 'que el correo llegue al buzón', segundos=90)
        registrar(f'OK: correo «{self.asunto}» entregado por el 25 y leído por IMAP.')

    def correo_entregado(self) -> bool:
        # En todas las carpetas, no solo INBOX: con salida a Internet (la CI)
        # el filtro de spam del motor lleva el mensaje de prueba, de un
        # remitente sin SPF, DKIM ni DMARC, a la de correo no deseado, y lo que
        # se comprueba es que llegó al buzón.
        with self.imap(BUZON, self.clave_buzon) as sesion:
            for carpeta in carpetas_imap(sesion):
                tipo, _ = sesion.select(comillas_imap(carpeta), readonly=True)
                if tipo != 'OK':
                    continue
                _, encontrados = sesion.search(None, 'SUBJECT', f'"{self.asunto}"')
                if not encontrados[0].split():
                    continue
                _, partes = sesion.fetch(encontrados[0].split()[0], '(BODY.PEEK[TEXT])')
                if f'Cuerpo de {self.asunto}' in partes[0][1].decode():
                    return True
            return False

    def comprobar_datos(self, que: str) -> None:
        """El mismo correo con la misma contraseña, el otro dominio, y el suspendido sin poder entrar."""
        assert self.correo_entregado(), f'{que}: el correo no está en el buzón'
        with self.imap(SEGUNDO, self.clave_segundo):
            pass
        if PANEL_REAL:
            # El panel de verdad no conoce los buzones de la prueba: no puede
            # volver a suspender el que el script oficial no conserva.
            registrar(f'OK: {que}: el correo se lee por IMAP con la misma contraseña y el otro dominio funciona.')
            return
        try:
            self.imap(SUSPENDIDO, self.clave_suspendido).logout()
        except imaplib.IMAP4.error:
            pass
        else:
            raise AssertionError(f'{que}: el buzón suspendido puede entrar')
        registrar(f'OK: {que}: el correo se lee por IMAP con la misma contraseña, el otro dominio funciona y el '
                  'buzón suspendido no entra.')

    def motor_sano(self) -> str:
        esperar(lambda: docker('inspect', '-f', '{{.State.Health.Status}}', 'mailway-mail').stdout.strip() == 'healthy',
                'que el motor esté sano', segundos=180)
        return docker('inspect', '-f', '{{.Config.Image}}', 'mailway-mail').stdout.strip()

    def carpetas(self, orden: str) -> list:
        return sorted(self.migraciones.glob(f'{orden}-*')) if self.migraciones.exists() else []

    def comprobar_trabajo(self, carpeta: Path) -> None:
        """El registro no lleva secretos y lo que los lleva ya no está."""
        registro = (carpeta / 'registro.log').read_text()
        for secreto in SECRETOS:
            assert secreto not in registro, f'un secreto aparece en {carpeta}/registro.log'
        for fichero in ('settings.json', 'principals.json', 'export.json', 'env-antes', 'migrate_v016.py'):
            assert not (carpeta / fichero).exists(), f'queda {fichero} en {carpeta}'
        assert not (carpeta / 'dependencias').exists(), f'quedan las dependencias en {carpeta}'

    def sin_mantenimiento(self) -> None:
        """Lo que dice la herramienta del motor del panel (la simulada o la de verdad)."""
        r = docker('exec', '-u', 'node', PANEL, 'node', 'server/dist/tools/motor.js', 'estado', comprobar=False)
        estado = json.loads(r.stdout.strip().splitlines()[-1])
        assert estado['mantenimiento']['activo'] is False, f'el panel sigue en mantenimiento: {estado}'

    def migrar_con_fallo(self) -> None:
        antes = self.env.read_bytes()
        self.guardar_estado_panel({**self.leer_estado_panel(), 'fallar': {'provisionar': True}})
        salida = self.instalador('--migrar-motor', '-y', codigo=1)
        assert 'Vuelta atrás: Stalwart 0.15' in salida, 'no se ve la vuelta atrás'
        assert 'stalwart:v0.15' in self.motor_sano(), 'el motor no ha vuelto a la 0.15'
        assert self.env.read_bytes() == antes, 'deploy/.env ha cambiado tras la vuelta atrás'
        self.sin_mantenimiento()
        self.comprobar_trabajo(self.carpetas('migracion-motor')[-1])
        self.comprobar_datos('tras la vuelta atrás automática')
        self.sirve(self.primero, 'el certificado de Traefik (de nuevo con la 0.15)')
        estado = self.leer_estado_panel()
        estado.pop('fallar')
        self.guardar_estado_panel(estado)
        registrar('OK: la migración que falla vuelve sola a la 0.15 sin cambiar deploy/.env ni perder datos.')

    def migrar(self) -> None:
        self.instalador('--migrar-motor', '-y')
        assert 'stalwart:v0.16' in self.motor_sano(), 'el motor no es la 0.16'
        env = self.leer_env()
        assert env.get('MAILWAY_MOTOR') == MOTOR_016, env.get('MAILWAY_MOTOR')
        assert re.fullmatch(r'mailway-stalwart-data-\d{8}-\d{6}', env.get('MAILWAY_STALWART_DATA_VOLUME', '')), \
            env.get('MAILWAY_STALWART_DATA_VOLUME')
        assert env.get('MAILWAY_MOTOR_MIGRADO'), 'falta MAILWAY_MOTOR_MIGRADO'
        self.sin_mantenimiento()
        self.comprobar_trabajo(self.carpetas('migracion-motor')[-1])
        self.comprobar_datos('tras migrar')
        listas = [lista for lista in self.lista_016('MailingList') if lista.get('emailAddress') == ALIAS]
        assert listas and EXTERNO in json.dumps(listas), f'el alias {ALIAS} no está con su destino externo: {listas}'
        despues = {f for f in self.dkim_016() if f[0] != MAIL}
        assert despues == self.dkim_antes, f'firmas DKIM: antes {sorted(self.dkim_antes)}, después {sorted(despues)}'
        self.sirve(self.primero, 'el certificado de Traefik con la 0.16', con_587=True)
        self.comprobar_ajustes_016()
        registrar(f'OK: migración a la 0.16, con el alias y su destino externo y las {len(despues)} firmas DKIM '
                  'de antes.')

    def revertir(self) -> None:
        self.instalador('--revertir-motor', '-y')
        assert 'stalwart:v0.15' in self.motor_sano(), 'el motor no ha vuelto a la 0.15'
        env = self.leer_env()
        assert env.get('MAILWAY_MOTOR') == MOTOR_015 and not env.get('MAILWAY_MOTOR_MIGRADO'), env
        self.sin_mantenimiento()
        self.comprobar_datos('tras revertir')
        self.sirve(self.primero, 'el certificado de Traefik (de nuevo con la 0.15)')
        registrar('OK: --revertir-motor vuelve a la 0.15 con sus datos.')

    def retirar(self) -> None:
        self.instalador('--retirar-motor-anterior', '-y', entorno={'MAILWAY_RETIRAR_VOLUMEN': 'otro-volumen'},
                        codigo=1)
        assert docker('volume', 'inspect', 'mailway-mail-data', comprobar=False).returncode == 0, \
            'se ha borrado el volumen de la 0.15 con un nombre que no coincide'
        salida = self.instalador('--retirar-motor-anterior', '-y',
                                 entorno={'MAILWAY_RETIRAR_VOLUMEN': 'mailway-mail-data'})
        assert docker('volume', 'inspect', 'mailway-mail-data', comprobar=False).returncode != 0, \
            'el volumen de la 0.15 sigue ahí'
        assert 'intentos de migración' in salida, 'no se dicen los volúmenes de los intentos que volvieron atrás'
        # La actualización siguiente no vuelve a crear el volumen de la 0.15.
        self.instalar()
        assert docker('volume', 'inspect', 'mailway-mail-data', comprobar=False).returncode != 0, \
            'la actualización ha vuelto a crear el volumen de la 0.15'
        assert 'stalwart:v0.16' in self.motor_sano()
        self.comprobar_datos('tras retirar la 0.15 y actualizar')
        registrar('OK: --retirar-motor-anterior borra solo el volumen de la 0.15, y solo con su nombre; la '
                  'actualización siguiente no lo vuelve a crear.')

    # -- diagnóstico y limpieza

    def diagnostico(self) -> None:
        registrar('== Diagnóstico')
        registrar(docker('ps', '-a', comprobar=False).stdout)
        for contenedor in ('mailway-mail', 'mailway-mail-gw', 'mailway-webmail', 'mailway-certs-dumper',
                           'mailway-bulwark', 'mailway-bulwark-gw', *TEMPORALES, TRAEFIK_RUTAS):
            r = docker('logs', '--tail', '80', contenedor, comprobar=False)
            registrar(f'--- docker logs {contenedor}\n{r.stdout}{r.stderr}')
        if 'v0.15' in docker('inspect', '-f', '{{.Config.Image}}', 'mailway-mail', comprobar=False).stdout:
            r = docker('exec', 'mailway-mail', 'sh', '-c', 'tail -n 80 /opt/stalwart/logs/stalwart.log.*',
                       comprobar=False)
            registrar(f'--- registro de Stalwart 0.15\n{r.stdout}{r.stderr}')

    def limpiar(self) -> None:
        for motor in (MOTOR_016, MOTOR_015):
            subprocess.run(['docker', 'compose', '--env-file', str(self.env), '-f',
                            str(DEPLOY / 'docker-compose.mail.yml'), '-f', str(self.extra), '--profile', 'tls',
                            '--profile', 'bulwark', 'down', '-v', '--remove-orphans', '--timeout', '5'],
                           capture_output=True, env={**os.environ, 'MAILWAY_MOTOR': motor})
        if PANEL_REAL:
            r = docker('logs', '--tail', '40', PANEL, comprobar=False)
            registrar(f'--- docker logs {PANEL} (final)\n{r.stdout}{r.stderr}')
        docker('rm', '-f', 'skyway-traefik', PANEL, TRAEFIK_RUTAS, *TEMPORALES, comprobar=False)
        docker('network', 'rm', 'skyway-edge', comprobar=False)
        # La prueba empieza sin volúmenes de Mailway (comprobar_entorno): los
        # que quedan son suyos, también los de cada intento de migración.
        volumenes = [v for v in docker('volume', 'ls', '-q', comprobar=False).stdout.split() if v.startswith('mailway-')]
        if volumenes:
            docker('volume', 'rm', '-f', *volumenes, comprobar=False)


def renovacion(pila: Pila) -> None:
    # Renovación: Traefik sustituye el certificado en acme.json.
    pila.escribir_acme((pila.otro, [OTRO]), (pila.renovado, [MAIL]))
    pila.sirve(pila.renovado, 'el certificado renovado')
    pila.extractor_correcto(pila.renovado)
    pila.comprobar_imap_webmail()
    # Un comodín que caduca más tarde: el extractor lo prefiere y el motor lo
    # sirve sin reiniciarse.
    pila.escribir_acme((pila.otro, [OTRO]), (pila.renovado, [MAIL]), (pila.comodin, [f'*.{DOMINIO}']))
    pila.sirve(pila.comodin, 'el certificado comodín')
    pila.extractor_correcto(pila.comodin)
    pila.comprobar_volumen()
    pila.comprobar_imap_y_smtp_directos()


def prueba_015(pila: Pila) -> None:
    pila.preparar(volcado_antiguo=True)
    pila.instalar()
    pila.extractor_correcto(pila.primero)
    pila.comprobar_volumen()
    pila.sirve(pila.primero, 'el certificado de Traefik')
    pila.crear_buzon()
    pila.comprobar_imap_webmail()
    pila.comprobar_tema_webmail()
    pila.comprobar_contrasena_incorrecta()
    pila.comprobar_imap_y_smtp_directos()
    pila.comprobar_rutas()
    renovacion(pila)
    pila.comprobar_instalador()
    # Bulwark necesita la 0.16: con la 0.15, activarlo se niega sin tocar nada.
    antes = pila.env.read_bytes()
    salida = pila.instalador('--activar-bulwark', codigo=1)
    assert 'Bulwark necesita Stalwart 0.16' in salida, 'no explica por qué no se activa Bulwark'
    assert pila.env.read_bytes() == antes, 'deploy/.env ha cambiado al negarse a activar Bulwark'
    assert docker('inspect', 'mailway-bulwark', comprobar=False).returncode != 0, 'hay un contenedor de Bulwark'
    registrar('OK: con Stalwart 0.15, --activar-bulwark se niega sin cambiar nada.')


def prueba_016(pila: Pila) -> None:
    pila.preparar(volcado_antiguo=False)
    pila.instalar()
    if PANEL_REAL:
        # Junto a Skyway, el instalador empareja el panel (su puesta en marcha)
        # y después le pide sus ajustes del motor; aquí no hay Skyway: se hace
        # con su herramienta y se repite la instalación.
        pila.poner_en_marcha_panel()
        pila.instalar()
    pila.extractor_correcto(pila.primero)
    pila.comprobar_volumen()
    pila.sirve(pila.primero, 'el certificado de Traefik', con_587=True)
    pila.comprobar_ajustes_016()
    pila.crear_buzon()
    pila.comprobar_imap_webmail()
    pila.comprobar_tema_webmail()
    pila.comprobar_contrasena_incorrecta()
    pila.comprobar_imap_y_smtp_directos()
    pila.comprobar_rutas()
    renovacion(pila)
    pila.comprobar_instalador()
    # Una actualización sobre lo instalado: sin primer arranque ni reinicio.
    salida = pila.instalar()
    assert 'Primer arranque de Stalwart 0.16' not in salida, 'la actualización repite el primer arranque'
    assert 'necesita reiniciarse' not in salida, 'la actualización vuelve a pedir un reinicio del motor'
    pila.comprobar_imap_y_smtp_directos()
    registrar('OK: una actualización sobre la 0.16 instalada no repite el primer arranque ni reinicia el motor.')


def prueba_bulwark(pila: Pila) -> None:
    pila.preparar(volcado_antiguo=False)
    salida = pila.instalar()
    assert 'Bulwark (beta):      desactivado' in salida, 'el resumen no dice que Bulwark está desactivado'
    assert docker('inspect', 'mailway-bulwark', comprobar=False).returncode != 0, \
        'una instalación levanta Bulwark sin pedirlo'
    pila.extractor_correcto(pila.primero)
    pila.crear_buzon()
    pila.comprobar_bulwark()
    pila.comprobar_imap_webmail()


def prueba_migracion(pila: Pila) -> None:
    pila.preparar(volcado_antiguo=False)
    pila.instalar()
    # Como un servidor instalado antes de la 0.16: deploy/.env sin MAILWAY_MOTOR.
    pila.env.write_text(''.join(linea for linea in pila.env.read_text().splitlines(keepends=True)
                                if not linea.startswith('MAILWAY_MOTOR=')))
    if PANEL_REAL:
        pila.poner_en_marcha_panel()
    pila.extractor_correcto(pila.primero)
    pila.sirve(pila.primero, 'el certificado de Traefik')
    pila.crear_buzon()
    pila.sembrar_015()
    pila.entregar()
    pila.comprobar_datos('con la 0.15')
    if PANEL_REAL:
        registrar('(Con el panel de verdad no se provoca el fallo: la vuelta atrás se prueba con el simulado.)')
    else:
        pila.migrar_con_fallo()
    pila.migrar()
    pila.comprobar_imap_webmail()
    pila.comprobar_imap_y_smtp_directos()
    pila.comprobar_instalador()
    pila.revertir()
    pila.migrar()
    pila.retirar()


def main() -> int:
    argumentos = argparse.ArgumentParser(description='Prueba de la pila de correo con contenedores reales.')
    modo = argumentos.add_mutually_exclusive_group()
    modo.add_argument('--motor', choices=(MOTOR_015, MOTOR_016), default=MOTOR_015,
                      help='motor de la instalación (por defecto, stalwart-0.15)')
    modo.add_argument('--migracion', action='store_true', help='de Stalwart 0.15 a 0.16, con sus vueltas atrás')
    modo.add_argument('--bulwark', action='store_true', help='Stalwart 0.16 con Bulwark activado y desactivado')
    opciones = argumentos.parse_args()
    comprobar_entorno()
    motor = MOTOR_016 if opciones.bulwark else (MOTOR_015 if opciones.migracion else opciones.motor)
    with tempfile.TemporaryDirectory(prefix='mailway-pila-') as temporal:
        carpeta = Path(temporal)
        carpeta.chmod(0o755)
        pila = Pila(carpeta, motor, con_panel=opciones.migracion or motor == MOTOR_016)
        try:
            if opciones.migracion:
                prueba_migracion(pila)
                registrar('OK: migración de Stalwart 0.15 a 0.16 comprobada con contenedores reales.')
            elif opciones.bulwark:
                prueba_bulwark(pila)
                registrar('OK: Bulwark activado y desactivado por el instalador, comprobado con contenedores reales.')
            elif motor == MOTOR_016:
                prueba_016(pila)
                registrar('OK: pila de correo con Stalwart 0.16 comprobada con contenedores reales.')
            else:
                prueba_015(pila)
                registrar('OK: pila de correo con Stalwart 0.15 comprobada con contenedores reales.')
            return 0
        except BaseException as error:
            registrar(f'FALLO: {type(error).__name__}: {error}')
            pila.diagnostico()
            return 1
        finally:
            pila.limpiar()


if __name__ == '__main__':
    sys.exit(main())
