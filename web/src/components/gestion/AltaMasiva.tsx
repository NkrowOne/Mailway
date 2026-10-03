import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type DomainRecord } from '../../lib/api';
import { plural } from '../../lib/format';
import {
  csvCredenciales,
  descargarTexto,
  mensajeDe,
  parsearLista,
  type BulkPreview,
  type BulkResponse,
} from '../../lib/gestion';
import { Button } from '../../ui/Button';
import { Textarea } from '../../ui/Field';
import { BotonCopiar, Dialogo, Escala, MarcaFondo } from '../../ui/kit';
import { esPropiedadPendiente } from '../../lib/dominios';
import {
  BandaAviso,
  BandaError,
  Botonera,
  dominioInicialDisponible,
  SelectorDominio,
  type MotivoBloqueoDominio,
} from './comun';

const MAX_LOTE = 100;

/**
 * Alta masiva de buzones: pegar una lista → revisión en el servidor (mismas
 * reglas y límite del plan que el alta real, sin crear nada) → creación →
 * tabla de credenciales con copia y descarga en CSV.
 *
 * El resultado lo guarda la página (`resultado`/`onResultado`): si el
 * diálogo se cierra por error, al volver a abrirlo las contraseñas siguen ahí
 * hasta que se confirme que se han guardado.
 */
