import { useState, type FormEvent } from 'react';
import { Cable } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatDate, formatDay, plural } from '../../lib/format';
import {
  CADUCIDADES,
  tokenEnmascarado,
  veredictoToken,
  type TokenCreado,
  type TokenGestion,
} from '../../lib/tokens';
import { Button } from '../../ui/Button';
import { Input, Select } from '../../ui/Field';
import { AvisoError, Dialogo, Hoja, MarcaFondo, Cargando, Muestra, Vacio, type Veredicto } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { useDireccionPanel } from '../gestion/consultas';

/** El nombre dice que el token es para Skyway («Skyway», «Skyway producción»…). */
function esParaSkyway(nombre: string): boolean {
  return /skyway/i.test(nombre);
}

/** Fuera de rango primero: un token caducado rompe una integración y se lee antes. */
const PESO: Record<Veredicto, number> = { fuera: 0, vigilar: 1, 'sin-dato': 2, normal: 3 };

/**
 * Tokens de gestión: credenciales para que Skyway, un script o la CI
 * gestionen Mailway por API con los permisos del usuario que los crea.
 * El token completo se muestra una sola vez, al crearlo.
 */
export function HojaTokens({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [verTodos, setVerTodos] = useState(false);
  const [verRevocados, setVerRevocados] = useState(false);
  const [crearAbierto, setCrearAbierto] = useState(false);
  const [nombre, setNombre] = useState('');
  const [caducidad, setCaducidad] = useState('365');
  // Elegida a mano: el nombre ya no la cambia.
  const [caducidadElegida, setCaducidadElegida] = useState(false);
  const [errorAlta, setErrorAlta] = useState('');
  const [creado, setCreado] = useState<TokenCreado | null>(null);
  const [aRevocar, setARevocar] = useState<TokenGestion | null>(null);

  const todos = isAdmin && verTodos;
  const tokens = useQuery({
    queryKey: ['tokens', todos ? 'todos' : 'propios'],
    queryFn: () => api.get<{ tokens: TokenGestion[] }>(`/api/tokens${todos ? '?all=1' : ''}`),
  });

  const crear = useMutation({
    mutationFn: () =>
      api.post<TokenCreado>('/api/tokens', {
        name: nombre.trim(),
        expiresInDays: CADUCIDADES.find((c) => c.valor === caducidad)?.dias ?? null,
      }),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['tokens'] });
      setCrearAbierto(false);
      setNombre('');
      setErrorAlta('');
      setCreado(data);
    },
    onError: (err) =>
      setErrorAlta(err instanceof ApiError ? err.message : 'No se ha podido crear el token.'),
  });

  const revocar = useMutation({
    mutationFn: (token: TokenGestion) => api.delete(`/api/tokens/${token.id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['tokens'] });
      setARevocar(null);
      toast('ok', 'Token revocado. Las integraciones que lo utilicen dejarán de tener acceso.');
    },
    onError: (err) => {
      setARevocar(null);
      toast('error', err instanceof ApiError ? err.message : 'No se ha podido revocar el token.');
    },
  });

  function abrirAlta() {
    // Cada alta empieza de cero: sin el nombre ni el error de la anterior.
    setErrorAlta('');
    setNombre('');
    setCaducidad('365');
    setCaducidadElegida(false);
    crear.reset();
    setCrearAbierto(true);
  }

  function enviarAlta(e: FormEvent) {
    e.preventDefault();
    if (!nombre.trim()) {
      setErrorAlta('Indica un nombre para el token.');
      return;
    }
    crear.mutate();
  }

  const ahora = Date.now();
  const lista = tokens.data?.tokens ?? [];
  const vigentes = lista
    .filter((t) => t.status !== 'revoked')
    .map((t) => ({ token: t, ...veredictoToken(t, ahora) }))
    .sort((a, b) => PESO[a.veredicto] - PESO[b.veredicto] || b.token.createdAt - a.token.createdAt);
  const revocados = lista.filter((t) => t.status === 'revoked');
  // Lo que se configura en Skyway es la dirección pública del panel, no la
  // IP o la URL interna por la que se esté entrando ahora.
  const origen = useDireccionPanel();

  return (
    <>
      <Hoja
        title="Tokens de gestión"
        meta={
          tokens.isSuccess && vigentes.length > 0
            ? plural(vigentes.length, 'token vigente', 'tokens vigentes')
            : undefined
        }
        actions={
          <Button variant="perfil" onClick={abrirAlta}>
            Crear token
          </Button>
        }
        flush
      >
        <div className="regla-fila flex flex-col gap-2 px-4 py-3">
          <p className="max-w-[75ch] text-base text-tinta-2">
            Un token de gestión permite que Skyway, un script o un proceso de integración continua
            gestionen Mailway por API. Tiene los mismos permisos que el usuario que lo crea y se
            envía en la cabecera{' '}
            <code className="valor text-sm text-tinta">Authorization: Bearer mwt_…</code>.
          </p>
          <p className="max-w-[75ch] text-sm text-tinta-3">
            {isAdmin
              ? 'Para conectar Skyway se necesita un token creado por un administrador. Cambiar la contraseña no revoca los tokens: revócalos aquí si sospechas de un uso indebido.'
              : 'Tu token solo da acceso a los datos de tu cuenta. Para conectar Skyway se necesita un token de un administrador de la instancia.'}
          </p>
          {isAdmin && (
            <label className="mt-1 flex w-fit cursor-pointer items-center gap-2 text-sm text-tinta-2">
              <input
                type="checkbox"
                className="h-3.5 w-3.5"
                checked={verTodos}
                onChange={(e) => setVerTodos(e.target.checked)}
              />
              Mostrar los tokens de todos los usuarios
            </label>
          )}
        </div>

        {tokens.isPending ? (
          <Cargando label="Leyendo los tokens de gestión…" />
        ) : tokens.isError ? (
          <div className="px-4 py-4">
            <AvisoError onRetry={() => void tokens.refetch()} retrying={tokens.isFetching}>
              No se han podido leer los tokens de gestión.{' '}
              {tokens.error instanceof ApiError ? tokens.error.message : 'Comprueba la conexión con el servidor.'}
            </AvisoError>
          </div>
        ) : vigentes.length === 0 && revocados.length === 0 ? (
          <Vacio icono={Cable} title="No hay tokens de gestión">
            Crea un token con «Crear token» para conectar Skyway o automatizar tareas por API. El
            token completo se muestra una sola vez.
          </Vacio>
        ) : (
          <>
            {vigentes.length === 0 ? (
              <p className="px-4 py-3 text-base text-tinta-2">
                No hay tokens vigentes. Los revocados se conservan como referencia.
              </p>
            ) : (
              <>
                <div className="regla-cabecera hidden items-baseline gap-x-4 bg-hoja-3 px-4 py-1.5 sm:flex">
                  <span className="rotulo min-w-0 flex-1">Token</span>
                  <span className="rotulo shrink-0 basis-28">Creado</span>
                  <span className="rotulo shrink-0 basis-32">Último uso</span>
                  <span className="rotulo shrink-0 basis-28">Caducidad</span>
                  <span className="rotulo shrink-0 basis-32 text-right">Estado</span>
                  <span className="rotulo shrink-0 basis-20 text-right">Acción</span>
                </div>
                <ul>
                  {vigentes.map(({ token, veredicto, texto }) => (
                    <FilaToken
                      key={token.id}
                      token={token}
                      veredicto={veredicto}
                      estado={texto}
                      mostrarTitular={todos}
                      onRevocar={() => setARevocar(token)}
                    />
                  ))}
                </ul>
              </>
            )}

            {revocados.length > 0 && (
              <div className="border-t border-regla px-4 py-2.5">
                <Button variant="plano" onClick={() => setVerRevocados((v) => !v)} aria-expanded={verRevocados}>
                  {verRevocados
                    ? 'Ocultar los tokens revocados'
                    : `Mostrar los tokens revocados (${revocados.length})`}
                </Button>
              </div>
            )}
            {verRevocados && revocados.length > 0 && (
              <ul className="border-t border-regla">
                {revocados.map((token) => (
                  <FilaToken
                    key={token.id}
                    token={token}
                    veredicto="sin-dato"
                    estado="Revocado"
                    mostrarTitular={todos}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </Hoja>

      {/* Alta */}
      <Dialogo open={crearAbierto} onClose={() => setCrearAbierto(false)} title="Crear token de gestión">
        <form onSubmit={enviarAlta} noValidate className="flex flex-col gap-4">
          <Input
            label="Nombre"
            maxLength={60}
            value={nombre}
            onChange={(e) => {
              setErrorAlta('');
              setNombre(e.target.value);
              // Un token para Skyway caducado corta la integración de todos los
              // proyectos; el instalador lo crea sin caducidad y aquí se propone igual.
              if (!caducidadElegida) setCaducidad(esParaSkyway(e.target.value) ? 'nunca' : '365');
            }}
            placeholder="Skyway producción"
            help="Sirve para reconocerlo después. Se recomienda un token por integración o entorno."
          />
          <Select
            label="Caducidad"
            value={caducidad}
            onChange={(e) => {
              setCaducidadElegida(true);
              setCaducidad(e.target.value);
            }}
            help={
              caducidad === 'nunca' && esParaSkyway(nombre)
                ? 'Sin caducidad, como el que crea el instalador: la conexión con Skyway no se corta un día sin aviso. Revócalo aquí si deja de usarse.'
                : 'Al caducar, la integración deja de tener acceso hasta que se configure un token nuevo. Si se usa, Mailway avisa 14 días antes.'
            }
          >
            {CADUCIDADES.map((c) => (
              <option key={c.valor} value={c.valor}>
                {c.texto}
              </option>
            ))}
          </Select>
          <p className="text-sm text-tinta-3">
            {isAdmin
              ? 'El token tendrá permisos de administrador sobre toda la instancia. Guárdalo como cualquier otra contraseña.'
              : 'El token tendrá los mismos permisos que tu usuario, limitados a tu cuenta.'}
          </p>
          {errorAlta && <AvisoError>{errorAlta}</AvisoError>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="plano" onClick={() => setCrearAbierto(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="principal" busy={crear.isPending}>
              Crear token
            </Button>
          </div>
        </form>
      </Dialogo>

      {/* El token, una sola vez: no se cierra sin confirmar que se ha guardado. */}
      <Dialogo
        open={creado !== null}
        onClose={() => setCreado(null)}
        title="Token de gestión creado"
        confirmarCierre={{ pregunta: '¿Has guardado el token?', detalle: 'No se podrá volver a ver.' }}
        pie={
          <Button variant="principal" onClick={() => setCreado(null)}>
            Ya lo he guardado
          </Button>
        }
      >
        {creado && <TokenRecienCreado creado={creado} origen={origen} isAdmin={isAdmin} />}
      </Dialogo>

      {/* Revocar */}
      <Dialogo open={aRevocar !== null} onClose={() => setARevocar(null)} title="Revocar token">
        {aRevocar && (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2">
              El token <strong className="text-tinta">{aRevocar.name}</strong>
              {todos && aRevocar.ownerEmail ? (
                <>
                  {' '}
                  de <span className="valor text-sm text-tinta">{aRevocar.ownerEmail}</span>
                </>
              ) : null}{' '}
              dejará de funcionar de inmediato. Las integraciones que lo utilicen recibirán un error
              401 hasta que se configure un token nuevo.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="plano" onClick={() => setARevocar(null)}>
                Cancelar
              </Button>
              <Button variant="peligro" busy={revocar.isPending} onClick={() => revocar.mutate(aRevocar)}>
                Revocar
              </Button>
            </div>
          </div>
        )}
      </Dialogo>
    </>
  );
}

/* ------------------------------ Fila de la tabla -------------------------- */

function FilaToken({
  token,
  veredicto,
  estado,
  mostrarTitular,
  onRevocar,
}: {
  token: TokenGestion;
  veredicto: Veredicto;
  estado: string;
  mostrarTitular: boolean;
  onRevocar?: () => void;
}) {
  const tinte = veredicto === 'fuera' ? 'fila-fuera' : veredicto === 'vigilar' ? 'fila-vigilar' : '';
  return (
    <li
      className={`regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-1.5 px-4 py-3 last:border-b-0 ${tinte}`}
    >
      {/* El nombre identifica la fila: línea propia en móvil, nunca recortado. */}
      <div className="min-w-0 basis-full sm:basis-0 sm:grow">
        <p className="break-words text-base font-medium text-tinta">{token.name}</p>
        <p className="mt-0.5 break-all text-sm text-tinta-3">
          <span className="codigo text-tinta-2">{tokenEnmascarado(token.prefix)}</span>
          {mostrarTitular && (
            <>
              {' · '}
              <span className="valor">{token.ownerEmail}</span>
              {token.ownerClientName
                ? ` (${token.ownerClientName})`
                : token.ownerRole === 'admin'
                  ? ' (administración)'
                  : ''}
            </>
          )}
        </p>
      </div>
      <span className="shrink-0 text-sm text-tinta-2 sm:basis-28">
        <span className="rotulo mr-1.5 sm:hidden">Creado</span>
        <span className="valor">{formatDay(token.createdAt)}</span>
      </span>
      <span className="shrink-0 text-sm text-tinta-2 sm:basis-32">
        <span className="rotulo mr-1.5 sm:hidden">Último uso</span>
        {token.lastUsedAt ? (
          <span className="valor" title={token.lastUsedIp ? `Desde ${token.lastUsedIp}` : undefined}>
            {formatDate(token.lastUsedAt)}
          </span>
        ) : (
          <span className="text-tinta-3">Sin uso</span>
        )}
      </span>
      <span className="shrink-0 text-sm text-tinta-2 sm:basis-28">
        <span className="rotulo mr-1.5 sm:hidden">Caducidad</span>
        {token.expiresAt ? (
          <span className="valor">{formatDay(token.expiresAt)}</span>
        ) : (
          <span className="text-tinta-3">Sin caducidad</span>
        )}
      </span>
      <span className="shrink-0 sm:basis-32 sm:text-right">
        <MarcaFondo veredicto={veredicto}>{estado}</MarcaFondo>
      </span>
      <span className="ml-auto shrink-0 sm:ml-0 sm:basis-20 sm:text-right">
        {onRevocar && (
          <Button variant="plano" onClick={onRevocar}>
            Revocar
          </Button>
        )}
      </span>
    </li>
  );
}

/* --------------------------- Token recién creado -------------------------- */

function TokenRecienCreado({
  creado,
  origen,
  isAdmin,
}: {
  creado: TokenCreado;
  origen: string;
  isAdmin: boolean;
}) {
  const curl = `curl -H "Authorization: Bearer ${creado.token}" \\\n  ${origen}/api/integrations/info`;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-base text-tinta-2">
        Copia el token ahora y guárdalo en un gestor de secretos:{' '}
        <strong className="text-tinta">no se volverá a mostrar</strong>.
      </p>
      <Muestra rotulo={`Token «${creado.info.name}»`} copiar={creado.token}>
        <code className="valor block break-all text-sm text-tinta">{creado.token}</code>
      </Muestra>

      <div className="flex flex-col gap-2">
        <p className="rotulo">Para conectar Skyway</p>
        {isAdmin ? (
          <>
            <p className="text-sm text-tinta-2">
              En Skyway, abre «Ajustes» → «Correo (Mailway)» e introduce la URL del panel y este
              token.
            </p>
            <Muestra rotulo="URL del panel" copiar={origen}>
              <code className="valor block break-all text-sm text-tinta">{origen}</code>
            </Muestra>
          </>
        ) : (
          <p className="text-sm text-tinta-2">
            Skyway necesita un token de un administrador de la instancia. Este token sirve para
            automatizar la gestión de tu cuenta desde scripts o procesos propios.
          </p>
        )}
      </div>

      <Muestra rotulo="Comprobación desde la línea de comandos" copiar={curl}>
        <pre className="valor whitespace-pre-wrap break-all text-sm leading-relaxed text-tinta">{curl}</pre>
      </Muestra>
    </div>
  );
}
