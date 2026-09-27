import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Alias, type Mailbox } from '../../lib/api';
import { formatDay } from '../../lib/format';
import { formatBytes, formatQuota, mensajeDe, veredictoUso } from '../../lib/gestion';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Dialogo, MarcaFondo, Muestra } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { ConectarBuzon } from '../ConectarBuzon';
import { BandaAviso, BandaError, Botonera, FilaDato, Opcion } from './comun';
import { ContrasenasAplicacion } from './ContrasenasAplicacion';

export type VistaFicha =
  | 'resumen'
  | 'credenciales'
  | 'conectar'
  | 'editar'
  | 'contrasena'
  | 'aplicaciones'
  | 'estado'
  | 'eliminar';

const titulos: Record<VistaFicha, string> = {
  resumen: 'Buzón',
  credenciales: 'Credenciales del buzón',
  conectar: 'Conectar dispositivos',
  editar: 'Editar buzón',
  contrasena: 'Restablecer contraseña',
  aplicaciones: 'Contraseñas de aplicación',
  estado: 'Estado del buzón',
  eliminar: 'Eliminar buzón',
};

/**
 * Ficha de un buzón en un único diálogo: el resumen y cada acción (editar,
 * contraseña, dispositivos, suspender, eliminar) son vistas de la misma
 * ficha, con «Volver». Así no se apilan diálogos modales unos sobre otros.
 *
 * Se monta con `key={mailbox.id}` para que cada buzón empiece desde cero.
 */
export function FichaBuzon({
  mailbox,
  vistaInicial = 'resumen',
  passwordInicial,
  planQuotaMb,
  clienteSuspendido,
  aliases,
  onClose,
}: {
  mailbox: Mailbox | null;
  vistaInicial?: VistaFicha;
  /** Contraseña recién generada al crear el buzón (se muestra una vez). */
  passwordInicial?: string;
  /** Cuota máxima del plan del cliente, si se conoce. */
  planQuotaMb?: number;
  clienteSuspendido?: boolean;
  /** Alias conocidos, para explicar qué pasa con ellos al eliminar. */
  aliases: Alias[];
  onClose: () => void;
}) {
  const [vista, setVista] = useState<VistaFicha>(vistaInicial);
  const [password, setPassword] = useState<string | undefined>(passwordInicial);

  const volver = () => setVista('resumen');

  return (
    <Dialogo open={mailbox !== null} onClose={onClose} title={titulos[vista]}>
      {mailbox && (
        <div className="flex flex-col gap-4">
          {vista !== 'resumen' && vista !== 'credenciales' && (
            <button
              type="button"
              onClick={volver}
              className="self-start text-sm text-laboratorio underline decoration-1 underline-offset-2 hover:text-tinta"
            >
              Volver a la ficha de {mailbox.email}
            </button>
          )}

          {vista === 'resumen' && (
            <Resumen mailbox={mailbox} clienteSuspendido={clienteSuspendido} onVista={setVista} />
          )}
          {vista === 'credenciales' && (
            <Credenciales
              mailbox={mailbox}
              password={password}
              onHecho={() => {
                setPassword(undefined);
                volver();
              }}
            />
          )}
          {vista === 'conectar' && (
            <ConectarBuzon mailboxId={mailbox.id} email={mailbox.email} passwordRecienGenerada={password} />
          )}
          {vista === 'editar' && <Editar mailbox={mailbox} planQuotaMb={planQuotaMb} onHecho={volver} />}
          {vista === 'contrasena' && (
            <Restablecer
              mailbox={mailbox}
              onGenerada={(nueva) => {
                setPassword(nueva);
                setVista('credenciales');
              }}
              onHecho={volver}
            />
          )}
          {vista === 'aplicaciones' && <ContrasenasAplicacion mailboxId={mailbox.id} email={mailbox.email} />}
          {vista === 'estado' && (
            <Estado mailbox={mailbox} clienteSuspendido={clienteSuspendido} onHecho={volver} />
          )}
          {vista === 'eliminar' && (
            <Eliminar mailbox={mailbox} aliases={aliases} onHecho={onClose} onCancelar={volver} />
          )}
        </div>
      )}
    </Dialogo>
  );
}