export function AltaMasiva({
  open,
  onClose,
  domains,
  dominioInicial,
  resultado,
  onResultado,
  etiquetaDominio,
  motivoBloqueo,
}: {
  open: boolean;
  onClose: () => void;
  domains: DomainRecord[];
  dominioInicial?: string;
  resultado: { dominio: string; respuesta: BulkResponse } | null;
  onResultado: (r: { dominio: string; respuesta: BulkResponse } | null) => void;
  etiquetaDominio: (d: DomainRecord) => string;
  motivoBloqueo?: MotivoBloqueoDominio;
}) {
  const queryClient = useQueryClient();
  const [domainId, setDomainId] = useState(() => dominioInicialDisponible(domains, dominioInicial, motivoBloqueo));
  const [texto, setTexto] = useState('');
  const [revision, setRevision] = useState<BulkPreview | null>(null);
  const [error, setError] = useState('');

  const dominio = domains.find((d) => d.id === domainId);
  const lineas = useMemo(() => parsearLista(texto, dominio?.domain ?? ''), [texto, dominio?.domain]);
  // Solo viajan al servidor las líneas sin error local: algunos errores (una
  // dirección de otro dominio) el servidor no los vería, porque recibe solo
  // el nombre del buzón.
  const enviadas = useMemo(() => lineas.filter((l) => !l.error), [lineas]);
  const validasLocales = enviadas.length;
  const rechazadas = useMemo(
    () =>
      lineas
        .filter((l) => l.error)
        .map((l) => ({
          localPart: l.localPart,
          email: `Línea ${l.linea}: ${l.localPart}`,
          displayName: l.displayName,
          ok: false,
          error: l.error ?? undefined,
        })),
    [lineas],
  );

  const revisar = useMutation({
    mutationFn: () =>
      api.post<BulkPreview>('/api/mailboxes/bulk', {
        domainId,
        dryRun: true,
        entries: enviadas.map((l) => ({ localPart: l.localPart, displayName: l.displayName })),
      }),
    onSuccess: (data) => {
      // «Fuera de rango primero»: las líneas que no se crearán encabezan la revisión.
      setRevision({ ...data, results: ordenarPorVeredicto([...data.results, ...rechazadas]) });
      setError('');
    },
    onError: (err) => {
      if (esPropiedadPendiente(err)) void queryClient.invalidateQueries({ queryKey: ['domains'] });
      setError(mensajeDe(err, 'No se ha podido revisar la lista.'));
    },
  });

  const crear = useMutation({
    mutationFn: () =>
      api.post<BulkResponse>('/api/mailboxes/bulk', {
        domainId,
        entries: enviadas.map((l) => ({ localPart: l.localPart, displayName: l.displayName })),
      }),
    onSuccess: async (data) => {
      onResultado({
        dominio: dominio?.domain ?? '',
        respuesta: { ...data, results: [...data.results, ...rechazadas], failed: data.failed + rechazadas.length },
      });
      setRevision(null);
      setTexto('');
      setError('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mailboxes'] }),
        queryClient.invalidateQueries({ queryKey: ['client-dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['clients'] }),
        queryClient.invalidateQueries({ queryKey: ['client'] }),
      ]);
    },
    onError: (err) => setError(mensajeDe(err, 'No se han podido crear los buzones.')),
  });

  const titulo = resultado ? 'Buzones creados' : revision ? 'Revisar el alta masiva' : 'Alta masiva de buzones';
  const conCredenciales = Boolean(resultado?.respuesta.results.some((r) => r.ok && r.password));

  // Cerrar con credenciales sin confirmar no las pierde (la página conserva el
  // resultado y ofrece volver a verlas), así que no se pregunta; pero la
  // confirmación va fija al pie para que en el móvil no quede tras la lista.
  const pie = resultado ? (
    <Button
      variant="principal"
      onClick={() => {
        onResultado(null);
        onClose();
      }}
    >
      {conCredenciales ? 'He guardado las credenciales' : 'Cerrar'}
    </Button>
  ) : undefined;

  return (
    <Dialogo open={open} onClose={onClose} title={titulo} pie={pie}>
      {resultado ? (
        <Resultado dominio={resultado.dominio} respuesta={resultado.respuesta} />
      ) : revision ? (
        <div className="flex flex-col gap-4">
          <Escala
            label={`Buzones del plan tras el alta (${plural(revision.valid, 'nuevo', 'nuevos')})`}
            usado={revision.capacity.used + revision.valid}
            maximo={revision.capacity.max}
          />
          {revision.ownershipPending && (
            <BandaError>
              {revision.ownershipError ||
                'Falta comprobar la propiedad del dominio: no se creará ningún buzón hasta completarla.'}{' '}
              {dominio && (
                <Link
                  to={`/dominios/${dominio.id}`}
                  className="underline underline-offset-2 hover:text-tinta"
                >
                  Abrir la ficha del dominio
                </Link>
              )}
            </BandaError>
          )}
          {revision.exceedsPlan && !revision.ownershipPending && (
            <BandaError>
              El plan permite crear {revision.capacity.remaining} buzones más y la lista contiene{' '}
              {revision.valid} válidos. Reduce la lista o amplía el plan del cliente; no se creará ninguno
              mientras no quepan todos.
            </BandaError>
          )}
          <div className="max-h-80 overflow-y-auto border border-regla">
            {revision.results.map((r, i) => (
              <div
                key={`${r.localPart}-${i}`}
                className={`regla-fila flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 last:border-b-0 ${r.ok ? '' : 'fila-fuera'}`}
              >
                <div className="min-w-0 grow basis-full sm:basis-0">
                  <p className="valor break-all text-sm text-tinta">{r.email}</p>
                  {r.displayName && <p className="text-sm text-tinta-3">{r.displayName}</p>}
                  {r.error && <p className="text-sm text-fuera">{r.error}</p>}
                </div>
                <MarcaFondo veredicto={r.ok ? 'normal' : 'fuera'}>{r.ok ? 'Válida' : 'No se creará'}</MarcaFondo>
              </div>
            ))}
          </div>
          {error && <BandaError>{error}</BandaError>}
          <Botonera>
            <Button variant="plano" onClick={() => setRevision(null)}>
              Volver a la lista
            </Button>
            <Button
              variant="principal"
              busy={crear.isPending}
              disabled={revision.valid === 0 || revision.exceedsPlan}
              onClick={() => crear.mutate()}
            >
              {revision.valid === 1 ? 'Crear 1 buzón' : `Crear ${revision.valid} buzones`}
            </Button>
          </Botonera>
        </div>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!domainId) {
              setError('Selecciona un dominio que admita buzones.');
              return;
            }
            if (lineas.length === 0) {
              setError('Escribe al menos una dirección.');
              return;
            }
            if (enviadas.length === 0) {
              setError('Ninguna línea es válida. Corrige los errores indicados.');
              return;
            }
            if (lineas.length > MAX_LOTE) {
              setError(`Se pueden crear como máximo ${MAX_LOTE} buzones por lote; la lista tiene ${lineas.length}.`);
              return;
            }
            revisar.mutate();
          }}
        >
          <SelectorDominio
            domains={domains}
            value={domainId}
            onChange={(id) => {
              setError('');
              setDomainId(id);
            }}
            etiquetaDominio={etiquetaDominio}
            motivoBloqueo={motivoBloqueo}
            uso="buzones"
          />
          <Textarea
            label="Direcciones, una por línea"
            rows={8}
            className="valor text-sm"
            value={texto}
            onChange={(e) => {
              setError('');
              setTexto(e.target.value);
            }}
            placeholder={'ana\nluis, Luis Martín\nsoporte, Atención al cliente'}
            help={`Escribe el nombre del buzón o «nombre, Nombre visible». También se admite la dirección completa y lo pegado desde una hoja de cálculo. Máximo ${MAX_LOTE} por lote.`}
          />
          {lineas.length > 0 && (
            <p className="text-sm text-tinta-2">
              {plural(lineas.length, 'línea', 'líneas')} · {plural(validasLocales, 'válida', 'válidas')}
              {lineas.length > validasLocales && (
                <>
                  {' '}
                  · <span className="text-fuera">{lineas.length - validasLocales} con errores</span>
                </>
              )}
            </p>
          )}
          {lineas.some((l) => l.error) && (
            <ul className="max-h-32 overflow-y-auto border border-regla text-sm">
              {lineas
                .filter((l) => l.error)
                .map((l) => (
                  <li key={l.linea} className="regla-fila fila-fuera px-3 py-1.5 last:border-b-0">
                    <span className="valor text-tinta-2">Línea {l.linea}</span> · {l.error}
                  </li>
                ))}
            </ul>
          )}
          <p className="text-sm text-tinta-3">
            Las contraseñas se generan automáticamente y se muestran una sola vez al terminar, con opción de
            descargarlas en CSV.
          </p>
          {error && <BandaError>{error}</BandaError>}
          <Botonera>
            <Button type="button" variant="plano" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" variant="principal" busy={revisar.isPending} disabled={!domainId}>
              Revisar lista
            </Button>
          </Botonera>
        </form>
      )}
    </Dialogo>
  );
}

