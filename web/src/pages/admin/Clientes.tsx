import { useState, type FormEvent } from 'react';
import { Building2, SearchX } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Client, type DomainRecord, type Plan } from '../../lib/api';
import {
  avisoAltaDominio,
  cuentasUtilizables,
  type CuentaCloudflare,
  type EstadoAltaDominio,
  type RespuestaAltaDominio,
} from '../../lib/cloudflare';
import { plural } from '../../lib/format';
import { esCorreoValido, formatQuota, mensajeDe, vinculadoConSkyway } from '../../lib/gestion';
import { Button } from '../../ui/Button';
import { Input, Select } from '../../ui/Field';
import { Dialogo, Escala, Hoja, MarcaFondo, Membrete, Cargando, Muestra, Vacio } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { BandaAviso, BandaError, Botonera, Casilla, Opcion, rutaCliente } from '../../components/gestion/comun';
import { useDireccionPanel } from '../../components/gestion/consultas';
import { CamposBienvenida, EnlaceBienvenidaListo } from '../../components/EnlaceBienvenida';
import { VALIDEZ_POR_DEFECTO, type InvitacionCreada } from '../../lib/bienvenida';

/**
 * Cartera de clientes: una fila por cliente, con el uso de buzones medido
 * contra el límite de su plan y el veredicto de servicio en el margen. Cada
 * fila abre la ficha del cliente, donde se gestiona todo lo suyo.
 */
export default function Clientes() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: Client[] }>('/api/clients'),
  });

  const list = clients.data?.clients ?? [];
  const texto = q.trim().toLowerCase();
  const filtrados = texto
    ? list.filter(
        (c) =>
          c.name.toLowerCase().includes(texto) ||
          c.contactEmail.toLowerCase().includes(texto) ||
          (c.plan?.name.toLowerCase().includes(texto) ?? false),
      )
    : list;

  return (
    <>
      <Membrete
        title="Clientes"
        meta={
          <>
            <p>
              Cada cliente tiene su panel, su plan y su ficha, donde se gestionan sus dominios, buzones, alias y
              usuarios.
            </p>
            {clients.isSuccess && list.length > 0 && (
              <p className="mt-1 text-sm text-tinta-3">
                {plural(list.length, 'cliente', 'clientes')} ·{' '}
                <Link to="/planes" className="underline hover:text-tinta">
                  Gestionar planes
                </Link>
              </p>
            )}
          </>
        }
        actions={
          <Button variant="principal" onClick={() => setOpen(true)}>
            Alta de cliente
          </Button>
        }
      />

      {clients.isPending ? (
        <Hoja flush>
          <Cargando label="Cargando los clientes…" />
        </Hoja>
      ) : clients.isError ? (
        <BandaError onRetry={() => void clients.refetch()}>
          {mensajeDe(clients.error, 'No se han podido cargar los clientes.')}
        </BandaError>
      ) : list.length === 0 ? (
        <Hoja flush>
          <Vacio icono={Building2}
            title="Todavía no hay clientes"
            action={
              <Button variant="perfil" onClick={() => setOpen(true)}>
                Dar de alta el primero
              </Button>
            }
          >
            Un cliente es una empresa o un proyecto: se le asigna un plan y se le envía un enlace de bienvenida
            para que cree su acceso y ponga en marcha su correo.
          </Vacio>
        </Hoja>
      ) : (
        <Hoja flush>
          {list.length > 8 && (
            <div className="regla-fila px-4 py-3">
              <Input
                label="Buscar"
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Nombre, correo de contacto o plan"
              />
            </div>
          )}
          {/* Cabecera de columnas: en pantalla estrecha cada dato lleva su rótulo. */}
          <div className="regla-cabecera hidden items-baseline gap-x-4 px-4 py-2 sm:flex">
            <span className="rotulo min-w-0 grow basis-0">Cliente</span>
            <span className="rotulo w-24 shrink-0">Plan</span>
            <span className="rotulo w-44 shrink-0">Uso del plan</span>
            <span className="rotulo w-24 shrink-0 text-right">Envíos 30 d</span>
            <span className="rotulo w-28 shrink-0 text-right">Estado</span>
          </div>

          {filtrados.length === 0 && <Vacio icono={SearchX} title="Ningún cliente coincide con la búsqueda" />}
          {filtrados.map((client) => (
            <div
              key={client.id}
              className="regla-fila group relative flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3
                transition-colors duration-100 last:border-b-0 hover:bg-hoja-2"
            >
              {/* El nombre identifica la fila: línea propia en móvil, sin truncar.
                  Su enlace cubre la fila entera (no hay otros controles en ella):
                  se entra en la ficha pulsando en cualquier sitio. */}
              <div className="min-w-0 grow basis-full sm:basis-0">
                <Link
                  to={rutaCliente(client.id)}
                  className="break-words text-md font-medium text-tinta after:absolute after:inset-0 after:content-['']
                    hover:text-petroleo group-hover:text-petroleo group-hover:underline"
                >
                  {client.name}
                </Link>
                {client.contactEmail && (
                  <p className="valor break-all text-sm text-tinta-3">{client.contactEmail}</p>
                )}
                {vinculadoConSkyway(client.externalRef) && <p className="rotulo mt-0.5">Vinculado con Skyway</p>}
              </div>

              <div className="flex shrink-0 items-baseline gap-1.5 sm:w-24">
                <span className="rotulo sm:hidden">Plan</span>
                <span className="min-w-0 break-words text-sm text-tinta-2">{client.plan?.name ?? '—'}</span>
              </div>

              <div className="basis-full sm:w-44 sm:shrink-0 sm:basis-auto">
                {client.usage && client.plan ? (
                  <Escala label="Buzones" usado={client.usage.mailboxes} maximo={client.plan.maxMailboxes} />
                ) : (
                  <div className="flex items-baseline gap-1.5">
                    <span className="rotulo">Uso del plan</span>
                    <span className="valor text-sm text-tinta-3">—</span>
                  </div>
                )}
              </div>

              <div className="flex shrink-0 items-baseline gap-1.5 sm:w-24 sm:justify-end">
                <span className="rotulo sm:hidden">Envíos 30 d</span>
                <span className="valor text-sm text-tinta-2">{client.usage?.messagesLast30d ?? 0}</span>
              </div>

              <div className="shrink-0 sm:w-28 sm:text-right">
                {client.suspended ? (
                  <MarcaFondo veredicto="fuera">Suspendido</MarcaFondo>
                ) : (
                  <MarcaFondo veredicto="normal">Activo</MarcaFondo>
                )}
              </div>
            </div>
          ))}
        </Hoja>
      )}

      {open && <AltaCliente onClose={() => setOpen(false)} />}
    </>
  );
}

