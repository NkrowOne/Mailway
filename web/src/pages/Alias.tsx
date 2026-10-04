import { useMemo, useState, type FormEvent } from 'react';
import { Forward, Globe, SearchX } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Alias as AliasType, type DomainRecord, type Mailbox } from '../lib/api';
import { plural } from '../lib/format';
import { errorNombreBuzon, esCorreoValido, mensajeDe } from '../lib/gestion';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import { Dialogo, Hoja, Membrete, Cargando, Vacio } from '../ui/kit';
import { useToast } from '../ui/toast';
import {
  BandaAviso,
  BandaError,
  Botonera,
  Casilla,
  dominioInicialDisponible,
  SelectorDominio,
  type MotivoBloqueoDominio,
} from '../components/gestion/comun';
import { useClientes, useUsuario, type FichaCliente } from '../components/gestion/consultas';
import { esPropiedadPendiente } from '../lib/dominios';

const MAX_DESTINOS = 20;

type Editor = { modo: 'crear' } | { modo: 'editar'; alias: AliasType };

/**
 * Alias: direcciones que solo reciben correo y lo reenvían a buzones del
 * mismo cliente o a direcciones externas. Tabla reglada con la dirección, a
 * quién reenvía y, para el administrador, de qué cliente es.
 */
export default function Alias() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const user = useUsuario();
  const isAdmin = user?.role === 'admin';
  const { clientes } = useClientes(user);
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const filtroCliente = isAdmin ? (params.get('cliente') ?? '') : '';
  const [editor, setEditor] = useState<Editor | null>(null);
  const [toDelete, setToDelete] = useState<AliasType | null>(null);

  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ domains: DomainRecord[] }>('/api/domains'),
  });
  const aliases = useQuery({
    queryKey: ['aliases'],
    queryFn: () => api.get<{ aliases: AliasType[] }>('/api/aliases'),
  });
  const mailboxes = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => api.get<{ mailboxes: Mailbox[] }>('/api/mailboxes'),
  });

  const remove = useMutation({
    mutationFn: (alias: AliasType) => api.delete(`/api/aliases/${alias.id}`),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['aliases'] }),
        queryClient.invalidateQueries({ queryKey: ['client-dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['clients'] }),
        queryClient.invalidateQueries({ queryKey: ['client'] }),
      ]);
      setToDelete(null);
      toast('ok', 'Alias eliminado.');
    },
    onError: (err) => toast('error', mensajeDe(err, 'No se ha podido eliminar el alias.')),
  });

  function setFiltro(clave: 'q' | 'cliente', valor: string) {
    const next = new URLSearchParams(params);
    if (valor) next.set(clave, valor);
    else next.delete(clave);
    setParams(next, { replace: true });
  }

  const domainList = useMemo(() => domains.data?.domains ?? [], [domains.data]);
  const all = useMemo(() => aliases.data?.aliases ?? [], [aliases.data]);
  const filtrados = useMemo(() => {
    const texto = q.trim().toLowerCase();
    return all.filter(
      (a) =>
        (!filtroCliente || a.clientId === filtroCliente) &&
        (!texto || a.email.includes(texto) || a.destinations.some((d) => d.includes(texto))),
    );
  }, [all, q, filtroCliente]);

  const clientePropio = !isAdmin ? [...clientes.values()][0] : undefined;
  const limiteAlcanzado = clientePropio ? clientePropio.usage.aliases >= clientePropio.plan.maxAliases : false;
  const cargando = aliases.isPending || domains.isPending;
  const error = aliases.error ?? domains.error;

  return (
    <>
      <Membrete
        title="Alias"
        meta={
          <>
            <p>
              Direcciones que reciben correo y lo reenvían a buzones de la plataforma o a direcciones externas.
              Los alias solo reciben: para enviar se utiliza un buzón.
            </p>
            {!cargando && (clientePropio || all.length > 0) && (
              <p className="mt-1 text-sm text-tinta-3">
                {clientePropio
                  ? `${clientePropio.usage.aliases} de ${clientePropio.plan.maxAliases} alias del plan`
                  : plural(all.length, 'alias', 'alias')}
              </p>
            )}
          </>
        }
        actions={
          <Button
            variant="principal"
            disabled={domainList.length === 0 || limiteAlcanzado || clientePropio?.suspended}
            onClick={() => setEditor({ modo: 'crear' })}
          >
            Crear alias
          </Button>
        }
      />

      {limiteAlcanzado && (
        <div className="mb-4">
          <BandaAviso>
            Se ha alcanzado el máximo de alias del plan ({clientePropio!.plan.maxAliases}). Para crear más,
            elimina alguno o solicita una ampliación del plan.
          </BandaAviso>
        </div>
      )}

      {cargando ? (
        <Hoja flush>
          <Cargando label="Cargando los alias…" />
        </Hoja>
      ) : error ? (
        <BandaError
          onRetry={() => {
            void aliases.refetch();
            void domains.refetch();
          }}
        >
          {mensajeDe(error, 'No se han podido cargar los alias.')} Comprueba la conexión y vuelve a intentarlo.
        </BandaError>
      ) : domainList.length === 0 ? (
        <Hoja flush>
          <Vacio icono={Globe}
            title="Primero se necesita un dominio"
            action={
              <Link to="/dominios" className="text-sm text-petroleo underline">
                Ir a Dominios
              </Link>
            }
          >
            Los alias son direcciones de tus dominios, como ventas@tudominio.com.
          </Vacio>
        </Hoja>
      ) : all.length === 0 ? (
        <Hoja flush>
          <Vacio icono={Forward}
            title="Todavía no hay alias"
            action={
              !limiteAlcanzado && (
                <Button variant="perfil" onClick={() => setEditor({ modo: 'crear' })}>
                  Crear el primero
                </Button>
              )
            }
          >
            Un alias como ventas@{domainList[0]?.domain} puede reenviar a varios buzones a la vez, o a una
            dirección externa, sin ocupar plaza de buzón.
          </Vacio>
        </Hoja>
      ) : (
        <Hoja title="Registro de alias" meta={filtrados.length !== all.length ? `${filtrados.length} de ${all.length}` : undefined} flush>
          <div className="regla-fila grid gap-3 px-4 py-3 sm:grid-cols-2">
            <Input
              label="Buscar"
              type="search"
              value={q}
              onChange={(e) => setFiltro('q', e.target.value)}
              placeholder="Alias o destino"
            />
            {isAdmin && (
              <Select label="Cliente" value={filtroCliente} onChange={(e) => setFiltro('cliente', e.target.value)}>
                <option value="">Todos los clientes</option>
                {[...clientes.values()]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </Select>
            )}
          </div>

          {filtrados.length === 0 ? (
            <Vacio icono={SearchX}
              title="Ningún alias coincide con la búsqueda"
              action={
                <Button variant="perfil" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                  Quitar filtros
                </Button>
              }
            />
          ) : (
            <>
              <div className="regla-cabecera hidden items-baseline gap-x-4 px-4 py-2 lg:flex">
                <span className="rotulo min-w-0 grow basis-0">Alias</span>
                {isAdmin && <span className="rotulo w-32 shrink-0">Cliente</span>}
                <span className="rotulo min-w-0 grow-[1.4] basis-0">Reenvía a</span>
                <span className="rotulo w-40 shrink-0 text-right">Acciones</span>
              </div>

              {filtrados.map((alias) => {
                const externos = new Set(alias.externalDestinations ?? []);
                return (
                  <div
                    key={alias.id}
                    className="regla-fila flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-2.5
                      transition-colors duration-100 last:border-b-0 hover:bg-hoja-2"
                  >
                    {/* La dirección identifica la fila: línea propia en móvil, sin truncar. */}
                    <p className="valor min-w-0 grow basis-full break-all text-base text-tinta lg:basis-0">
                      {alias.email}
                    </p>

                    {isAdmin && (
                      <div className="flex min-w-0 shrink-0 items-baseline gap-1.5 lg:w-32">
                        <span className="rotulo lg:hidden">Cliente</span>
                        {alias.clientId ? (
                          <Link
                            to={`/clientes/${alias.clientId}`}
                            className="min-w-0 break-words text-sm text-tinta-2 hover:text-petroleo hover:underline"
                          >
                            {alias.clientName}
                          </Link>
                        ) : (
                          <span className="text-sm text-tinta-3">—</span>
                        )}
                      </div>
                    )}

                    <div className="min-w-0 grow-[1.4] basis-full lg:basis-0">
                      <span className="rotulo lg:hidden">Reenvía a</span>
                      <ul>
                        {alias.destinations.map((destination) => (
                          <li key={destination} className="flex flex-wrap items-baseline gap-x-2">
                            <span className="valor break-all text-sm text-tinta-2">{destination}</span>
                            {externos.has(destination) && <span className="rotulo">externa</span>}
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="flex w-full justify-end gap-1 lg:w-40">
                      <Button variant="perfil" className="px-2" onClick={() => setEditor({ modo: 'editar', alias })}>
                        Editar
                      </Button>
                      <Button variant="peligro" className="px-2" onClick={() => setToDelete(alias)}>
                        Eliminar
                      </Button>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </Hoja>
      )}

      {editor && (
        <FormularioAlias
          key={editor.modo === 'editar' ? editor.alias.id : 'nuevo'}
          editor={editor}
          domains={filtroCliente ? domainList.filter((d) => d.clientId === filtroCliente) : domainList}
          todosLosDominios={domainList}
          mailboxes={mailboxes.data?.mailboxes ?? []}
          mailboxesError={mailboxes.isError}
          etiquetaDominio={(d) => {
            const cliente = isAdmin ? clientes.get(d.clientId)?.name : undefined;
            return cliente ? `${d.domain} · ${cliente}` : d.domain;
          }}
          motivoBloqueo={(d) => bloqueoAlias(clientes.get(d.clientId))}
          onClose={() => setEditor(null)}
        />
      )}

      <Dialogo open={toDelete !== null} onClose={() => setToDelete(null)} title="Eliminar alias">
        {toDelete && (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2">
              El alias <strong className="valor break-all font-medium text-tinta">{toDelete.email}</strong>{' '}
              dejará de recibir correo. Los buzones de destino y su correo no se modifican.
            </p>
            <Botonera>
              <Button variant="plano" onClick={() => setToDelete(null)}>
                Cancelar
              </Button>
              <Button variant="peligro" busy={remove.isPending} onClick={() => remove.mutate(toDelete)}>
                Eliminar alias
              </Button>
            </Botonera>
          </div>
        )}
      </Dialogo>
    </>
  );
}

/** Motivo por el que un cliente no admite alias nuevos, o null. */
function bloqueoAlias(cliente: FichaCliente | undefined): string | null {
  if (!cliente) return null;
  if (cliente.suspended) return 'Cliente suspendido';
  if (cliente.usage.aliases >= cliente.plan.maxAliases) return 'Límite de alias del plan alcanzado';
  return null;
}

/* -------------------------- Crear / editar alias -------------------------- */

function FormularioAlias({
  editor,
  domains,
  todosLosDominios,
  mailboxes,
  mailboxesError,
  etiquetaDominio,
  motivoBloqueo,
  onClose,
}: {
  editor: Editor;
  domains: DomainRecord[];
  /** Todos los dominios visibles (también de otros clientes), para reconocer destinos internos. */
  todosLosDominios: DomainRecord[];
  mailboxes: Mailbox[];
  mailboxesError: boolean;
  etiquetaDominio: (d: DomainRecord) => string;
  motivoBloqueo: MotivoBloqueoDominio;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const editando = editor.modo === 'editar' ? editor.alias : null;
  const [domainId, setDomainId] = useState(
    () => editando?.domainId ?? dominioInicialDisponible(domains, undefined, motivoBloqueo),
  );
  const [localPart, setLocalPart] = useState('');
  const [error, setError] = useState('');
  const [buscar, setBuscar] = useState('');

  // La clasificación interna/externa la da el servidor; así no depende de que
  // la lista de buzones ya se haya cargado al abrir el diálogo.
  const [internos, setInternos] = useState<Set<string>>(() => {
    const ext = new Set(editando?.externalDestinations ?? []);
    return new Set((editando?.destinations ?? []).filter((d) => !ext.has(d)));
  });
  const [externos, setExternos] = useState<string[]>(() => editando?.externalDestinations ?? []);

  const dominio = domains.find((d) => d.id === domainId);
  const clientId = editando?.clientId ?? dominio?.clientId;
  // Solo buzones del mismo cliente: el servidor rechaza los de otros.
  const candidatos = mailboxes.filter((m) => !clientId || m.clientId === clientId);
  const texto = buscar.trim().toLowerCase();
  const visibles = texto
    ? candidatos.filter((m) => m.email.includes(texto) || m.displayName.toLowerCase().includes(texto))
    : candidatos;
  const email = editando ? editando.email : `${localPart.trim().toLowerCase()}@${dominio?.domain ?? ''}`;
  // Un dominio sin la propiedad comprobada no es de la plataforma todavía (ni
  // existe en el motor): sus direcciones son externas, como en el servidor.
  const dominiosInstancia = new Set(
    todosLosDominios.filter((d) => d.ownershipVerifiedAt !== null).map((d) => d.domain.toLowerCase()),
  );
  const correosCandidatos = new Set(candidatos.map((m) => m.email.toLowerCase()));
  // Stalwart expande el alias al recibir y cada destino hereda el origen del
  // mensaje: lo que llega de Internet a un alias de un dominio que recibe aquí
  // se entrega en el buzón local aunque el dominio del destino reciba todavía
  // en otro proveedor (lo enviado desde este servidor, en cambio, sale por su
  // MX). Se avisa para que el reparto no sorprenda.
  const recibenFuera = new Set(todosLosDominios.filter((d) => d.recepcionExterna).map((d) => d.domain.toLowerCase()));
  const dominioDelAlias = (editando?.domain ?? dominio?.domain ?? '').toLowerCase();
  const destinosConRecepcionExterna = recibenFuera.has(dominioDelAlias)
    ? []
    : [...internos].filter((correo) => recibenFuera.has(correo.split('@')[1] ?? ''));

  const save = useMutation({
    mutationFn: () => {
      const destinations = [...internos, ...externos.map((e) => e.trim().toLowerCase()).filter(Boolean)];
      return editando
        ? api.patch(`/api/aliases/${editando.id}`, { destinations })
        : api.post('/api/aliases', { domainId, localPart, destinations });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['aliases'] }),
        queryClient.invalidateQueries({ queryKey: ['client-dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['clients'] }),
        queryClient.invalidateQueries({ queryKey: ['client'] }),
      ]);
      toast('ok', editando ? `Alias ${editando.email} actualizado.` : `Alias ${email} creado.`);
      onClose();
    },
    onError: (err) => {
      if (esPropiedadPendiente(err)) void queryClient.invalidateQueries({ queryKey: ['domains'] });
      setError(mensajeDe(err, 'No se ha podido guardar el alias.'));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!editando) {
      if (!domainId) {
        setError('Selecciona un dominio que admita alias.');
        return;
      }
      const errorNombre = errorNombreBuzon(localPart.trim().toLowerCase());
      if (errorNombre) {
        setError(`Nombre del alias: ${errorNombre}`);
        return;
      }
    }
    const limpios = externos.map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (internos.size + limpios.length === 0) {
      setError('Selecciona al menos un buzón o añade una dirección externa.');
      return;
    }
    if (internos.size + limpios.length > MAX_DESTINOS) {
      setError(`Un alias admite como máximo ${MAX_DESTINOS} destinos.`);
      return;
    }
    const invalida = limpios.find((x) => !esCorreoValido(x));
    if (invalida) {
      setError(`${invalida} no es una dirección de correo válida.`);
      return;
    }
    const propia = limpios.find((x) => dominiosInstancia.has(x.split('@')[1] ?? ''));
    if (propia) {
      // Solo se puede indicar «selecciónala en la lista» si está en la lista:
      // un buzón de otro cliente no se ofrece y el servidor lo rechazaría.
      setError(
        correosCandidatos.has(propia)
          ? `${propia} es de un dominio de esta plataforma: selecciónala en la lista de buzones.`
          : `${propia} pertenece a otro cliente de esta plataforma y no puede usarse como destino.`,
      );
      return;
    }
    setError('');
    save.mutate();
  }

  function alternar(correo: string, marcado: boolean) {
    setError('');
    setInternos((prev) => {
      const next = new Set(prev);
      if (marcado) next.add(correo);
      else next.delete(correo);
      return next;
    });
  }

  return (
    <Dialogo open onClose={onClose} title={editando ? 'Editar alias' : 'Crear alias'}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {editando ? (
          <p className="valor break-all text-base text-tinta">{editando.email}</p>
        ) : (
          <>
            <SelectorDominio
              domains={domains}
              value={domainId}
              onChange={(id) => {
                setError('');
                setDomainId(id);
                // Los buzones elegidos son del cliente del dominio anterior.
                setInternos(new Set());
              }}
              etiquetaDominio={etiquetaDominio}
              motivoBloqueo={motivoBloqueo}
              uso="alias"
            />
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[10rem] flex-1">
                <Input
                  label="Nombre del alias"
                  mono
                  autoComplete="off"
                  value={localPart}
                  onChange={(e) => {
                    setError('');
                    setLocalPart(e.target.value);
                  }}
                  placeholder="ventas"
                />
              </div>
              <span className="valor break-all pb-2.5 text-sm text-tinta-3">@{dominio?.domain || '…'}</span>
            </div>
          </>
        )}

        <fieldset className="flex flex-col gap-2">
          <legend className="rotulo mb-1">Buzones de destino</legend>
          {mailboxesError ? (
            <BandaError>No se han podido cargar los buzones. Cierra el diálogo y vuelve a intentarlo.</BandaError>
          ) : candidatos.length === 0 ? (
            <p className="text-sm text-tinta-3">
              Este cliente aún no tiene buzones. Puedes reenviar a una dirección externa o crear antes un buzón.
            </p>
          ) : (
            <>
              {candidatos.length > 8 && (
                <Input label="Filtrar buzones" type="search" value={buscar} onChange={(e) => setBuscar(e.target.value)} />
              )}
              <div className="flex max-h-56 flex-col gap-2 overflow-y-auto border border-regla p-3">
                {visibles.map((m) => (
                  <Casilla
                    key={m.id}
                    checked={internos.has(m.email.toLowerCase())}
                    onChange={(v) => alternar(m.email.toLowerCase(), v)}
                    label={<span className="valor break-all text-sm">{m.email}</span>}
                    help={m.displayName || undefined}
                  />
                ))}
                {visibles.length === 0 && <p className="text-sm text-tinta-3">Ningún buzón coincide.</p>}
              </div>
            </>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="rotulo mb-1">Direcciones externas</legend>
          <p className="text-sm text-tinta-3">
            Reenvío a una dirección externa: el correo que llegue al alias se reenviará también a esa dirección
            (por ejemplo, una cuenta de otro proveedor). Algunos proveedores pueden clasificar como no deseado
            el correo reenviado.
          </p>
          {externos.map((valor, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <div className="min-w-[12rem] flex-1">
                <Input
                  label={`Dirección externa ${i + 1}`}
                  type="email"
                  mono
                  value={valor}
                  onChange={(e) => {
                    setError('');
                    setExternos(externos.map((x, j) => (j === i ? e.target.value : x)));
                  }}
                  placeholder="nombre@proveedor.com"
                />
              </div>
              <Button
                type="button"
                variant="plano"
                aria-label={`Quitar la dirección externa ${i + 1}`}
                onClick={() => {
                  setError('');
                  setExternos(externos.filter((_, j) => j !== i));
                }}
              >
                Quitar
              </Button>
            </div>
          ))}
          {internos.size + externos.length < MAX_DESTINOS && (
            <Button type="button" variant="plano" className="self-start px-2" onClick={() => setExternos([...externos, ''])}>
              Añadir dirección externa
            </Button>
          )}
        </fieldset>

        {destinosConRecepcionExterna.length > 0 && (
          <BandaAviso>
            El correo de{' '}
            <span className="valor break-all">
              {[...new Set(destinosConRecepcionExterna.map((c) => c.split('@')[1]))].join(', ')}
            </span>{' '}
            se recibe hoy en otro proveedor. Lo que llegue de Internet a este alias se entregará en{' '}
            {destinosConRecepcionExterna.length === 1 ? 'el buzón' : 'los buzones'} de aquí (
            <span className="valor break-all">{destinosConRecepcionExterna.join(', ')}</span>), no en ese
            proveedor, hasta que se haga el cambio del MX. Lo que se envíe al alias desde este servidor sí
            llega al proveedor actual.
          </BandaAviso>
        )}
        {error && <BandaError>{error}</BandaError>}
        <Botonera>
          <Button type="button" variant="plano" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="principal" busy={save.isPending} disabled={!editando && !domainId}>
            {editando ? 'Guardar cambios' : 'Crear alias'}
          </Button>
        </Botonera>
      </form>
    </Dialogo>
  );
}
