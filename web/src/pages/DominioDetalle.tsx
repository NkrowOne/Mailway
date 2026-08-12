import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type CheckStatus, type DnsCheck, type DomainRecord } from '../lib/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';
import {
  CabeceraMedidas,
  Dialogo,
  Hoja,
  MarcaFondo,
  Medida,
  Membrete,
  Midiendo,
  Muestra,
  type Veredicto,
} from '../ui/kit';
import { useToast } from '../ui/toast';
import { formatDate } from '../lib/format';

/*
  El análisis del dominio.

  Cada registro DNS es una MEDICIÓN: `expected` es el valor de referencia,
  `found` es el valor medido y el estado es el veredicto. Lo que está fuera de
  rango se lee primero; lo que está en rango baja al final de su grupo.
*/

const veredictoDe: Record<CheckStatus, Veredicto> = {
  ok: 'normal',
  missing: 'fuera',
  mismatch: 'fuera',
  unknown: 'sin-dato',
};

const etiquetaDe: Record<CheckStatus, string> = {
  ok: 'En rango',
  missing: 'Falta',
  mismatch: 'No coincide',
  unknown: 'Sin medir',
};

/** Orden de lectura del informe: primero lo que reclama una acción. */
const prioridad: Record<Veredicto, number> = { fuera: 0, vigilar: 1, 'sin-dato': 2, normal: 3 };

function porVeredicto(checks: DnsCheck[]): DnsCheck[] {
  return [...checks].sort(
    (a, b) => prioridad[veredictoDe[a.status]] - prioridad[veredictoDe[b.status]],
  );
}

/** Valores largos: se desplazan en horizontal, nunca se parten a mitad de palabra. */
const cinta =
  'block overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';

