import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DominioCorreo } from '../../lib/cloudflare';
import {
  cambioDominio,
  claveCambio,
  invalidarTrasCambio,
  mensajeCambio,
  nombresApps,
  resumenPlan,
  textoAppsManuales,
  type CambioDominioVista,
  type PlanCambioDominio,
} from '../../lib/cambioDominio';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { AvisoError, Cargando } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { BloqueosYAvisos, Seccion } from './comun';

/*
  Paso «Elegir»: el dominio nuevo y, mientras se escribe, lo que pasaría
  (plan del servidor, sin efectos). Los bloqueos se dicen aquí, antes de
  pulsar, con el mismo mensaje que daría la creación.
*/

/** Lo que se escribe, como lo normaliza el servidor (sin esquema, ruta ni punto final). */
function limpiarDominio(texto: string): string {
  return texto
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '');
}

/** Solo se pide el plan cuando lo escrito tiene forma de dominio (letras, punto y algo más). */
function pareceDominio(texto: string): boolean {
  return /^[^\s.@]+(\.[^\s.@]+)+$/.test(texto);
}

/** Se espera a que se deje de escribir: cada pulsación no debe consultar al servidor. */
function useDiferido(valor: string, ms: number): string {
  const [diferido, setDiferido] = useState(valor);
  useEffect(() => {
    const t = window.setTimeout(() => setDiferido(valor), ms);
    return () => window.clearTimeout(t);
  }, [valor, ms]);
  return diferido;
}

