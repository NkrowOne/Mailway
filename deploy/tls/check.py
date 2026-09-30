"""Read-only stack diagnosis. Run through ./mailway.sh check."""
import sys
from sync import Sync


def main():
    worker = Sync()
    failures = 0
    for port in (993, 465):
        try:
            worker.probe(port)
            print(f'OK: certificado público, nombre y vigencia en {port}')
        except Exception as error:
            failures += 1
            print(f'FALLO: TLS en {port} ({type(error).__name__})')
    try:
        records = worker.request('/api/dns/records/' + worker.hostname)
        mx = [r['content'].split()[-1].lower().rstrip('.') for r in records if r['type'] == 'MX']
        if mx != [worker.hostname]:
            raise ValueError('Hostname activo distinto')
        print('OK: Stalwart anuncia ' + worker.hostname)
    except Exception as error:
        failures += 1
        print(f'FALLO: identidad/API de Stalwart ({type(error).__name__}); revisa Ajustes → Identidad')
    print('Pendiente fuera de este diagnóstico: DNS público/PTR, puertos desde Internet, entrega externa y acceso web de Roundcube.')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