export default function DominioDetalle() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [justVerified, setJustVerified] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const domain = useQuery({
    queryKey: ['domain', id],
    queryFn: () => api.get<{ domain: DomainRecord }>(`/api/domains/${id}`),
  });

  const verify = useMutation({
    mutationFn: () => api.post<{ domain: DomainRecord }>(`/api/domains/${id}/verify`),
    onSuccess: async (data) => {
      queryClient.setQueryData(['domain', id], data);
      await queryClient.invalidateQueries({ queryKey: ['domains'] });
      setJustVerified(true);
      const report = data.domain.dnsStatus;
      if (report.allRequiredOk) {
        toast('ok', '¡Dominio verificado! Ya está en reparto.');
      } else {
        toast(
          'ok',
          `Verificación hecha: ${report.requiredOk ?? 0} de ${report.requiredTotal ?? 0} registros obligatorios correctos.`,
        );
      }
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se pudo verificar.'),
  });

  const remove = useMutation({
    mutationFn: () =>
      api.delete(`/api/domains/${id}?confirm=${encodeURIComponent(confirmText.trim().toLowerCase())}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast('ok', 'Dominio eliminado.');
      navigate('/dominios');
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se pudo eliminar.'),
  });

  if (domain.isPending) {
    return (
      <Hoja>
        <Midiendo label="Leyendo la ficha del dominio…" />
      </Hoja>
    );
  }
  if (domain.isError || !domain.data) {
    return (
      <Hoja>
        <p role="alert" className="text-base text-tinta-2">
          <span className="text-fuera">No se encontró el dominio.</span>{' '}
          <Link className="text-laboratorio underline" to="/dominios">
            Volver a dominios
          </Link>
        </p>
      </Hoja>
    );
  }

  const record = domain.data.domain;
  const checks = record.dnsStatus.checks ?? [];
  const required = checks.filter((c) => c.required);
  const optional = checks.filter((c) => !c.required);
  const requiredOk = record.dnsStatus.requiredOk ?? required.filter((c) => c.status === 'ok').length;
  const requiredTotal = record.dnsStatus.requiredTotal ?? required.length;
  const optionalOk = optional.filter((c) => c.status === 'ok').length;
  const medido = Boolean(record.lastCheckedAt);
  const enReparto = record.status === 'active';

  return (
    <>
      <Membrete
        title={
          <span className="valor text-xl font-semibold normal-case tracking-normal">
            {record.domain}
          </span>
        }
        meta={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <MarcaFondo veredicto={enReparto ? 'normal' : medido ? 'fuera' : 'sin-dato'}>
              {enReparto ? 'En reparto' : 'Esperando DNS'}
            </MarcaFondo>
            <span className="text-tinta-3">Última medición: {formatDate(record.lastCheckedAt)}</span>
          </span>
        }
        actions={
          <>
            <Button variant="peligro" onClick={() => setConfirmOpen(true)}>
              Eliminar
            </Button>
            <Button variant="tinta" busy={verify.isPending} onClick={() => verify.mutate()}>
              Medir el DNS ahora
            </Button>
          </>
        }
      />

      {checks.length === 0 ? (
        <Hoja title="Sin lectura del DNS">
          <p className="max-w-[75ch] text-base text-tinta-2">
            Aún no hay lectura del DNS. Pulsa «Medir el DNS ahora» para obtener los registros
            que debes crear.
          </p>
        </Hoja>
      ) : (
        <div className="flex flex-col gap-4">
          <Hoja title="Resumen de la medición" meta={formatDate(record.lastCheckedAt)}>
            <CabeceraMedidas />
            <Medida
              concepto="Registros obligatorios en rango"
              valor={`${requiredOk}/${requiredTotal}`}
              referencia={`${requiredTotal}/${requiredTotal}`}
              veredicto={
                !medido ? 'sin-dato' : requiredOk >= requiredTotal ? 'normal' : 'fuera'
              }
              nota={
                requiredOk >= requiredTotal && medido
                  ? undefined
                  : 'Mientras falte alguno, el dominio no reparte correo.'
              }
            />
            {optional.length > 0 && (
              <Medida
                concepto="Registros recomendados en rango"
                valor={`${optionalOk}/${optional.length}`}
                referencia={`${optional.length}/${optional.length}`}
                veredicto={
                  !medido ? 'sin-dato' : optionalOk >= optional.length ? 'normal' : 'vigilar'
                }
              />
            )}
          </Hoja>

          <p className="max-w-[75ch] text-base text-tinta-2">
            Crea estos registros en el panel DNS de tu proveedor (Cloudflare, IONOS,
            GoDaddy…) copiando cada muestra tal cual. Los cambios pueden tardar de minutos a
            horas en propagarse; vuelve a medir cuando los tengas.
          </p>

          <Hoja
            title="Registros obligatorios"
            meta={`${requiredOk} de ${requiredTotal} en rango`}
            flush
          >
            <ul>
              {porVeredicto(required).map((check) => (
                <RegistroMedido key={check.id} check={check} recien={justVerified} />
              ))}
            </ul>
          </Hoja>

          {optional.length > 0 && (
            <Hoja
              title="Recomendados (autoconfiguración y endurecimiento)"
              meta={`${optionalOk} de ${optional.length} en rango`}
              flush
            >
              <ul>
                {porVeredicto(optional).map((check) => (
                  <RegistroMedido key={check.id} check={check} recien={justVerified} />
                ))}
              </ul>
            </Hoja>
          )}
        </div>
      )}

      <Dialogo open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Eliminar dominio">
        <div className="flex flex-col gap-4">
          <p className="text-base text-tinta-2">
            Se eliminarán el dominio, <strong className="text-tinta">todos sus buzones con su
            correo dentro</strong> y sus alias, tanto de Mailway como del motor de correo. Esta
            acción no tiene vuelta atrás.
          </p>
          <Input
            label={`Escribe ${record.domain} para confirmar`}
            mono
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={record.domain}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="plano" onClick={() => setConfirmOpen(false)}>
              Cancelar
            </Button>
            <Button
              variant="peligro"
              disabled={confirmText.trim().toLowerCase() !== record.domain}
              busy={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Eliminar definitivamente
            </Button>
          </div>
        </div>
      </Dialogo>
    </>
  );
}

/**
 * Una medición: el valor de referencia que hay que crear (la muestra que el
 * usuario se lleva a su proveedor) y, debajo, lo que el DNS devuelve ahora.
 */
function RegistroMedido({ check, recien }: { check: DnsCheck; recien: boolean }) {
  const veredicto = veredictoDe[check.status];
  const fuera = veredicto === 'fuera';

  return (
    <li className="regla-fila px-4 py-3.5 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <h3 className="min-w-0 basis-full text-base font-medium text-tinta sm:basis-0 sm:grow">
          {check.label}
        </h3>
        <span className="rotulo shrink-0">{check.type}</span>
        <span className={`ml-auto shrink-0 sm:ml-0 ${recien ? 'revelar' : ''}`}>
          <MarcaFondo veredicto={veredicto}>{etiquetaDe[check.status]}</MarcaFondo>
        </span>
      </div>

      <Muestra
        rotulo="Valor de referencia"
        copiar={check.expected}
        className="mt-2.5"
      >
        {/* Las pistas se acotan a minmax(0,…) para que un valor largo se
            desplace dentro de su celda en vez de ensanchar la hoja. */}
        <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="rotulo sm:pt-px">Nombre</dt>
          <dd className={`valor min-w-0 text-sm text-tinta ${cinta}`}>{check.name}</dd>
          <dt className="rotulo mt-1 sm:mt-0 sm:pt-px">Valor</dt>
          <dd className={`valor min-w-0 text-sm text-tinta ${cinta}`}>{check.expected}</dd>
        </dl>
      </Muestra>

      {check.status !== 'ok' && (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="rotulo shrink-0">Ahora mismo el DNS devuelve</span>
          <span
            className={`valor min-w-0 basis-full text-sm sm:basis-0 sm:grow ${cinta} ${
              check.found ? (fuera ? 'text-fuera' : 'text-tinta-2') : 'text-tinta-3'
            }`}
          >
            {check.found || (check.status === 'unknown' ? 'sin lectura' : 'ningún registro')}
          </span>
        </p>
      )}

      <p className="mt-2 max-w-[75ch] text-sm text-tinta-2">{check.help}</p>
    </li>
  );
}
