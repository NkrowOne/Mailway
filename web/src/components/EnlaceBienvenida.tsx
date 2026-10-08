import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SetupStatus } from '../lib/api';
import {
  estadoInvitacion,
  mailtoBienvenida,
  VALIDECES_BIENVENIDA,
  VALIDEZ_POR_DEFECTO,
  type Invitacion,
  type InvitacionCreada,
} from '../lib/bienvenida';
import { formatDate } from '../lib/format';
import { esCorreoValido, mensajeDe } from '../lib/gestion';
import { fechaLarga } from '../lib/portal';
import { Button, estiloBoton } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import { Cargando, Dialogo, Hoja, MarcaFondo, Muestra } from '../ui/kit';
import { useToast } from '../ui/toast';
import { BandaError, Botonera } from './gestion/comun';
import { QR } from './QR';

/*
  Enlace de bienvenida del cliente, desde la administración: crearlo,
  entregarlo (URL, QR y correo preparado para la persona de contacto) y
  seguirlo (pendiente, abierto, aceptado) con la opción de volver a enviarlo
  o revocarlo. La experiencia de quien lo abre está en pages/bienvenida.
*/

/** Invitaciones del cliente, más recientes primero. */
export function useInvitaciones(clientId: string) {
  return useQuery({
    queryKey: ['invites', clientId],
    queryFn: () => api.get<{ invites: Invitacion[] }>(`/api/clients/${encodeURIComponent(clientId)}/invites`),
  });
}

/**
 * Nombre de la instancia para el correo de bienvenida: es el proveedor que la
 * persona de contacto reconoce. App ya tiene el estado en caché.
 */
function useMarca(): string {
  const setup = useQuery({
    queryKey: ['setup'],
    queryFn: () => api.get<SetupStatus>('/api/setup/status'),
  });
  return setup.data?.instance?.brandName || 'Mailway';
}

/* ------------------------------ Enlace listo ------------------------------- */

/**
 * Enlace listo para entregar: URL para copiar, QR (para enseñarlo en una
 * reunión o abrirlo en el móvil) y el correo de bienvenida ya redactado y
 * dirigido a la persona de contacto, que es la acción que se espera.
 */