export function ElegirDominio({ dominio, isAdmin }: { dominio: DominioCorreo; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [texto, setTexto] = useState('');
  const [verDetalle, setVerDetalle] = useState(false);
  const limpio = limpiarDominio(texto);
  const pedido = useDiferido(limpio, 450);
  const listoParaPedir = pareceDominio(pedido);
  const desde = dominio.domainUnicode || dominio.domain;

  const plan = useQuery({
    queryKey: ['domain-migration-plan', dominio.id, pedido],
    queryFn: () => cambioDominio.plan(dominio.id, pedido),
    enabled: listoParaPedir,
    retry: false,
    staleTime: 30_000,
  });

  const crear = useMutation({
    mutationFn: (destino: string) => cambioDominio.crear(dominio.id, destino),
    onSuccess: async (vista: CambioDominioVista) => {
      queryClient.setQueryData(claveCambio(vista.id), vista);
      // La ficha cambia al asistente sin esperar a releer el dominio.
      queryClient.setQueryData<{ domain: DominioCorreo }>(['domain', dominio.id], (prev) =>
        prev
          ? {
              domain: {
                ...prev.domain,
                migracion: {
                  id: vista.id,
                  rol: 'origen',
                  estado: vista.estado,
                  pareja: vista.hacia.domain,
                  cuentaEnPlan: false,
                },
              },
            }
          : prev,
      );
      toast('ok', `Se está preparando ${vista.hacia.domain}.`);
      await invalidarTrasCambio(queryClient);
    },
  });

  // El plan que se ve corresponde a lo escrito: mientras se escribe otra cosa
  // no se ofrece «Preparar» con el plan anterior.
  const vigente = listoParaPedir && pedido === limpio ? plan.data : undefined;
  const bloqueado = !vigente || vigente.bloqueos.length > 0;
  const hacia = vigente?.hacia.domain ?? (pareceDominio(limpio) ? limpio : '');

  function enviar(e: FormEvent) {
    e.preventDefault();
    if (bloqueado || !vigente) return;
    crear.mutate(vigente.hacia.domain);
  }

  return (
    <Seccion>
      <form onSubmit={enviar} noValidate className="flex flex-col gap-4">
        <p className="max-w-[75ch] text-base text-tinta-2 [overflow-wrap:anywhere]">
          Pasa los buzones, alias, contraseñas, claves de API y formularios de {desde} a un dominio nuevo. El
          correo que llegue a {desde} seguirá entrando en los mismos buzones hasta que lo des de baja.
        </p>
        <div className="max-w-md">
          <Input
            label="Dominio nuevo"
            mono
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="nuevodominio.es"
            value={texto}
            onChange={(e) => {
              crear.reset();
              setTexto(e.target.value);
            }}
          />
        </div>

        {listoParaPedir && plan.isPending && <Cargando label={`Revisando ${pedido}…`} />}
        {listoParaPedir && plan.isError && pedido === limpio && (
          <AvisoError onRetry={() => void plan.refetch()} retrying={plan.isFetching}>
            {mensajeCambio(plan.error, 'No se ha podido revisar el dominio nuevo.')}
          </AvisoError>
        )}
        {vigente && (
          <ResumenPlan
            plan={vigente}
            isAdmin={isAdmin}
            verDetalle={verDetalle}
            onVerDetalle={() => setVerDetalle((v) => !v)}
          />
        )}
        {crear.isError && (
          <AvisoError>{mensajeCambio(crear.error, 'No se ha podido empezar el cambio de dominio.')}</AvisoError>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="submit" variant="principal" disabled={bloqueado} busy={crear.isPending}>
            {hacia ? `Preparar ${hacia}` : 'Preparar el dominio nuevo'}
          </Button>
        </div>
      </form>
    </Seccion>
  );
}

function ResumenPlan({
  plan,
  isAdmin,
  verDetalle,
  onVerDetalle,
}: {
  plan: PlanCambioDominio;
  isAdmin: boolean;
  verDetalle: boolean;
  onVerDetalle: () => void;
}) {
  const hayDetalle =
    plan.buzones.length > 0 || plan.alias.length > 0 || plan.formularios.length > 0 || Boolean(plan.webmail.viejo);
  return (
    <div className="revelar flex flex-col gap-3">
      <BloqueosYAvisos bloqueos={plan.bloqueos} avisos={plan.avisos} />
      {plan.bloqueos.length === 0 && (
        <div className="rounded-lg border border-regla bg-hoja-2 px-3 py-2.5">
          <p className="max-w-[75ch] text-base text-tinta [overflow-wrap:anywhere]">{resumenPlan(plan)}</p>
          <p className="mt-1 max-w-[75ch] text-sm text-tinta-2 [overflow-wrap:anywhere]">
            {isAdmin
              ? `${plan.desde.domain} no contará en el plan del cliente mientras dure el cambio.`
              : `${plan.desde.domain} no contará en tu plan mientras dure el cambio.`}
          </p>
          {hayDetalle && (
            <Button
              type="button"
              variant="plano"
              className="-ml-2 mt-1 px-2"
              aria-expanded={verDetalle}
              onClick={onVerDetalle}
            >
              {verDetalle ? 'Ocultar el detalle' : 'Ver el detalle'}
            </Button>
          )}
        </div>
      )}
      {plan.bloqueos.length === 0 && verDetalle && <DetallePlan plan={plan} />}
    </div>
  );
}

/** Qué se muda y adónde: una fila por buzón, alias, formulario y el webmail con tu marca. */
function DetallePlan({ plan }: { plan: PlanCambioDominio }) {
  return (
    <div className="flex flex-col gap-3">
      {plan.buzones.length > 0 && (
        <Grupo titulo="Buzones">
          {plan.buzones.map((b) => (
            <Fila key={b.id} de={b.de} a={b.a}>
              {b.usadoPorApps.length > 0 && (
                <p className="text-sm text-tinta-3">
                  Lo usa una aplicación para enviar ({nombresApps(b.usadoPorApps)}).
                </p>
              )}
              {b.appsManuales.length > 0 && (
                <p className="text-sm text-tinta-3 [overflow-wrap:anywhere]">{textoAppsManuales(b.appsManuales, b.a)}</p>
              )}
            </Fila>
          ))}
        </Grupo>
      )}
      {plan.alias.length > 0 && (
        <Grupo titulo="Alias">
          {plan.alias.map((a) => (
            <Fila key={a.id} de={a.de} a={a.a} />
          ))}
        </Grupo>
      )}
      {plan.formularios.length > 0 && (
        <Grupo titulo="Formularios">
          {plan.formularios.map((f) => (
            <li key={f.id} className="regla-fila px-3 py-2 last:border-b-0">
              <p className="text-base text-tinta [overflow-wrap:anywhere]">{f.name}</p>
              {f.origenesNuevos.length > 0 && (
                <p className="text-sm text-tinta-2 [overflow-wrap:anywhere]">
                  Se añade: <span className="valor">{f.origenesNuevos.join(', ')}</span>
                </p>
              )}
            </li>
          ))}
        </Grupo>
      )}
      {plan.webmail.viejo && (
        <Grupo titulo="Webmail con tu marca">
          <Fila de={plan.webmail.viejo} a={plan.webmail.nuevo ?? '—'} />
        </Grupo>
      )}
    </div>
  );
}

function Grupo({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div>
      <p className="rotulo mb-1.5">{titulo}</p>
      <ul className="rounded-lg border border-regla">{children}</ul>
    </div>
  );
}

/** «ana@dominio.es → ana@dominio2.es»; en móvil la flecha baja con la dirección nueva. */
function Fila({ de, a, children }: { de: string; a: string; children?: ReactNode }) {
  return (
    <li className="regla-fila px-3 py-2 last:border-b-0">
      <p className="flex flex-wrap items-baseline gap-x-2 text-base">
        <span className="valor min-w-0 break-all text-tinta-2">{de}</span>
        <span aria-hidden className="text-tinta-3">
          →
        </span>
        <span className="sr-only">pasa a</span>
        <span className="valor min-w-0 break-all text-tinta">{a}</span>
      </p>
      {children}
    </li>
  );
}
