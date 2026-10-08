import { useState, type Ref } from 'react';
import { CircleDashed, Globe } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DireccionObligatoria } from '../../lib/api';
import { propiedadPendiente, type DominioCorreo } from '../../lib/cloudflare';
import { esCorreoValido, mensajeDe } from '../../lib/gestion';
import { Button } from '../../ui/Button';
import { Input, Select } from '../../ui/Field';
import { AvisoError, Cargando, Hoja, Vacio } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { invalidarCorreo } from './comun';
import { CabeceraPaso, FilaEstado, PieDePaso, type ContextoPuesta } from './marco';

const NINGUNO = '';

const PORQUE = {
  postmaster: 'Avisos de entrega: mensajes que no han llegado, rebotes y problemas con otros servidores.',
  abuse: 'Quejas de abuso: si alguien denuncia correo no deseado enviado desde tu dominio.',
} as const;

export function PasoObligatorias({ ctx, tituloRef }: { ctx: ContextoPuesta; tituloRef: Ref<HTMLHeadingElement> }) {
  const cabecera = (
    <CabeceraPaso ref={tituloRef} titulo="Direcciones obligatorias">
      Los estándares del correo exigen que todo dominio tenga postmaster@ y abuse@: ahí llegan los avisos de
      entrega y las quejas por abuso. No ocupan buzones ni cuentan para tu plan.
    </CabeceraPaso>
  );
  const pie = (
    <PieDePaso
      atras="Tu equipo"
      onAtras={() => ctx.irA('equipo')}
      saltar={
        <Button variant="plano" onClick={() => ctx.irA('dispositivos')}>
          Saltar por ahora
        </Button>
      }
    />
  );
  if (!ctx.dominio || propiedadPendiente(ctx.dominio)) {
    return (
      <>
        {cabecera}
        <Hoja>
          <Vacio
            icono={ctx.dominio ? CircleDashed : Globe}
            title={ctx.dominio ? 'Falta comprobar que el dominio es tuyo' : 'Primero se necesita un dominio'}
            action={
              <Button variant="perfil" onClick={() => ctx.irA('dominio')}>
                Ir a «Tu dominio»
              </Button>
            }
          >
            Estas direcciones se crean en tu dominio en cuanto esté comprobado que es tuyo.
          </Vacio>
        </Hoja>
        {pie}
      </>
    );
  }
  return <Obligatorias ctx={ctx} dominio={ctx.dominio} cabecera={cabecera} />;
}

function Obligatorias({
  ctx,
  dominio,
  cabecera,
}: {
  ctx: ContextoPuesta;
  dominio: DominioCorreo;
  cabecera: JSX.Element;
}) {
  const estado = useQuery({
    queryKey: ['essential-addresses', dominio.id],
    queryFn: () => api.get<{ addresses: DireccionObligatoria[] }>(`/api/domains/${dominio.id}/essential-addresses`),
  });

  if (!estado.data) {
    return (
      <>
        {cabecera}
        {estado.isError ? (
          <AvisoError onRetry={() => void estado.refetch()} retrying={estado.isFetching}>
            {mensajeDe(estado.error, 'No se ha podido consultar el estado de estas direcciones.')}
          </AvisoError>
        ) : (
          <Hoja>
            <Cargando label="Consultando postmaster@ y abuse@…" />
          </Hoja>
        )}
        <PieDePaso
          atras="Tu equipo"
          onAtras={() => ctx.irA('equipo')}
          saltar={
            <Button variant="plano" onClick={() => ctx.irA('dispositivos')}>
              Saltar por ahora
            </Button>
          }
        />
      </>
    );
  }
  return <Formulario ctx={ctx} dominio={dominio} cabecera={cabecera} direcciones={estado.data.addresses} />;
}

/**
 * El formulario parte de lo que ya hay (los dos alias van al mismo sitio) o,
 * si no hay nada, del buzón de quien hace la puesta en marcha.
 */
