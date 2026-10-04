#!/usr/bin/env python3
"""Cambio de dominio con un Stalwart v0.15.5 real (CI, máquina desechable).

Comprueba, con un contenedor desechable de la misma imagen que
deploy/docker-compose.mail.yml y las MISMAS peticiones que el driver de
Mailway (server/src/engine/stalwart.ts: setAddresses, renamePrincipal,
reloadDirectory y removeDkim), que un buzón y un alias pasan de viejo.test a
nuevo.test sin perder nada:

  1. preparación: viejo.test y viejo.test.ejemplo (la trampa del prefijo de
     las claves DKIM), ana@viejo.test con contraseña y contraseña de
     aplicación, la lista info@viejo.test con ana, y correo en su buzón;
  2. pre-recepción: nuevo.test con DKIM y las direcciones nuevas añadidas;
  3. el correo a las dos direcciones entra en los mismos buzones;
  4. pasar: la dirección nueva es la principal y la lista se renombra;
  5. con el usuario viejo se envía ya como la dirección nueva (no como otra);
  6. renombrar el buzón conserva su número, el correo y las contraseñas;
  7. con el usuario nuevo, cambiar la contraseña conserva la de aplicación;
  8. baja: se quitan las direcciones viejas, se borra el dominio y solo sus
     claves DKIM, la recarga no da errores y viejo.test deja de recibir.

Credenciales desechables y dominios .test. Se niega a ejecutarse sin
MAILWAY_PRUEBA_DESECHABLE=1 (lo define .github/workflows/stack.yml) o si el
contenedor de la prueba ya existe, y lo retira siempre al terminar.

En la CI el contenedor arranca tal cual. Fuera de ella se adapta a dos
entornos de laboratorio habituales: un Docker sin la red «bridge» por defecto
(dockerd --bridge=none), con una red propia temporal, y un núcleo sin IPv6,
en el que la configuración inicial de Stalwart («[::]:puerto») no podría
abrir ningún puerto y se cambia a 0.0.0.0 antes del primer arranque.

    MAILWAY_PRUEBA_DESECHABLE=1 python3 deploy/prueba-cambio-dominio.py
"""
from __future__ import annotations

import base64
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
import time
import urllib.error
import urllib.request

CONTENEDOR = 'mw-prueba-cambio'
RED_PROPIA = 'mw-prueba-cambio-red'
# La misma imagen que deploy/docker-compose.mail.yml.
IMAGEN = 'stalwartlabs/stalwart:v0.15.5'
API = 'http://127.0.0.1:18080'
PUERTO_SMTP = 10025
PUERTO_ENVIO = 10587
PUERTO_IMAP = 10993

VIEJO = 'viejo.test'
TRAMPA = 'viejo.test.ejemplo'
NUEVO = 'nuevo.test'
ANA_V, ANA_N = f'ana@{VIEJO}', f'ana@{NUEVO}'
INFO_V, INFO_N = f'info@{VIEJO}', f'info@{NUEVO}'
REMITENTE = 'alguien@remoto.example'

SECRETOS: list = []
# Certificado autofirmado del motor recién creado: aquí no se prueba TLS.
SIN_VERIFICAR = ssl.create_default_context()
SIN_VERIFICAR.check_hostname = False
SIN_VERIFICAR.verify_mode = ssl.CERT_NONE


def registrar(texto: str) -> None:
    for secreto in SECRETOS:
        texto = texto.replace(secreto, '***')
    print(texto, flush=True)


def ocultar(*valores: str) -> None:
    SECRETOS.extend(valores)
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        for valor in valores:
            print(f'::add-mask::{valor}', flush=True)


def docker(*argumentos: str, comprobar: bool = True) -> subprocess.CompletedProcess:
    resultado = subprocess.run(['docker', *argumentos], text=True, capture_output=True)
    if comprobar and resultado.returncode != 0:
        raise AssertionError(f'docker {argumentos[0]} falló ({resultado.returncode}): '
                             f'{(resultado.stderr or resultado.stdout).strip()[-600:]}')
    return resultado


