"""Disposable Docker integration: real Stalwart, Roundcube IMAP and TLS renewal.

Never uses production volumes, domains, credentials or external recipients.
"""
import base64
import json
import os
from pathlib import Path
import secrets
import smtplib
import socket
import ssl
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).parent / 'tls'))
from sync import Sync


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def wait(fn, timeout=120):
    deadline = time.monotonic() + timeout
    while True:
        try:
            return fn()
        except Exception:
            if time.monotonic() >= deadline:
                raise
            time.sleep(2)


def main():
    project = Path(__file__).resolve().parent
    prefix = 'mailway-test-' + secrets.token_hex(4)
    network, engine, webmail = prefix + '-net', prefix + '-mail', prefix + '-webmail'
    admin, password = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        root.chmod(0o755)
        output = root / 'output'
        output.mkdir()
        for name in ('first', 'renewed'):
            run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3',
                '-subj', '/CN=mail.example.test', '-addext', 'subjectAltName=DNS:mail.example.test',
                '-keyout', str(root / f'{name}.key'), '-out', str(root / f'{name}.pem'),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (root / 'ca.pem').write_bytes((root / 'first.pem').read_bytes() + (root / 'renewed.pem').read_bytes())
        (root / 'ca.pem').chmod(0o644)
        env_file = root / 'engine.env'
        env_file.write_text('STALWART_ADMIN_PASSWORD=' + admin + '\n')
        env_file.chmod(0o600)
        os.environ.update(MAIL_HOSTNAME='mail.example.test', STALWART_ADMIN_PASSWORD=admin,
            STALWART_URL='http://127.0.0.1:18080', STALWART_TLS_HOST='127.0.0.1',
            ACME_FILE_PATH=str(root / 'acme.json'), CERT_OUTPUT=str(output),
            TLS_HEALTH_FILE=str(root / 'health'))
        worker = Sync()
        worker.context = ssl.create_default_context(cafile=str(root / 'ca.pem'))
        probe = worker.probe
        worker.probe = lambda port, fingerprint=None: probe({993: 19993, 465: 19465}[port], fingerprint)

        def acme(name):
            worker.source.write_text(json.dumps({'le': {'Certificates': [{
                'domain': {'main': worker.hostname},
                'certificate': base64.b64encode((root / f'{name}.pem').read_bytes()).decode(),
                'key': base64.b64encode((root / f'{name}.key').read_bytes()).decode(),
            }]}}))

        try:
            run('docker', 'network', 'create', network, stdout=subprocess.DEVNULL)
            run('docker', 'run', '-d', '--name', engine, '--hostname', worker.hostname,
                '--network', network, '--network-alias', worker.hostname, '--env-file', str(env_file),
                '-p', '127.0.0.1:18080:8080', '-p', '127.0.0.1:19993:993', '-p', '127.0.0.1:19465:465',
                '-v', f'{output}:/opt/stalwart/certs:ro', 'stalwartlabs/stalwart:v0.15.5', stdout=subprocess.DEVNULL)
            wait(lambda: worker.request('/api/settings/keys?keys=server.hostname'))
            worker.request('/api/settings', [{'type': 'insert', 'prefix': None, 'assert_empty': False,
                'values': [['server.hostname', worker.hostname]]}])
            result = worker.request('/api/reload')
            if result['errors']:
                raise RuntimeError('Stalwart reload failed')
            acme('first')
            wait(worker.once)
            print('OK: TLS aplicado por API al Stalwart real', flush=True)
            worker.request('/api/principal', {'type': 'domain', 'name': 'example.test'})
            hashed = run('openssl', 'passwd', '-6', '-stdin', input=password, text=True, capture_output=True).stdout.strip()
            worker.request('/api/principal', {'type': 'individual', 'name': 'info@example.test',
                'secrets': [hashed], 'emails': ['info@example.test'], 'roles': ['user']})
            run('docker', 'run', '-d', '--name', webmail, '--network', network,
                '-e', 'ROUNDCUBEMAIL_DEFAULT_HOST=ssl://mail.example.test', '-e', 'ROUNDCUBEMAIL_DEFAULT_PORT=993',
                '-e', 'ROUNDCUBEMAIL_SMTP_SERVER=ssl://mail.example.test', '-e', 'ROUNDCUBEMAIL_SMTP_PORT=465',
                '-e', 'ROUNDCUBEMAIL_DB_TYPE=sqlite', '-v', f'{root / "ca.pem"}:/test/ca.pem:ro',
                '-v', f'{project / "roundcube/check.php"}:/test/check.php:ro',
                'roundcube/roundcubemail:1.7.x-apache', stdout=subprocess.DEVNULL)

            def login():
                return run('docker', 'exec', '-i', webmail, 'php', '-d', 'openssl.cafile=/test/ca.pem',
                    '/test/check.php', '--login-stdin', input='info@example.test\n' + password + '\n',
                    text=True, capture_output=True)
            result = wait(login)
            print(result.stdout, flush=True)
            bad = subprocess.run(['docker', 'exec', '-i', webmail, 'php', '-d', 'openssl.cafile=/test/ca.pem',
                '/test/check.php', '--login-stdin'], input='info@example.test\nincorrect-password\n',
                text=True, capture_output=True)
            if bad.returncode == 0:
                raise RuntimeError('Incorrect password accepted')
            class TestSMTP(smtplib.SMTP_SSL):
                def _get_socket(self, host, port, timeout):
                    return worker.context.wrap_socket(socket.create_connection((host, port), timeout),
                        server_hostname=worker.hostname)
            with TestSMTP('127.0.0.1', 19465, timeout=15) as smtp:
                smtp.login('info@example.test', password)
            print('OK: autenticación SMTP real (sin enviar correo externo)', flush=True)
            acme('renewed')
            wait(worker.once)
            result = wait(login)
            print('OK: renovación aplicada y login conservado', flush=True)
            print(result.stdout, flush=True)

        finally:
            for container in (webmail, engine):
                subprocess.run(['docker', 'rm', '-fv', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(['docker', 'network', 'rm', network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
