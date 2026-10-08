import { useState, type FormEvent } from 'react';
import { UserRound } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../../lib/api';
import { formatDate, plural } from '../../../lib/format';
import { esCorreoValido, mensajeDe, type ClientUser } from '../../../lib/gestion';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Field';
import { Dialogo, Hoja, MarcaFondo, Muestra, Vacio } from '../../../ui/kit';
import { useToast } from '../../../ui/toast';
import { BandaAviso, BandaError, Botonera, CabeceraVista, Opcion } from '../../../components/gestion/comun';
import { useDireccionPanel } from '../../../components/gestion/consultas';
import { DialogoBienvenida, HojaInvitaciones } from '../../../components/EnlaceBienvenida';
import { CONFIRMAR_CONTRASENA, useRefrescarCliente, type ContextoCliente } from './datos';

/**
 * Pestaña «Usuarios» de la ficha del cliente: las personas que entran en su
 * panel y los enlaces de bienvenida con los que se dan de alta. El enlace es
 * la forma recomendada de dar acceso (cada persona elige su contraseña);
 * crear el usuario con una contraseña generada sigue disponible.
 */
export default function UsuariosCliente({ contexto }: { contexto: ContextoCliente }) {
  const { id, cliente, usuarios } = contexto;
  const location = useLocation();
  const navigate = useNavigate();
  // Desde el Resumen se puede llegar con la alternativa ya elegida.
  const [anadir, setAnadir] = useState(
    () => Boolean((location.state as { anadirUsuario?: boolean } | null)?.anadirUsuario),
  );
  const [bienvenida, setBienvenida] = useState<null | { email: string; name: string }>(null);

  function cerrarAnadir() {
    setAnadir(false);
    // Que volver atrás o recargar no reabra el diálogo.
    if (location.state) navigate(location.pathname, { replace: true, state: null });
  }

  const enviarEnlace = (persona?: { email: string; name: string }) =>
    setBienvenida(persona ?? { email: usuarios.length === 0 ? cliente.contactEmail : '', name: '' });

  return (
    <>
      <CabeceraVista
        enPestana
        title="Usuarios"
        meta={`Personas que entran en el panel de ${cliente.name} para gestionar sus dominios, buzones, alias y claves de API.`}
        actions={
          <>
            <Button variant="perfil" onClick={() => setAnadir(true)}>
              Crear usuario con contraseña
            </Button>
            <Button variant="principal" disabled={cliente.suspended} onClick={() => enviarEnlace()}>
              Enviar enlace de bienvenida
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-4">
        <Hoja title="Usuarios del panel" meta={plural(usuarios.length, 'usuario', 'usuarios')} flush>
          {usuarios.length === 0 ? (
            <Vacio
              icono={UserRound}
              title="Sin usuarios de acceso"
              action={
                <>
                  <Button variant="perfil" disabled={cliente.suspended} onClick={() => enviarEnlace()}>
                    Enviar enlace de bienvenida
                  </Button>
                  <Button variant="plano" onClick={() => setAnadir(true)}>
                    Crear usuario con contraseña
                  </Button>
                </>
              }
            >
              {cliente.name} aún no puede entrar en su panel. Con un enlace de bienvenida, la persona de contacto crea
              su propio acceso y pone en marcha el correo paso a paso.
            </Vacio>
          ) : (
            <ul>
              {usuarios.map((user) => (
                <FilaUsuario key={user.id} clientId={id} user={user} />
              ))}
            </ul>
          )}
        </Hoja>

        <HojaInvitaciones clientId={id} clientName={cliente.name} onCrear={enviarEnlace} />
      </div>

      {anadir && <AnadirUsuario clientId={id} clientName={cliente.name} onClose={cerrarAnadir} />}
      {bienvenida && (
        <DialogoBienvenida
          clientId={id}
          clientName={cliente.name}
          emailInicial={bienvenida.email}
          nombreInicial={bienvenida.name}
          onClose={() => setBienvenida(null)}
        />
      )}
    </>
  );
}

function CredencialUsuario({ clientId, email, password }: { clientId: string; email: string; password: string }) {
  const panel = useDireccionPanel({ clientId });
  return (
    <>
      <BandaAviso>
        La contraseña <strong className="font-semibold">solo se muestra ahora</strong>. Entrégala por un canal
        seguro; el usuario podrá cambiarla desde «Mi cuenta».
      </BandaAviso>
      <Muestra rotulo="Dirección del panel" copiar={panel}>
        <p className="valor break-all text-base text-tinta">{panel}</p>
      </Muestra>
      <Muestra rotulo="Usuario" copiar={email}>
        <p className="valor break-all text-base text-tinta">{email}</p>
      </Muestra>
      <Muestra rotulo="Contraseña" copiar={password}>
        <p className="codigo break-all text-base text-tinta">{password}</p>
      </Muestra>
    </>
  );
}

function AnadirUsuario({ clientId, clientName, onClose }: { clientId: string; clientName: string; onClose: () => void }) {
  const refrescar = useRefrescarCliente(clientId);
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [modo, setModo] = useState<'generar' | 'propia'>('generar');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [creado, setCreado] = useState<{ email: string; password: string } | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ user: { email: string }; password?: string }>(`/api/clients/${clientId}/users`, {
        name,
        email,
        password: modo === 'propia' ? password : undefined,
      }),
    onSuccess: async (data) => {
      await refrescar();
      if (data.password) {
        setCreado({ email: data.user.email, password: data.password });
      } else {
        toast('ok', `Usuario ${data.user.email} creado.`);
        onClose();
      }
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido crear el usuario.')),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) {
      setError('El nombre debe tener al menos 2 caracteres.');
      return;
    }
    if (!esCorreoValido(email)) {
      setError('Indica un correo válido: será el usuario con el que entrará en el panel.');
      return;
    }
    if (modo === 'propia' && password.length < 10) {
      setError('La contraseña debe tener al menos 10 caracteres.');
      return;
    }
    setError('');
    create.mutate();
  }

  function limpiar<T>(set: (v: T) => void) {
    return (v: T) => {
      setError('');
      set(v);
    };
  }

  return (
    <Dialogo
      open
      onClose={onClose}
      title={creado ? 'Usuario creado' : 'Añadir usuario del panel'}
      confirmarCierre={creado ? CONFIRMAR_CONTRASENA : null}
      pie={
        creado ? (
          <Button variant="principal" onClick={onClose}>
            Ya he guardado la contraseña
          </Button>
        ) : undefined
      }
    >
      {creado ? (
        <div className="flex flex-col gap-4">
          <CredencialUsuario clientId={clientId} email={creado.email} password={creado.password} />
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <p className="text-base text-tinta-2">
            Este usuario entrará en el panel de {clientName} y podrá gestionar sus dominios, buzones, alias y
            claves de API, dentro de los límites del plan.
          </p>
          <Input label="Nombre" maxLength={80} value={name} onChange={(e) => limpiar(setName)(e.target.value)} />
          <Input
            label="Correo (será su usuario)"
            type="email"
            value={email}
            onChange={(e) => limpiar(setEmail)(e.target.value)}
          />
          <fieldset className="flex flex-col gap-2.5">
            <legend className="rotulo mb-2">Contraseña</legend>
            <Opcion
              name="usuario-modo"
              checked={modo === 'generar'}
              onChange={() => limpiar(setModo)('generar')}
              label="Generar una contraseña segura"
              help="Se mostrará una sola vez."
            />
            <Opcion
              name="usuario-modo"
              checked={modo === 'propia'}
              onChange={() => limpiar(setModo)('propia')}
              label="Escribir una contraseña"
            />
          </fieldset>
          {modo === 'propia' && (
            <Input
              label="Contraseña"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => limpiar(setPassword)(e.target.value)}
              help="Mínimo 10 caracteres."
            />
          )}
          {error && <BandaError>{error}</BandaError>}
          <Botonera>
            <Button type="button" variant="plano" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" variant="principal" busy={create.isPending}>
              Crear usuario
            </Button>
          </Botonera>
        </form>
      )}
    </Dialogo>
  );
}