def esperar(funcion, que: str, segundos: float = 90, pausa: float = 2):
    """Repite la función hasta que devuelve algo verdadero."""
    limite = time.monotonic() + segundos
    ultimo = None
    while True:
        try:
            resultado = funcion()
            if resultado:
                return resultado
        except Exception as error:  # noqa: BLE001 — se reintenta y se informa al final
            ultimo = error
        if time.monotonic() > limite:
            raise AssertionError(f'Tiempo agotado esperando {que}' + (f': {ultimo}' if ultimo else '.'))
        time.sleep(pausa)


def cifrar(clave: str) -> str:
    """sha512-crypt ($6$), el formato que el panel guarda en el motor."""
    return subprocess.run(['openssl', 'passwd', '-6', '-stdin'], input=clave, text=True,
                          capture_output=True, check=True).stdout.strip()


def comprobar_entorno() -> None:
    if os.environ.get('MAILWAY_PRUEBA_DESECHABLE') != '1':
        sys.exit('Esta prueba crea y BORRA un contenedor de Docker. Solo se ejecuta en una máquina desechable '
                 '(la CI): define MAILWAY_PRUEBA_DESECHABLE=1.')
    existentes = docker('ps', '-a', '--format', '{{.Names}}').stdout.split()
    if CONTENEDOR in existentes:
        sys.exit(f'Ya existe un contenedor «{CONTENEDOR}» en este Docker: la prueba no se ejecuta.')
    if RED_PROPIA in docker('network', 'ls', '--format', '{{.Name}}').stdout.split():
        sys.exit(f'Ya existe una red «{RED_PROPIA}» en este Docker: la prueba no se ejecuta.')


def sin_red_por_defecto() -> bool:
    """dockerd --bridge=none: sin la red «bridge», los puertos publicados no llegan al contenedor."""
    return docker('network', 'inspect', 'bridge', comprobar=False).returncode != 0


def sin_ipv6() -> bool:
    """El núcleo es el mismo dentro del contenedor: si aquí no hay IPv6, allí tampoco."""
    try:
        socket.socket(socket.AF_INET6, socket.SOCK_STREAM).close()
    except OSError:
        return True
    return False


