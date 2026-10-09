#!/usr/bin/env python3
"""Prueba de la pila de correo con contenedores reales (CI, máquina desechable).

Levanta con el instalador (deploy/instalar.sh --actualizar) Stalwart v0.15.5,
Roundcube y el extractor del certificado (perfil «tls») con la topología de
deploy/docker-compose.mail.yml: red interna con subred fija, red skyway-edge y
un Traefik de Skyway simulado del que solo se usa su volumen de certificados
(acme.json con certificados de laboratorio). Comprueba:

  - que el extractor sustituye al volcado antiguo: migra su carpeta, retira
    las claves de otros dominios y deja en el volumen solo el par del servidor;
  - el certificado servido en 993 y 465 (cadena, nombre y huella);
  - el inicio de sesión IMAP desde el webmail (biblioteca de Roundcube) y
    desde fuera, y la autenticación SMTP en 465 y 587, sin enviar correo;
  - que la pantalla de acceso del webmail usa Elastic con la marca de
    Mailway;
  - la renovación y el paso a un certificado comodín, aplicados por el
    extractor sin perder el acceso;
  - deploy/instalar.sh --comprobar y --probar-acceso.

Credenciales desechables y dominios .test: nunca toca nada de producción. Se
niega a ejecutarse si encuentra restos de Mailway o de Skyway y exige
MAILWAY_PRUEBA_DESECHABLE=1 (lo define .github/workflows/stack.yml).

    MAILWAY_PRUEBA_DESECHABLE=1 python3 deploy/prueba-stack.py
"""
from __future__ import annotations

import base64
import datetime as dt
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

DOMINIO = 'mailway.test'
MAIL = f'mail.{DOMINIO}'
BUZON = f'prueba@{DOMINIO}'
OTRO = 'web.otra-empresa.test'
VOLUMEN_ACME = 'mailway-prueba-acme'


def imagen_del_extractor() -> str:
    """La imagen de Python del compose (la del extractor), con su versión exacta.

    Se lee del compose para que siga a Dependabot, que solo actualiza ahí.
    """
    compose = (DEPLOY / 'docker-compose.mail.yml').read_text(encoding='utf-8')
    encontrada = re.search(r'^\s*image:\s*(python:\S+)\s*$', compose, re.MULTILINE)
    if not encontrada:
        raise SystemExit('No se encuentra la imagen de Python en deploy/docker-compose.mail.yml.')
    return encontrada.group(1)


# La misma imagen que el extractor: una sola descarga para las tareas auxiliares.
IMAGEN_AUX = imagen_del_extractor()
API = 'http://127.0.0.1:18080'
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


def docker(*argumentos: str, entrada: str | None = None, comprobar: bool = True) -> subprocess.CompletedProcess:
    resultado = subprocess.run(['docker', *argumentos], input=entrada, text=True, capture_output=True)
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