function FilaUsuario({ clientId, user }: { clientId: string; user: ClientUser }) {
  const refrescar = useRefrescarCliente(clientId);
  const toast = useToast();
  const [dialogo, setDialogo] = useState<null | 'restablecer' | 'eliminar'>(null);
  const [nueva, setNueva] = useState<string | null>(null);
  const [error, setError] = useState('');

  const toggle = useMutation({
    mutationFn: () => api.patch(`/api/clients/${clientId}/users/${user.id}`, { disabled: !user.disabled }),
    onSuccess: async () => {
      await refrescar();
      toast('ok', user.disabled ? `Usuario ${user.email} habilitado.` : `Usuario ${user.email} deshabilitado.`);
    },
    onError: (err) => toast('error', mensajeDe(err, 'No se ha podido cambiar el usuario.')),
  });

  const reset = useMutation({
    mutationFn: () =>
      api.patch<{ ok: boolean; password?: string }>(`/api/clients/${clientId}/users/${user.id}`, {
        generatePassword: true,
      }),
    onSuccess: (data) => {
      setNueva(data.password ?? null);
      setError('');
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido restablecer la contraseña.')),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/clients/${clientId}/users/${user.id}`),
    onSuccess: async () => {
      setDialogo(null);
      await refrescar();
      toast('ok', `Usuario ${user.email} eliminado.`);
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido eliminar el usuario.')),
  });

  function cerrar() {
    setDialogo(null);
    setNueva(null);
    setError('');
  }

  function abrir(cual: 'restablecer' | 'eliminar') {
    // Cada apertura empieza limpia: sin el error ni el estado de la anterior.
    setError('');
    reset.reset();
    remove.reset();
    setDialogo(cual);
  }

  return (
    <li className="regla-fila flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 last:border-b-0">
      {/* Nombre y correo identifican la fila: nunca se recortan. */}
      <div className="min-w-0 basis-full sm:basis-0 sm:grow">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-base font-medium text-tinta">
          {user.name}
          {user.disabled && <MarcaFondo veredicto="fuera">Deshabilitado</MarcaFondo>}
        </p>
        <p className="text-sm text-tinta-3">
          <span className="valor break-all">{user.email}</span> · último acceso{' '}
          <span className="valor">{formatDate(user.lastLoginAt)}</span>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button variant="plano" className="px-2" onClick={() => abrir('restablecer')}>
          Restablecer contraseña
        </Button>
        <Button variant="plano" className="px-2" busy={toggle.isPending} onClick={() => toggle.mutate()}>
          {user.disabled ? 'Habilitar' : 'Deshabilitar'}
        </Button>
        <Button variant="peligro" className="px-2" onClick={() => abrir('eliminar')}>
          Eliminar
        </Button>
      </div>

      <Dialogo
        open={dialogo === 'restablecer'}
        onClose={cerrar}
        title={nueva ? 'Contraseña restablecida' : 'Restablecer contraseña del usuario'}
        confirmarCierre={nueva ? CONFIRMAR_CONTRASENA : null}
        pie={
          nueva ? (
            <Button variant="principal" onClick={cerrar}>
              Ya he guardado la contraseña
            </Button>
          ) : undefined
        }
      >
        {nueva ? (
          <div className="flex flex-col gap-4">
            <CredencialUsuario clientId={clientId} email={user.email} password={nueva} />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2">
              Se generará una contraseña nueva para <span className="valor break-all">{user.email}</span> y se
              cerrarán sus sesiones abiertas. La contraseña se mostrará una sola vez.
            </p>
            {error && <BandaError>{error}</BandaError>}
            <Botonera>
              <Button variant="plano" onClick={cerrar}>
                Cancelar
              </Button>
              <Button variant="principal" busy={reset.isPending} onClick={() => reset.mutate()}>
                Generar contraseña
              </Button>
            </Botonera>
          </div>
        )}
      </Dialogo>

      <Dialogo open={dialogo === 'eliminar'} onClose={cerrar} title="Eliminar usuario">
        <div className="flex flex-col gap-4">
          <p className="text-base text-tinta-2">
            <span className="valor break-all">{user.email}</span> dejará de poder entrar en el panel y se cerrarán
            sus sesiones. Los buzones y dominios del cliente no se modifican.
          </p>
          {error && <BandaError>{error}</BandaError>}
          <Botonera>
            <Button variant="plano" onClick={cerrar}>
              Cancelar
            </Button>
            <Button variant="peligro" busy={remove.isPending} onClick={() => remove.mutate()}>
              Eliminar usuario
            </Button>
          </Botonera>
        </div>
      </Dialogo>
    </li>
  );
}