function Formulario({
  ctx,
  dominio,
  cabecera,
  direcciones,
}: {
  ctx: ContextoPuesta;
  dominio: DominioCorreo;
  cabecera: JSX.Element;
  direcciones: DireccionObligatoria[];
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const pendientes = direcciones.filter((d) => d.kind !== 'mailbox');
  const configuradas = direcciones.length > 0 && direcciones.every((d) => d.kind !== null);
  const actuales = direcciones.find((d) => d.kind === 'alias')?.destinations ?? [];
  const esInterno = (email: string) => ctx.buzonesCliente.some((b) => b.email.toLowerCase() === email.toLowerCase());

  const [buzon, setBuzon] = useState(() => {
    const interno = actuales.find(esInterno);
    if (interno) return interno;
    if (actuales.length > 0) return NINGUNO;
    const mio = ctx.buzonesCliente.find((b) => b.id === ctx.mioId)?.email;
    return mio ?? ctx.buzonesCliente[0]?.email ?? NINGUNO;
  });
  const [externa, setExterna] = useState(() => actuales.find((d) => !esInterno(d)) ?? '');
  const [error, setError] = useState('');
  const [errorExterna, setErrorExterna] = useState('');

  const fuera = externa.trim();
  const destinos = [buzon, fuera].filter(Boolean);
  const sinCambios =
    configuradas &&
    destinos.length === actuales.length &&
    destinos.every((d) => actuales.some((a) => a.toLowerCase() === d.toLowerCase()));
  const soloBuzones = direcciones.length > 0 && pendientes.length === 0;

  const guardar = useMutation({
    mutationFn: () =>
      api.put<{ addresses: DireccionObligatoria[] }>(`/api/domains/${dominio.id}/essential-addresses`, {
        destinations: destinos,
      }),
    onSuccess: async (data) => {
      queryClient.setQueryData(['essential-addresses', dominio.id], data);
      await invalidarCorreo(queryClient);
      toast('ok', configuradas ? 'Destino de postmaster@ y abuse@ guardado.' : 'postmaster@ y abuse@ creadas.');
      ctx.irA('dispositivos');
    },
    onError: (err) => setError(mensajeDe(err, 'No se han podido guardar las direcciones.')),
  });

  function enviar() {
    setError('');
    if (fuera && !esCorreoValido(fuera)) {
      setErrorExterna('Esta dirección no parece válida. Revísala o déjala en blanco.');
      return;
    }
    if (destinos.length === 0) {
      setError(
        ctx.buzonesCliente.length > 0
          ? 'Elige un buzón de tu equipo o escribe una dirección externa.'
          : 'Escribe una dirección externa, o crea antes los buzones de tu equipo en el paso anterior.',
      );
      return;
    }
    guardar.mutate();
  }

  return (
    <>
      {cabecera}

      <Hoja title="Estado" meta={dominio.domainUnicode || dominio.domain} flush>
        {direcciones.map((d) => (
          <FilaEstado
            key={d.localPart}
            concepto={<span className="break-all font-medium">{d.email}</span>}
            veredicto={d.kind ? 'normal' : 'sin-dato'}
            estado={d.kind === 'mailbox' ? 'Es un buzón: ya entrega' : d.kind === 'alias' ? 'Creada' : 'Sin crear'}
            nota={
              <>
                {PORQUE[d.localPart]}
                {d.kind === 'alias' && d.destinations.length > 0 && (
                  <span className="block break-all text-tinta-3">Reenvía a {d.destinations.join(', ')}</span>
                )}
              </>
            }
          />
        ))}
      </Hoja>

      {soloBuzones ? (
        <Hoja>
          <p className="text-base text-tinta-2">
            Las dos son buzones de tu equipo, así que ya reciben su correo. No hay nada más que hacer aquí.
          </p>
        </Hoja>
      ) : (
        <Hoja title="¿Quién las recibe?">
          <form
            id="form-obligatorias"
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              enviar();
            }}
          >
            <Select
              label="Buzón de tu equipo"
              value={buzon}
              onChange={(e) => {
                setBuzon(e.target.value);
                setError('');
              }}
              help={
                ctx.buzonesCliente.length === 0
                  ? 'Aún no hay buzones en tu equipo: usa una dirección externa o vuelve al paso anterior.'
                  : 'Lo normal es quien se ocupa del correo en la empresa.'
              }
            >
              {ctx.buzonesCliente.map((b) => (
                <option key={b.id} value={b.email}>
                  {b.displayName ? `${b.displayName} · ${b.email}` : b.email}
                  {b.id === ctx.mioId ? ' (tú)' : ''}
                </option>
              ))}
              <option value={NINGUNO}>Ningún buzón del equipo</option>
            </Select>
            <Input
              label="Y además, una dirección externa (opcional)"
              type="email"
              inputMode="email"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={externa}
              error={errorExterna || undefined}
              onChange={(e) => {
                setExterna(e.target.value);
                setError('');
                setErrorExterna('');
              }}
              placeholder="informatica@ejemplo.com"
              help="Por ejemplo, la de quien os lleva la informática. Recibirá también cada aviso."
            />
            {pendientes.length < direcciones.length && (
              <p className="text-sm text-tinta-3">
                {direcciones.find((d) => d.kind === 'mailbox')?.email} es un buzón y se queda como está.
              </p>
            )}
            {error && <AvisoError>{error}</AvisoError>}
          </form>
        </Hoja>
      )}

      <PieDePaso
        atras="Tu equipo"
        onAtras={() => ctx.irA('equipo')}
        saltar={
          !configuradas ? (
            <Button variant="plano" onClick={() => ctx.irA('dispositivos')}>
              Saltar por ahora
            </Button>
          ) : undefined
        }
        principal={
          soloBuzones || sinCambios ? (
            <Button variant="principal" onClick={() => ctx.irA('dispositivos')}>
              Continuar
            </Button>
          ) : (
            <Button
              type="submit"
              form="form-obligatorias"
              variant="principal"
              busy={guardar.isPending}
              disabled={ctx.suspendido}
            >
              {configuradas ? 'Guardar y continuar' : 'Crear y continuar'}
            </Button>
          )
        }
      />
    </>
  );
}
