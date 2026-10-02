"""PKI de laboratorio para las pruebas del extractor y de la pila (solo pruebas).

Genera con el binario openssl una CA propia y certificados con fechas
arbitrarias (también caducados o aún no válidos, con «openssl ca»), claves EC o
RSA en los formatos que escribe Traefik y su acme.json. Nada de esto se usa en
producción: las claves son desechables y viven en una carpeta temporal.
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import json
import os
import ssl
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

_CONFIGURACION_CA = """
[ ca ]
default_ca = ca_laboratorio

[ ca_laboratorio ]
dir = {dir}
database = $dir/index.txt
new_certs_dir = $dir/emitidos
serial = $dir/serial
default_md = sha256
policy = politica
copy_extensions = none
unique_subject = no
email_in_dn = no

[ politica ]
commonName = supplied

[ hoja ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
subjectAltName = $ENV::MAILWAY_SAN
"""


def _openssl(*argumentos: str, entorno: dict | None = None) -> None:
    subprocess.run(['openssl', *argumentos], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                   env={**os.environ, **(entorno or {})})


def _fecha(momento: dt.datetime) -> str:
    return momento.astimezone(dt.timezone.utc).strftime('%Y%m%d%H%M%SZ')


@dataclass
class Par:
    nombre: str
    cadena: bytes = field(repr=False)   # hoja + CA, como el «certificate» de Traefik
    clave: bytes = field(repr=False)
    ruta_cadena: Path
    ruta_clave: Path

    @property
    def hoja(self) -> bytes:
        fin = b'-----END CERTIFICATE-----'
        return self.cadena[: self.cadena.index(fin) + len(fin)] + b'\n'

    @property
    def huella(self) -> str:
        return hashlib.sha256(ssl.PEM_cert_to_DER_cert(self.hoja.decode())).hexdigest()


class Laboratorio:
    def __init__(self, carpeta: Path):
        self.carpeta = Path(carpeta)
        self.ca_dir = self.carpeta / 'ca'
        (self.ca_dir / 'emitidos').mkdir(parents=True, exist_ok=True)
        (self.ca_dir / 'index.txt').write_text('')
        (self.ca_dir / 'serial').write_text('1000\n')
        self.configuracion = self.carpeta / 'ca.cnf'
        self.configuracion.write_text(_CONFIGURACION_CA.format(dir=self.ca_dir))
        self.ca = self.carpeta / 'ca.pem'
        self.ca_clave = self.carpeta / 'ca.key'
        _openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
                 '-keyout', str(self.ca_clave), '-out', str(self.ca), '-days', '30',
                 '-subj', '/O=Laboratorio Mailway/CN=CA de pruebas',
                 '-addext', 'basicConstraints=critical,CA:TRUE',
                 '-addext', 'keyUsage=critical,keyCertSign,cRLSign')

    def _clave(self, ruta: Path, tipo: str) -> None:
        if tipo == 'ec':        # «EC PRIVATE KEY» (SEC1), como Traefik con EC256
            _openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', str(ruta))
        elif tipo == 'rsa':     # «RSA PRIVATE KEY» (PKCS#1), como Traefik con RSA
            _openssl('genrsa', '-traditional', '-out', str(ruta), '2048')
        elif tipo == 'pkcs8':   # «PRIVATE KEY»
            _openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', str(ruta))
        else:
            raise ValueError(tipo)

    def emitir(self, nombre: str, nombres: list, desde=dt.timedelta(days=-1), hasta=dt.timedelta(days=60),
               tipo: str = 'ec') -> Par:
        """Certificado firmado por la CA.

        «desde» y «hasta» son fechas absolutas (datetime) o desplazamientos
        desde ahora (timedelta).
        """
        ahora = dt.datetime.now(dt.timezone.utc)
        desde = desde if isinstance(desde, dt.datetime) else ahora + desde
        hasta = hasta if isinstance(hasta, dt.datetime) else ahora + hasta
        clave = self.carpeta / f'{nombre}.key'
        solicitud = self.carpeta / f'{nombre}.csr'
        hoja = self.carpeta / f'{nombre}.pem'
        self._clave(clave, tipo)
        _openssl('req', '-new', '-key', str(clave), '-out', str(solicitud), '-subj', f'/CN={nombres[0]}')
        _openssl('ca', '-batch', '-config', str(self.configuracion), '-cert', str(self.ca),
                 '-keyfile', str(self.ca_clave), '-in', str(solicitud), '-out', str(hoja), '-notext',
                 '-extensions', 'hoja', '-startdate', _fecha(desde), '-enddate', _fecha(hasta),
                 entorno={'MAILWAY_SAN': ','.join(f'DNS:{n}' for n in nombres)})
        cadena = self.carpeta / f'{nombre}-cadena.pem'
        cadena.write_bytes(hoja.read_bytes() + self.ca.read_bytes())
        return Par(nombre, cadena.read_bytes(), clave.read_bytes(), cadena, clave)

    def autofirmado(self, nombre: str, nombres: list) -> Par:
        """Como el certificado que genera el motor cuando no tiene ninguno."""
        clave = self.carpeta / f'{nombre}.key'
        cert = self.carpeta / f'{nombre}.pem'
        self._clave(clave, 'ec')
        _openssl('req', '-x509', '-key', str(clave), '-out', str(cert), '-days', '30', '-subj', f'/CN={nombres[0]}',
                 '-addext', 'subjectAltName=' + ','.join(f'DNS:{n}' for n in nombres))
        return Par(nombre, cert.read_bytes(), clave.read_bytes(), cert, clave)


def acme_json(entradas: list, resolutor: str = 'le') -> str:
    """acme.json de Traefik v2/v3 con las entradas (Par, [nombres del dominio])."""
    certificados = []
    for par, nombres in entradas:
        certificados.append({
            'domain': {'main': nombres[0], **({'sans': nombres[1:]} if nombres[1:] else {})},
            'certificate': base64.b64encode(par.cadena).decode(),
            'key': base64.b64encode(par.clave).decode(),
            'Store': 'default',
        })
    return json.dumps({resolutor: {'Account': {'Email': 'pruebas@mailway.test'}, 'Certificates': certificados}},
                      indent=1)
