"""Traefik -> Stalwart 0.15.5. No Docker socket, external packages or logged secrets."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import ssl
import sys
import tempfile
import time
import urllib.request


def hostname(value):
    value = value.strip().lower().rstrip('.')
    if not re.fullmatch(r'(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}', value):
        raise ValueError('MAIL_HOSTNAME debe ser un dominio público completo')
    return value


class Sync:
    def __init__(self):
        self.hostname = hostname(os.environ['MAIL_HOSTNAME'])
        self.source = Path(os.getenv('ACME_FILE_PATH', '/traefik/acme.json'))
        self.output = Path(os.getenv('CERT_OUTPUT', '/output'))
        self.marker = Path(os.getenv('TLS_HEALTH_FILE', '/tmp/mailway-tls-health'))
        self.url = os.getenv('STALWART_URL', 'http://mailway-mail:8080').rstrip('/')
        self.host = os.getenv('STALWART_TLS_HOST', 'mailway-mail')
        secret_file = os.getenv('STALWART_ADMIN_PASSWORD_FILE')
        password = Path(secret_file).read_text().strip() if secret_file else os.getenv('STALWART_ADMIN_PASSWORD', '')
        if not password:
            raise ValueError('Falta la contraseña vigente del administrador de Stalwart')
        user = os.getenv('STALWART_ADMIN_USER', 'admin')
        self.auth = 'Basic ' + base64.b64encode(f'{user}:{password}'.encode()).decode()
        self.context = ssl.create_default_context()

    def request(self, path, body=None):
        request = urllib.request.Request(self.url + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': self.auth, 'Content-Type': 'application/json'})
        # Do not send the administration credential to a redirect target.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
            result = json.load(response)
        if not isinstance(result, dict) or 'data' not in result:
            raise ValueError('Respuesta de la API no válida')
        return result['data']

    def certificate(self):
        # A partial/invalid acme.json is retried; never replace a working pair.
        data = json.loads(self.source.read_text())
        for resolver in data.values():
            if not isinstance(resolver, dict):
                continue
            for item in resolver.get('Certificates', []) or []:
                domain = item.get('domain', {})
                names = [domain.get('main', ''), *(domain.get('sans') or [])]
                if self.hostname not in [name.lower().rstrip('.') for name in names]:
                    continue
                cert = base64.b64decode(item['certificate'], validate=True)
                key = base64.b64decode(item['key'], validate=True)
                # Immutable, versioned pairs prevent certificate/key races on renewal.
                version = hashlib.sha256(cert + key).hexdigest()
                directory = self.output / self.hostname / version
                directory.mkdir(parents=True, exist_ok=True, mode=0o700)
                cert_path, key_path = directory / 'cert.pem', directory / 'key.pem'
                for path, content in [(cert_path, cert), (key_path, key)]:
                    with tempfile.NamedTemporaryFile(dir=directory, delete=False) as stream:
                        temporary = Path(stream.name)
                        try:
                            stream.write(content)
                            stream.flush()
                            os.fsync(stream.fileno())
                            os.chmod(temporary, 0o600)
                            os.replace(temporary, path)
                        finally:
                            temporary.unlink(missing_ok=True)
                # OpenSSL checks PEM syntax and matching private key before configuring Stalwart.
                ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(cert_path, key_path)
                leaf = ssl.PEM_cert_to_DER_cert(cert.decode().split('-----END CERTIFICATE-----')[0] + '-----END CERTIFICATE-----')
                return directory, hashlib.sha256(leaf).hexdigest()
        raise ValueError('Traefik aún no tiene un certificado para MAIL_HOSTNAME; revisa DNS, 80/443 y ACME')

    def probe(self, port, fingerprint=None):
        with socket.create_connection((self.host, port), timeout=10) as connection:
            with self.context.wrap_socket(connection, server_hostname=self.hostname) as secured:
                cert = secured.getpeercert()
                if ssl.cert_time_to_seconds(cert['notAfter']) <= time.time() + 86400:
                    raise ValueError('El certificado de correo caduca en menos de 24 horas')
                if fingerprint and hashlib.sha256(secured.getpeercert(binary_form=True)).hexdigest() != fingerprint:
                    raise ValueError('Stalwart todavía sirve otro certificado')

    def once(self):
        directory, fingerprint = self.certificate()
        relative = directory.relative_to(self.output).as_posix()
        desired = {
            'certificate.default.cert': f'%{{file:/opt/stalwart/certs/{relative}/cert.pem}}%',
            'certificate.default.private-key': f'%{{file:/opt/stalwart/certs/{relative}/key.pem}}%',
            'certificate.default.default': 'true',
        }
        stored = self.request('/api/settings/keys?keys=' + ','.join(desired))
        if not isinstance(stored, dict):
            raise ValueError('No se pudo leer la configuración de certificados')
        changed = any(stored.get(key) != value for key, value in desired.items())
        if changed:
            self.request('/api/settings', [{
                'type': 'insert', 'prefix': None, 'assert_empty': False,
                'values': list(desired.items()),
            }])
        try:
            if changed:
                raise ValueError('Recarga pendiente')
            for port in (993, 465):
                self.probe(port, fingerprint)
        except (OSError, ValueError):
            result = self.request('/api/reload/certificate')
            if not isinstance(result, dict) or not isinstance(result.get('errors'), dict) or result['errors']:
                raise ValueError('Stalwart rechazó la recarga; revisa los errores en su administrador')
            for port in (993, 465):
                self.probe(port, fingerprint)
        self.marker.write_text(str(time.time()))
        # Only remove our own obsolete version directories after verified activation.
        for old in directory.parent.iterdir():
            if old != directory and old.is_dir() and re.fullmatch('[a-f0-9]{64}', old.name):
                for name in ('cert.pem', 'key.pem'):
                    (old / name).unlink(missing_ok=True)
                try:
                    old.rmdir()
                except OSError:
                    pass


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'health':
        try:
            checked = float(Path(os.getenv('TLS_HEALTH_FILE', '/tmp/mailway-tls-health')).read_text())
            return 0 if 0 <= time.time() - checked < 180 else 1
        except (ValueError, OSError):
            return 1
    worker = Sync()
    previous = None
    while True:
        try:
            worker.once()
            message = 'TLS verificado en IMAP 993 y SMTP 465. No acredita login ni entrega de correo.'
        except Exception as error:
            worker.marker.unlink(missing_ok=True)
            # HTTP/SSL errors can include configuration; never log response bodies or credentials.
            message = f'TLS pendiente ({type(error).__name__}). Revisa DNS/ACME, contraseña vigente y logs de Stalwart; se reintentará en 30 s.'
        if message != previous:
            print(message, flush=True)
            previous = message
        time.sleep(30)


if __name__ == '__main__':
    sys.exit(main())
