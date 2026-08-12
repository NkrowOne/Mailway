import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type ClientDashboard } from '../lib/api';
import { Button } from '../ui/Button';
import { Cargando, Encabezado, Estado, Medidor, Panel, Sello } from '../ui/kit';

/**
 * Primer viewport del cliente: el manifiesto de puesta en marcha a la
 * izquierda (ALTA ›› DNS ›› BUZONES ›› API) y los medidores de carga del
 * plan a la derecha; una única tecla naranja.
 */
export default function InicioCliente() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['client-dashboard'],
    queryFn: () => api.get<ClientDashboard>('/api/dashboard/client'),
  });

  if (isPending) return <Cargando label="Leyendo el manifiesto…" />;
  if (isError || !data) {
    return <p className="text-devuelto">No se pudo cargar tu panel. Recarga la página.</p>;
  }

  const { onboarding, plan, usage, domains, messages } = data;
  const steps = [
    {
      key: 'alta',
      label: 'Alta del dominio',
      done: onboarding.hasDomain,
      to: '/dominios',
      hint: 'Registra tu dominio en la plataforma.',
    },
    {
      key: 'dns',
      label: 'DNS verificado',
      done: onboarding.hasActiveDomain,
      to: domains[0] ? `/dominios/${domains[0].id}` : '/dominios',
      hint: 'Copia los registros y verifica que apuntan bien.',
    },
    {
      key: 'buzones',
      label: 'Primer buzón',
      done: onboarding.hasMailbox,
      to: '/buzones',
      hint: 'Crea las cuentas de correo de tu equipo.',
    },
    {
      key: 'api',
      label: 'Clave de API',
      done: onboarding.hasApiKey,
      to: '/api-envio',
      hint: 'Para envíos automáticos (OTP, avisos).',
    },
  ];
  const nextStep = steps.find((s) => !s.done);
  const completed = steps.filter((s) => s.done).length;

  return (
    <>
      <Encabezado
        title={data.client.name}
        meta={
          data.client.suspended ? (
            <Estado tone="devuelto">Cuenta suspendida: contacta con tu proveedor</Estado>
          ) : (
            `Plan ${plan.name}`
          )
        }
        actions={
          nextStep ? (
            <Link to={nextStep.to}>
              <Button variant="accion">Siguiente parada: {nextStep.label}</Button>
            </Link>
          ) : (
            data.webmailUrl && (
              <a href={data.webmailUrl} target="_blank" rel="noreferrer">
                <Button variant="accion">Abrir webmail</Button>
              </a>
            )
          )
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        {/* Manifiesto de puesta en marcha */}
        <Panel
          title="Manifiesto de puesta en marcha"
          actions={
            <span className="num font-guia text-sm text-tinta-3">
              {completed}/{steps.length}
            </span>
          }
          flush
        >
          <ol>
            {steps.map((step, i) => (
              <li key={step.key} className={i > 0 ? 'border-t border-suave' : ''}>
                <Link
                  to={step.to}
                  className="group flex items-center gap-3 px-4 py-3 transition-colors duration-100 hover:bg-chasis-2"
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border font-guia text-sm ${
                      step.done
                        ? 'border-[rgb(var(--entregado)/0.5)] text-entregado'
                        : step === nextStep
                          ? 'border-[rgb(var(--accion)/0.7)] text-accion'
                          : 'border-fuerte text-tinta-3'
                    }`}
                    aria-hidden
                  >
                    {step.done ? (
                      <svg viewBox="0 0 14 14" className="h-3 w-3">
                        <path d="M2 7.5L5.5 11L12 3.5" stroke="currentColor" strokeWidth="1.8" fill="none" />
                      </svg>
                    ) : (
                      i + 1
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={`text-base font-medium ${step.done ? 'text-tinta-2' : 'text-tinta'}`}>
                      {step.label}
                    </p>
                    {!step.done && <p className="text-sm text-tinta-3">{step.hint}</p>}
                  </div>
                  {step.done ? (
                    <Sello tone="entregado">Hecho</Sello>
                  ) : step === nextStep ? (
                    <svg aria-hidden viewBox="0 0 16 12" className="h-3 w-4 text-accion transition-transform duration-100 group-hover:translate-x-0.5">
                      <path d="M1 1l5 5-5 5M8 1l5 5-5 5" stroke="currentColor" strokeWidth="1.8" fill="none" />
                    </svg>
                  ) : null}
                </Link>
              </li>
            ))}
          </ol>
        </Panel>

        {/* Carga del plan */}
        <Panel title="Carga del plan">
          <div className="flex flex-col gap-4">
            <Medidor label="Dominios" used={usage.domains} max={plan.maxDomains} />
            <Medidor label="Buzones" used={usage.mailboxes} max={plan.maxMailboxes} />
            <Medidor label="Alias" used={usage.aliases} max={plan.maxAliases} />
            <div className="border-t border-suave pt-3">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-tinta-2">Envíos API · 7 días</span>
                <span className="num font-guia text-md font-bold text-tinta">{messages.last7d}</span>
              </div>
              {messages.failed7d > 0 && (
                <p className="mt-1 text-sm text-devuelto">
                  {messages.failed7d} envío(s) fallido(s) — revisa la pestaña API.
                </p>
              )}
            </div>
          </div>
        </Panel>
      </div>

      {/* Dominios */}
      {domains.length > 0 && (
        <Panel title="Tus dominios" className="mt-4" flush>
          <ul>
            {domains.map((domain, i) => (
              <li key={domain.id} className={i > 0 ? 'border-t border-suave' : ''}>
                <Link
                  to={`/dominios/${domain.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors duration-100 hover:bg-chasis-2"
                >
                  <span className="min-w-0 flex-1 truncate font-guia text-sm text-tinta">{domain.domain}</span>
                  {domain.status === 'active' ? (
                    <Estado tone="entregado">En reparto</Estado>
                  ) : (
                    <Estado tone="transito">DNS pendiente</Estado>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
