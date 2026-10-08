import { forwardRef, useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { CircleDashed, ClipboardPaste, Globe, Plus, X } from 'lucide-react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ConEnlace } from '../../lib/api';
import { propiedadPendiente, type DominioCorreo } from '../../lib/cloudflare';
import { plural } from '../../lib/format';
import { mensajeDe, type BulkEntryResult, type BulkPreview, type BulkResponse } from '../../lib/gestion';
import { Button } from '../../ui/Button';
import { Textarea } from '../../ui/Field';
import { AvisoError, Escala, Hoja, Vacio } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import {
  clave,
  direccionesRepetidas,
  errorFila,
  FORMATOS,
  filaNueva,
  filaVacia,
  interpretarLista,
  invalidarCorreo,
  lecturaCuenta,
  limpiarDireccion,
  proponerDireccion,
  useRecordado,
  VALIDEZ_ENLACE_HORAS,
  type EnlaceGuardado,
  type FilaPersona,
  type Formato,
} from './comun';
import { CuentasEquipo, EnviarConfiguracion } from './CuentasEquipo';
import { CabeceraPaso, MarcaTu, PieDePaso, type ContextoPuesta } from './marco';

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
  // El alta está abierta si no hay buzones, si hay una lista a medias o si se
  // ha pedido («Añadir buzones»); si no, manda la lista de buzones.
  const [anadiendo, setAnadiendo] = useState(() => ctx.buzones.length === 0 || filas.length > 0 || ctx.anadir);
  const altaRef = useRef<HTMLDivElement>(null);
  // Envío por correo: los buzones marcados al abrirlo y una clave para que
  // cada apertura empiece de cero.
  const [envio, setEnvio] = useState<{ ids: string[]; vez: number } | null>(null);

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

  /**
   * Cierra el alta y quita ?anadir=1 de la dirección: así el próximo «Añadir
   * buzones» de la cabecera vuelve a abrirla.
   */
  function cerrarAlta() {
    setAnadiendo(false);
    if (ctx.anadir) ctx.irA('equipo');
  }

  /** «Añadir buzones»: abre el alta con una fila lista para escribir. */
  function abrirAlta() {
    setAnadiendo(true);
    if (filas.length === 0) anadirPersona();
    else enfocarFila(filas[filas.length - 1]!.id, 'nombre');
    window.requestAnimationFrame(() => altaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  // «Añadir buzones» (?anadir=1), al entrar en el paso o con él abierto: el
  // alta se abre con una fila lista para escribir. La referencia evita una
  // segunda fila si el efecto se repite con la misma petición.
  const altaPedida = useRef(false);
  useEffect(() => {
    if (!ctx.anadir) {
      altaPedida.current = false;
      return;
    }
    if (altaPedida.current) return;
    altaPedida.current = true;
    abrirAlta();
    // Solo al pedirlo; abrirAlta cambia en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.anadir]);

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
      for (const n of nuevos) if (n.correoPersonal) ctx.setPersonal(n.mailboxId, n.correoPersonal);
      setFilas((prev) => prev.filter((f) => !creadas.has(f.id) && !filaVacia(f)));
      if (usadas.every((f) => creadas.has(f.id))) cerrarAlta();
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
        toast('ok', res.created === 1 ? 'Buzón creado.' : `${res.created} buzones creados.`);
      }
      // Lo siguiente es hacerles llegar su configuración: con los correos
      // personales ya escritos, el envío se abre listo para confirmar.
      const conCorreo = nuevos.filter((n) => !n.mio && n.correoPersonal).map((n) => n.mailboxId);
      if (conCorreo.length > 0) {
        setEnvio({ ids: conCorreo, vez: Date.now() });
      } else {
        window.requestAnimationFrame(() => {
          resultadosRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    } catch (err) {
      setErrorGeneral(mensajeDe(err, 'No se han podido crear los buzones. Vuelve a intentarlo.'));
    } finally {
      setFase(null);
    }
  }

  const formularioAbierto = anadiendo || ctx.buzones.length === 0;
  const ejemplo = usadas.find((f) => f.nombre.trim())?.nombre ?? 'Ana García';
  const sinConfigurar = ctx.buzones.filter((b) => b.id !== ctx.mioId && lecturaCuenta(b).estado === 'sin-configurar').length;

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
      {ctx.buzones.length === 0 ? (
        <CabeceraPaso ref={tituloRef} titulo="¿Quién va a tener correo?">
          Crea de una vez un buzón para cada persona. Después le enviarás su configuración para que tenga el correo en
          el móvil y el ordenador sin ayuda.
        </CabeceraPaso>
      ) : (
        <CabeceraPaso ref={tituloRef} titulo="Tu equipo">
          Cada persona necesita su configuración para usar el correo. Las que aún no la tienen salen en rojo:
          envíasela por correo o copia su enlace.
        </CabeceraPaso>
      )}

      {ctx.buzones.length > 0 && (
        <div ref={resultadosRef} className="scroll-mt-6">
          <CuentasEquipo
            ctx={ctx}
            dominio={dominio}
            onAnadir={formularioAbierto ? undefined : abrirAlta}
            onEnviar={(ids) => setEnvio({ ids, vez: Date.now() })}
          />
        </div>
      )}

      {formularioAbierto && (
        <div ref={altaRef} className="scroll-mt-6">
        <Hoja
          title={ctx.buzones.length > 0 ? 'Añadir buzones' : 'Tu equipo'}
          meta={`${plural(plazas, 'buzón libre', 'buzones libres')} en tu plan`}
          actions={
            ctx.buzones.length > 0 && usadas.length === 0 ? (
              <Button
                variant="plano"
                onClick={() => {
                  setFilas([]);
                  cerrarAlta();
                }}
              >
                Cerrar
              </Button>
            ) : undefined
          }
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
              Las contraseñas se generan solas y van dentro del enlace de cada persona. Con su correo personal, al crear
              los buzones podrás enviarle su configuración por correo.
            </p>
            {errorGeneral && <AvisoError>{errorGeneral}</AvisoError>}
          </div>
        </Hoja>
        </div>
      )}

      {envio && (
        <EnviarConfiguracion
          key={envio.vez}
          open
          onClose={() => setEnvio(null)}
          ctx={ctx}
          dominio={dominio}
          marcadosIniciales={envio.ids}
        />
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
            : usadas.length > 0
              ? `Cada buzón tendrá su enlace con la contraseña incluida, válido ${VALIDEZ_ENLACE_HORAS / 24} días.`
              : sinConfigurar > 0
                ? `${sinConfigurar === 1 ? 'Queda 1 buzón' : `Quedan ${sinConfigurar} buzones`} sin configurar. Puedes seguir y enviar la configuración más tarde.`
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
