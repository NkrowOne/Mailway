import type { ReactNode } from 'react';
import { ListChecks } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type ClientDashboard } from '../lib/api';
import { plural } from '../lib/format';
import { dominiosQueCuentan } from '../lib/cambioDominio';
import { lecturaDominio } from '../lib/cloudflare';
import { pesoVeredicto } from '../lib/dominios';
import { useDireccionPanel, useUsuario } from '../components/gestion/consultas';
import { estiloBoton } from '../ui/Button';
import {
  AvisoError,
  Escala,
  Hoja,
  Marca,
  MarcaFondo,
  Membrete,
  Cargando,
  Tesela,
} from '../ui/kit';

interface Paso {
  key: string;
  label: string;
  /** null = no se puede medir desde el panel (p. ej. dispositivos conectados). */
  done: boolean | null;
  to: string;
  hint: ReactNode;
  /** Los pasos opcionales no cuentan para «puesta en marcha completa». */
  obligatorio: boolean;
}

/** Enlace dentro de la pista de un paso: por encima del enlace que ocupa la fila. */
const enlacePista = 'relative z-10 text-petroleo underline underline-offset-2 hover:text-tinta';


/**
 * El parte del cliente. Arriba, la puesta en marcha como lista de pasos
 * (aquí el orden SÍ es información: cada paso depende del anterior). A la
 * derecha, la carga del plan medida frente a su límite.
 */
