import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Mailbox } from '../../lib/api';
import { plural } from '../../lib/format';
import { mensajeDe } from '../../lib/gestion';
import type { ContrasenaAplicacion, EnlaceConfiguracion, EnlaceCreado } from '../../lib/portal';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Field';
import { Muestra } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { EnlaceListo } from '../ConectarBuzon';
import { BandaAviso, BandaError, Botonera, Casilla } from './comun';

/** Respuesta de POST /api/mailboxes/:id/setup-reset. */
interface Reinicio {
  password: string;
  link: EnlaceCreado;
  linksRemoved: number;
  appPasswordsRevoked: number;
}

const VALIDECES = [
  { horas: 24, texto: '1 día' },
  { horas: 72, texto: '3 días' },
  { horas: 168, texto: '7 días' },
  { horas: 720, texto: '30 días' },
];

/**
 * Reiniciar la configuración del buzón: para cuando quien lo administra lo
 * ha probado (ha abierto el enlace, ha entrado en «Mi buzón», ha conectado
 * su móvil) y quiere entregárselo al titular como recién creado. El servidor
 * genera la contraseña nueva y el enlace; aquí se explica qué se pierde y,
 * al terminar, se muestra el enlace listo para enviar.
 */
export function ReiniciarBuzon({
  mailbox,
  clienteSuspendido,
  onCancelar,
  onPendiente,
}: {
  mailbox: Mailbox;
  clienteSuspendido?: boolean;
  onCancelar: () => void;
  /** true mientras el enlace nuevo está en pantalla sin confirmar que se ha copiado. */
  onPendiente: (pendiente: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [validez, setValidez] = useState('72');
  const [conContrasena, setConContrasena] = useState(true);
  const [revocarApps, setRevocarApps] = useState(true);
  const [error, setError] = useState('');
  const [hecho, setHecho] = useState<Reinicio | null>(null);

  useEffect(() => {
    onPendiente(hecho !== null);
  }, [hecho, onPendiente]);
  // Al salir de la vista ya no hay nada pendiente que proteger.
  useEffect(() => () => onPendiente(false), [onPendiente]);

  // Las mismas consultas que las vistas de enlaces y contraseñas de
  // aplicación: lo que se va a borrar se nombra antes de confirmar.
  const apps = useQuery({
    queryKey: ['app-passwords', mailbox.id],
    queryFn: () => api.get<{ appPasswords: ContrasenaAplicacion[] }>(`/api/mailboxes/${mailbox.id}/app-passwords`),
  });
  const enlaces = useQuery({
    queryKey: ['setup-links', mailbox.id],
    queryFn: () => api.get<{ links: EnlaceConfiguracion[] }>(`/api/mailboxes/${mailbox.id}/setup-links`),
  });
  const activas = (apps.data?.appPasswords ?? []).filter((a) => !a.revokedAt);
  const numEnlaces = enlaces.data?.links.length ?? 0;

  const reiniciar = useMutation({
    mutationFn: () =>
      api.post<Reinicio>(`/api/mailboxes/${mailbox.id}/setup-reset`, {
        ttlHours: Number(validez),
        includePassword: conContrasena,
        revokeAppPasswords: revocarApps,
      }),
    onSuccess: async (data) => {
      setHecho(data);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['setup-links', mailbox.id] }),
        queryClient.invalidateQueries({ queryKey: ['app-passwords', mailbox.id] }),
      ]);
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido reiniciar la configuración del buzón.')),
  });

  if (hecho) {
    return (
      <>
        <p className="text-base text-tinta-2">
          <span className="valor break-all">{mailbox.email}</span> está listo para el titular. Envíale este
          enlace: al abrirlo verá las instrucciones para su dispositivo
          {hecho.link.hasPassword ? ' y la contraseña del buzón' : ''}.
        </p>
        <EnlaceListo email={mailbox.email} enlace={hecho.link} />
        <Muestra rotulo="Contraseña nueva" copiar={hecho.password}>
          <p className="codigo break-all text-base text-tinta">{hecho.password}</p>
        </Muestra>
        <p className="text-sm text-tinta-3">
          La contraseña tampoco se podrá volver a ver.
          {hecho.linksRemoved > 0 &&
            (hecho.linksRemoved === 1
              ? ' Se ha eliminado el enlace anterior.'
              : ` Se han eliminado ${plural(hecho.linksRemoved, 'enlace anterior', 'enlaces anteriores')}.`)}
          {hecho.appPasswordsRevoked > 0 &&
            (hecho.appPasswordsRevoked === 1
              ? ' Se ha revocado 1 contraseña de aplicación.'
              : ` Se han revocado ${plural(hecho.appPasswordsRevoked, 'contraseña de aplicación', 'contraseñas de aplicación')}.`)}
        </p>
        <Botonera>
          <Button
            variant="principal"
            onClick={() => {
              toast('ok', `Configuración de ${mailbox.email} reiniciada.`);
              setHecho(null);
              onCancelar();
            }}
          >
            Ya he copiado el enlace
          </Button>
        </Botonera>
      </>
    );
  }

  // El servidor lo rechaza igual; se dice antes de rellenar nada.
  const suspendido = mailbox.status === 'suspended' || Boolean(clienteSuspendido);

  return (
    <>
      <p className="text-base text-tinta-2">
        Deja <span className="valor break-all">{mailbox.email}</span> como recién creado para entregárselo al
        titular, por ejemplo después de haberlo probado. El correo que contiene no se modifica.
      </p>
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-base text-tinta-2">
        <li>Se genera una contraseña nueva: la actual deja de funcionar en el webmail y en los dispositivos.</li>
        <li>
          {enlaces.isPending
            ? 'Se eliminan los enlaces de configuración anteriores'
            : numEnlaces > 0
              ? `Se eliminan ${numEnlaces === 1 ? 'el enlace de configuración anterior' : `los ${numEnlaces} enlaces de configuración anteriores`}`
              : 'No hay enlaces de configuración anteriores'}{' '}
          y se cierran las sesiones abiertas en «Mi buzón».
        </li>
        <li>Se crea un enlace de configuración nuevo para el titular.</li>
      </ul>

      <div className="flex flex-col gap-3 border-t border-regla pt-4">
        {activas.length > 0 && (
          <Casilla
            checked={revocarApps}
            onChange={(v) => {
              setError('');
              setRevocarApps(v);
            }}
            label={`Revocar también ${activas.length === 1 ? 'la contraseña de aplicación' : `las ${activas.length} contraseñas de aplicación`}`}
            help={
              <>
                <span className="break-words">{activas.map((a) => `«${a.name}»`).join(', ')}</span>. Desmárcalo si
                alguna la usa una aplicación o una integración que debe seguir enviando correo.
              </>
            }
          />
        )}
        <Casilla
          checked={conContrasena}
          onChange={(v) => {
            setError('');
            setConContrasena(v);
          }}
          label="Incluir la contraseña en el enlace"
          help="Así el titular no tendrá que escribirla. Se borra del enlace cuando caduca o cuando el titular indica que ha terminado."
        />
        <Select label="Validez del enlace" value={validez} onChange={(e) => setValidez(e.target.value)}>
          {VALIDECES.map((v) => (
            <option key={v.horas} value={String(v.horas)}>
              {v.texto}
            </option>
          ))}
        </Select>
      </div>

      {suspendido && (
        <BandaAviso>
          {mailbox.status === 'suspended'
            ? 'El buzón está suspendido. Reactívalo antes de reiniciar su configuración.'
            : 'El cliente está suspendido. Reactívalo antes de reiniciar la configuración de sus buzones.'}
        </BandaAviso>
      )}
      {error && <BandaError>{error}</BandaError>}
      <Botonera>
        <Button variant="plano" onClick={onCancelar}>
          Cancelar
        </Button>
        <Button
          variant="peligro"
          busy={reiniciar.isPending}
          disabled={suspendido}
          onClick={() => {
            setError('');
            reiniciar.mutate();
          }}
        >
          Reiniciar buzón
        </Button>
      </Botonera>
    </>
  );
}