/* ---------------------------- Alta de cliente ---------------------------- */

interface Resultado {
  client: Client;
  user?: { id: string; email: string; name: string };
  password?: string;
  /** Enlace de bienvenida: el cliente ya existe aunque este paso falle. */
  invitacion?: { ok: true; invite: InvitacionCreada } | { ok: false; error: string };
  dominio?:
    | {
        ok: true;
        domain: DomainRecord;
        /** Lo que pasó con Cloudflare, para la ficha del dominio. */
        alta: EstadoAltaDominio;
        aviso: { tono: 'ok' | 'error'; texto: string };
      }
    | { ok: false; error: string };
}

/** Cómo recibe el cliente su primer acceso al panel. */
type ModoAcceso = 'bienvenida' | 'contrasena' | 'ninguno';

/**
 * Alta guiada: datos, plan, acceso al panel y, opcionalmente, el primer
 * dominio. El acceso recomendado es el enlace de bienvenida: la persona de
 * contacto elige su contraseña y hace la puesta en marcha guiada, sin que
 * nadie tenga que entregarle credenciales. Crear el usuario con una
 * contraseña generada (que se muestra una vez) sigue disponible. Al terminar
 * lleva a la ficha del cliente.
 */
function AltaCliente({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  const plans = useQuery({
    queryKey: ['plans'],
    queryFn: () => api.get<{ plans: Plan[] }>('/api/plans'),
  });
  const planList = plans.data?.plans ?? [];

  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [planId, setPlanId] = useState('');
  const [acceso, setAcceso] = useState<ModoAcceso>('bienvenida');
  const [validez, setValidez] = useState<string>(VALIDEZ_POR_DEFECTO);
  const [userName, setUserName] = useState('');
  // null = sin tocar: el correo del acceso sigue al de contacto mientras se
  // escribe, y se ve como valor (no como ejemplo gris que parece vacío).
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [dominio, setDominio] = useState('');
  const [autoDns, setAutoDns] = useState(true);
  const [error, setError] = useState('');
  const [resultado, setResultado] = useState<Resultado | null>(null);
  // El cliente recibirá esta dirección: la pública de la instancia, no la
  // IP o la URL interna por la que haya entrado el administrador.
  const panel = useDireccionPanel();

  // Un cliente recién creado aún no tiene cuentas de Cloudflare propias: el
  // DNS de su primer dominio solo lo puede configurar una cuenta de la
  // instancia, y solo porque quien da de alta es el administrador.
  const cuentas = useQuery({
    queryKey: ['cloudflare-accounts'],
    queryFn: () => api.get<{ accounts: CuentaCloudflare[] }>('/api/cloudflare/accounts'),
  });
  const deInstancia = cuentasUtilizables(cuentas.data?.accounts ?? [], { clientId: null, isAdmin: true });
  const hayCloudflare = deInstancia.length > 0;
  const conDns = hayCloudflare && autoDns && Boolean(dominio.trim());

  const plan = planList.find((p) => p.id === planId) ?? planList[0];
  // Por defecto, el acceso (enlace o usuario) es para la persona de contacto.
  const correoUsuario = userEmail ?? contactEmail;
  const conUsuario = acceso === 'contrasena';

  const alta = useMutation({
    mutationFn: async (): Promise<Resultado> => {
      const created = await api.post<{
        client: Client;
        user?: { id: string; email: string; name: string };
        password?: string;
      }>('/api/clients', {
        name,
        contactEmail,
        planId: plan?.id,
        user: conUsuario ? { name: userName || name, email: correoUsuario } : undefined,
      });
      const out: Resultado = { ...created };
      if (acceso === 'bienvenida') {
        // Como el dominio: si falla, el cliente ya existe y el enlace se puede
        // crear después desde su ficha; se explica en el resultado.
        try {
          const inv = await api.post<{ invite: InvitacionCreada }>(
            `/api/clients/${encodeURIComponent(created.client.id)}/invites`,
            { email: correoUsuario.trim(), name: (userName || '').trim() || undefined, ttlHours: Number(validez) },
          );
          out.invitacion = { ok: true, invite: inv.invite };
        } catch (err) {
          out.invitacion = { ok: false, error: mensajeDe(err, 'No se ha podido crear el enlace de bienvenida.') };
        }
      }
      if (dominio.trim()) {
        // El dominio se da de alta aparte: si falla, el cliente ya existe y
        // se explica en el resultado en lugar de perder todo lo anterior.
        try {
          const d = await api.post<RespuestaAltaDominio>('/api/domains', {
            domain: dominio.trim().toLowerCase(),
            clientId: created.client.id,
            ...(conDns ? { autoDns: true } : {}),
          });
          const alta: EstadoAltaDominio = {
            autoDns: conDns,
            cloudflare: d.cloudflare ?? null,
            ...(d.cloudflareReason ? { cloudflareReason: d.cloudflareReason } : {}),
          };
          out.dominio = { ok: true, domain: d.domain, alta, aviso: avisoAltaDominio(d, conDns) };
        } catch (err) {
          out.dominio = { ok: false, error: mensajeDe(err, 'No se ha podido añadir el dominio.') };
        }
      }
      return out;
    },
    onSuccess: async (data) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['clients'] }),
        queryClient.invalidateQueries({ queryKey: ['plans'] }),
        queryClient.invalidateQueries({ queryKey: ['domains'] }),
      ]);
      // Con el DNS automático pedido, su resultado acompaña al aviso; si
      // reclama atención (motivo, errores o conflictos), se muestra en el
      // resumen en lugar de en un aviso que desaparece.
      const dns = data.dominio?.ok && data.dominio.alta.autoDns ? data.dominio.aviso : null;
      // El enlace de bienvenida se enseña siempre: es lo siguiente que hay que enviar.
      if (!data.password && !data.invitacion && (!data.dominio || data.dominio.ok) && dns?.tono !== 'error') {
        toast('ok', dns ? `Cliente ${data.client.name} dado de alta. ${dns.texto}` : `Cliente ${data.client.name} dado de alta.`);
        navigate(rutaCliente(data.client.id));
        return;
      }
      setResultado(data);
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido dar de alta el cliente.')),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!plan) {
      setError('Es necesario crear antes un plan en «Planes».');
      return;
    }
    if (name.trim().length < 2) {
      setError('El nombre del cliente debe tener al menos 2 caracteres.');
      return;
    }
    if (contactEmail.trim() && !esCorreoValido(contactEmail)) {
      setError('El correo de contacto no es una dirección válida.');
      return;
    }
    if (conUsuario && !esCorreoValido(correoUsuario)) {
      setError('Indica el correo del usuario de acceso (o el correo de contacto).');
      return;
    }
    if (acceso === 'bienvenida' && !esCorreoValido(correoUsuario)) {
      setError('Indica el correo de la persona que recibirá el enlace de bienvenida (o el correo de contacto).');
      return;
    }
    setError('');
    alta.mutate();
  }

  function limpiar<T>(set: (v: T) => void) {
    return (v: T) => {
      setError('');
      set(v);
    };
  }

  if (resultado) {
    const conContrasena = Boolean(resultado.password && resultado.user);
    const conEnlace = resultado.invitacion?.ok === true;
    const irAFicha = () => navigate(rutaCliente(resultado.client.id));
    return (
      <Dialogo
        open
        onClose={irAFicha}
        title="Cliente dado de alta"
        confirmarCierre={
          conContrasena ? { pregunta: '¿Has guardado la contraseña?', detalle: 'No se podrá volver a ver.' } : null
        }
        pie={
          <>
            {/* Con una contraseña a la vista, la única salida es confirmar que
                se ha guardado; el DNS se configura después desde la ficha. */}
            {resultado.dominio?.ok && !conContrasena && (
              <Button
                variant="perfil"
                onClick={() => {
                  const alta = resultado.dominio as { domain: DomainRecord; alta: EstadoAltaDominio };
                  navigate(`/dominios/${alta.domain.id}`, { state: { alta: alta.alta } });
                }}
              >
                {resultado.dominio.alta.autoDns ? 'Revisar el DNS' : 'Configurar el DNS'}
              </Button>
            )}
            {/* Con el enlace a la vista, la acción principal es enviarlo (en el
                cuerpo); ir a la ficha pasa a secundaria. */}
            <Button variant={conEnlace ? 'perfil' : 'principal'} onClick={irAFicha}>
              {conContrasena ? 'Ya he guardado la contraseña' : 'Ir a la ficha del cliente'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-base text-tinta-2">
            Se ha dado de alta <strong className="font-semibold text-tinta">{resultado.client.name}</strong> con
            el plan «{resultado.client.plan?.name ?? plan?.name}».
          </p>
          {resultado.invitacion &&
            (resultado.invitacion.ok ? (
              <EnlaceBienvenidaListo invitacion={resultado.invitacion.invite} clientName={resultado.client.name} />
            ) : (
              <BandaError>
                El cliente se ha creado, pero no se ha podido crear el enlace de bienvenida: {resultado.invitacion.error}{' '}
                Puedes crearlo después desde la pestaña «Usuarios» de su ficha.
              </BandaError>
            ))}
          {resultado.password && resultado.user && (
            <>
              <BandaAviso>
                La contraseña del usuario <strong className="font-semibold">solo se muestra ahora</strong>.
                Entrégala por un canal seguro; podrá cambiarla desde «Mi cuenta».
              </BandaAviso>
              <Muestra rotulo="Dirección del panel" copiar={panel}>
                <p className="valor break-all text-base text-tinta">{panel}</p>
              </Muestra>
              <Muestra rotulo="Usuario" copiar={resultado.user.email}>
                <p className="valor break-all text-base text-tinta">{resultado.user.email}</p>
              </Muestra>
              <Muestra rotulo="Contraseña" copiar={resultado.password}>
                <p className="codigo break-all text-base text-tinta">{resultado.password}</p>
              </Muestra>
            </>
          )}
          {resultado.dominio &&
            (resultado.dominio.ok ? (
              !resultado.dominio.alta.autoDns ? (
                <p className="text-base text-tinta-2">
                  Dominio <span className="valor">{resultado.dominio.domain.domain}</span> añadido. Configura su DNS
                  desde la ficha del dominio.
                </p>
              ) : resultado.dominio.aviso.tono === 'error' ? (
                <BandaAviso>
                  <span className="valor">{resultado.dominio.domain.domain}</span>: {resultado.dominio.aviso.texto}
                </BandaAviso>
              ) : (
                <p className="text-base text-tinta-2">
                  <span className="valor">{resultado.dominio.domain.domain}</span>: {resultado.dominio.aviso.texto}
                </p>
              )
            ) : (
              <BandaError>
                El cliente se ha creado, pero no se ha podido añadir el dominio: {resultado.dominio.error} Puedes
                añadirlo después desde la pestaña «Dominios» de su ficha.
              </BandaError>
            ))}
        </div>
      </Dialogo>
    );
  }

  return (
    <Dialogo open onClose={onClose} title="Alta de cliente">
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <section className="flex flex-col gap-3">
          <p className="rotulo">1 · Datos del cliente</p>
          <Input
            label="Nombre"
            maxLength={80}
            value={name}
            onChange={(e) => limpiar(setName)(e.target.value)}
            placeholder="Empresa o proyecto"
          />
          <Input
            label="Correo de contacto (opcional)"
            type="email"
            value={contactEmail}
            onChange={(e) => limpiar(setContactEmail)(e.target.value)}
            placeholder="gerencia@empresa.com"
          />
        </section>

        <section className="flex flex-col gap-3">
          <p className="rotulo">2 · Plan</p>
          {plans.isError ? (
            <BandaError onRetry={() => void plans.refetch()}>No se han podido cargar los planes.</BandaError>
          ) : (
            <Select
              label="Plan"
              value={plan?.id ?? ''}
              onChange={(e) => limpiar(setPlanId)(e.target.value)}
              help={
                plan
                  ? `${plural(plan.maxDomains, 'dominio', 'dominios')} · ${plural(plan.maxMailboxes, 'buzón', 'buzones')} de ${formatQuota(plan.mailboxQuotaMb)} · ${plan.maxAliases} alias · ${plan.apiDailyLimit === 0 ? 'envíos por API sin límite diario' : plural(plan.apiDailyLimit, 'envío por API al día', 'envíos por API al día')}`
                  : plans.isPending
                    ? 'Cargando planes…'
                    : undefined
              }
            >
              {planList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <p className="rotulo">3 · Acceso al panel</p>
          <fieldset className="flex flex-col gap-2.5">
            <legend className="sr-only">Cómo recibe el cliente su acceso</legend>
            <Opcion
              name="alta-acceso"
              checked={acceso === 'bienvenida'}
              onChange={() => limpiar(setAcceso)('bienvenida')}
              label="Enviar un enlace de bienvenida al contacto"
              help="Recomendado. Crea su propio acceso con la contraseña que elija y pone en marcha el correo paso a paso."
            />
            <Opcion
              name="alta-acceso"
              checked={acceso === 'contrasena'}
              onChange={() => limpiar(setAcceso)('contrasena')}
              label="Crear el usuario con una contraseña generada"
              help="Se muestra una sola vez y tendrás que entregarla tú por un canal seguro."
            />
            <Opcion
              name="alta-acceso"
              checked={acceso === 'ninguno'}
              onChange={() => limpiar(setAcceso)('ninguno')}
              label="Ahora no"
              help="Podrás enviarle el enlace más tarde desde su ficha."
            />
          </fieldset>
          {acceso === 'bienvenida' && (
            <CamposBienvenida
              email={correoUsuario}
              name={userName}
              validez={validez}
              onEmail={limpiar(setUserEmail)}
              onName={limpiar(setUserName)}
              onValidez={setValidez}
            />
          )}
          {conUsuario && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Nombre del usuario"
                maxLength={80}
                value={userName}
                onChange={(e) => limpiar(setUserName)(e.target.value)}
                placeholder={name || 'Nombre y apellidos'}
              />
              <Input
                label="Correo (será su usuario)"
                type="email"
                value={correoUsuario}
                onChange={(e) => limpiar(setUserEmail)(e.target.value)}
                placeholder="persona@empresa.com"
              />
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <p className="rotulo">4 · Primer dominio (opcional)</p>
          <Input
            label="Dominio de correo"
            mono
            autoComplete="off"
            value={dominio}
            onChange={(e) => limpiar(setDominio)(e.target.value)}
            placeholder="empresa.com"
            help="Después se indicarán los registros DNS que hay que configurar."
          />
          {hayCloudflare && dominio.trim() && (
            <Casilla
              checked={autoDns}
              onChange={setAutoDns}
              label="Configurar el DNS automáticamente en Cloudflare"
              help={`La zona del dominio debe estar en una cuenta de Cloudflare de la instancia (${deInstancia
                .map((c) => c.label)
                .join(', ')}). Solo se crean los registros que faltan: lo que ya existe (también un SPF que habría que completar) no se modifica y podrás revisarlo y aplicarlo en la ficha del dominio.`}
            />
          )}
        </section>

        {error && <BandaError>{error}</BandaError>}
        <Botonera>
          <Button type="button" variant="plano" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="principal" busy={alta.isPending} disabled={!plan}>
            {conDns ? 'Dar de alta y configurar' : 'Dar de alta'}
          </Button>
        </Botonera>
      </form>
    </Dialogo>
  );
}
