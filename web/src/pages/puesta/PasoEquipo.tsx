import { forwardRef, useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { CircleDashed, ClipboardPaste, Globe, Plus, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ConEnlace, type Mailbox } from '../../lib/api';
import { propiedadPendiente, type DominioCorreo } from '../../lib/cloudflare';
import { plural } from '../../lib/format';
import { mensajeDe, type BulkEntryResult, type BulkPreview, type BulkResponse } from '../../lib/gestion';
import {
  BotonCopiarTexto,
  FilaEnlace,
  NotaEnlaces,
  textoEnlaces,
} from '../../components/EnlacesEquipo';
import { Button } from '../../ui/Button';
import { Textarea } from '../../ui/Field';
import { AvisoError, Escala, Hoja, Vacio } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import {
  clave,
  direccionesRepetidas,
  enlaceConContrasenaNueva,
  errorFila,
  FORMATOS,
  filaNueva,
  filaVacia,
  interpretarLista,
  invalidarCorreo,
  limpiarDireccion,
  proponerDireccion,
  useRecordado,
  VALIDEZ_ENLACE_HORAS,
  type EnlaceGuardado,
  type FilaPersona,
  type Formato,
} from './comun';
import { CabeceraPaso, PieDePaso, type ContextoPuesta } from './marco';

/** Distintivo de la fila de quien hace la puesta en marcha. */
export function MarcaTu() {
  return (
    <span className="rounded-full bg-petroleo-claro px-2 py-px text-sm font-semibold text-petroleo">Tú</span>
  );
}

export function PasoEquipo({ ctx, tituloRef }: { ctx: ContextoPuesta; tituloRef: Ref<HTMLHeadingElement> }) {
  const { dominio } = ctx;
  if (!dominio) {
    return (
      <>
        <CabeceraPaso ref={tituloRef} titulo="Tu equipo" />
        <Hoja>
          <Vacio
            icono={Globe}
            title="Primero se necesita un dominio"
            action={
              <Button variant="perfil" onClick={() => ctx.irA('dominio')}>
                Ir a «Tu dominio»
              </Button>
            }
          >
            Los buzones se crean con el dominio de tu empresa, como ana@tuempresa.com.
          </Vacio>
        </Hoja>
        <PieDePaso atras="Tu dominio" onAtras={() => ctx.irA('dominio')} />
      </>
    );
  }
  if (propiedadPendiente(dominio)) {
    return (
      <>
        <CabeceraPaso ref={tituloRef} titulo="Tu equipo" />
        <Hoja>
          <Vacio
            icono={CircleDashed}
            title="Falta comprobar que el dominio es tuyo"
            action={
              <Button variant="perfil" onClick={() => ctx.irA('dominio')}>
                Ir a «Tu dominio»
              </Button>
            }
          >
            En cuanto quede comprobado podrás crear aquí los buzones de todo el equipo, aunque falten otros
            registros del DNS.
          </Vacio>
        </Hoja>
        <PieDePaso atras="Tu dominio" onAtras={() => ctx.irA('dominio')} />
      </>
    );
  }
  return <Equipo ctx={ctx} dominio={dominio} tituloRef={tituloRef} />;
}

/** Valor que deja de cambiar durante `ms`: la revisión en vivo no pregunta en cada tecla. */
function useDiferido<T>(valor: T, ms: number): T {
  const [diferido, setDiferido] = useState(valor);
  useEffect(() => {
    const t = window.setTimeout(() => setDiferido(valor), ms);
    return () => window.clearTimeout(t);
  }, [valor, ms]);
  return diferido;
}

type RespuestaAlta = Omit<BulkResponse, 'results'> & { results: ConEnlace<BulkEntryResult>[] };

function Equipo({
  ctx,
  dominio,
  tituloRef,
}: {
  ctx: ContextoPuesta;
  dominio: DominioCorreo;
  tituloRef: Ref<HTMLHeadingElement>;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const clientId = ctx.panel.client.id;
  const { plan, usage } = ctx.panel;
  const resultadosRef = useRef<HTMLDivElement>(null);
  const listaRef = useRef<HTMLUListElement>(null);

  const [formato, setFormato] = useRecordado<Formato>(clave(clientId, 'formato'), () => 'nombre.apellido', 'local');
  // Sin buzones, la lista empieza con quien hace la puesta en marcha: casi
  // siempre necesita el suyo. Su correo de acceso al panel sirve para
  // enviarse el enlace si no es del dominio que se está creando.
  const [filas, setFilas] = useRecordado<FilaPersona[]>(
    clave(clientId, `borrador:${dominio.id}`),
    () =>
      ctx.buzones.length === 0
        ? [
            filaNueva(formato, {
              nombre: ctx.usuario.name,
              mio: true,
              personal: ctx.usuario.email.toLowerCase().endsWith(`@${dominio.domain}`) ? '' : ctx.usuario.email,
            }),
          ]
        : [],
    'sesion',
  );
  const [tocadas, setTocadas] = useState<Set<string>>(() => new Set());
  const [intentado, setIntentado] = useState(false);
  const [erroresCreacion, setErroresCreacion] = useState<Map<string, string>>(() => new Map());
  const [errorGeneral, setErrorGeneral] = useState('');
  const [fase, setFase] = useState<'revisando' | 'creando' | null>(null);
  const [pegando, setPegando] = useState(false);
  const [textoPegado, setTextoPegado] = useState('');

  const usadas = useMemo(() => filas.filter((f) => !filaVacia(f)), [filas]);
  const repetidas = useMemo(() => direccionesRepetidas(usadas), [usadas]);
  const plazas = Math.max(0, plan.maxMailboxes - usage.mailboxes);
  const excede = usadas.length > plazas;

  // Revisión en vivo: en cuanto una dirección es válida se pregunta al
  // servidor (sin crear nada) si ya existe, para avisar en su fila antes de
  // pulsar «Crear».
  const candidatas = usadas
    .filter((f) => errorFila(f, repetidas)?.campo !== 'local')
    .map((f) => f.local.trim());
  const firma = useDiferido(candidatas.join(','), 600);
  const revision = useQuery({
    queryKey: ['puesta-revision', dominio.id, firma],
    queryFn: () =>
      api.post<BulkPreview>('/api/mailboxes/bulk', {
        domainId: dominio.id,
        dryRun: true,
        entries: firma.split(',').map((localPart) => ({ localPart })),
      }),
    enabled: firma !== '' && !ctx.suspendido,
    staleTime: 15_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const erroresServidor = useMemo(() => {
    const m = new Map(erroresCreacion);
    for (const r of revision.data?.results ?? []) if (!r.ok && r.error) m.set(r.localPart, r.error);
    return m;
  }, [erroresCreacion, revision.data]);

  function errorVisible(f: FilaPersona): { campo: 'nombre' | 'local' | 'personal'; texto: string } | null {
    const local = errorFila(f, repetidas);
    if (local && (intentado || tocadas.has(f.id))) return local;
    const servidor = erroresServidor.get(f.local.trim());
    if (!local && servidor) return { campo: 'local', texto: servidor };
    return null;
  }

  function actualizar(id: string, cambio: (f: FilaPersona) => FilaPersona) {
    setFilas((prev) => prev.map((f) => (f.id === id ? cambio(f) : f)));
    setErrorGeneral('');
  }

  function cambiarFormato(nuevo: Formato) {
    setFormato(nuevo);
    setFilas((prev) => prev.map((f) => (f.localEditado ? f : { ...f, local: proponerDireccion(f.nombre, nuevo) })));
  }

  function enfocarFila(id: string, campo: string) {
    window.requestAnimationFrame(() => {
      listaRef.current?.querySelector<HTMLInputElement>(`[data-fila="${id}"][data-campo="${campo}"]`)?.focus();
    });
  }

  function anadirPersona() {
    const nueva = filaNueva(formato);
    setFilas((prev) => [...prev, nueva]);
    enfocarFila(nueva.id, 'nombre');
  }

  function anadirLista() {
    const personas = interpretarLista(textoPegado);
    if (personas.length === 0) return;
    setFilas((prev) => [
      ...prev.filter((f) => !filaVacia(f)),
      ...personas.map((p) => filaNueva(formato, { nombre: p.nombre, personal: p.personal })),
    ]);
    setTextoPegado('');
    setPegando(false);
    toast('ok', `${plural(personas.length, 'persona añadida', 'personas añadidas')} a la lista.`);
  }

  async function crear() {
    setIntentado(true);
    setErrorGeneral('');
    const primera = usadas.find((f) => errorFila(f, repetidas));
    if (primera) {
      enfocarFila(primera.id, errorFila(primera, repetidas)!.campo);
      return;
    }
    if (excede || usadas.length === 0) return;
    const entries = usadas.map((f) => ({ localPart: f.local.trim(), displayName: f.nombre.trim() }));
    try {
      // Revisión completa justo antes: mismas reglas y mismo límite que el
      // alta real. Si algo no cabe o ya existe, se dice en su fila y no se
      // crea ninguno (el equipo no se queda a medias).
      setFase('revisando');
      const previa = await api.post<BulkPreview>('/api/mailboxes/bulk', {
        domainId: dominio.id,
        dryRun: true,
        entries,
      });
      const rechazos = new Map(previa.results.filter((r) => !r.ok).map((r) => [r.localPart, r.error ?? 'No se puede crear.']));
      if (rechazos.size > 0) {
        setErroresCreacion(rechazos);
        const fila = usadas.find((f) => rechazos.has(f.local.trim()));
        if (fila) enfocarFila(fila.id, 'local');
        return;
      }
      if (previa.exceedsPlan) {
        setErrorGeneral(
          `Tu plan permite crear ${plural(previa.capacity.remaining, 'buzón más', 'buzones más')} y la lista tiene ${usadas.length}. Quita a alguien de la lista o pide a tu proveedor que amplíe el plan.`,
        );
        return;
      }

      setFase('creando');
      const res = await api.post<RespuestaAlta>('/api/mailboxes/bulk', {
        domainId: dominio.id,
        entries,
        setupLinks: { ttlHours: VALIDEZ_ENLACE_HORAS },
      });
      const porLocal = new Map(usadas.map((f) => [f.local.trim(), f]));
      const nuevos: EnlaceGuardado[] = [];
      const creadas = new Set<string>();
      const fallos = new Map<string, string>();
      for (const r of res.results) {
        const fila = porLocal.get(r.localPart);
        if (r.ok && r.mailbox) {
          if (fila) creadas.add(fila.id);
          if (fila?.mio) ctx.setMioId(r.mailbox.id);
          if (r.setupLink) {
            nuevos.push({
              mailboxId: r.mailbox.id,
              nombre: r.displayName || fila?.nombre.trim() || '',
              email: r.email,
              url: r.setupLink.url,
              expiresAt: r.setupLink.expiresAt,
              hasPassword: r.setupLink.hasPassword,
              correoPersonal: fila?.personal.trim() || undefined,
              mio: Boolean(fila?.mio),
            });
          }
        } else {
          fallos.set(r.localPart, r.error ?? 'No se ha podido crear el buzón.');
        }
      }
      ctx.setEnlaces((prev) => [...nuevos, ...prev.filter((p) => !nuevos.some((n) => n.mailboxId === p.mailboxId))]);
      setFilas((prev) => prev.filter((f) => !creadas.has(f.id) && !filaVacia(f)));
      setErroresCreacion(fallos);
      setIntentado(false);
      setTocadas(new Set());
      queryClient.removeQueries({ queryKey: ['puesta-revision'] });
      await invalidarCorreo(queryClient);
      if (fallos.size > 0) {
        toast(
          'error',
          `${res.created === 1 ? 'Se ha creado 1 buzón' : `Se han creado ${res.created} buzones`}; ${fallos.size === 1 ? '1 no se ha podido crear' : `${fallos.size} no se han podido crear`}. Revisa la lista.`,
        );
      } else {
        toast('ok', res.created === 1 ? 'Buzón creado con su enlace.' : `${res.created} buzones creados, cada uno con su enlace.`);
      }
      window.requestAnimationFrame(() => {
        resultadosRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        resultadosRef.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
      });
    } catch (err) {
      setErrorGeneral(mensajeDe(err, 'No se han podido crear los buzones. Vuelve a intentarlo.'));
    } finally {
      setFase(null);
    }
  }

  const sinEnlace = ctx.buzones.filter((b) => !ctx.enlaces.some((e) => e.mailboxId === b.id));
  const enlacesDelDominio = ctx.enlaces.filter((e) => e.email.endsWith(`@${dominio.domain}`));
  const formularioAbierto = filas.length > 0 || ctx.buzones.length === 0;
  const ejemplo = usadas.find((f) => f.nombre.trim())?.nombre ?? 'Ana García';

  const principal =
    usadas.length > 0 ? (
      <Button
        variant="principal"
        busy={fase !== null}
        disabled={excede || ctx.suspendido}
        onClick={() => void crear()}
      >
        {fase === 'revisando'
          ? 'Revisando…'
          : fase === 'creando'
            ? 'Creando…'
            : usadas.length === 1
              ? 'Crear 1 buzón'
              : `Crear ${usadas.length} buzones`}
      </Button>
    ) : ctx.buzones.length > 0 ? (
      <Button variant="principal" onClick={() => ctx.irA('obligatorias')}>
        Continuar
      </Button>
    ) : (
      <Button variant="principal" disabled>
        Crear los buzones
      </Button>
    );

  return (
    <>
      <CabeceraPaso ref={tituloRef} titulo="¿Quién va a tener correo?">
        Crea de una vez un buzón para cada persona. Cada una recibirá un enlace para configurar su correo en el
        móvil y el ordenador sin ayuda.
      </CabeceraPaso>

      {enlacesDelDominio.length > 0 && (
        <div ref={resultadosRef} className="scroll-mt-6">
          <EnlacesCreados ctx={ctx} enlaces={enlacesDelDominio} />
        </div>
      )}

      {sinEnlace.length > 0 && <YaEnElEquipo ctx={ctx} buzones={sinEnlace} />}

      {formularioAbierto ? (
        <Hoja
          title={ctx.buzones.length > 0 ? 'Añadir personas' : 'Tu equipo'}
          meta={`${plural(plazas, 'buzón libre', 'buzones libres')} en tu plan`}
          flush
        >
          <div className="flex flex-col gap-4 px-4 pb-4 pt-3.5">
            <Escala
              label="Buzones del plan con esta lista"
              usado={usage.mailboxes + usadas.length}
              maximo={plan.maxMailboxes}
            />
            {excede && (
              <AvisoError>
                {plazas === 0
                  ? `Has llegado al máximo de buzones de tu plan (${plan.maxMailboxes}). Pide a tu proveedor que lo amplíe para añadir a más personas.`
                  : `Tu plan permite crear ${plural(plazas, 'buzón más', 'buzones más')} y la lista tiene ${usadas.length}. Quita a alguien de la lista o pide a tu proveedor que amplíe el plan.`}
              </AvisoError>
            )}
            <fieldset>
              <legend className="rotulo mb-1.5">Formato de las direcciones</legend>
              <div className="flex flex-wrap gap-2">
                {FORMATOS.map((f) => (
                  <label
                    key={f.id}
                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-regla-fuerte bg-hoja px-3 text-base
                      text-tinta-2 shadow-boton transition-colors hover:bg-hoja-2 has-[:checked]:border-[rgb(var(--petroleo)/0.45)]
                      has-[:checked]:bg-petroleo-claro has-[:checked]:text-petroleo has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-petroleo
                      sm:min-h-9"
                  >
                    <input
                      type="radio"
                      name="formato-direcciones"
                      className="sr-only"
                      checked={formato === f.id}
                      onChange={() => cambiarFormato(f.id)}
                    />
                    <span className="codigo text-sm">{proponerDireccion(ejemplo, f.id) || f.rotulo}@</span>
                    <span className="sr-only">({f.rotulo})</span>
                  </label>
                ))}
              </div>
              <p className="mt-1.5 text-sm text-tinta-3">
                Es una propuesta a partir del nombre: puedes cambiar cualquier dirección en su fila.
              </p>
            </fieldset>
          </div>

          <ListaPersonas
            ref={listaRef}
            filas={filas}
            dominio={dominio.domain}
            errorVisible={errorVisible}
            onCambio={actualizar}
            onTocada={(id) => setTocadas((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))}
            onQuitar={(id) => setFilas((prev) => prev.filter((f) => f.id !== id))}
            formato={formato}
          />

          <div className="flex flex-col gap-3 border-t border-regla px-4 py-3.5">
            <div className="flex flex-wrap gap-2">
              <Button variant="perfil" onClick={anadirPersona} disabled={usadas.length >= plazas}>
                <Plus className="h-4 w-4" aria-hidden />
                Añadir persona
              </Button>
              <Button variant="plano" aria-expanded={pegando} onClick={() => setPegando((v) => !v)}>
                <ClipboardPaste className="h-4 w-4" aria-hidden />
                Pegar una lista
              </Button>
            </div>
            {usadas.length >= plazas && plazas > 0 && !excede && (
              <p className="text-sm text-tinta-2">La lista ya ocupa todos los buzones libres de tu plan.</p>
            )}
            {pegando && (
              <div className="revelar flex flex-col gap-3 rounded-lg border border-regla bg-hoja-2 p-3">
                <Textarea
                  label="Una persona por línea"
                  rows={5}
                  value={textoPegado}
                  onChange={(e) => setTextoPegado(e.target.value)}
                  placeholder={'Ana García\nLuis Martín, luis.martin@gmail.com'}
                  help="Puedes pegarla desde una hoja de cálculo o desde tu agenda: el nombre y, si quieres, su correo personal."
                />
                <div className="flex flex-wrap gap-2">
                  <Button variant="perfil" disabled={!textoPegado.trim()} onClick={anadirLista}>
                    Añadir a la lista
                  </Button>
                  <Button variant="plano" onClick={() => setPegando(false)}>
                    Cancelar
                  </Button>
                </div>
              </div>
            )}
            <p className="max-w-[68ch] text-sm text-tinta-3">
              Las contraseñas se generan solas y van dentro del enlace de cada persona. El correo personal solo se usa
              en este navegador para preparar el mensaje con su enlace: no se guarda en el servidor.
            </p>
            {errorGeneral && <AvisoError>{errorGeneral}</AvisoError>}
          </div>
        </Hoja>
      ) : (
        <Hoja>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 max-w-[60ch] flex-1 basis-60 text-base text-tinta-2">
              {plazas === 0 ? (
                <>
                  Tu plan ya no admite más buzones ({plan.maxMailboxes}). Para añadir a más personas, pide a tu
                  proveedor que lo amplíe.
                </>
              ) : (
                <>
                  ¿Falta alguien? Añádelo ahora o más adelante desde{' '}
                  <Link to="/buzones" className="text-petroleo underline underline-offset-2 hover:text-tinta">
                    Buzones
                  </Link>
                  .
                </>
              )}
            </p>
            <Button variant="perfil" onClick={anadirPersona} disabled={plazas === 0 || ctx.suspendido}>
              <Plus className="h-4 w-4" aria-hidden />
              Añadir personas
            </Button>
          </div>
        </Hoja>
      )}

      <PieDePaso
        atras="Tu dominio"
        onAtras={() => ctx.irA('dominio')}
        saltar={
          usadas.length > 0 || ctx.buzones.length === 0 ? (
            <Button variant="plano" onClick={() => ctx.irA('obligatorias')}>
              Saltar por ahora
            </Button>
          ) : undefined
        }
        principal={principal}
        nota={
          usadas.length === 0 && ctx.buzones.length === 0
            ? 'Añade al menos a una persona para crear su buzón.'
            : usadas.length > 0 && enlacesDelDominio.length === 0
              ? `Cada enlace incluirá la contraseña de su buzón y caducará a los ${VALIDEZ_ENLACE_HORAS / 24} días.`
              : undefined
        }
      />
    </>
  );
}

/* --------------------------- Lista editable -------------------------------- */

const control =
  'h-10 w-full min-w-0 rounded-lg border bg-hoja px-3 text-base text-tinta shadow-boton placeholder:text-tinta-3 ' +
  'transition duration-150 hover:border-[rgb(var(--tinta)/0.32)] focus:border-[rgb(var(--petroleo))] focus:outline-none ' +
  'focus:ring-[3px] focus:ring-petroleo/15';

/*
  La fila cabe en una línea a partir de 42rem de ancho de la hoja (consulta de
  contenedor, no de ventana). Las clases van escritas enteras: Tailwind solo
  genera las que encuentra literalmente en el código.
*/

interface PropsLista {
  filas: FilaPersona[];
  dominio: string;
  errorVisible: (f: FilaPersona) => { campo: 'nombre' | 'local' | 'personal'; texto: string } | null;
  onCambio: (id: string, cambio: (f: FilaPersona) => FilaPersona) => void;
  onTocada: (id: string) => void;
  onQuitar: (id: string) => void;
  formato: Formato;
}

const ListaPersonas = forwardRef<HTMLUListElement, PropsLista>(function ListaPersonas(
  { filas, dominio, errorVisible, onCambio, onTocada, onQuitar, formato },
  ref,
) {
  // Estrecha: un campo debajo de otro. Ancha: nombre y dirección en la
  // primera línea (la dirección necesita sitio para el dominio) y el correo
  // personal, que es opcional, debajo.
  const columnas = 'grid-cols-[minmax(0,1fr)_auto] [@container(min-width:40rem)]:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_2.5rem]';
  return (
    <div className="[container-type:inline-size]">
      {filas.length > 0 && (
        <div className={`regla-cabecera hidden gap-x-3 bg-hoja-2 px-4 py-2 [@container(min-width:40rem)]:grid ${columnas}`} aria-hidden>
          <span className="rotulo">Nombre y apellidos</span>
          <span className="rotulo">Dirección</span>
          <span />
        </div>
      )}
      <ul ref={ref} className={filas.length > 0 ? 'border-t border-regla' : ''}>
        {filas.map((f, i) => {
          const error = errorVisible(f);
          const invalido = (campo: string) => (error?.campo === campo ? true : undefined);
          const quien = f.nombre.trim() || `la persona ${i + 1}`;
          return (
            <li
              key={f.id}
              className={`regla-fila px-4 py-3 last:border-b-0 ${error ? 'fila-fuera' : ''}`}
              onBlur={(e) => {
                // La fila se da por tocada al salir de ella, no al pasar de un campo a otro.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onTocada(f.id);
              }}
            >
              <div className={`grid items-start gap-x-3 gap-y-2 ${columnas}`}>
                <label className="flex min-w-0 flex-col gap-1">
                  <span className={`rotulo flex items-center gap-2 [@container(min-width:40rem)]:sr-only`}>
                    Nombre y apellidos{f.mio && <MarcaTu />}
                  </span>
                  <input
                    data-fila={f.id}
                    data-campo="nombre"
                    className={`${control} ${invalido('nombre') ? 'border-[rgb(var(--fuera)/0.6)]' : 'border-regla-fuerte'}`}
                    value={f.nombre}
                    autoComplete="off"
                    maxLength={80}
                    placeholder="Ana García"
                    aria-invalid={invalido('nombre')}
                    onChange={(e) => {
                      const nombre = e.target.value;
                      onCambio(f.id, (p) => ({
                        ...p,
                        nombre,
                        local: p.localEditado ? p.local : proponerDireccion(nombre, formato),
                      }));
                    }}
                  />
                </label>

                <button
                  type="button"
                  onClick={() => onQuitar(f.id)}
                  aria-label={`Quitar a ${quien} de la lista`}
                  className={`col-start-2 row-start-1 flex h-10 w-10 items-center justify-center self-end rounded-lg text-tinta-3
                    transition-colors hover:bg-hoja-3 hover:text-tinta [@container(min-width:40rem)]:col-start-3`}
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>

                <label className={`col-span-2 flex min-w-0 flex-col gap-1 [@container(min-width:40rem)]:col-span-1 [@container(min-width:40rem)]:col-start-2 [@container(min-width:40rem)]:row-start-1`}>
                  <span className={`rotulo [@container(min-width:40rem)]:sr-only`}>Dirección</span>
                  <span
                    className={`flex min-h-10 min-w-0 items-stretch rounded-lg border bg-hoja shadow-boton transition duration-150
                      focus-within:border-[rgb(var(--petroleo))] focus-within:ring-[3px] focus-within:ring-petroleo/15 ${
                        invalido('local') ? 'border-[rgb(var(--fuera)/0.6)]' : 'border-regla-fuerte'
                      }`}
                  >
                    <input
                      data-fila={f.id}
                      data-campo="local"
                      className="codigo min-w-[5rem] flex-1 rounded-l-lg bg-transparent px-3 text-sm text-tinta placeholder:text-tinta-3 focus:outline-none"
                      value={f.local}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="ana.garcia"
                      aria-invalid={invalido('local')}
                      aria-describedby={`sufijo-${f.id}`}
                      onChange={(e) => {
                        const local = limpiarDireccion(e.target.value);
                        onCambio(f.id, (p) => ({ ...p, local, localEditado: true }));
                      }}
                    />
                    <span
                      id={`sufijo-${f.id}`}
                      className="codigo flex max-w-[60%] items-center break-all rounded-r-lg border-l border-regla bg-hoja-2 px-2.5 py-1.5 text-sm text-tinta-3"
                    >
                      @{dominio}
                    </span>
                  </span>
                </label>

                <label
                  className={`col-span-2 flex min-w-0 flex-col gap-1 [@container(min-width:40rem)]:col-start-1 [@container(min-width:40rem)]:row-start-2 [@container(min-width:40rem)]:flex-row [@container(min-width:40rem)]:items-center [@container(min-width:40rem)]:gap-3`}
                >
                  <span className="rotulo shrink-0">Correo personal (opcional)</span>
                  <input
                    data-fila={f.id}
                    data-campo="personal"
                    type="email"
                    inputMode="email"
                    className={`${control} [@container(min-width:40rem)]:max-w-sm ${invalido('personal') ? 'border-[rgb(var(--fuera)/0.6)]' : 'border-regla-fuerte'}`}
                    value={f.personal}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="Para enviarle su enlace"
                    aria-invalid={invalido('personal')}
                    onChange={(e) => onCambio(f.id, (p) => ({ ...p, personal: e.target.value }))}
                  />
                </label>
              </div>
              {error ? (
                <p className="mt-1.5 text-sm text-fuera" role="alert">
                  {error.texto}
                </p>
              ) : f.mio ? (
                <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-tinta-3">
                  <span className={`hidden [@container(min-width:40rem)]:inline`}>
                    <MarcaTu />
                  </span>
                  Es tu buzón: lo configurarás en tus dispositivos en el paso 4.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
});

/* ------------------------------ Resultados --------------------------------- */

function EnlacesCreados({ ctx, enlaces }: { ctx: ContextoPuesta; enlaces: EnlaceGuardado[] }) {
  const [confirmando, setConfirmando] = useState(false);
  const caducan = Math.min(...enlaces.map((e) => e.expiresAt));
  const otros = enlaces.filter((e) => !e.mio);
  return (
    <Hoja
      title={
        <h2 tabIndex={-1} className="text-md font-semibold text-tinta focus:outline-none">
          Enlaces para tu equipo
        </h2>
      }
      meta={plural(enlaces.length, 'enlace listo', 'enlaces listos')}
      actions={<BotonCopiarTexto texto={textoEnlaces(enlaces)} rotulo="Copiar todos" />}
      flush
    >
      <div className="regla-fila px-4 py-3">
        <NotaEnlaces
          expiresAt={caducan}
          conContrasena={enlaces.some((e) => e.hasPassword)}
          conservacion="Se conservan en esta pestaña hasta que la cierres."
        />
      </div>
      <ul>
        {enlaces.map((e) => (
          <FilaEnlace
            key={e.mailboxId}
            persona={e}
            firma={ctx.usuario.name}
            marca={e.mio ? <MarcaTu /> : undefined}
            nota={e.mio ? 'Es tu buzón: lo configurarás en tus dispositivos en el paso 4.' : undefined}
          />
        ))}
      </ul>
      {otros.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-regla px-4 py-3">
          {confirmando ? (
            <>
              <p className="min-w-0 flex-1 basis-60 text-sm text-tinta-2">
                Los enlaces de tu equipo dejarán de verse aquí y no se podrán recuperar. El tuyo se queda para el paso 4.
              </p>
              <div className="flex gap-2">
                <Button variant="plano" onClick={() => setConfirmando(false)}>
                  Cancelar
                </Button>
                <Button variant="perfil" onClick={() => ctx.setEnlaces((prev) => prev.filter((p) => p.mio))}>
                  Quitar de la vista
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="min-w-0 flex-1 basis-60 text-sm text-tinta-3">
                ¿Ya los has enviado todos? Puedes quitarlos de esta pantalla.
              </p>
              <Button variant="plano" onClick={() => setConfirmando(true)}>
                Ya los he enviado
              </Button>
            </>
          )}
        </div>
      )}
    </Hoja>
  );
}

/**
 * Buzones que ya existen y no tienen enlace en esta pestaña (se crearon antes,
 * o se cerró la pestaña con los enlaces). Su enlace se puede volver a crear,
 * con una contraseña nueva.
 */
function YaEnElEquipo({ ctx, buzones }: { ctx: ContextoPuesta; buzones: Mailbox[] }) {
  return (
    <Hoja title="Ya en tu equipo" meta={plural(buzones.length, 'buzón', 'buzones')} flush>
      <p className="regla-fila px-4 py-3 text-sm text-tinta-2">
        Si alguien necesita su enlace de configuración, créalo aquí. Para cambiar nombres, cuotas o contraseñas,
        ve a{' '}
        <Link to="/buzones" className="text-petroleo underline underline-offset-2 hover:text-tinta">
          Buzones
        </Link>
        .
      </p>
      <ul>
        {buzones.map((b) => (
          <FilaSinEnlace key={b.id} ctx={ctx} buzon={b} />
        ))}
      </ul>
    </Hoja>
  );
}

function FilaSinEnlace({ ctx, buzon }: { ctx: ContextoPuesta; buzon: Mailbox }) {
  const [confirmando, setConfirmando] = useState(false);
  const crear = useMutation({
    mutationFn: () => enlaceConContrasenaNueva(buzon.id),
    onSuccess: (link) => {
      ctx.setEnlaces((prev) => [
        {
          mailboxId: buzon.id,
          nombre: buzon.displayName,
          email: buzon.email,
          url: link.url,
          expiresAt: link.expiresAt,
          hasPassword: link.hasPassword,
          mio: buzon.id === ctx.mioId,
        },
        ...prev.filter((p) => p.mailboxId !== buzon.id),
      ]);
    },
  });
  const mio = buzon.id === ctx.mioId;
  return (
    <li className="regla-fila px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 grow basis-full sm:basis-0">
          <p className="flex flex-wrap items-baseline gap-x-2 text-base font-medium text-tinta [overflow-wrap:anywhere]">
            {buzon.displayName || buzon.email}
            {mio && <MarcaTu />}
          </p>
          {buzon.displayName && <p className="break-all text-sm text-tinta-2">{buzon.email}</p>}
        </div>
        {!confirmando && (
          <Button variant="perfil" onClick={() => setConfirmando(true)} disabled={buzon.status !== 'active'}>
            {mio ? 'Crear mi enlace' : 'Crear su enlace'}
          </Button>
        )}
      </div>
      {confirmando && (
        <div className="revelar mt-2.5 flex flex-col gap-2.5 rounded-lg border border-[rgb(var(--vigilar)/0.45)] bg-vigilar-fondo px-3 py-2.5">
          <p className="max-w-[68ch] text-sm text-tinta">
            Se generará una contraseña nueva para <span className="break-all font-medium">{buzon.email}</span> y un
            enlace que la incluye. Si ya usa este buzón en algún dispositivo, tendrá que volver a configurarlo con el
            enlace.
          </p>
          {crear.isError && <AvisoError>{mensajeDe(crear.error, 'No se ha podido crear el enlace.')}</AvisoError>}
          <div className="flex flex-wrap gap-2">
            <Button variant="perfil" busy={crear.isPending} onClick={() => crear.mutate()}>
              Generar contraseña y enlace
            </Button>
            <Button variant="plano" onClick={() => setConfirmando(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
