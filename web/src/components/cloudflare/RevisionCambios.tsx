import { useId } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../ui/Button';
import { Cargando } from '../../ui/kit';
import type { PlanCloudflare, PlanInstancia, ZonaCloudflare } from '../../lib/cloudflare';
import { BandaAviso, BandaError, TablaCambios, claseEnlacePerfil } from './comun';

/*
  Revisión de un plan antes de aplicarlo en Cloudflare. Vive dentro de un
  Dialogo: es la única superficie de la vista con su propia acción principal
  («Aplicar en Cloudflare»), y nada se escribe en la zona sin pasar por aquí.
*/

interface Props {
  plan: PlanCloudflare | PlanInstancia | undefined;
  cargando: boolean;
  error: string | null;
  /** Dominio de correo, para acortar los nombres de las filas. */
  apex?: string;
  reemplazar: boolean;
  onReemplazar: (valor: boolean) => void;
  aplicando: boolean;
  errorAplicar: string | null;
  onAplicar: () => void;
  onCancelar: () => void;
}

function esPlanInstancia(plan: PlanCloudflare | PlanInstancia): plan is PlanInstancia {
  return 'zones' in plan;
}

function AvisoZonaPendiente({ zona }: { zona: ZonaCloudflare }) {
  if (zona.status === 'active') return null;
  return (
    <BandaAviso titulo="Zona pendiente de activación">
      La zona <span className="valor">{zona.name}</span> todavía no está activa en Cloudflare. Los
      registros se guardarán, pero no tendrán efecto hasta que los servidores de nombres del
      dominio sean los de Cloudflare
      {zona.nameServers && zona.nameServers.length > 0 && (
        <>
          : <span className="valor break-all">{zona.nameServers.join(', ')}</span>
        </>
      )}
      .
    </BandaAviso>
  );
}

export function RevisionCambios({
  plan,
  cargando,
  error,
  apex,
  reemplazar,
  onReemplazar,
  aplicando,
  errorAplicar,
  onAplicar,
  onCancelar,
}: Props) {
  const idCasilla = useId();

  if (cargando) return <Cargando label="Leyendo la zona en Cloudflare…" />;
  if (error || !plan) {
    return (
      <div className="flex flex-col gap-4">
        <BandaError>{error || 'No se ha podido leer la zona en Cloudflare.'}</BandaError>
        <div className="flex justify-end">
          <Button variant="plano" onClick={onCancelar}>
            Cerrar
          </Button>
        </div>
      </div>
    );
  }
  if (!plan.available) {
    return (
      <div className="flex flex-col gap-4">
        <BandaError>{plan.reason || 'No es posible configurar este DNS en Cloudflare.'}</BandaError>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="plano" onClick={onCancelar}>
            Cerrar
          </Button>
          <Link to="/conexiones" className={claseEnlacePerfil}>
            Ir a Conexiones
          </Link>
        </div>
      </div>
    );
  }

  const { summary } = plan;
  const pendientes = summary.create + summary.update;
  const puedeAplicar = pendientes > 0 || (summary.conflict > 0 && reemplazar);
  const zonas = esPlanInstancia(plan) ? plan.zones : plan.zone ? [plan.zone] : [];
  const sinZona = esPlanInstancia(plan) ? plan.missing : [];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-base text-tinta-2">
        {zonas.length > 0 && (
          <>
            Zona{zonas.length > 1 ? 's' : ''}{' '}
            <span className="valor text-tinta">{zonas.map((z) => z.name).join(', ')}</span>
          </>
        )}
        {plan.account && (
          <>
            {' '}· cuenta <span className="text-tinta">{plan.account.label}</span>
          </>
        )}
      </p>

      {zonas.map((z) => (
        <AvisoZonaPendiente key={z.id} zona={z} />
      ))}

      {sinZona.length > 0 && (
        <BandaAviso titulo="Nombres sin zona">
          Ninguna cuenta de la instancia contiene la zona de{' '}
          <span className="valor break-all">{sinZona.join(', ')}</span>. Estos nombres no se
          modificarán.
        </BandaAviso>
      )}

      <p className="valor text-sm text-tinta-2">
        {summary.create} nuevos · {summary.update} a actualizar · {summary.keep} correctos ·{' '}
        <span className={summary.conflict > 0 ? 'text-fuera' : ''}>{summary.conflict} en conflicto</span>
      </p>

      <TablaCambios cambios={plan.changes} apex={apex} />

      {summary.conflict > 0 && (
        <div className="rounded-lg border border-[rgb(var(--fuera)/0.35)] bg-fuera-fondo px-3 py-2.5">
          <label htmlFor={idCasilla} className="flex cursor-pointer items-baseline gap-2.5">
            <input
              id={idCasilla}
              type="checkbox"
              checked={reemplazar}
              onChange={(e) => onReemplazar(e.target.checked)}
              className="mt-0.5 shrink-0"
            />
            <span className="text-base font-medium text-tinta">Reemplazar los registros en conflicto</span>
          </label>
          <p className="mt-1.5 max-w-[75ch] text-sm text-tinta">
            Los registros en conflicto se eliminarán o sustituirán en Cloudflare. Si el dominio
            recibe hoy correo en otro proveedor, dejará de recibirlo allí en cuanto se apliquen los
            cambios: activa esta opción solo si estás trasladando el correo a este servidor. Los SPF
            duplicados y los registros bloqueados por Email Routing nunca se modifican
            automáticamente.
          </p>
        </div>
      )}

      {pendientes === 0 && summary.conflict === 0 && (
        <p className="text-base text-tinta-2">
          No hay cambios pendientes: todos los registros ya están configurados en Cloudflare.
        </p>
      )}

      {errorAplicar && <BandaError>{errorAplicar}</BandaError>}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="plano" onClick={onCancelar}>
          Cancelar
        </Button>
        <Button variant="principal" busy={aplicando} disabled={!puedeAplicar} onClick={onAplicar}>
          Aplicar en Cloudflare
        </Button>
      </div>
    </div>
  );
}