export function EnlaceBienvenidaListo({
  invitacion,
  clientName,
  children,
}: {
  invitacion: InvitacionCreada;
  clientName: string;
  /** Acciones adicionales junto a «Enviar por correo». */
  children?: ReactNode;
}) {
  const marca = useMarca();
  return (
    <div className="revelar flex flex-col gap-4">
      <p className="text-base text-tinta-2">
        Envíalo a <span className="valor [overflow-wrap:anywhere] font-medium text-tinta">{invitacion.email}</span>
        {invitacion.name ? ` (${invitacion.name})` : ''}. Al abrirlo, creará su acceso al panel de {clientName} y
        empezará la puesta en marcha guiada del correo.
      </p>
      <Muestra rotulo="Enlace de bienvenida" copiar={invitacion.url}>
        <p className="valor break-all text-sm text-tinta">{invitacion.url}</p>
      </Muestra>
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <QR texto={invitacion.url} tamano={140} etiqueta={`Código QR del enlace de bienvenida de ${invitacion.email}`} />
        <div className="flex flex-col gap-1.5 text-sm text-tinta-2">
          <p>Válido hasta el {fechaLarga(invitacion.expiresAt)} y para un solo uso.</p>
          <p>Es personal: crea el acceso de esta dirección. No lo publiques ni lo reenvíes a otras personas.</p>
          <p>Mientras siga pendiente, puedes volver a enviarlo desde la pestaña «Usuarios» del cliente.</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <a
          href={mailtoBienvenida({ ...invitacion, clientName, brandName: marca })}
          className={estiloBoton('principal')}
        >
          Enviar por correo
        </a>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------- Crear enlace ------------------------------ */

/**
 * Diálogo para crear el enlace de bienvenida y, al terminar, entregarlo. El
 * correo se propone con el de contacto del cliente: es a quien va dirigido.
 */
export function DialogoBienvenida({
  clientId,
  clientName,
  emailInicial = '',
  nombreInicial = '',
  onClose,
}: {
  clientId: string;
  clientName: string;
  emailInicial?: string;
  nombreInicial?: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState(emailInicial);
  const [name, setName] = useState(nombreInicial);
  const [validez, setValidez] = useState<string>(VALIDEZ_POR_DEFECTO);
  const [error, setError] = useState('');
  const [creada, setCreada] = useState<InvitacionCreada | null>(null);

  const crear = useMutation({
    mutationFn: () =>
      api.post<{ invite: InvitacionCreada }>(`/api/clients/${encodeURIComponent(clientId)}/invites`, {
        email: email.trim(),
        name: name.trim() || undefined,
        ttlHours: Number(validez),
      }),
    onSuccess: async (data) => {
      setCreada(data.invite);
      await queryClient.invalidateQueries({ queryKey: ['invites', clientId] });
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido crear el enlace de bienvenida.')),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!esCorreoValido(email)) {
      setError('Indica un correo válido: será el usuario con el que la persona entrará en el panel.');
      return;
    }
    setError('');
    crear.mutate();
  }

  return (
    <Dialogo
      open
      onClose={onClose}
      title={creada ? 'Enlace de bienvenida listo' : 'Enlace de bienvenida'}
      pie={
        creada ? (
          <Button variant="perfil" onClick={onClose}>
            Cerrar
          </Button>
        ) : undefined
      }
    >
      {creada ? (
        <EnlaceBienvenidaListo invitacion={creada} clientName={clientName} />
      ) : (
        <FormularioBienvenida
          clientName={clientName}
          email={email}
          name={name}
          validez={validez}
          onEmail={(v) => {
            setError('');
            setEmail(v);
          }}
          onName={(v) => {
            setError('');
            setName(v);
          }}
          onValidez={setValidez}
          onSubmit={submit}
          error={error}
          pie={
            <Botonera>
              <Button type="button" variant="plano" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" variant="principal" busy={crear.isPending}>
                Crear enlace
              </Button>
            </Botonera>
          }
        />
      )}
    </Dialogo>
  );
}

/** Explicación y campos del enlace; lo comparten este diálogo y el alta de cliente. */
export function CamposBienvenida({
  email,
  name,
  validez,
  onEmail,
  onName,
  onValidez,
  emailPlaceholder = 'persona@empresa.com',
  nombrePlaceholder = 'Nombre y apellidos',
}: {
  email: string;
  name: string;
  validez: string;
  onEmail: (v: string) => void;
  onName: (v: string) => void;
  onValidez: (v: string) => void;
  emailPlaceholder?: string;
  nombrePlaceholder?: string;
}) {
  return (
    <>
      {/* El correo, a lo ancho: es el usuario y tiene que leerse entero. */}
      <Input
        label="Correo de la persona"
        type="email"
        inputMode="email"
        autoCapitalize="none"
        spellCheck={false}
        value={email}
        onChange={(e) => onEmail(e.target.value)}
        placeholder={emailPlaceholder}
        help="Será su usuario del panel."
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Nombre (opcional)"
          maxLength={80}
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder={nombrePlaceholder}
          help="Podrá cambiarlo al crear su acceso."
        />
        <Select label="Validez del enlace" value={validez} onChange={(e) => onValidez(e.target.value)}>
          {VALIDECES_BIENVENIDA.map((v) => (
            <option key={v.horas} value={String(v.horas)}>
              {v.texto}
            </option>
          ))}
        </Select>
      </div>
    </>
  );
}

function FormularioBienvenida({
  clientName,
  email,
  name,
  validez,
  onEmail,
  onName,
  onValidez,
  onSubmit,
  error,
  pie,
}: {
  clientName: string;
  email: string;
  name: string;
  validez: string;
  onEmail: (v: string) => void;
  onName: (v: string) => void;
  onValidez: (v: string) => void;
  onSubmit: (e: FormEvent) => void;
  error: string;
  pie: ReactNode;
}) {
  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <p className="text-base text-tinta-2">
        Quien lo reciba creará su propio acceso al panel de {clientName}, sin contraseñas que entregar, y pondrá en
        marcha el correo paso a paso: el dominio, las direcciones obligatorias, los buzones de su equipo y sus
        dispositivos.
      </p>
      <CamposBienvenida
        email={email}
        name={name}
        validez={validez}
        onEmail={onEmail}
        onName={onName}
        onValidez={onValidez}
      />
      <p className="text-sm text-tinta-3">
        Si ya había un enlace pendiente para este correo, se anula: solo vale el último que crees.
      </p>
      {error && <BandaError>{error}</BandaError>}
      {pie}
    </form>
  );
}

/* --------------------------- Lista de invitaciones -------------------------- */

/** Texto de seguimiento de una invitación: lo último que se sabe de ella. */
function detalleInvitacion(inv: Invitacion, etiqueta: string): string {
  switch (etiqueta) {
    case 'Aceptado':
      return `Aceptado el ${formatDate(inv.acceptedAt)}`;
    case 'Revocado':
      return `Revocado el ${formatDate(inv.revokedAt)}`;
    case 'Caducado':
      return `Caducó el ${formatDate(inv.expiresAt)}${inv.openedAt ? ' · se abrió, pero no se completó' : ' · sin abrir'}`;
    case 'Abierto':
      return `Abierto el ${formatDate(inv.openedAt)} · caduca el ${formatDate(inv.expiresAt)}`;
    default:
      return `Creado el ${formatDate(inv.createdAt)} · sin abrir · caduca el ${formatDate(inv.expiresAt)}`;
  }
}

/**
 * Acciones sobre las invitaciones de un cliente: volver a enviar una
 * pendiente (abre el enlace listo para entregar) y revocarla.
 */
function useAccionesInvitacion(clientId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reenvio, setReenvio] = useState<InvitacionCreada | null>(null);
  const recuperar = useMutation({
    mutationFn: (inviteId: string) =>
      api.get<{ invite: InvitacionCreada }>(
        `/api/clients/${encodeURIComponent(clientId)}/invites/${encodeURIComponent(inviteId)}/url`,
      ),
    onSuccess: (data) => setReenvio(data.invite),
    onError: async (err) => {
      toast('error', mensajeDe(err, 'No se ha podido recuperar el enlace.'));
      // Si caducó o se usó mientras tanto, la lista debe decirlo.
      await queryClient.invalidateQueries({ queryKey: ['invites', clientId] });
    },
  });
  const revocar = useMutation({
    mutationFn: (inviteId: string) =>
      api.delete(`/api/clients/${encodeURIComponent(clientId)}/invites/${encodeURIComponent(inviteId)}`),
    onSuccess: async () => {
      toast('ok', 'Se ha revocado el enlace de bienvenida.');
      await queryClient.invalidateQueries({ queryKey: ['invites', clientId] });
    },
    onError: (err) => toast('error', mensajeDe(err, 'No se ha podido revocar el enlace.')),
  });
  return { reenvio, setReenvio, recuperar, revocar };
}

/**
 * Hoja «Enlaces de bienvenida» de la pestaña Usuarios: cada invitación con su
 * estado y, mientras sigue vigente, «Volver a enviar» y «Revocar».
 */
export function HojaInvitaciones({
  clientId,
  clientName,
  onCrear,
}: {
  clientId: string;
  clientName: string;
  /** Abre el diálogo de crear, con la persona de una invitación caducada si se indica. */
  onCrear: (persona?: { email: string; name: string }) => void;
}) {
  const invitaciones = useInvitaciones(clientId);
  const { reenvio, setReenvio, recuperar, revocar } = useAccionesInvitacion(clientId);
  const [aRevocar, setARevocar] = useState<string | null>(null);
  const lista = invitaciones.data?.invites ?? [];

  // Sin invitaciones no hay nada que seguir: la acción ya está en la cabecera
  // y en el estado vacío de los usuarios, así que la hoja no ocupa sitio.
  if (invitaciones.isSuccess && lista.length === 0) return null;

  return (
    <Hoja title="Enlaces de bienvenida" meta={invitaciones.isSuccess ? `${lista.length} en total` : undefined} flush>
      {invitaciones.isPending ? (
        <Cargando label="Cargando los enlaces de bienvenida…" />
      ) : invitaciones.isError ? (
        <div className="p-4">
          <BandaError onRetry={() => void invitaciones.refetch()}>
            {mensajeDe(invitaciones.error, 'No se han podido cargar los enlaces de bienvenida.')}
          </BandaError>
        </div>
      ) : (
        <ul>
          {lista.map((inv) => {
            const estado = estadoInvitacion(inv);
            return (
              <li
                key={inv.id}
                className="regla-fila flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 last:border-b-0"
              >
                {/* Persona y correo identifican la fila: nunca se recortan. */}
                <div className="min-w-0 basis-full sm:basis-0 sm:grow">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-base text-tinta">
                    <span className="valor [overflow-wrap:anywhere] font-medium">{inv.email}</span>
                    {inv.name && <span className="break-words text-tinta-2">{inv.name}</span>}
                  </p>
                  <p className="text-sm text-tinta-3">{detalleInvitacion(inv, estado.etiqueta)}</p>
                </div>
                <span className="shrink-0">
                  <MarcaFondo veredicto={estado.veredicto}>{estado.etiqueta}</MarcaFondo>
                </span>
                <div className="flex shrink-0 flex-wrap items-center gap-1">
                  {estado.vigente ? (
                    aRevocar === inv.id ? (
                      <>
                        <Button
                          variant="peligro"
                          className="px-2"
                          busy={revocar.isPending}
                          onClick={() => revocar.mutate(inv.id, { onSettled: () => setARevocar(null) })}
                        >
                          Confirmar
                        </Button>
                        <Button variant="plano" className="px-2" onClick={() => setARevocar(null)}>
                          Cancelar
                        </Button>
                      </>
                    ) : (
                      <>
                        {inv.recoverable && (
                          <Button
                            variant="perfil"
                            className="px-2"
                            busy={recuperar.isPending && recuperar.variables === inv.id}
                            onClick={() => recuperar.mutate(inv.id)}
                          >
                            Volver a enviar
                          </Button>
                        )}
                        <Button variant="plano" className="px-2" onClick={() => setARevocar(inv.id)}>
                          Revocar
                        </Button>
                      </>
                    )
                  ) : estado.etiqueta === 'Caducado' ? (
                    // Lo habitual con uno caducado es mandar otro a la misma persona.
                    <Button variant="plano" className="px-2" onClick={() => onCrear({ email: inv.email, name: inv.name })}>
                      Enviar uno nuevo
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {reenvio && (
        <Dialogo
          open
          onClose={() => setReenvio(null)}
          title="Volver a enviar el enlace"
          pie={
            <Button variant="perfil" onClick={() => setReenvio(null)}>
              Cerrar
            </Button>
          }
        >
          <EnlaceBienvenidaListo invitacion={reenvio} clientName={clientName} />
        </Dialogo>
      )}
    </Hoja>
  );
}

/* ------------------------ Siguiente paso (Resumen) ------------------------- */

/**
 * Bloque del Resumen de un cliente sin usuarios del panel: el siguiente paso
 * recomendado es enviarle el enlace de bienvenida. Si ya hay uno vigente, se
 * dice en qué punto está y se ofrece volver a enviarlo.
 */
export function SiguientePasoBienvenida({
  clientId,
  clientName,
  contactEmail,
  suspended,
  alternativa,
}: {
  clientId: string;
  clientName: string;
  contactEmail: string;
  suspended: boolean;
  /** Enlace a la alternativa (crear el usuario con contraseña). */
  alternativa: ReactNode;
}) {
  const invitaciones = useInvitaciones(clientId);
  const { reenvio, setReenvio, recuperar } = useAccionesInvitacion(clientId);
  const [crear, setCrear] = useState(false);
  const vigente = (invitaciones.data?.invites ?? []).find((inv) => estadoInvitacion(inv).vigente);
  const estado = vigente ? estadoInvitacion(vigente) : null;

  return (
    <Hoja title="Acceso al panel" meta="Siguiente paso recomendado">
      <div className="flex flex-col gap-3">
        {vigente && estado ? (
          <>
            <p className="max-w-[75ch] text-base text-tinta-2">
              {clientName} aún no ha creado su acceso. El enlace de bienvenida está enviado a{' '}
              <span className="valor [overflow-wrap:anywhere] text-tinta">{vigente.email}</span>
              {estado.etiqueta === 'Abierto'
                ? `: lo abrió el ${formatDate(vigente.openedAt)}, pero todavía no ha terminado.`
                : ' y todavía no lo ha abierto.'}{' '}
              Caduca el {fechaLarga(vigente.expiresAt)}.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <MarcaFondo veredicto={estado.veredicto}>{estado.etiqueta}</MarcaFondo>
              {vigente.recoverable && (
                <Button
                  variant="perfil"
                  busy={recuperar.isPending}
                  onClick={() => recuperar.mutate(vigente.id)}
                >
                  Volver a enviar
                </Button>
              )}
              <Button variant="plano" disabled={suspended} onClick={() => setCrear(true)}>
                Crear otro enlace
              </Button>
            </div>
            {/* Si no le llega o no puede abrirlo, la alternativa sigue a mano. */}
            <div>{alternativa}</div>
          </>
        ) : (
          <>
            <p className="max-w-[75ch] text-base text-tinta-2">
              {clientName} aún no puede entrar en su panel. Envía un enlace de bienvenida a la persona de contacto:
              creará su propio acceso y pondrá en marcha el correo paso a paso (dominio, direcciones obligatorias,
              buzones del equipo y sus dispositivos).
            </p>
            {suspended && (
              <p className="text-sm text-tinta-3">Reactiva el cliente para poder enviarle el enlace.</p>
            )}
            {invitaciones.isError && (
              <BandaError onRetry={() => void invitaciones.refetch()}>
                {mensajeDe(invitaciones.error, 'No se han podido cargar los enlaces de bienvenida.')}
              </BandaError>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button variant="principal" disabled={suspended} onClick={() => setCrear(true)}>
                Enviar enlace de bienvenida
              </Button>
              {alternativa}
            </div>
          </>
        )}
      </div>

      {crear && (
        <DialogoBienvenida
          clientId={clientId}
          clientName={clientName}
          emailInicial={vigente?.email ?? contactEmail}
          nombreInicial={vigente?.name ?? ''}
          onClose={() => setCrear(false)}
        />
      )}
      {reenvio && (
        <Dialogo
          open
          onClose={() => setReenvio(null)}
          title="Volver a enviar el enlace"
          pie={
            <Button variant="perfil" onClick={() => setReenvio(null)}>
              Cerrar
            </Button>
          }
        >
          <EnlaceBienvenidaListo invitacion={reenvio} clientName={clientName} />
        </Dialogo>
      )}
    </Hoja>
  );
}