/* --------------------------------- Resumen -------------------------------- */

function Resumen({
  mailbox,
  clienteSuspendido,
  onVista,
}: {
  mailbox: Mailbox;
  clienteSuspendido?: boolean;
  onVista: (vista: VistaFicha) => void;
}) {
  const veredicto = veredictoUso(mailbox.usedBytes, mailbox.quotaMb);
  const suspendido = mailbox.status === 'suspended' || clienteSuspendido;
  return (
    <>
      <Muestra rotulo="Dirección" copiar={mailbox.email}>
        <p className="valor break-all text-base text-tinta">{mailbox.email}</p>
      </Muestra>
      <div className="border border-regla">
        <FilaDato rotulo="Nombre visible">{mailbox.displayName || <span className="text-tinta-3">Sin nombre visible</span>}</FilaDato>
        <FilaDato rotulo="Ocupación">
          <span className="valor text-sm">
            {mailbox.usedBytes === null ? 'Sin dato' : formatBytes(mailbox.usedBytes)} de {formatQuota(mailbox.quotaMb)}
          </span>{' '}
          {veredicto !== 'normal' && (
            <MarcaFondo veredicto={veredicto}>
              {veredicto === 'fuera' ? 'Lleno' : veredicto === 'vigilar' ? 'Casi lleno' : 'Sin dato'}
            </MarcaFondo>
          )}
        </FilaDato>
        <FilaDato rotulo="Estado">
          {suspendido ? (
            <MarcaFondo veredicto="fuera">
              {mailbox.status === 'suspended' ? 'Suspendido' : 'Cliente suspendido'}
            </MarcaFondo>
          ) : (
            <MarcaFondo veredicto="normal">Activo</MarcaFondo>
          )}
        </FilaDato>
        <FilaDato rotulo="Alta">
          <span className="valor text-sm">{formatDay(mailbox.createdAt)}</span>
        </FilaDato>
      </div>
      {veredicto === 'fuera' && (
        <BandaError>
          El buzón ha alcanzado su cuota y deja de recibir correo. Amplíe la cuota o pida al titular que
          libere espacio.
        </BandaError>
      )}

      <div className="border border-regla">
        <Accion
          titulo="Conectar dispositivos"
          detalle="Datos de conexión, perfiles de configuración y enlace para el titular."
          boton="Abrir"
          onClick={() => onVista('conectar')}
        />
        <Accion titulo="Editar" detalle="Nombre visible y cuota." boton="Editar" onClick={() => onVista('editar')} />
        <Accion
          titulo="Restablecer contraseña"
          detalle="Los dispositivos configurados deberán actualizarse con la nueva."
          boton="Restablecer"
          onClick={() => onVista('contrasena')}
        />
        <Accion
          titulo="Contraseñas de aplicación"
          detalle="Una por dispositivo o aplicación; se revocan por separado."
          boton="Gestionar"
          onClick={() => onVista('aplicaciones')}
        />
        <Accion
          titulo={mailbox.status === 'active' ? 'Suspender' : 'Reactivar'}
          detalle={
            mailbox.status === 'active'
              ? 'Impide iniciar sesión sin eliminar el correo.'
              : 'Permite de nuevo iniciar sesión.'
          }
          boton={mailbox.status === 'active' ? 'Suspender' : 'Reactivar'}
          onClick={() => onVista('estado')}
        />
        <Accion
          titulo="Eliminar"
          detalle="Borra el buzón y todo su correo."
          boton="Eliminar"
          peligro
          onClick={() => onVista('eliminar')}
        />
      </div>
    </>
  );
}