class Motor:
    """API de gestión del motor, con las mismas peticiones que el driver de Mailway."""

    def __init__(self, clave_admin: str):
        self.autorizacion = 'Basic ' + base64.b64encode(f'admin:{clave_admin}'.encode()).decode()
        # Sin proxies: el motor escucha en 127.0.0.1.
        self.abridor = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def api(self, metodo: str, ruta: str, cuerpo=None) -> dict:
        """Respuesta completa: Stalwart 0.15 devuelve los errores de gestión con HTTP 200 y { error }."""
        peticion = urllib.request.Request(
            API + ruta, method=metodo, data=None if cuerpo is None else json.dumps(cuerpo).encode(),
            headers={'Authorization': self.autorizacion, 'Content-Type': 'application/json'})
        try:
            with self.abridor.open(peticion, timeout=20) as respuesta:
                texto = respuesta.read().decode()
        except urllib.error.HTTPError as error:
            raise AssertionError(f'{metodo} {ruta}: HTTP {error.code} {error.read().decode()[:300]}') from None
        datos = json.loads(texto) if texto else {}
        if not isinstance(datos, dict):
            raise AssertionError(f'{metodo} {ruta}: respuesta inesperada {texto[:300]}')
        return datos

    def datos(self, metodo: str, ruta: str, cuerpo=None):
        respuesta = self.api(metodo, ruta, cuerpo)
        if 'error' in respuesta or 'data' not in respuesta:
            raise AssertionError(f'{metodo} {ruta}: el motor respondió {respuesta}')
        return respuesta['data']

    def listo(self) -> bool:
        return isinstance(self.datos('GET', '/api/principal?types=domain&page=1&limit=1'), dict)

    def crear(self, tipo: str, nombre: str, **campos) -> int:
        cuerpo = {'type': tipo, 'name': nombre, 'description': '', 'quota': 0, 'secrets': [], 'emails': [],
                  'urls': [], 'memberOf': [], 'roles': [], 'lists': [], 'members': [], 'enabledPermissions': [],
                  'disabledPermissions': [], 'externalMembers': []}
        cuerpo.update(campos)
        return self.datos('POST', '/api/principal', cuerpo)

    def principal(self, nombre: str) -> dict | None:
        respuesta = self.api('GET', f'/api/principal/{urllib.request.quote(nombre)}')
        if respuesta.get('error') == 'notFound':
            return None
        if 'data' not in respuesta:
            raise AssertionError(f'GET {nombre}: {respuesta}')
        return respuesta['data']

    @staticmethod
    def direcciones(principal: dict) -> list:
        """Como el driver: Stalwart omite el campo vacío o puede darlo como cadena."""
        valor = principal.get('emails')
        lista = valor if isinstance(valor, list) else [valor] if isinstance(valor, str) and valor else []
        return [d.lower() for d in lista]

    def patch(self, nombre: str, cambios: list) -> dict:
        return self.api('PATCH', f'/api/principal/{urllib.request.quote(nombre)}', cambios)

    def ensure_dkim(self, dominio: str) -> None:
        for algoritmo in ('Ed25519', 'Rsa'):
            self.datos('POST', '/api/dkim', {'id': None, 'algorithm': algoritmo, 'domain': dominio, 'selector': None})

    def recargar(self) -> None:
        """reloadDirectory: una recarga con errores no aplica nada y es un fallo."""
        resultado = self.datos('GET', '/api/reload') or {}
        errores = resultado.get('errors') or {}
        assert not errores, f'la recarga devolvió errores: {errores}'

    def set_addresses(self, nombre: str, add=(), remove=(), primary: str | None = None) -> list:
        """setAddresses del driver: lee, fusiona y escribe con UN PATCH «set emails» (nada si no cambia)."""
        actual = self.principal(nombre)
        assert actual is not None, f'{nombre} no existe en el motor'
        actuales = self.direcciones(actual)
        quitar = {d.lower() for d in remove}
        final = [d for d in actuales if d not in quitar]
        for d in add:
            if d.lower() not in final:
                final.append(d.lower())
        if primary:
            final = [primary.lower()] + [d for d in final if d != primary.lower()]
        if final != actuales:
            respuesta = self.patch(nombre, [{'action': 'set', 'field': 'emails', 'value': final}])
            assert 'error' not in respuesta, f'set emails de {nombre}: {respuesta}'
        return final

    def rename_principal(self, desde: str, hacia: str, esperada: str, emails: list | None = None) -> str:
        """renamePrincipal del driver: UN PATCH [set name, set emails?]; idempotente si ya se hizo."""
        cambios = [{'action': 'set', 'field': 'name', 'value': hacia}]
        if emails is not None:
            cambios.append({'action': 'set', 'field': 'emails', 'value': emails})
        respuesta = self.patch(desde, cambios)
        if 'error' not in respuesta:
            return 'renombrado'
        if respuesta.get('error') == 'notFound' and str(respuesta.get('item', '')).lower() == desde:
            destino = self.principal(hacia)
            if destino and esperada in self.direcciones(destino):
                return 'ya_hecho'
        raise AssertionError(f'renombrar {desde} → {hacia}: {respuesta}')

    def claves_firma(self) -> dict:
        return self.datos('GET', '/api/settings/keys?prefixes=signature') or {}

    def remove_dkim(self, dominio: str) -> list:
        """removeDkim del driver: claves exactas del dominio (id más largo que las prefija), delete y recarga."""
        claves = self.claves_firma()
        ids = [k[len('signature.'):-len('.domain')] for k in claves if k.endswith('.domain')]
        propios = {i for i in ids if str(claves.get(f'signature.{i}.domain', '')).lower() == dominio}
        ids.sort(key=len, reverse=True)
        borrar = []
        for clave in claves:
            resto = clave[len('signature.'):]
            dueno = next((i for i in ids if resto == i or resto.startswith(i + '.')), None)
            if dueno in propios:
                borrar.append(clave)
        if borrar:
            self.datos('POST', '/api/settings', [{'type': 'delete', 'keys': sorted(borrar)}])
            self.recargar()
        return sorted(propios)


# -- correo