/** Las líneas que no se crearán, primero; después, las válidas en su orden. */
function ordenarPorVeredicto<T extends { ok: boolean }>(filas: T[]): T[] {
  return [...filas.filter((f) => !f.ok), ...filas.filter((f) => f.ok)];
}

function Resultado({ dominio, respuesta }: { dominio: string; respuesta: BulkResponse }) {
  const creados = respuesta.results.filter((r) => r.ok && r.password);
  const fallidos = respuesta.results.filter((r) => !r.ok);
  const filas = creados.map((r) => ({ email: r.email, displayName: r.displayName, password: r.password! }));
  const textoCopia = filas.map((f) => `${f.email}\t${f.password}`).join('\n');

  return (
    <div className="flex flex-col gap-4">
      <p className="text-base text-tinta-2">
        Se {creados.length === 1 ? 'ha creado 1 buzón' : `han creado ${creados.length} buzones`}
        {fallidos.length > 0 && ` y ${fallidos.length === 1 ? '1 línea no se ha podido crear' : `${fallidos.length} líneas no se han podido crear`}`}.
      </p>
      {creados.length > 0 && (
        <>
          <BandaAviso>
            Las contraseñas <strong className="font-semibold">solo se muestran ahora</strong>. Descárgalas o
            cópialas antes de cerrar y entrégalas a cada titular por un canal seguro.
          </BandaAviso>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="perfil"
              onClick={() =>
                descargarTexto(
                  `credenciales-${dominio || 'buzones'}-${new Date().toISOString().slice(0, 10)}.csv`,
                  csvCredenciales(filas),
                )
              }
            >
              Descargar CSV
            </Button>
            <BotonCopiar text={textoCopia} label="Copiar todo" />
          </div>
          <div className="max-h-80 overflow-y-auto border border-regla">
            <div className="regla-cabecera hidden items-baseline gap-x-3 px-3 py-1.5 sm:flex">
              <span className="rotulo min-w-0 grow basis-0">Dirección</span>
              <span className="rotulo w-60 shrink-0">Contraseña</span>
            </div>
            {creados.map((r) => (
              <div key={r.email} className="regla-fila flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 last:border-b-0">
                <p className="valor min-w-0 grow basis-full break-all text-sm text-tinta sm:basis-0">{r.email}</p>
                <div className="flex items-center gap-2 sm:w-60 sm:shrink-0">
                  <span className="rotulo sm:hidden">Contraseña</span>
                  <span className="codigo break-all text-sm text-tinta">{r.password}</span>
                  <BotonCopiar text={r.password!} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {fallidos.length > 0 && (
        <div className="border border-regla">
          <p className="rotulo regla-cabecera px-3 py-1.5">No creados</p>
          {fallidos.map((r, i) => (
            <div key={`${r.email}-${i}`} className="regla-fila fila-fuera px-3 py-2 last:border-b-0">
              <p className="valor break-all text-sm text-tinta">{r.email}</p>
              <p className="text-sm text-fuera">{r.error}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