function Accion({
  titulo,
  detalle,
  boton,
  onClick,
  peligro = false,
}: {
  titulo: string;
  detalle: string;
  boton: string;
  onClick: () => void;
  peligro?: boolean;
}) {
  return (
    <div className="regla-fila flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-3 py-2 last:border-b-0">
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-base text-tinta">{titulo}</p>
        <p className="text-sm text-tinta-3">{detalle}</p>
      </div>
      <Button variant={peligro ? 'peligro' : 'perfil'} className="px-2" onClick={onClick}>
        {boton}
      </Button>
    </div>
  );
}

/* ------------------------------ Credenciales ------------------------------ */

function Credenciales({
  mailbox,
  password,
  onHecho,
}: {
  mailbox: Mailbox;
  password?: string;
  onHecho: () => void;
}) {
  return (
    <>
      {password ? (
        <>
          <BandaAviso>
            Esta contraseña <strong className="font-semibold">solo se muestra ahora</strong>. Entréguela al
            titular del buzón por un canal seguro o utilice el enlace de configuración.
          </BandaAviso>
          <Muestra rotulo="Usuario" copiar={mailbox.email}>
            <p className="valor break-all text-base text-tinta">{mailbox.email}</p>
          </Muestra>
          <Muestra rotulo="Contraseña" copiar={password}>
            <p className="valor break-all text-base text-tinta">{password}</p>
          </Muestra>
        </>
      ) : (
        <p className="text-base text-tinta-2">
          El buzón <span className="valor break-all">{mailbox.email}</span> está listo.
        </p>
      )}
      <div className="border-t border-regla pt-4">
        <p className="rotulo mb-2">Conectar dispositivos</p>
        <ConectarBuzon mailboxId={mailbox.id} email={mailbox.email} passwordRecienGenerada={password} />
      </div>
      <Botonera>
        <Button variant="tinta" onClick={onHecho}>
          {password ? 'Ya he guardado la contraseña' : 'Continuar'}
        </Button>
      </Botonera>
    </>
  );
}

/* --------------------------------- Editar --------------------------------- */