def imap_total(usuario: str, clave: str) -> int:
    """Inicia sesión y cuenta los mensajes de todas las carpetas (el filtro puede llevar alguno a «Junk Mail»)."""
    with imaplib.IMAP4_SSL('127.0.0.1', PUERTO_IMAP, ssl_context=SIN_VERIFICAR, timeout=20) as imap:
        imap.login(usuario, clave)
        _, carpetas = imap.list()
        total = 0
        for linea in carpetas or []:
            nombre = re.search(rb'"([^"]*)"\s*$', linea) or re.search(rb'(\S+)\s*$', linea)
            if not nombre:
                continue
            tipo, estado = imap.status(b'"' + nombre.group(1) + b'"', '(MESSAGES)')
            if tipo == 'OK' and estado and estado[0]:
                cuenta = re.search(rb'MESSAGES (\d+)', estado[0])
                total += int(cuenta.group(1)) if cuenta else 0
        return total


def imap_rechaza(usuario: str, clave: str) -> bool:
    try:
        with imaplib.IMAP4_SSL('127.0.0.1', PUERTO_IMAP, ssl_context=SIN_VERIFICAR, timeout=20) as imap:
            imap.login(usuario, clave)
    except imaplib.IMAP4.error:
        return True
    return False


def imap_anadir(usuario: str, clave: str, asunto: str) -> None:
    with imaplib.IMAP4_SSL('127.0.0.1', PUERTO_IMAP, ssl_context=SIN_VERIFICAR, timeout=20) as imap:
        imap.login(usuario, clave)
        mensaje = (f'From: {REMITENTE}\r\nTo: {usuario}\r\nSubject: {asunto}\r\n'
                   f'Message-ID: <{secrets.token_hex(8)}@remoto.example>\r\n\r\nHola.\r\n').encode()
        tipo, _ = imap.append('INBOX', None, imaplib.Time2Internaldate(time.time()), mensaje)
        assert tipo == 'OK', f'APPEND en el buzón de {usuario}: {tipo}'


def destinatario(rcpt: str) -> tuple:
    """Código de RCPT TO en el puerto 25, sin enviar nada."""
    with smtplib.SMTP('127.0.0.1', PUERTO_SMTP, timeout=20) as smtp:
        smtp.ehlo('mx.remoto.example')
        smtp.mail(REMITENTE)
        codigo, texto = smtp.rcpt(rcpt)
        smtp.rset()
        return codigo, texto.decode(errors='replace')


def entregar(rcpt: str, asunto: str) -> None:
    """Entrega un mensaje por el puerto 25 (como un servidor de fuera); falla si se rechaza."""
    mensaje = (f'From: {REMITENTE}\r\nTo: {rcpt}\r\nSubject: {asunto}\r\n'
               f'Message-ID: <{secrets.token_hex(8)}@remoto.example>\r\n\r\nHola.\r\n')
    with smtplib.SMTP('127.0.0.1', PUERTO_SMTP, timeout=30) as smtp:
        smtp.ehlo('mx.remoto.example')
        rechazados = smtp.sendmail(REMITENTE, [rcpt], mensaje)
        assert not rechazados, f'entrega a {rcpt} rechazada: {rechazados}'


def remitente_aceptado(usuario: str, clave: str, remitente: str) -> int:
    """Código de MAIL FROM en el 587 (STARTTLS) tras autenticarse; no envía nada."""
    with smtplib.SMTP('127.0.0.1', PUERTO_ENVIO, timeout=20) as smtp:
        smtp.ehlo('cliente.remoto.example')
        smtp.starttls(context=SIN_VERIFICAR)
        smtp.ehlo('cliente.remoto.example')
        smtp.login(usuario, clave)
        codigo, _ = smtp.mail(remitente)
        smtp.rset()
        return codigo


