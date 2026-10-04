import { useState, type FormEvent } from 'react';
import { Cloud } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Client } from '../../lib/api';
import {
  URL_CREAR_TOKEN,
  invalidarTrasCambioDeCuenta,
  type CuentaCloudflare,
  type PlanInstancia,
  type ResultadoAplicacion,
} from '../../lib/cloudflare';
import { formatDate, plural } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Input, Select } from '../../ui/Field';
import { Dialogo, Hoja, MarcaFondo, Cargando, Vacio } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { BandaAviso, BandaError, ResultadoCloudflare, claseEnlacePerfil } from '../cloudflare/comun';
import { RevisionCambios } from '../cloudflare/RevisionCambios';

/*
  Cuentas de Cloudflare conectadas. Con una cuenta, la ficha de cada dominio
  ofrece aplicar su DNS de correo con un clic, y el alta de dominios puede
  hacerlo sola. El token se pide una vez, se guarda cifrado y no se vuelve a
  mostrar: solo sus cuatro últimos caracteres, para reconocerlo.
*/

const ZONAS_VISIBLES = 8;

function mensaje(err: unknown, porDefecto: string): string {
  return err instanceof ApiError ? err.message : porDefecto;
}

export function HojaCloudflare({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [formulario, setFormulario] = useState(false);
  const [aBorrar, setABorrar] = useState<CuentaCloudflare | null>(null);

  const cuentas = useQuery({
    queryKey: ['cloudflare-accounts'],
    queryFn: () => api.get<{ accounts: CuentaCloudflare[] }>('/api/cloudflare/accounts'),
  });
  const clientes = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: Client[] }>('/api/clients'),
    enabled: isAdmin,
  });

  const comprobar = useMutation({
    mutationFn: () => api.get<{ accounts: CuentaCloudflare[] }>('/api/cloudflare/accounts?refresh=1'),
    onSuccess: (data) => {
      queryClient.setQueryData(['cloudflare-accounts'], data);
      const conError = data.accounts.filter((a) => a.lastError).length;
      if (conError > 0) {
        toast('error', `${plural(conError, 'cuenta con error', 'cuentas con error')}. Revisa el detalle en la lista.`);
      } else {
        toast('ok', 'Cuentas comprobadas.');
      }
    },
    onError: (err) => toast('error', mensaje(err, 'No se han podido comprobar las cuentas.')),
  });

  // El motor puede usar el token de una cuenta de la instancia para renovar
  // su certificado (lo copia el instalador o «Emitir» en Ajustes): entonces
  // el diálogo no debe recomendar revocarlo.
  const deInstancia = isAdmin && aBorrar !== null && aBorrar.clientId === null;
  const usoMotor = useQuery({
    queryKey: ['engine-acme-account', aBorrar?.id],
    queryFn: () => api.get<{ inUse: boolean | null }>(`/api/engine/acme/accounts/${aBorrar!.id}`),
    enabled: deInstancia,
    staleTime: 0,
  });
  // true/false: respuesta del servidor; null: no se pudo saber (error de la
  // petición o motor sin responder, que el servidor devuelve como inUse: null);
  // undefined: todavía comprobándolo.
  const usadaPorElMotor = !deInstancia
    ? false
    : usoMotor.isError
      ? null
      : usoMotor.data
        ? usoMotor.data.inUse
        : undefined;

  const borrar = useMutation({
    mutationFn: (id: string) => api.delete(`/api/cloudflare/accounts/${id}`),
    onSuccess: async () => {
      setABorrar(null);
      // Los dominios que la usaban pierden su asociación: sus fichas y sus
      // planes de Cloudflare también se vuelven a leer.
      await invalidarTrasCambioDeCuenta(queryClient);
      toast('ok', 'Cuenta de Cloudflare eliminada.');
    },
  });

  function pedirBorrado(cuenta: CuentaCloudflare) {
    // Un error de un intento anterior no debe aparecer al abrir otra vez.
    borrar.reset();
    setABorrar(cuenta);
  }

  const lista = cuentas.data?.accounts ?? [];
  const nombreCliente = new Map((clientes.data?.clients ?? []).map((c) => [c.id, c.name]));
  const mostrarFormulario = formulario || (cuentas.isSuccess && lista.length === 0);

  return (
    <>
      <Hoja
        title="Cloudflare"
        meta="DNS automático"
        actions={
          lista.length > 0 ? (
            <Button variant="plano" busy={comprobar.isPending} onClick={() => comprobar.mutate()}>
              Comprobar ahora
            </Button>
          ) : undefined
        }
        flush
      >
        {/* El filete va en el contenedor y la medida en el párrafo: juntos en el
            mismo elemento, la regla se cortaba a 80 caracteres. */}
        <div className="regla-fila px-4 py-3">
          <p className="max-w-[80ch] text-base text-tinta-2">
            Conecta una cuenta de Cloudflare para que Mailway cree y corrija los registros DNS de
            correo de {isAdmin ? 'los dominios' : 'tus dominios'} con un clic. Antes de aplicar se
            muestran todos los cambios, los registros de correo nunca se activan con el proxy de
            Cloudflare y lo que ya existe (otros proveedores, un SPF propio, un DMARC) no se modifica
            sin tu confirmación.
          </p>
        </div>

        {cuentas.isPending ? (
          <Cargando label="Consultando las cuentas de Cloudflare…" />
        ) : cuentas.isError ? (
          <div className="px-4 py-3">
            <BandaError onRetry={() => void cuentas.refetch()} retrying={cuentas.isFetching}>
              {mensaje(cuentas.error, 'No se han podido consultar las cuentas de Cloudflare.')}
            </BandaError>
          </div>
        ) : lista.length === 0 ? (
          <Vacio icono={Cloud} title="Todavía no hay ninguna cuenta conectada">
            Sigue los tres pasos siguientes: crear el token en Cloudflare, pegarlo aquí y conectar.
          </Vacio>
        ) : (
          <>
            <div className="regla-cabecera hidden items-baseline gap-x-4 bg-hoja-3 px-4 py-1.5 sm:flex">
              <span className="rotulo min-w-0 flex-1">Cuenta</span>
              {isAdmin && <span className="rotulo shrink-0 basis-40">Ámbito</span>}
              <span className="rotulo shrink-0 basis-16">Zonas</span>
              <span className="rotulo shrink-0 basis-28">Estado</span>
              <span className="shrink-0 basis-20" aria-hidden />
            </div>
            <ul>
              {lista.map((cuenta) => {
                const zonas = cuenta.zones ?? [];
                const total = cuenta.zonesTotal ?? zonas.length;
                const resto = total - Math.min(zonas.length, ZONAS_VISIBLES);
                return (
                  <li
                    key={cuenta.id}
                    className={`regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-1.5 px-4 py-2.5 last:border-b-0 ${
                      cuenta.lastError ? 'fila-fuera' : ''
                    }`}
                  >
                    <span className="min-w-0 basis-full sm:basis-0 sm:grow">
                      <span className="break-words text-base font-medium text-tinta">{cuenta.label}</span>
                      {cuenta.tokenHint && (
                        <span className="valor ml-2 whitespace-nowrap text-sm text-tinta-3">
                          token …{cuenta.tokenHint}
                        </span>
                      )}
                    </span>
                    {isAdmin && (
                      <span className="min-w-0 shrink-0 sm:basis-40">
                        <span className="rotulo mr-1.5 sm:hidden">Ámbito</span>
                        <span className="break-words text-sm text-tinta-2">
                          {cuenta.clientId ? nombreCliente.get(cuenta.clientId) ?? 'Cliente' : 'Toda la instancia'}
                        </span>
                      </span>
                    )}
                    <span className="shrink-0 sm:basis-16">
                      <span className="rotulo mr-1.5 sm:hidden">Zonas</span>
                      <span className="valor text-sm text-tinta-2">{cuenta.zones ? total : '—'}</span>
                    </span>
                    <span className="shrink-0 sm:basis-28">
                      <MarcaFondo veredicto={cuenta.lastError ? 'fuera' : cuenta.lastVerifiedAt ? 'normal' : 'sin-dato'}>
                        {cuenta.lastError ? 'Con error' : cuenta.lastVerifiedAt ? 'Verificada' : 'Sin verificar'}
                      </MarcaFondo>
                    </span>
                    <span className="ml-auto shrink-0 sm:ml-0 sm:basis-20 sm:text-right">
                      <Button variant="plano" onClick={() => pedirBorrado(cuenta)}>
                        Eliminar
                      </Button>
                    </span>
                    {zonas.length > 0 && (
                      <p className="basis-full break-words text-sm text-tinta-2">
                        <span className="rotulo mr-1.5">Zonas</span>
                        <span className="valor">{zonas.slice(0, ZONAS_VISIBLES).join(', ')}</span>
                        {resto > 0 && <span> y {resto} más</span>}
                      </p>
                    )}
                    {cuenta.lastError && (
                      <p className="basis-full text-sm text-fuera" role="alert">
                        {cuenta.lastError}
                      </p>
                    )}
                    <p className="basis-full text-sm text-tinta-3">
                      Conectada el {formatDate(cuenta.createdAt)} · última verificación{' '}
                      {formatDate(cuenta.lastVerifiedAt)}
                    </p>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {!cuentas.isPending && !cuentas.isError && (
          <div className="border-t border-regla px-4 py-4">
            {mostrarFormulario ? (
              <FormularioConexion
                isAdmin={isAdmin}
                clientes={clientes.data?.clients ?? []}
                onCancelar={lista.length > 0 ? () => setFormulario(false) : undefined}
                onConectada={() => setFormulario(false)}
              />
            ) : (
              <Button variant="perfil" onClick={() => setFormulario(true)}>
                Conectar otra cuenta
              </Button>
            )}
          </div>
        )}
      </Hoja>

      {isAdmin && <HojaDnsPlataforma hayInstancia={lista.some((c) => c.clientId === null)} />}

      <Dialogo open={aBorrar !== null} onClose={() => setABorrar(null)} title="Eliminar cuenta">
        <div className="flex flex-col gap-4">
          <p className="text-base text-tinta-2">
            Mailway dejará de usar la cuenta <strong className="text-tinta">{aBorrar?.label}</strong>.
            Los registros DNS ya creados en Cloudflare no se modifican.
            {usadaPorElMotor === false &&
              ' El token sigue existiendo en Cloudflare: si ya no lo necesitas, revócalo en Cloudflare (My Profile → API Tokens).'}
          </p>
          {deInstancia && usadaPorElMotor === undefined && <Cargando label="Comprobando si el servidor de correo usa este token…" />}
          {usadaPorElMotor === true && (
            <BandaAviso titulo="El servidor de correo usa este token">
              El motor lo usa para renovar el certificado de IMAP y SMTP (Let’s Encrypt). Eliminar la
              cuenta de Mailway no lo cambia, pero no revoques el token en Cloudflare: la siguiente
              renovación fallaría y, al caducar el certificado, los programas de correo dejarían de
              conectar. Para dejar de usarlo, emite antes el certificado con otra cuenta en Ajustes →
              Servidor de correo.
            </BandaAviso>
          )}
          {usadaPorElMotor === null && (
            <BandaAviso titulo="No se ha podido comprobar el servidor de correo">
              No se sabe si el motor usa este token para renovar su certificado. Antes de revocarlo en
              Cloudflare, compruébalo en Ajustes → Servidor de correo.
            </BandaAviso>
          )}
          {borrar.isError && <BandaError>{mensaje(borrar.error, 'No se ha podido eliminar la cuenta.')}</BandaError>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="plano" onClick={() => setABorrar(null)}>
              Cancelar
            </Button>
            <Button
              variant="peligro"
              busy={borrar.isPending}
              onClick={() => aBorrar && borrar.mutate(aBorrar.id)}
            >
              Eliminar
            </Button>
          </div>
        </div>
      </Dialogo>
    </>
  );
}

/** Conexión paso a paso: crear el token, pegarlo y conectar. */
function FormularioConexion({
  isAdmin,
  clientes,
  onCancelar,
  onConectada,
}: {
  isAdmin: boolean;
  clientes: Client[];
  onCancelar?: () => void;
  onConectada: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [token, setToken] = useState('');
  const [etiqueta, setEtiqueta] = useState('');
  const [ambito, setAmbito] = useState('');

  const conectar = useMutation({
    mutationFn: () =>
      api.post<{ account: CuentaCloudflare }>('/api/cloudflare/accounts', {
        token: token.trim(),
        ...(etiqueta.trim() ? { label: etiqueta.trim() } : {}),
        ...(isAdmin && ambito ? { clientId: ambito } : {}),
      }),
    onSuccess: async (data) => {
      // El token no se conserva en la página más de lo imprescindible.
      setToken('');
      setEtiqueta('');
      // Con una cuenta nueva, las fichas de los dominios pueden ofrecer ya la
      // configuración automática.
      await invalidarTrasCambioDeCuenta(queryClient);
      const zonas = data.account.zonesTotal ?? data.account.zones?.length ?? 0;
      toast('ok', `Cuenta conectada: ${zonas === 1 ? '1 zona disponible' : `${zonas} zonas disponibles`}.`);
      onConectada();
    },
  });

  function enviar(e: FormEvent) {
    e.preventDefault();
    conectar.mutate();
  }

  return (
    <form onSubmit={enviar} className="flex flex-col gap-5">
      <ol className="flex flex-col gap-5">
        <li className="flex flex-col gap-2">
          <p className="rotulo">Paso 1 · Crear el token en Cloudflare</p>
          <p className="max-w-[75ch] text-base text-tinta-2">
            El enlace abre Cloudflare con los dos permisos necesarios ya seleccionados: «Zone · Zone ·
            Read» y «Zone · DNS · Edit». En «Zone Resources», elige las zonas de{' '}
            {isAdmin ? 'los dominios' : 'tus dominios'} (o «All zones»), pulsa «Continue to summary»
            y, después, «Create Token».
          </p>
          <div>
            <a href={URL_CREAR_TOKEN} target="_blank" rel="noopener noreferrer" className={claseEnlacePerfil}>
              Crear el token en Cloudflare
            </a>
          </div>
        </li>
        <li className="flex flex-col gap-2">
          <p className="rotulo">Paso 2 · Pegar el token</p>
          <Input
            label="Token de API de Cloudflare"
            type="password"
            mono
            required
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            help="Cloudflare lo muestra una sola vez. Mailway lo guarda cifrado y no vuelve a mostrarlo."
          />
        </li>
        <li className="flex flex-col gap-2">
          <p className="rotulo">Paso 3 · Identificar la cuenta</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Nombre (opcional)"
              value={etiqueta}
              maxLength={80}
              onChange={(e) => setEtiqueta(e.target.value)}
              placeholder="Por defecto, el nombre de la cuenta de Cloudflare"
            />
            {isAdmin && (
              <Select
                label="Ámbito"
                value={ambito}
                onChange={(e) => setAmbito(e.target.value)}
                help={
                  ambito
                    ? 'El cliente podrá usarla para sus dominios.'
                    : 'Sirve para cualquier dominio cuya zona esté en esta cuenta de Cloudflare, siempre a petición del administrador.'
                }
              >
                <option value="">Toda la instancia</option>
                {clientes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </li>
      </ol>

      {conectar.isError && (
        <BandaError>{mensaje(conectar.error, 'No se ha podido conectar la cuenta.')}</BandaError>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {onCancelar && (
          <Button type="button" variant="plano" onClick={onCancelar}>
            Cancelar
          </Button>
        )}
        <Button type="submit" variant="principal" busy={conectar.isPending} disabled={token.trim().length < 20}>
          Conectar cuenta
        </Button>
      </div>
    </form>
  );
}

/**
 * DNS de la propia plataforma (solo administrador): el servidor de correo,
 * el webmail y el panel, más autoconfig/autodiscover del dominio base, que
 * permiten a Thunderbird configurar las cuentas de todos los clientes.
 */
function HojaDnsPlataforma({ hayInstancia }: { hayInstancia: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [abierto, setAbierto] = useState(false);
  const [abiertoEn, setAbiertoEn] = useState(0);
  const [reemplazar, setReemplazar] = useState(false);
  const [resultado, setResultado] = useState<ResultadoAplicacion | null>(null);

  const plan = useQuery({
    queryKey: ['cloudflare-instance-dns'],
    queryFn: () => api.get<PlanInstancia>('/api/cloudflare/instance-dns'),
    enabled: abierto,
    staleTime: 30_000,
  });

  const aplicar = useMutation({
    mutationFn: () =>
      api.post<ResultadoAplicacion & { missing: string[] }>('/api/cloudflare/instance-dns', {
        replaceConflicts: reemplazar,
      }),
    onSuccess: async (data) => {
      setResultado(data);
      setAbierto(false);
      setReemplazar(false);
      await queryClient.invalidateQueries({ queryKey: ['cloudflare-instance-dns'] });
      toast(
        data.errors.length > 0 ? 'error' : 'ok',
        data.errors.length > 0
          ? 'Parte de los registros no se ha podido aplicar. Revisa el detalle.'
          : 'DNS de la plataforma aplicado en Cloudflare.',
      );
    },
  });

  function abrir() {
    aplicar.reset();
    setReemplazar(false);
    setAbiertoEn(Date.now());
    setAbierto(true);
    void plan.refetch();
  }

  return (
    <>
      <Hoja
        title="DNS de la plataforma"
        meta="Servidor, webmail y panel"
        actions={
          <Button variant="perfil" disabled={!hayInstancia} onClick={abrir}>
            Revisar cambios
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="max-w-[80ch] text-base text-tinta-2">
            Se crean en Cloudflare los registros del propio servidor: el nombre del servidor de correo, el
            webmail y el panel apuntando a la IP pública (el servidor de correo, siempre sin proxy), y
            autoconfig y autodiscover del dominio base apuntando al servidor. Con estos dos últimos,
            Thunderbird configura automáticamente las cuentas de todos los clientes cuyo MX sea este
            servidor, sin registros adicionales en sus dominios.
          </p>
          {!hayInstancia && (
            <p className="text-sm text-tinta-3">
              Requiere una cuenta de Cloudflare conectada con el ámbito «Toda la instancia».
            </p>
          )}
          {resultado && <ResultadoCloudflare resultado={resultado} />}
        </div>
      </Hoja>

      <Dialogo open={abierto} onClose={() => setAbierto(false)} title="DNS de la plataforma">
        <RevisionCambios
          plan={plan.data}
          cargando={(!plan.data && !plan.isError) || (plan.isFetching && plan.dataUpdatedAt < abiertoEn)}
          error={plan.isError ? mensaje(plan.error, 'No se ha podido leer la zona en Cloudflare.') : null}
          reemplazar={reemplazar}
          onReemplazar={setReemplazar}
          aplicando={aplicar.isPending}
          errorAplicar={aplicar.isError ? mensaje(aplicar.error, 'No se ha podido aplicar en Cloudflare.') : null}
          onAplicar={() => aplicar.mutate()}
          onCancelar={() => setAbierto(false)}
        />
      </Dialogo>
    </>
  );
}