export default function InicioCliente() {
  const { data, isPending, isFetching, refetch } = useQuery({
    queryKey: ['client-dashboard'],
    queryFn: () => api.get<ClientDashboard>('/api/dashboard/client'),
  });
  const user = useUsuario();
  // La dirección que se da a los titulares: la pública del panel (o la de
  // marca blanca del cliente), no la que muestre ahora el navegador.
  const panel = useDireccionPanel({ user });

  if (isPending) return <Cargando label="Cargando tu resumen…" />;
  // Si una relectura falla pero ya hubo datos, se siguen mostrando.
  if (!data) {
    return (
      <>
        <Membrete title="Resumen" />
        <AvisoError onRetry={() => void refetch()} retrying={isFetching}>
          No se ha podido cargar el resumen de tu correo. Comprueba la conexión y vuelve a intentarlo.
        </AvisoError>
      </>
    );
  }

  const { onboarding, plan, usage, domains, messages } = data;
  // El paso del DNS lleva al dominio que falta por verificar, no al primero
  // de la lista (que puede estar ya verificado).
  const porVerificar = domains.find((d) => d.status !== 'active') ?? domains[0];
  const portal = `${panel}/mi-buzon`;

  // Los pasos llevan a la puesta en marcha guiada, cada uno a su apartado;
  // el del DNS, a la ficha del dominio, que es donde están todos los registros.
  const pasos: Paso[] = [
    {
      key: 'alta',
      label: 'Dar de alta el dominio',
      done: onboarding.hasDomain,
      to: '/puesta-en-marcha?paso=dominio',
      hint: 'Registra el dominio con el que enviarás y recibirás correo (por ejemplo, tu-empresa.com).',
      obligatorio: true,
    },
    {
      key: 'dns',
      label: 'Configurar el DNS',
      done: onboarding.hasActiveDomain,
      to: porVerificar ? `/dominios/${porVerificar.id}` : '/puesta-en-marcha?paso=dominio',
      hint: (
        <>
          {/* Sin nombrar el producto: el panel del cliente puede ir con marca blanca. */}
          Publica en el proveedor del dominio los registros que figuran en la ficha del
          dominio. Si el dominio está en Cloudflare,{' '}
          <Link to="/conexiones" className={enlacePista}>
            conecta tu cuenta en Conexiones
          </Link>{' '}
          y los registros se crearán automáticamente.
          {onboarding.ownershipVerified && !onboarding.hasMailbox && (
            <> La propiedad ya está comprobada: puedes crear los buzones mientras tanto.</>
          )}
        </>
      ),
      obligatorio: true,
    },
    {
      key: 'buzones',
      label: 'Crear los buzones',
      done: onboarding.hasMailbox,
      to: '/puesta-en-marcha?paso=equipo',
      hint: 'Las cuentas de correo de tu equipo, todas de una vez y cada una con su enlace de configuración.',
      obligatorio: true,
    },
    {
      key: 'obligatorias',
      label: 'Crear postmaster@ y abuse@',
      done: onboarding.hasEssentialAddresses,
      to: '/puesta-en-marcha?paso=obligatorias',
      hint: 'Las exigen los estándares del correo: ahí llegan los avisos de entrega y las quejas por abuso. No cuentan para tu plan.',
      obligatorio: true,
    },
    {
      key: 'dispositivos',
      label: 'Conectar los dispositivos',
      done: null,
      to: '/puesta-en-marcha?paso=equipo',
      hint: (
        <>
          En la puesta en marcha ves quién tiene ya su correo configurado y envías la
          configuración por correo a quien le falte. También puede entrar en{' '}
          <span className="valor text-sm text-tinta">{portal}</span> con su dirección y contraseña.
        </>
      ),
      obligatorio: false,
    },
    {
      key: 'api',
      label: 'Crear una clave de API',
      done: onboarding.hasApiKey,
      to: '/api-envio',
      hint: 'Solo si tus aplicaciones envían correo automático (códigos de acceso, avisos, facturas).',
      obligatorio: false,
    },
  ];
  const obligatorios = pasos.filter((p) => p.obligatorio);
  const hechos = obligatorios.filter((p) => p.done).length;
  const siguiente = obligatorios.find((p) => !p.done);
  // Mismo veredicto que en «Dominios»: un dominio pendiente no se ve ámbar
  // aquí y carmín allí, y sin lectura del DNS no se afirma que esté mal.
  const dominiosOrdenados = [...domains].sort(
    (a, b) => pesoVeredicto[lecturaDominio(a).veredicto] - pesoVeredicto[lecturaDominio(b).veredicto],
  );

  return (
    <>
      <Membrete
        title={data.client.name}
        meta={
          data.client.suspended ? (
            <MarcaFondo veredicto="fuera">
              Cuenta suspendida: ponte en contacto con tu proveedor
            </MarcaFondo>
          ) : (
            <span>
              Plan <span className="font-medium text-tinta">{plan.name}</span> ·{' '}
              {hechos === obligatorios.length
                ? 'puesta en marcha completa'
                : `${hechos} de ${obligatorios.length} pasos obligatorios completados`}
            </span>
          )
        }
        actions={
          data.webmailUrl ? (
            // El webmail siempre a mano; mientras quede un paso pendiente, la
            // acción principal es la puesta en marcha (debajo) y el webmail
            // pasa a secundaria.
            <a
              href={data.webmailUrl}
              target="_blank"
              rel="noreferrer"
              className={estiloBoton(siguiente ? 'perfil' : 'principal')}
            >
              Abrir webmail <span aria-hidden>↗</span>
            </a>
          ) : undefined
        }
      />

      {siguiente && !data.client.suspended && (
        <Hoja className="mb-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <Tesela icono={ListChecks} />
            <div className="min-w-0 flex-1 basis-64">
              <p className="text-md font-semibold text-tinta">
                {hechos === 0 ? 'Pon en marcha el correo de tu empresa' : 'Tu correo aún no está listo del todo'}
              </p>
              <p className="max-w-[68ch] text-base text-tinta-2">
                {hechos === 0
                  ? 'Dominio, buzones de todo el equipo y dispositivos, paso a paso. Se guarda solo: puedes dejarlo y seguir más tarde.'
                  : `Siguiente: ${siguiente.label.charAt(0).toLowerCase()}${siguiente.label.slice(1)}. La puesta en marcha te guía y sigue donde lo dejaste.`}
              </p>
            </div>
            <Link to="/puesta-en-marcha" className={estiloBoton('principal', 'w-full sm:w-auto')}>
              {hechos === 0 ? 'Empezar la puesta en marcha' : 'Continuar la puesta en marcha'}
            </Link>
          </div>
        </Hoja>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Hoja
          title="Primeros pasos"
          meta={
            <span className="valor">
              {hechos}/{obligatorios.length}
            </span>
          }
          flush
        >
          <ol>
            {pasos.map((paso, i) => {
              const esSiguiente = paso === siguiente;
              return (
                <li
                  key={paso.key}
                  className="regla-fila relative flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3
                    transition-colors duration-100 last:border-b-0 focus-within:bg-hoja-3 hover:bg-hoja-3"
                >
                  <span
                    aria-hidden
                    className={`valor shrink-0 text-sm ${
                      paso.done ? 'text-normal' : esSiguiente ? 'text-petroleo' : 'text-tinta-3'
                    }`}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 basis-48">
                    {/* Un solo enlace por fila; su ::after cubre la fila entera
                        para que todo el renglón sea pulsable sin anidar enlaces. */}
                    <Link
                      to={paso.to}
                      className={`text-base after:absolute after:inset-0 after:content-[''] ${
                        paso.done ? 'text-tinta-2' : 'font-medium text-tinta'
                      }`}
                    >
                      {paso.label}
                    </Link>
                    {!paso.done && <p className="text-sm text-tinta-2">{paso.hint}</p>}
                  </div>
                  <span className="ml-auto shrink-0">
                    {paso.done ? (
                      <Marca veredicto="normal">Hecho</Marca>
                    ) : esSiguiente ? (
                      <Marca veredicto="vigilar">Siguiente</Marca>
                    ) : paso.done === null ? (
                      <Marca veredicto="sin-dato">Recomendado</Marca>
                    ) : paso.obligatorio ? (
                      <Marca veredicto="sin-dato">Pendiente</Marca>
                    ) : (
                      <Marca veredicto="sin-dato">Opcional</Marca>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </Hoja>

        <Hoja title="Uso de tu plan" meta="Recursos disponibles">
          <div className="flex flex-col gap-4">
            {/* El dominio anterior de un cambio abierto no cuenta en el plan. */}
            <Escala label="Dominios" usado={dominiosQueCuentan(usage.domains, domains)} maximo={plan.maxDomains} />
            <Escala label="Buzones" usado={usage.mailboxes} maximo={plan.maxMailboxes} />
            <Escala label="Alias" usado={usage.aliases} maximo={plan.maxAliases} />
            <div className="border-t border-regla pt-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-base text-tinta-2">Envíos por API · 7 días</span>
                <span className="valor text-md font-medium text-tinta">{messages.last7d}</span>
              </div>
              {messages.failed7d > 0 ? (
                <p className="mt-1 text-sm text-fuera">
                  {plural(messages.failed7d, 'envío fallido', 'envíos fallidos')}. Consulta el
                  detalle en{' '}
                  <Link to="/api-envio" className="underline underline-offset-2 hover:text-tinta">
                    API de envío
                  </Link>
                  .
                </p>
              ) : onboarding.hasApiKey && !onboarding.hasSentMessage ? (
                <p className="mt-1 text-sm text-tinta-3">
                  La clave de API está creada, pero todavía no se ha enviado ningún mensaje.
                </p>
              ) : null}
            </div>
          </div>
        </Hoja>
      </div>

      {domains.length > 0 && (
        <Hoja title="Tus dominios" meta="Pendientes primero" className="mt-4" flush>
          <ul>
            {dominiosOrdenados.map((domain) => {
              const estado = lecturaDominio(domain);
              return (
                <li key={domain.id} className="regla-fila last:border-b-0">
                  <Link
                    to={`/dominios/${domain.id}`}
                    className={`flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 py-2.5
                      transition-colors duration-100 hover:bg-hoja-3 ${
                        estado.veredicto === 'fuera'
                          ? 'fila-fuera'
                          : estado.veredicto === 'vigilar'
                            ? 'fila-vigilar'
                            : ''
                      }`}
                  >
                    <span className="valor min-w-0 break-all text-base text-tinta">{domain.domain}</span>
                    <MarcaFondo veredicto={estado.veredicto}>{estado.etiqueta}</MarcaFondo>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Hoja>
      )}
    </>
  );
}