class Prueba:
    def __init__(self):
        self.clave_admin = secrets.token_hex(24)
        self.clave = 'Principal ' + secrets.token_urlsafe(12)
        self.clave_app = 'App ' + secrets.token_urlsafe(12)
        self.clave_nueva = 'Nueva ' + secrets.token_urlsafe(12)
        ocultar(self.clave_admin, self.clave, self.clave_app, self.clave_nueva)
        self.motor = Motor(self.clave_admin)
        self.mensajes = 0
        self.red_creada = False

    def paso(self, texto: str) -> None:
        registrar(f'== {texto}')

    def ok(self, texto: str) -> None:
        registrar(f'OK: {texto}')

    def arrancar(self) -> None:
        self.paso('Contenedor desechable de Stalwart v0.15.5')
        opciones = ['-e', f'STALWART_ADMIN_PASSWORD={self.clave_admin}',
                    '-p', '127.0.0.1:18080:8080', '-p', f'127.0.0.1:{PUERTO_SMTP}:25',
                    '-p', f'127.0.0.1:{PUERTO_ENVIO}:587', '-p', f'127.0.0.1:{PUERTO_IMAP}:993']
        if sin_red_por_defecto():
            docker('network', 'create', RED_PROPIA)
            self.red_creada = True
            opciones += ['--network', RED_PROPIA]
            registrar(f'Docker sin la red «bridge» por defecto: se usa la red temporal {RED_PROPIA}.')
        orden: list = []
        if sin_ipv6():
            # Lo mismo que el entrypoint.sh de la imagen, con los puertos en IPv4.
            opciones += ['--entrypoint', '/bin/sh']
            orden = ['-c', '/usr/local/bin/stalwart --init /opt/stalwart'
                           ' && sed -i "s/\\[::\\]/0.0.0.0/" /opt/stalwart/etc/config.toml'
                           ' && exec /usr/local/bin/stalwart --config /opt/stalwart/etc/config.toml']
            registrar('Núcleo sin IPv6: el motor escuchará en 0.0.0.0.')
        docker('run', '-d', '--name', CONTENEDOR, *opciones, IMAGEN, *orden)
        # Sin salida a Internet el primer arranque espera a que falle la descarga del webadmin (~1 min).
        esperar(self.motor.listo, 'la API de gestión del motor', segundos=240)
        self.ok('la API de gestión responde.')

    def esperar_mensajes(self, usuario: str, clave: str, cuantos: int, que: str) -> int:
        def contar():
            total = imap_total(usuario, clave)
            return total if total >= cuantos else None

        total = esperar(contar, f'{cuantos} mensajes en el buzón ({que})')
        assert total == cuantos, f'se esperaban {cuantos} mensajes y hay {total}'
        return total

    # -- 1

    def preparar(self) -> None:
        self.paso('1. Preparación')
        m = self.motor
        for dominio in (VIEJO, TRAMPA):
            m.crear('domain', dominio, description=dominio)
            m.ensure_dkim(dominio)
        m.recargar()
        app = f'$app$movil${cifrar(self.clave_app)}'
        m.crear('individual', ANA_V, secrets=[cifrar(self.clave), app], emails=[ANA_V], roles=['user'])
        m.crear('list', INFO_V, emails=[INFO_V], members=[ANA_V])
        self.id_info = m.principal(INFO_V)['id']
        imap_anadir(ANA_V, self.clave, 'Correo antiguo 1')
        imap_anadir(ANA_V, self.clave, 'Correo antiguo 2')
        entregar(ANA_V, 'Entrante antes del cambio')
        self.mensajes = self.esperar_mensajes(ANA_V, self.clave, 3, 'dos con APPEND y uno por el 25')
        self.ok('viejo.test y viejo.test.ejemplo con DKIM, ana con contraseña y contraseña de aplicación, '
                'la lista info y 3 mensajes en el buzón.')

    # -- 2

    def pre_recepcion(self) -> None:
        self.paso('2. Dominio nuevo y pre-recepción')
        m = self.motor
        m.crear('domain', NUEVO, description=NUEVO)
        m.ensure_dkim(NUEVO)
        m.recargar()
        # Los errores en los que se apoya el driver: dominio sin dar de alta y dirección de otro.
        r = m.patch(ANA_V, [{'action': 'set', 'field': 'emails', 'value': [ANA_V, 'ana@otro.test']}])
        assert r.get('error') == 'notFound' and r.get('item') == 'otro.test', r
        r = m.patch(ANA_V, [{'action': 'set', 'field': 'emails', 'value': [ANA_V, INFO_V]}])
        assert r.get('error') == 'fieldAlreadyExists', r
        assert m.direcciones(m.principal(ANA_V)) == [ANA_V], 'un PATCH rechazado no cambia nada'
        assert m.set_addresses(ANA_V, add=[ANA_N]) == [ANA_V, ANA_N]
        assert m.set_addresses(INFO_V, add=[INFO_N]) == [INFO_V, INFO_N]
        m.recargar()
        assert m.direcciones(m.principal(ANA_V)) == [ANA_V, ANA_N]
        self.ok('nuevo.test con DKIM; ana e info tienen las dos direcciones (la principal sigue siendo la vieja) '
                'y la recarga no da errores. Un dominio sin dar de alta da notFound con item y una dirección '
                'de otro, fieldAlreadyExists.')

    # -- 3

    def recibe_en_las_dos(self) -> None:
        self.paso('3. Recibe en las dos direcciones')
        for rcpt in (ANA_N, ANA_V, INFO_N):
            entregar(rcpt, f'Entrante a {rcpt} durante el cambio')
        self.mensajes = self.esperar_mensajes(ANA_V, self.clave, self.mensajes + 3, 'ana@ de los dos dominios e info@nuevo')
        self.ok('las entregas a ana@nuevo.test, ana@viejo.test e info@nuevo.test se aceptan y llegan al buzón de ana.')

    # -- 4

    def pasar(self) -> None:
        self.paso('4. Pasar')
        m = self.motor
        assert m.set_addresses(ANA_V, primary=ANA_N) == [ANA_N, ANA_V]
        extra = [d for d in m.direcciones(m.principal(INFO_V)) if d not in (INFO_N, INFO_V)]
        assert m.rename_principal(INFO_V, INFO_N, INFO_V, [INFO_N, INFO_V, *extra]) == 'renombrado'
        m.recargar()
        assert m.direcciones(m.principal(ANA_V))[0] == ANA_N, 'la dirección nueva es la principal'
        info = m.principal(INFO_N)
        assert info and info['id'] == self.id_info, 'la lista conserva su número'
        assert m.direcciones(info) == [INFO_N, INFO_V]
        assert m.principal(INFO_V) is None
        self.ok('ana tiene [ana@nuevo.test, ana@viejo.test]; la lista es info@nuevo.test con las dos direcciones '
                '(un solo PATCH con nombre y direcciones) y conserva su número.')

    # -- 5

    def envia_como_la_nueva(self) -> None:
        self.paso('5. Con el usuario viejo, remitente nuevo')
        self.mensajes = imap_total(ANA_V, self.clave)
        assert imap_total(ANA_V, self.clave_app) == self.mensajes
        codigo = remitente_aceptado(ANA_V, self.clave, ANA_N)
        assert codigo == 250, f'MAIL FROM:<{ANA_N}> con el usuario viejo: {codigo}'
        codigo = remitente_aceptado(ANA_V, self.clave, f'otra@{NUEVO}')
        assert 500 <= codigo < 600, f'MAIL FROM:<otra@{NUEVO}> debería rechazarse: {codigo}'
        self.ok('IMAP con ana@viejo.test (contraseña y contraseña de aplicación); en el 587 envía como '
                f'{ANA_N} (250) y no como otra@{NUEVO} (5xx).')

    # -- 6

    def renombrar(self) -> None:
        self.paso('6. Renombrar el buzón (actualizar dispositivos)')
        m = self.motor
        antes = m.principal(ANA_V)
        assert m.rename_principal(ANA_V, ANA_N, ANA_N) == 'renombrado'
        despues = m.principal(ANA_N)
        assert despues and despues['id'] == antes['id'], 'el número interno se conserva'
        assert m.principal(ANA_V) is None
        assert imap_total(ANA_N, self.clave) >= self.mensajes, 'el correo se conserva'
        assert imap_total(ANA_N, self.clave_app) >= self.mensajes, 'la contraseña de aplicación se conserva'
        assert imap_rechaza(ANA_V, self.clave), 'el usuario viejo ya no entra'
        codigo = remitente_aceptado(ANA_N, self.clave_app, ANA_V)
        assert codigo == 250, f'MAIL FROM:<{ANA_V}> con el usuario nuevo: {codigo}'
        # Reintento tras una caída: notFound con item = nombre viejo, y el nuevo tiene la dirección.
        r = m.patch(ANA_V, [{'action': 'set', 'field': 'name', 'value': ANA_N}])
        assert r.get('error') == 'notFound' and r.get('item') == ANA_V, r
        assert m.rename_principal(ANA_V, ANA_N, ANA_N) == 'ya_hecho'
        # Nombre ocupado por otro principal.
        r = m.patch(INFO_N, [{'action': 'set', 'field': 'name', 'value': ANA_N}])
        assert r.get('error') == 'fieldAlreadyExists', r
        self.ok('sin recargar, ana@nuevo.test conserva el número y el correo y entra con las dos contraseñas; '
                'ana@viejo.test ya no entra; sigue enviando como ana@viejo.test; repetir el renombrado es '
                'idempotente y un nombre ocupado da fieldAlreadyExists.')

    # -- 7

    def cambiar_contrasena(self) -> None:
        self.paso('7. Usuario nuevo y cambio de contraseña')
        m = self.motor
        r = m.patch(ANA_N, [{'action': 'addItem', 'field': 'secrets', 'value': cifrar(self.clave_nueva)}])
        assert 'error' not in r, r
        assert imap_total(ANA_N, self.clave_nueva) >= self.mensajes
        assert imap_total(ANA_N, self.clave_app) >= self.mensajes
        self.ok('entra con la contraseña nueva y la de aplicación sigue valiendo.')

    # -- 8

    def baja(self) -> None:
        self.paso('8. Baja de viejo.test')
        m = self.motor
        assert m.set_addresses(ANA_N, remove=[ANA_V]) == [ANA_N]
        assert m.set_addresses(INFO_N, remove=[INFO_V]) == [INFO_N]
        m.recargar()
        r = m.api('DELETE', f'/api/principal/{VIEJO}')
        assert 'error' not in r, r
        ids = m.remove_dkim(VIEJO)
        assert ids == [f'ed25519-{VIEJO}', f'rsa-{VIEJO}'], ids
        claves = m.claves_firma()
        assert not any(k.startswith((f'signature.rsa-{VIEJO}.', f'signature.ed25519-{VIEJO}.'))
                       and not k.startswith((f'signature.rsa-{TRAMPA}.', f'signature.ed25519-{TRAMPA}.'))
                       for k in claves), 'quedan claves de viejo.test'
        for id_ in (f'rsa-{TRAMPA}', f'ed25519-{TRAMPA}', f'rsa-{NUEVO}', f'ed25519-{NUEVO}'):
            assert claves.get(f'signature.{id_}.domain'), f'se ha borrado {id_}'
            assert claves.get(f'signature.{id_}.private-key'), f'se ha borrado la clave de {id_}'
        m.recargar()
        codigo, texto = destinatario(ANA_V)
        assert 500 <= codigo < 600, f'RCPT TO:<{ANA_V}> debería rechazarse: {codigo} {texto}'
        entregar(INFO_N, 'A la lista tras la baja')
        self.mensajes = self.esperar_mensajes(ANA_N, self.clave_nueva, self.mensajes + 1, 'info@nuevo tras la baja')
        self.ok(f'sin direcciones viejas, dominio borrado y solo sus claves DKIM ({", ".join(ids)}); las de '
                f'{TRAMPA} y {NUEVO} siguen y la recarga no da errores. RCPT TO:<{ANA_V}> → {codigo}; '
                f'ana@nuevo.test entra y la lista le sigue entregando.')

    # -- diagnóstico y limpieza

    def diagnostico(self) -> None:
        r = docker('logs', '--tail', '60', CONTENEDOR, comprobar=False)
        registrar(f'--- docker logs {CONTENEDOR}\n{r.stdout}{r.stderr}')

    def limpiar(self) -> None:
        docker('rm', '-f', CONTENEDOR, comprobar=False)
        if self.red_creada:
            docker('network', 'rm', RED_PROPIA, comprobar=False)


def main() -> int:
    comprobar_entorno()
    prueba = Prueba()
    try:
        prueba.arrancar()
        prueba.preparar()
        prueba.pre_recepcion()
        prueba.recibe_en_las_dos()
        prueba.pasar()
        prueba.envia_como_la_nueva()
        prueba.renombrar()
        prueba.cambiar_contrasena()
        prueba.baja()
        registrar('OK: cambio de dominio comprobado con Stalwart v0.15.5 real.')
        return 0
    except BaseException as error:
        registrar(f'FALLO: {type(error).__name__}: {error}')
        prueba.diagnostico()
        return 1
    finally:
        prueba.limpiar()


if __name__ == '__main__':
    sys.exit(main())