function Editar({ mailbox, planQuotaMb, onHecho }: { mailbox: Mailbox; planQuotaMb?: number; onHecho: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [displayName, setDisplayName] = useState(mailbox.displayName);
  const [quota, setQuota] = useState(String(mailbox.quotaMb));
  const [error, setError] = useState('');

  const quotaMb = Number(quota);
  const quotaValida = Number.isInteger(quotaMb) && quotaMb >= 64;
  const excedePlan = planQuotaMb !== undefined && quotaValida && quotaMb > planQuotaMb;
  const bajoUso =
    quotaValida && mailbox.usedBytes !== null && mailbox.usedBytes > quotaMb * 1024 * 1024;

  const save = useMutation({
    mutationFn: () =>
      api.patch<{ mailbox: Mailbox }>(`/api/mailboxes/${mailbox.id}`, {
        displayName,
        quotaMb,
      }),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
      toast(
        'ok',
        data.mailbox.quotaMb < quotaMb
          ? `Buzón actualizado. La cuota se ha limitado a ${formatQuota(data.mailbox.quotaMb)}, el máximo del plan.`
          : 'Buzón actualizado.',
      );
      onHecho();
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido guardar el buzón.')),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!quotaValida) {
      setError('La cuota debe ser un número entero de MB, como mínimo 64.');
      return;
    }
    save.mutate();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Input
        label="Nombre visible"
        maxLength={80}
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        placeholder="Equipo de soporte"
        help="Es el nombre que ven los destinatarios junto a la dirección."
      />
      <Input
        label="Cuota (MB)"
        type="number"
        inputMode="numeric"
        min={64}
        max={planQuotaMb}
        step={1}
        mono
        value={quota}
        onChange={(e) => setQuota(e.target.value)}
        help={
          planQuotaMb !== undefined
            ? `Equivale a ${quotaValida ? formatQuota(quotaMb) : '—'}. Máximo del plan: ${formatQuota(planQuotaMb)} (${planQuotaMb} MB).`
            : `Equivale a ${quotaValida ? formatQuota(quotaMb) : '—'}.`
        }
        error={excedePlan ? `Supera el máximo del plan; se guardará ${formatQuota(planQuotaMb!)}.` : undefined}
      />
      {bajoUso && (
        <BandaAviso>
          El buzón ya ocupa {formatBytes(mailbox.usedBytes!)}. Con esta cuota dejará de recibir correo hasta
          que se libere espacio.
        </BandaAviso>
      )}
      {error && <BandaError>{error}</BandaError>}
      <Botonera>
        <Button type="button" variant="plano" onClick={onHecho}>
          Cancelar
        </Button>
        <Button type="submit" variant="tinta" busy={save.isPending}>
          Guardar cambios
        </Button>
      </Botonera>
    </form>
  );
}

/* ------------------------------- Contraseña ------------------------------- */

function Restablecer({
  mailbox,
  onGenerada,
  onHecho,
}: {
  mailbox: Mailbox;
  onGenerada: (password: string) => void;
  onHecho: () => void;
}) {
  const toast = useToast();
  const [modo, setModo] = useState<'generar' | 'propia'>('generar');
  const [propia, setPropia] = useState('');
  const [repetida, setRepetida] = useState('');
  const [error, setError] = useState('');

  const reset = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; password?: string }>(`/api/mailboxes/${mailbox.id}/password`, {
        password: modo === 'propia' ? propia : undefined,
      }),
    onSuccess: (data) => {
      if (data.password) {
        onGenerada(data.password);
      } else {
        toast('ok', `Contraseña de ${mailbox.email} restablecida.`);
        onHecho();
      }
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido restablecer la contraseña.')),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (modo === 'propia') {
      if (propia.length < 10) {
        setError('La contraseña debe tener al menos 10 caracteres.');
        return;
      }
      if (propia !== repetida) {
        setError('Las dos contraseñas no coinciden.');
        return;
      }
    }
    setError('');
    reset.mutate();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <BandaAviso>
        Al restablecer la contraseña, los programas y dispositivos configurados con la actual (correo del
        móvil, Outlook, Thunderbird) dejarán de conectarse hasta que se introduzca la nueva. Las contraseñas
        de aplicación siguen funcionando.
      </BandaAviso>
      <fieldset className="flex flex-col gap-2.5">
        <legend className="rotulo mb-2">Nueva contraseña</legend>
        <Opcion
          name={`modo-${mailbox.id}`}
          checked={modo === 'generar'}
          onChange={() => setModo('generar')}
          label="Generar una contraseña segura"
          help="Se mostrará una sola vez al terminar."
        />
        <Opcion
          name={`modo-${mailbox.id}`}
          checked={modo === 'propia'}
          onChange={() => setModo('propia')}
          label="Escribir una contraseña"
          help="Mínimo 10 caracteres."
        />
      </fieldset>
      {modo === 'propia' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Contraseña"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            value={propia}
            onChange={(e) => setPropia(e.target.value)}
          />
          <Input
            label="Repetir contraseña"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            value={repetida}
            onChange={(e) => setRepetida(e.target.value)}
          />
        </div>
      )}
      {error && <BandaError>{error}</BandaError>}
      <Botonera>
        <Button type="button" variant="plano" onClick={onHecho}>
          Cancelar
        </Button>
        <Button type="submit" variant="tinta" busy={reset.isPending}>
          Restablecer contraseña
        </Button>
      </Botonera>
    </form>
  );
}

/* --------------------------------- Estado --------------------------------- */