class Pila:
    def __init__(self, carpeta: Path):
        self.carpeta = carpeta
        self.lab = Laboratorio(carpeta / 'pki')
        dia = dt.timedelta(days=1)
        self.antiguo = self.lab.emitir('antiguo', [MAIL], hasta=10 * dia)
        self.primero = self.lab.emitir('primero', [MAIL], hasta=40 * dia)
        self.renovado = self.lab.emitir('renovado', [MAIL], hasta=80 * dia, tipo='rsa')
        self.comodin = self.lab.emitir('comodin', [f'*.{DOMINIO}'], hasta=85 * dia)
        self.otro = self.lab.emitir('otro', [OTRO], hasta=90 * dia)
        self.clave_admin = secrets.token_hex(24)
        self.clave_buzon = 'Prueba ' + secrets.token_urlsafe(18)
        valores = {
            'MAILWAY_INSTALACION': 'skyway',
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
            'MAILWAY_PANEL_INTERNAL_URL': 'http://skyway-mailway-panel:4100',
            'MAILWAY_SECRET': secrets.token_hex(32),
            'MAILWAY_SETUP_TOKEN': secrets.token_hex(16),
            'MAILWAY_TRAEFIK_TOKEN': secrets.token_hex(24),
            'MAILWAY_WEBMAIL_TOKEN': secrets.token_hex(24),
            'MAILWAY_INTERNAL_SUBNET': '10.203.53.0/24',
            'MAILWAY_MAIL_INTERNAL_IP': '10.203.53.10',
        }
        ocultar(self.clave_admin, self.clave_buzon, *(valores[k] for k in (
            'ROUNDCUBE_DES_KEY', 'MAILWAY_SECRET', 'MAILWAY_SETUP_TOKEN', 'MAILWAY_TRAEFIK_TOKEN',
            'MAILWAY_WEBMAIL_TOKEN')))
        self.env = carpeta / 'mailway.env'
        self.env.write_text(''.join(f"{clave}='{valor}'\n" for clave, valor in valores.items()))
        self.env.chmod(0o600)
        # Solo para la prueba: la CA de laboratorio para el extractor y el
        # diagnóstico del webmail, la API del motor en 127.0.0.1 y un
        # extractor que mira el acme.json cada 3 segundos.
        ca = self.lab.ca
        self.extra = carpeta / 'compose.prueba.yml'
        self.extra.write_text(f"""services:
  mailway-mail:
    ports:
      - '127.0.0.1:18080:8080'
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
""")
        self.contexto = ssl.create_default_context(cafile=str(ca))
        # Se quitan (no se vacían) las variables que el instalador o Compose
        # tomarían del entorno antes que de deploy/.env: Compose da prioridad
        # al entorno, y una contraseña vacía haría fallar la interpolación.
        self.entorno = {clave: valor for clave, valor in os.environ.items() if clave not in (
            'STALWART_ADMIN_PASSWORD', 'SKYWAY_TOKEN', 'CLOUDFLARE_API_TOKEN', 'LETSENCRYPT_EMAIL', 'MAILWAY_DOMINIO',
            'MAILWAY_MAIL_HOST', 'MAILWAY_WEBMAIL_HOST', 'MAILWAY_PANEL_HOST', 'MAILWAY_IP', 'MAIL_HOSTNAME')}
        self.entorno.update({'MAILWAY_ENV_FILE': str(self.env), 'MAILWAY_COMPOSE_EXTRA': str(self.extra),
                             'MAILWAY_ESPERA_DNS': '0', 'MAILWAY_TRAEFIK_PROVEEDOR': '0'})

    # -- preparación

    def escribir_acme(self, *entradas) -> None:
        (self.carpeta / 'acme.json').write_text(acme_json(list(entradas)))
        docker('run', '--rm', '-v', f'{VOLUMEN_ACME}:/le', '-v', f'{self.carpeta}:/fuente:ro', IMAGEN_AUX, 'sh', '-c',
               'cp /fuente/acme.json /le/.acme.json.tmp && chmod 600 /le/.acme.json.tmp '
               '&& mv /le/.acme.json.tmp /le/acme.json')

    def preparar(self) -> None:
        # Skyway simulado: su red y un «Traefik» que solo aporta el volumen.
        docker('network', 'create', 'skyway-edge')
        docker('volume', 'create', VOLUMEN_ACME)
        self.escribir_acme((self.otro, [OTRO]), (self.primero, [MAIL]))
        docker('run', '-d', '--name', 'skyway-traefik', '--network', 'skyway-edge',
               '-v', f'{VOLUMEN_ACME}:/letsencrypt', IMAGEN_AUX, 'sleep', '86400')
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

    def instalar(self) -> None:
        registrar('== deploy/instalar.sh --actualizar')
        subprocess.run(['bash', str(DEPLOY / 'instalar.sh'), '--actualizar'], stdin=subprocess.DEVNULL,
                       env=self.entorno, check=True)

    # -- utilidades

    def api(self, metodo: str, ruta: str, cuerpo=None):
        peticion = urllib.request.Request(
            API + ruta, method=metodo, data=None if cuerpo is None else json.dumps(cuerpo).encode(),
            headers={'Authorization': 'Basic ' + base64.b64encode(f'admin:{self.clave_admin}'.encode()).decode(),
                     'Content-Type': 'application/json'})
        abridor = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with abridor.open(peticion, timeout=20) as respuesta:
            datos = json.load(respuesta)
        if not isinstance(datos, dict) or 'data' not in datos:
            raise AssertionError(f'La API del motor respondió {datos}')
        return datos['data']

    def servido(self, puerto: int) -> str:
        sondeo = extractor.sondear('127.0.0.1', puerto, MAIL, self.contexto)
        if not sondeo.verificado:
            raise AssertionError(f'{puerto}: {sondeo.error}')
        return sondeo.huella

    def sirve(self, par, que: str) -> None:
        def comprobar():
            return all(self.servido(p) == par.huella for p in (993, 465))
        esperar(comprobar, f'que el motor sirva {que} en 993 y 465', segundos=150)
        registrar(f'OK: el motor sirve {que} en 993 y 465 (cadena, nombre y huella).')

    def extractor_correcto(self, par) -> None:
        """Espera a que el extractor dé por bueno ESE par (su estado muestra el principio de la huella)."""
        def comprobar():
            r = docker('exec', 'mailway-certs-dumper', 'python', '/app/extractor.py', 'estado', comprobar=False)
            return r.stdout.strip() if r.returncode == 0 and par.huella[:16] in r.stdout else None
        registrar('OK: extractor → ' + esperar(comprobar, 'que el extractor dé el certificado por bueno').splitlines()[0])

    def acceso_webmail(self, clave: str):
        return docker('exec', '-i', '-u', 'www-data', 'mailway-webmail', 'php', '/opt/mailway/comprobar.php', 'acceso',
                      entrada=f'{BUZON}\n{clave}\n', comprobar=False)

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
        registrar('OK: el volumen del motor solo contiene el par del servidor (volcado antiguo migrado y claves '
                  'de otros dominios retiradas).')

    def crear_buzon(self) -> None:
        vacio = {'quota': 0, 'urls': [], 'memberOf': [], 'lists': [], 'members': [], 'enabledPermissions': [],
                 'disabledPermissions': [], 'externalMembers': []}
        self.api('POST', '/api/principal', {'type': 'domain', 'name': DOMINIO, 'description': 'Prueba',
                                            'secrets': [], 'emails': [], 'roles': [], **vacio})
        cifrada = subprocess.run(['openssl', 'passwd', '-6', '-stdin'], input=self.clave_buzon, text=True,
                                 capture_output=True, check=True).stdout.strip()
        self.api('POST', '/api/principal', {'type': 'individual', 'name': BUZON, 'description': 'Buzón de prueba',
                                            'secrets': [cifrada], 'emails': [BUZON], 'roles': ['user'], **vacio})
        registrar(f'OK: buzón de prueba {BUZON} creado en el motor.')

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

        class Imap(imaplib.IMAP4_SSL):
            def _create_socket(self, timeout):
                conexion = socket.create_connection(('127.0.0.1', self.port), timeout)
                return contexto.wrap_socket(conexion, server_hostname=MAIL)

        with Imap(MAIL, 993, ssl_context=contexto, timeout=20) as imap:
            imap.login(BUZON, self.clave_buzon)
            tipo, _ = imap.select('INBOX')
            assert tipo == 'OK', tipo
        registrar('OK: inicio de sesión IMAP en 993 y apertura de la bandeja de entrada.')

        class SmtpSsl(smtplib.SMTP_SSL):
            def _get_socket(self, host, port, timeout):
                conexion = socket.create_connection(('127.0.0.1', port), timeout)
                return contexto.wrap_socket(conexion, server_hostname=MAIL)

        class SmtpLocal(smtplib.SMTP):
            def _get_socket(self, host, port, timeout):
                return socket.create_connection(('127.0.0.1', port), timeout)

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
        registrar('== deploy/instalar.sh --comprobar')
        subprocess.run(['bash', str(DEPLOY / 'instalar.sh'), '--comprobar'], stdin=subprocess.DEVNULL,
                       env=self.entorno, check=True)
        registrar('== deploy/instalar.sh --probar-acceso')
        resultado = subprocess.run(['bash', str(DEPLOY / 'instalar.sh'), '--probar-acceso'],
                                   input=f'{BUZON}\n{self.clave_buzon}\n', text=True, capture_output=True,
                                   env=self.entorno)
        registrar(resultado.stdout + resultado.stderr)
        assert resultado.returncode == 0, 'instalar.sh --probar-acceso falló'
        assert self.clave_buzon not in resultado.stdout + resultado.stderr

    # -- diagnóstico y limpieza

    def diagnostico(self) -> None:
        registrar('== Diagnóstico')
        registrar(docker('ps', '-a', comprobar=False).stdout)
        for contenedor in ('mailway-mail', 'mailway-webmail', 'mailway-certs-dumper'):
            r = docker('logs', '--tail', '80', contenedor, comprobar=False)
            registrar(f'--- docker logs {contenedor}\n{r.stdout}{r.stderr}')
        r = docker('exec', 'mailway-mail', 'sh', '-c', 'tail -n 80 /opt/stalwart/logs/stalwart.log.*', comprobar=False)
        registrar(f'--- registro de Stalwart\n{r.stdout}{r.stderr}')

    def limpiar(self) -> None:
        subprocess.run(['docker', 'compose', '--env-file', str(self.env), '-f', str(DEPLOY / 'docker-compose.mail.yml'),
                        '-f', str(self.extra), '--profile', 'tls', 'down', '-v', '--remove-orphans', '--timeout', '5'],
                       capture_output=True)
        for argumentos in (('rm', '-f', 'skyway-traefik'), ('network', 'rm', 'skyway-edge'),
                           ('volume', 'rm', '-f', VOLUMEN_ACME, 'mailway-mail-certs')):
            docker(*argumentos, comprobar=False)


