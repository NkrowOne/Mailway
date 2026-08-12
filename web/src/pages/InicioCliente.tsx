import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type ClientDashboard } from '../lib/api';
import { Button } from '../ui/Button';
import { Escala, Hoja, Marca, MarcaFondo, Membrete, Midiendo } from '../ui/kit';

/**
 * El parte del cliente. Arriba, la puesta en marcha como lista de pasos
 * pendientes (aquí el orden SÍ es información: cada paso depende del
 * anterior). A la derecha, la carga del plan medida frente a su límite.
 */
export default function InicioCliente() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['client-dashboard'],
    queryFn: () => api.get<ClientDashboard>('/api/dashboard/client'),
  });

  if (isPending) return <Midiendo label="Leyendo tu parte…" />;
  if (isError || !data) {
    return (
      <p className="border border-regla bg-fuera-fondo px-4 py-3 text-base text-fuera">
        No se pudo cargar tu panel. Recarga la página.
      </p>
    );
  }

  const { onboarding, plan, usage, domains, messages } = data;
  const pasos = [
    {
      key: 'alta',
      label: 'Dar de alta tu dominio',
      done: onboarding.hasDomain,
      to: '/dominios',
      hint: 'Registra el dominio con el que enviarás y recibirás correo.',
    },
    {
      key: 'dns',
      label: 'Verificar el DNS',
      done: onboarding.hasActiveDomain,
      to: domains[0] ? `/dominios/${domains[0].id}` : '/dominios',
      hint: 'Copia los registros en tu proveedor de dominios y comprueba que apuntan bien.',
    },
    {
      key: 'buzones',
      label: 'Crear el primer buzón',
      done: onboarding.hasMailbox,
      to: '/buzones',
      hint: 'Las cuentas de correo de tu equipo.',
    },
    {
      key: 'api',
      label: 'Crear una clave de API',
      done: onboarding.hasApiKey,
      to: '/api-envio',
      hint: 'Solo si vas a enviar correos automáticos (códigos, avisos).',
    },
  ];
  const siguiente = pasos.find((p) => !p.done);
  const hechos = pasos.filter((p) => p.done).length;

  return (
    <>
      <Membrete
        title={data.client.name}
        meta={
          data.client.suspended ? (
            <MarcaFondo veredicto="fuera">
              Cuenta suspendida: contacta con tu proveedor
            </MarcaFondo>
          ) : (
            <span>
              Plan <span className="font-medium text-tinta">{plan.name}</span> ·{' '}
              {hechos === pasos.length
                ? 'puesta en marcha completa'
                : `${hechos} de ${pasos.length} pasos completados`}
            </span>
          )
        }
        actions={
          siguiente ? (
            <Link to={siguiente.to}>
              <Button variant="tinta">{siguiente.label}</Button>
            </Link>
          ) : (
            data.webmailUrl && (
              <a href={data.webmailUrl} target="_blank" rel="noreferrer">
                <Button variant="tinta">Abrir webmail</Button>
              </a>
            )
          )
        }
      />

      <div className="grid items-start gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Hoja
          title="Puesta en marcha"
          meta={
            <span className="valor">
              {hechos}/{pasos.length}
            </span>
          }
          flush
        >
          <ol>
            {pasos.map((paso, i) => (
              <li key={paso.key} className="regla-fila last:border-b-0">
                <Link
                  to={paso.to}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 transition-colors duration-100 hover:bg-hoja-3"
                >
                  <span
                    aria-hidden
                    className={`valor shrink-0 text-sm ${
                      paso.done ? 'text-normal' : paso === siguiente ? 'text-laboratorio' : 'text-tinta-3'
                    }`}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 basis-48">
                    <p
                      className={`text-base ${
                        paso.done ? 'text-tinta-2' : 'font-medium text-tinta'
                      }`}
                    >
                      {paso.label}
                    </p>
                    {!paso.done && <p className="text-sm text-tinta-2">{paso.hint}</p>}
                  </div>
                  <span className="shrink-0">
                    {paso.done ? (
                      <Marca veredicto="normal">Hecho</Marca>
                    ) : paso === siguiente ? (
                      <Marca veredicto="vigilar">Siguiente</Marca>
                    ) : (
                      <Marca veredicto="sin-dato">Pendiente</Marca>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </Hoja>

        <Hoja title="Carga del plan" meta="Uso frente a tu límite">
          <div className="flex flex-col gap-4">
            <Escala label="Dominios" usado={usage.domains} maximo={plan.maxDomains} />
            <Escala label="Buzones" usado={usage.mailboxes} maximo={plan.maxMailboxes} />
            <Escala label="Alias" usado={usage.aliases} maximo={plan.maxAliases} />
            <div className="border-t border-regla pt-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-base text-tinta-2">Envíos por API · 7 días</span>
                <span className="valor text-md font-medium text-tinta">{messages.last7d}</span>
              </div>
              {messages.failed7d > 0 && (
                <p className="mt-1 text-sm text-fuera">
                  {messages.failed7d} envío(s) fallido(s). Míralos en API de envío.
                </p>
              )}
            </div>
          </div>
        </Hoja>
      </div>

      {domains.length > 0 && (
        <Hoja title="Tus dominios" className="mt-4" flush>
          <ul>
            {domains.map((domain) => (
              <li key={domain.id} className="regla-fila last:border-b-0">
                <Link
                  to={`/dominios/${domain.id}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 py-2.5 transition-colors duration-100 hover:bg-hoja-3"
                >
                  <span className="valor min-w-0 text-base text-tinta">{domain.domain}</span>
                  <MarcaFondo veredicto={domain.status === 'active' ? 'normal' : 'vigilar'}>
                    {domain.status === 'active' ? 'Verificado' : 'DNS pendiente'}
                  </MarcaFondo>
                </Link>
              </li>
            ))}
          </ul>
        </Hoja>
      )}
    </>
  );
}