function Estado({
  mailbox,
  clienteSuspendido,
  onHecho,
}: {
  mailbox: Mailbox;
  clienteSuspendido?: boolean;
  onHecho: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState('');
  const suspender = mailbox.status === 'active';

  const change = useMutation({
    mutationFn: () => api.patch(`/api/mailboxes/${mailbox.id}`, { status: suspender ? 'suspended' : 'active' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
      toast('ok', suspender ? `Buzón ${mailbox.email} suspendido.` : `Buzón ${mailbox.email} reactivado.`);
      onHecho();
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido cambiar el estado del buzón.')),
  });

  return (
    <>
      {suspender ? (
        <p className="text-base text-tinta-2">
          Mientras esté suspendido, el titular de <span className="valor break-all">{mailbox.email}</span> no
          podrá iniciar sesión en ningún programa, móvil ni en el webmail. El correo guardado se conserva y el
          buzón se puede reactivar en cualquier momento.
        </p>
      ) : clienteSuspendido ? (
        <BandaAviso>
          El cliente está suspendido: sus buzones permanecen suspendidos hasta que se reactive el cliente.
        </BandaAviso>
      ) : (
        <p className="text-base text-tinta-2">
          El titular de <span className="valor break-all">{mailbox.email}</span> podrá volver a iniciar sesión
          con su contraseña actual.
        </p>
      )}
      {error && <BandaError>{error}</BandaError>}
      <Botonera>
        <Button variant="plano" onClick={onHecho}>
          Cancelar
        </Button>
        <Button
          variant={suspender ? 'peligro' : 'tinta'}
          busy={change.isPending}
          disabled={!suspender && clienteSuspendido}
          onClick={() => change.mutate()}
        >
          {suspender ? 'Suspender buzón' : 'Reactivar buzón'}
        </Button>
      </Botonera>
    </>
  );
}

/* -------------------------------- Eliminar -------------------------------- */

function Eliminar({
  mailbox,
  aliases,
  onHecho,
  onCancelar,
}: {
  mailbox: Mailbox;
  aliases: Alias[];
  onHecho: () => void;
  onCancelar: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmacion, setConfirmacion] = useState('');
  const [error, setError] = useState('');
  const email = mailbox.email.toLowerCase();

  const afectados = aliases.filter((a) => a.destinations.some((d) => d.toLowerCase() === email));
  const seEliminan = afectados.filter((a) => a.destinations.length === 1);
  const seActualizan = afectados.filter((a) => a.destinations.length > 1);

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/mailboxes/${mailbox.id}`),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mailboxes'] }),
        queryClient.invalidateQueries({ queryKey: ['aliases'] }),
        queryClient.invalidateQueries({ queryKey: ['client-dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['clients'] }),
      ]);
      toast('ok', `Buzón ${mailbox.email} eliminado.`);
      onHecho();
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido eliminar el buzón.')),
  });

  const coincide = confirmacion.trim().toLowerCase() === email;

  return (
    <>
      <p className="text-base text-tinta-2">
        Se eliminará <strong className="valor break-all font-medium text-tinta">{mailbox.email}</strong> y todo
        el correo que contiene, también del servidor de correo. Esta acción no se puede deshacer.
      </p>
      {(seActualizan.length > 0 || seEliminan.length > 0) && (
        <BandaAviso>
          {seActualizan.length > 0 && (
            <p>
              Dejarán de reenviar a este buzón:{' '}
              <span className="valor break-all">{seActualizan.map((a) => a.email).join(', ')}</span>.
            </p>
          )}
          {seEliminan.length > 0 && (
            <p>
              Se eliminarán porque no tienen otros destinos:{' '}
              <span className="valor break-all">{seEliminan.map((a) => a.email).join(', ')}</span>.
            </p>
          )}
        </BandaAviso>
      )}
      <Input
        label="Escriba la dirección para confirmar"
        mono
        autoComplete="off"
        value={confirmacion}
        onChange={(e) => setConfirmacion(e.target.value)}
        placeholder={mailbox.email}
      />
      {error && <BandaError>{error}</BandaError>}
      <Botonera>
        <Button variant="plano" onClick={onCancelar}>
          Cancelar
        </Button>
        <Button variant="peligro" disabled={!coincide} busy={remove.isPending} onClick={() => remove.mutate()}>
          Eliminar definitivamente
        </Button>
      </Botonera>
    </>
  );
}
