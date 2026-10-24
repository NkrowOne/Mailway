import { useEffect, useState } from 'react';
import { FingerprintPattern, Mail } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type SetupStatus } from '../../lib/api';
import {
  entrarConLlave,
  estadoValido,
  hostValido,
  llavesDisponibles,
  mensajeErrorLlave,
  motivoSinLlaves,
} from '../../lib/llaves';
import { Button } from '../../ui/Button';
import { AvisoError, claseEnlaceBoton, TACTIL } from './comun';
import { MarcoAccesoPortal } from './MarcoAcceso';

/** Qué hacer con un enlace incompleto: empezar de nuevo desde la pantalla de acceso del webmail. */
const TEXTO_VOLVER = 'Vuelve a la pantalla de acceso de tu correo y pulsa de nuevo «Usar llave de acceso».';

/** Respuesta de POST /api/portal/llave/entrar cuando se pide entrar en un webmail. */
interface RespuestaEntrar {
  ok: true;
  email: string;
  webmailUrl?: string;
}

/**
 * Solo se sigue la dirección del webmail que se pidió y por HTTPS: si el
 * servidor devolviera otra cosa, se trata como si no hubiera llegado.
 */
function urlWebmailSegura(valor: string | undefined, destino: string): string | null {
  if (!valor) return null;
  try {
    const url = new URL(valor);
    return url.protocol === 'https:' && url.host.toLowerCase() === destino ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Paso al webmail con llave de acceso (/mi-buzon/correo-web?destino=…&estado=…).
 * El webmail envía aquí al titular porque las llaves de «Mi buzón» están
 * ligadas a esta dirección: se comprueba la llave y se vuelve al webmail con
 * un código de un solo uso que lo deja dentro.
 */
export default function EntrarCorreoWeb() {
  const [params] = useSearchParams();
  // Lo que llega por la URL no se usa en un enlace ni se envía sin comprobarlo.
  const destino = hostValido(params.get('destino'));
  const estado = estadoValido(params.get('estado'));
  const [disponible] = useState(llavesDisponibles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // La llave se comprobó, pero el servidor no dio el paso al webmail:
  // repetirlo no cambiaría nada, queda la contraseña.
  const [sinPaso, setSinPaso] = useState(false);
  // La marca de la instancia, para que el titular reconozca a su proveedor.
  const setup = useQuery({
    queryKey: ['setup'],
    queryFn: () => api.get<SetupStatus>('/api/setup/status'),
    retry: false,
  });
  const marca = setup.data?.instance?.brandName || 'Correo';

  useEffect(() => {
    document.title = 'Accede a tu correo';
  }, []);

  // Al volver con «Atrás» desde el webmail, el navegador puede restaurar la
  // página tal como se dejó (con el botón ocupado): se deja lista otra vez.
  useEffect(() => {
    const alMostrar = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener('pageshow', alMostrar);
    return () => window.removeEventListener('pageshow', alMostrar);
  }, []);

  async function entrar() {
    if (!destino || !estado) return;
    setBusy(true);
    setError('');
    try {
      const res = await entrarConLlave<RespuestaEntrar>('/api/portal', { webmail: destino, estado });
      const url = urlWebmailSegura(res?.webmailUrl, destino);
      if (url) {
        // El botón sigue ocupado mientras carga el webmail.
        window.location.assign(url);
        return;
      }
      setSinPaso(true);
      setError(
        'Se ha comprobado la llave de acceso, pero no se ha podido acceder a tu correo con ella. Accede con tu contraseña.',
      );
    } catch (err) {
      setError(mensajeErrorLlave(err, 'entrar'));
    }
    setBusy(false);
  }

  const pie = (
    <p>
      Las llaves de acceso se añaden en{' '}
      <a href="/mi-buzon" className="font-medium text-petroleo underline underline-offset-2 hover:text-tinta">
        «Mi buzón»
      </a>
      , después de acceder con tu dirección y tu contraseña.
    </p>
  );

  if (!destino) {
    return (
      <MarcoAccesoPortal marca={marca} pie={pie}>
        <div className="flex flex-col gap-4 px-5 pb-7 pt-4 sm:px-8">
          <div className="text-center">
            <h1 className="text-2xl font-semibold text-tinta">El enlace no es válido</h1>
            <p className="mt-1 text-base text-tinta-2">{TEXTO_VOLVER}</p>
          </div>
        </div>
      </MarcoAccesoPortal>
    );
  }

  const enlaceContrasena = `https://${destino}/`;
  // Sin `estado` válido el servidor rechazaría la entrada: no se ofrece el botón.
  const puedeEntrar = disponible && estado !== null && !sinPaso;

  return (
    <MarcoAccesoPortal marca={marca} pie={pie}>
      <div className="flex flex-col gap-4 px-5 pb-7 pt-4 sm:px-8">
        <div className="text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-petroleo-claro px-2.5 py-1 text-sm font-semibold text-petroleo">
            <Mail className="h-4 w-4" aria-hidden />
            Tu correo
          </span>
          <h1 className="mt-3 text-2xl font-semibold text-tinta">Accede a tu correo</h1>
          <p className="mt-1 text-base text-tinta-2">
            Usa tu llave de acceso para acceder a tu correo en{' '}
            <span className="font-medium text-tinta [overflow-wrap:anywhere]">{destino}</span> sin escribir la
            contraseña.
          </p>
        </div>

        {!estado ? (
          <AvisoError>{TEXTO_VOLVER}</AvisoError>
        ) : !disponible ? (
          <p className="text-center text-base text-tinta-2">{motivoSinLlaves()}</p>
        ) : sinPaso ? null : (
          <Button
            type="button"
            variant="principal"
            busy={busy}
            onClick={() => void entrar()}
            className={`w-full ${TACTIL}`}
          >
            {!busy && <FingerprintPattern className="h-4 w-4" aria-hidden />}
            Usar llave de acceso
          </Button>
        )}
        {error && <AvisoError>{error}</AvisoError>}

        {/* Si no se puede entrar con la llave, la contraseña pasa a ser el camino principal. */}
        <a
          href={enlaceContrasena}
          className={`${claseEnlaceBoton(puedeEntrar ? 'perfil' : 'principal')} w-full`}
        >
          Accede con contraseña
        </a>
      </div>
    </MarcoAccesoPortal>
  );
}
