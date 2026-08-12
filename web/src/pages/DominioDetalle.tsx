import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type DnsCheck, type DomainRecord } from '../lib/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';
import {
  Barcode,
  BotonCopiar,
  Cargando,
  Dialogo,
  Encabezado,
  Estado,
  Etiqueta,
  Panel,
  Sello,
} from '../ui/kit';
import { useToast } from '../ui/toast';
import { formatDate } from '../lib/format';

const statusMeta: Record<
  DnsCheck['status'],
  { tone: 'entregado' | 'transito' | 'devuelto' | 'neutro'; label: string }
> = {
  ok: { tone: 'entregado', label: 'Verificado' },
  missing: { tone: 'transito', label: 'Falta' },
  mismatch: { tone: 'devuelto', label: 'No coincide' },
  unknown: { tone: 'neutro', label: 'Sin comprobar' },
};

/**
 * La aduana del dominio: cada registro DNS es una etiqueta que el usuario
 * imprime (copia) en su proveedor; al verificar, los correctos quedan
 * sellados como VERIFICADO.
 */
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

  if (domain.isPending) return <Cargando label="Abriendo el expediente del dominio…" />;
  if (domain.isError || !domain.data) {
    return (
      <p className="text-devuelto">
        No se encontró el dominio. <Link className="underline" to="/dominios">Volver a dominios</Link>
      </p>
    );
  }

  const record = domain.data.domain;
  const checks = record.dnsStatus.checks ?? [];
  const required = checks.filter((c) => c.required);
  const optional = checks.filter((c) => !c.required);

  return (
    <>
      <Encabezado
        title={<span className="font-guia text-xl font-bold tracking-normal">{record.domain}</span>}
        meta={
          <span className="flex flex-wrap items-center gap-2.5">
            {record.status === 'active' ? (
              <Estado tone="entregado">En reparto</Estado>
            ) : (
              <Estado tone="transito">Esperando DNS</Estado>
            )}
            <span className="text-tinta-3">
              Última verificación: {formatDate(record.lastCheckedAt)}
            </span>
          </span>
        }
        actions={
          <>
            <Button variant="peligro" onClick={() => setConfirmOpen(true)}>
              Eliminar
            </Button>
            <Button variant="accion" busy={verify.isPending} onClick={() => verify.mutate()}>
              Verificar DNS ahora
            </Button>
          </>
        }
      />

      {checks.length === 0 ? (
        <Panel>
          <p className="text-tinta-2">
            Aún no hay lectura del DNS. Pulsa «Verificar DNS ahora» para obtener los
            registros que debes crear.
          </p>
        </Panel>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="max-w-[70ch] text-sm text-tinta-2">
            Crea estos registros en el panel DNS de tu proveedor (Cloudflare, IONOS,
            GoDaddy…) copiando cada etiqueta tal cual. Los cambios pueden tardar de
            minutos a horas en propagarse; vuelve a pulsar «Verificar» cuando los tengas.
          </p>

          <Panel title="Registros obligatorios" flush>
            <ul>
              {required.map((check) => (
                <ChecklistRow key={check.id} check={check} stamped={justVerified} />
              ))}
            </ul>
          </Panel>

          {optional.length > 0 && (
            <Panel title="Recomendados (autoconfiguración y endurecimiento)" flush>
              <ul>
                {optional.map((check) => (
                  <ChecklistRow key={check.id} check={check} stamped={justVerified} />
                ))}
              </ul>
            </Panel>
          )}
        </div>
      )}

      <Dialogo open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Eliminar dominio">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-tinta-2">
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
          <div className="flex justify-end gap-2">
            <Button variant="fantasma" onClick={() => setConfirmOpen(false)}>
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

function ChecklistRow({ check, stamped }: { check: DnsCheck; stamped: boolean }) {
  const meta = statusMeta[check.status];
  return (
    <li className="border-b border-suave px-4 py-3 last:border-0">
      <div className="mb-2 flex flex-wrap items-center gap-2.5">
        <span className="text-base font-medium text-tinta">{check.label}</span>
        <span className="flex-1" />
        {check.status === 'ok' ? (
          <Sello tone="entregado" stamped={stamped}>
            Verificado
          </Sello>
        ) : (
          <Estado tone={meta.tone}>{meta.label}</Estado>
        )}
      </div>

      {/* La etiqueta imprimible: lo que hay que pegar en el proveedor DNS.
          Los valores no se parten a mitad de palabra: en pantallas estrechas
          se desplazan en horizontal para poder copiarlos sin errores. */}
      <Etiqueta>
        <div className="flex items-start gap-3 px-3.5 py-2.5">
          <div className="grid min-w-0 flex-1 gap-1.5 sm:grid-cols-[52px_minmax(120px,0.8fr)_1.4fr] sm:items-baseline">
            <span className="font-guia text-micro font-bold uppercase text-[rgb(var(--etiqueta-tinta)/0.65)]">
              {check.type}
            </span>
            <code className="block overflow-x-auto whitespace-nowrap font-guia text-sm [scrollbar-width:none]">
              {check.name}
            </code>
            <code className="block overflow-x-auto whitespace-nowrap font-guia text-sm [scrollbar-width:none]">
              {check.expected}
            </code>
          </div>
          <div className="hidden text-[rgb(var(--etiqueta-tinta))] sm:block">
            <Barcode seed={check.name + check.type} />
          </div>
          <BotonCopiar text={check.expected} label="Copiar valor" />
        </div>
      </Etiqueta>

      <p className="mt-2 max-w-[75ch] text-sm text-tinta-3">{check.help}</p>
      {check.status === 'mismatch' && check.found && (
        <p className="mt-1 break-all font-guia text-micro text-devuelto">
          Ahora mismo el DNS devuelve: {check.found}
        </p>
      )}
    </li>
  );
}