def main() -> int:
    comprobar_entorno()
    with tempfile.TemporaryDirectory(prefix='mailway-pila-') as temporal:
        carpeta = Path(temporal)
        carpeta.chmod(0o755)
        pila = Pila(carpeta)
        try:
            pila.preparar()
            pila.instalar()
            pila.extractor_correcto(pila.primero)
            pila.comprobar_volumen()
            pila.sirve(pila.primero, 'el certificado de Traefik')
            pila.crear_buzon()
            pila.comprobar_imap_webmail()
            pila.comprobar_tema_webmail()
            pila.comprobar_contrasena_incorrecta()
            pila.comprobar_imap_y_smtp_directos()

            # Renovación: Traefik sustituye el certificado en acme.json.
            pila.escribir_acme((pila.otro, [OTRO]), (pila.renovado, [MAIL]))
            pila.sirve(pila.renovado, 'el certificado renovado')
            pila.extractor_correcto(pila.renovado)
            pila.comprobar_imap_webmail()
            # Un comodín que caduca más tarde: el motor debe dejar el exacto
            # (certificate.mailway.subjects lo permite sin reiniciarlo).
            pila.escribir_acme((pila.otro, [OTRO]), (pila.renovado, [MAIL]), (pila.comodin, [f'*.{DOMINIO}']))
            pila.sirve(pila.comodin, 'el certificado comodín')
            pila.extractor_correcto(pila.comodin)
            pila.comprobar_volumen()
            pila.comprobar_imap_y_smtp_directos()

            pila.comprobar_instalador()
            registrar('OK: pila de correo comprobada con contenedores reales.')
            return 0
        except BaseException as error:
            registrar(f'FALLO: {type(error).__name__}: {error}')
            pila.diagnostico()
            return 1
        finally:
            pila.limpiar()


if __name__ == '__main__':
    sys.exit(main())
