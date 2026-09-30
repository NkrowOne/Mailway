import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socketserver
import ssl
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

from sync import Sync


class TlsHandler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            with self.server.context.wrap_socket(self.request, server_side=True) as stream:
                stream.sendall(b'* OK test IMAP\r\n')
        except (ssl.SSLError, OSError):
            pass


class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory()
        cls.root = Path(cls.fixture.name)
        for name in ('old', 'new'):
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                '-days', '3', '-subj', '/CN=mail.example.com', '-addext', 'subjectAltName=DNS:mail.example.com',
                '-keyout', str(cls.root / f'{name}.key'), '-out', str(cls.root / f'{name}.pem')],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (cls.root / 'ca.pem').write_bytes((cls.root / 'old.pem').read_bytes() + (cls.root / 'new.pem').read_bytes())

    @classmethod
    def tearDownClass(cls):
        cls.fixture.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.env = patch.dict(os.environ, {
            'MAIL_HOSTNAME': 'mail.example.com', 'STALWART_ADMIN_PASSWORD': 'test-only',
            'ACME_FILE_PATH': str(self.path / 'acme.json'), 'CERT_OUTPUT': str(self.path / 'output'),
            'TLS_HEALTH_FILE': str(self.path / 'health'), 'STALWART_TLS_HOST': '127.0.0.1',
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.worker = Sync()
        self.worker.context = ssl.create_default_context(cafile=str(self.root / 'ca.pem'))
        self.tls = socketserver.ThreadingTCPServer(('127.0.0.1', 0), TlsHandler)
        self.tls.daemon_threads = True
        self.tls.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.tls.context.load_cert_chain(self.root / 'old.pem', self.root / 'old.key')
        threading.Thread(target=self.tls.serve_forever, daemon=True).start()
        self.addCleanup(self.tls.server_close)
        self.addCleanup(self.tls.shutdown)
        original_probe = self.worker.probe
        self.worker.probe = lambda port, fingerprint=None: original_probe(self.tls.server_address[1], fingerprint)
        self.stored = {}
        self.writes = 0
        self.reloads = 0
        self.fail_reload = False
        owner = self

        class API(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, value):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({'data': value}).encode())

            def do_GET(self):
                if self.path.startswith('/api/settings/keys'):
                    self.reply(owner.stored)
                elif self.path == '/api/reload/certificate':
                    owner.reloads += 1
                    if owner.fail_reload:
                        self.reply({'errors': {'certificate': 'test failure'}})
                        return
                    paths = [owner.stored[key].removeprefix('%{file:/opt/stalwart/certs/').removesuffix('}%')
                        for key in ('certificate.default.cert', 'certificate.default.private-key')]
                    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                    context.load_cert_chain(*(owner.worker.output / p for p in paths))
                    owner.tls.context = context
                    self.reply({'errors': {}})
                else:
                    self.send_error(404)

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))[0]
                if payload.get('assert_empty') is not False or payload.get('prefix') is not None:
                    self.send_error(400)
                    return
                owner.stored.update(payload['values'])
                owner.writes += 1
                self.reply(None)

        self.api = ThreadingHTTPServer(('127.0.0.1', 0), API)
        threading.Thread(target=self.api.serve_forever, daemon=True).start()
        self.addCleanup(self.api.server_close)
        self.addCleanup(self.api.shutdown)
        self.worker.url = f'http://127.0.0.1:{self.api.server_port}'
        self.acme('old')

    def acme(self, name, key=None):
        self.worker.source.write_text(json.dumps({'le': {'Certificates': [{
            'domain': {'main': 'mail.example.com'},
            'certificate': base64.b64encode((self.root / f'{name}.pem').read_bytes()).decode(),
            'key': base64.b64encode((self.root / f'{key or name}.key').read_bytes()).decode(),
        }]}}))

    def test_initial_sync_and_idempotence_with_real_tls(self):
        self.worker.once()
        self.worker.once()
        self.assertEqual(self.writes, 1)
        self.assertEqual(self.reloads, 1)
        self.assertTrue(self.worker.marker.exists())

    def test_renewal_is_applied_and_old_files_removed_only_after_activation(self):
        self.worker.once()
        old_path = self.stored['certificate.default.cert']
        self.acme('new')
        self.fail_reload = True
        with self.assertRaisesRegex(ValueError, 'recarga'):
            self.worker.once()
        self.assertEqual(len(list((self.worker.output / self.worker.hostname).iterdir())), 2)
        self.fail_reload = False
        self.worker.once()
        self.assertNotEqual(self.stored['certificate.default.cert'], old_path)
        self.assertEqual(self.writes, 2, 'retry must not rewrite settings')
        self.assertEqual(len(list((self.worker.output / self.worker.hostname).iterdir())), 1)

    def test_invalid_acme_preserves_working_configuration(self):
        self.worker.once()
        self.worker.source.write_text('{')
        with self.assertRaises(ValueError):
            self.worker.once()
        self.assertEqual(self.writes, 1)

    def test_mismatched_key_never_reaches_api(self):
        self.acme('old', key='new')
        with self.assertRaises(ssl.SSLError):
            self.worker.once()
        self.assertEqual(self.writes, 0)

    def test_tls_checks_name_and_trust(self):
        self.worker.hostname = 'wrong.example.com'
        with self.assertRaises(ssl.SSLCertVerificationError):
            self.worker.probe(993)
        self.worker.hostname = 'mail.example.com'
        self.worker.context = ssl.create_default_context()
        with self.assertRaises(ssl.SSLCertVerificationError):
            self.worker.probe(993)

    def test_does_not_follow_api_redirect_with_admin_credential(self):
        class Redirect(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                self.send_response(302)
                self.send_header('Location', f'http://127.0.0.1:{self.server.server_port}/stolen')
                self.end_headers()
        server = ThreadingHTTPServer(('127.0.0.1', 0), Redirect)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            self.worker.url = f'http://127.0.0.1:{server.server_port}'
            import urllib.error
            with self.assertRaises(urllib.error.HTTPError):
                self.worker.request('/redirect')
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
