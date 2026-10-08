import { useState, type Ref } from 'react';
import { ExternalLink, Inbox, Mail } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useDireccionPanel } from '../../components/gestion/consultas';
import { BotonCopiarTexto, mailtoEnlacePersona } from '../../components/EnlacesEquipo';
import { QR } from '../../components/QR';
import { mensajeDe } from '../../lib/gestion';
import { esDispositivoMovil, fechaLarga } from '../../lib/portal';
import { Button, estiloBoton } from '../../ui/Button';
import { Select } from '../../ui/Field';
import { AvisoError, Hoja, Marca, Vacio } from '../../ui/kit';
import { enlaceConContrasenaNueva, invalidarCorreo, marcarConfigurado, type EnlaceGuardado } from './comun';
import { CabeceraPaso, PieDePaso, type ContextoPuesta } from './marco';

/**
 * Buzón de quien hace la puesta en marcha: el que marcó como suyo al crear
 * el equipo o, si no consta (otro navegador), el que lleva su nombre o su
 * correo; si no, el primero.
 */
export function buzonPropio(ctx: Pick<ContextoPuesta, 'buzones' | 'mioId' | 'usuario'>): string | null {
  return buzonPropioSeguro(ctx) ?? ctx.buzones[0]?.id ?? null;
}

/**
 * Lo mismo, pero sin recurrir al primero: solo si consta o coincide con su
 * nombre o su correo. Es el que marca «Tú» en la lista y el que da el estado
 * del paso 4; un buzón adivinado no debe salir como el suyo.
 */
export function buzonPropioSeguro(ctx: Pick<ContextoPuesta, 'buzones' | 'mioId' | 'usuario'>): string | null {
  const { buzones, mioId, usuario } = ctx;
  if (mioId && buzones.some((b) => b.id === mioId)) return mioId;
  const nombre = usuario.name.trim().toLowerCase();
  const porNombre = buzones.find(
    (b) => b.email.toLowerCase() === usuario.email.toLowerCase() || (nombre && b.displayName.trim().toLowerCase() === nombre),
  );
  return porNombre?.id ?? null;
}

export function PasoDispositivos({ ctx, tituloRef }: { ctx: ContextoPuesta; tituloRef: Ref<HTMLHeadingElement> }) {
  const panel = useDireccionPanel({ user: ctx.usuario });
  const [elegido, setElegido] = useState<string | null>(() => buzonPropio(ctx));
  const buzon = ctx.buzones.find((b) => b.id === elegido) ?? null;
  const enlace = buzon ? ctx.enlaces.find((e) => e.mailboxId === buzon.id) : undefined;
  const webmail = ctx.panel.webmailUrl;
  const queryClient = useQueryClient();
  const configurado = Boolean(buzon?.configuredAt);

  const preparar = useMutation({
    mutationFn: (id: string) => enlaceConContrasenaNueva(id),
    onSuccess: (link, id) => {
      const b = ctx.buzones.find((x) => x.id === id);
      if (!b) return;
      ctx.setEnlaces((prev) => [
        {
          mailboxId: b.id,
          nombre: b.displayName,
          email: b.email,
          url: link.url,
          expiresAt: link.expiresAt,
          hasPassword: link.hasPassword,
          mio: true,
        },
        ...prev.filter((p) => p.mailboxId !== b.id).map((p) => ({ ...p, mio: false })),
      ]);
    },
  });

  // «Ya lo he configurado» lo deja marcado en el servidor: el paso deja de
  // salir en rojo también en otro navegador. Si lo configuró con el enlace o
  // entró en el webmail, ya estaba marcado solo.
  const terminar = useMutation({
    mutationFn: async () => {
      if (buzon && !configurado) {
        await marcarConfigurado(buzon.id, true);
        await invalidarCorreo(queryClient);
      }
    },
    onSuccess: () => ctx.irA('listo'),
  });

  return (
    <>
      <CabeceraPaso ref={tituloRef} titulo="Tu correo en tus dispositivos">
        Configura tu buzón en el móvil y en el ordenador. Con tu enlace se hace solo: abres, eliges el dispositivo y
        sigues los pasos.
      </CabeceraPaso>

      {ctx.buzones.length === 0 ? (
        <Hoja>
          <Vacio
            icono={Inbox}
            title="Primero, tu buzón"
            action={
              <Button variant="perfil" onClick={() => ctx.irA('equipo')}>
                Ir a «Tu equipo»
              </Button>
            }
          >
            Crea tu buzón en el paso «Tu equipo» y vuelve aquí para configurarlo.
          </Vacio>
        </Hoja>
      ) : (
        <>
          <Hoja>
            {buzon && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <span className="min-w-0 text-base text-tinta-2">
                  {configurado ? 'Tu buzón ya está configurado.' : 'Tu buzón aún no está configurado.'}
                </span>
                <Marca veredicto={configurado ? 'normal' : 'fuera'}>{configurado ? 'Configurado' : 'Sin configurar'}</Marca>
              </div>
            )}
            <Select
              label="¿Cuál es tu buzón?"
              value={elegido ?? ''}
              onChange={(e) => {
                setElegido(e.target.value);
                ctx.setMioId(e.target.value);
                preparar.reset();
              }}
            >
              {ctx.buzones.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.displayName ? `${b.displayName} · ${b.email}` : b.email}
                </option>
              ))}
            </Select>
          </Hoja>

          {buzon && enlace ? (
            <EnlacePropio enlace={enlace} />
          ) : buzon ? (
            <Hoja title="Prepara tu enlace">
              <div className="flex flex-col gap-3">
                <p className="max-w-[68ch] text-base text-tinta-2">
                  Se generará una contraseña nueva para <span className="break-all font-medium text-tinta">{buzon.email}</span>{' '}
                  y un enlace que la incluye, para que no tengas que escribirla. Si ya usas este buzón en algún
                  dispositivo, tendrás que volver a configurarlo con el enlace.
                </p>
                {preparar.isError && (
                  <AvisoError>{mensajeDe(preparar.error, 'No se ha podido preparar el enlace.')}</AvisoError>
                )}
                <Button
                  variant="perfil"
                  className="self-start"
                  busy={preparar.isPending}
                  disabled={ctx.suspendido || buzon.status !== 'active'}
                  onClick={() => preparar.mutate(buzon.id)}
                >
                  Preparar mi enlace
                </Button>
              </div>
            </Hoja>
          ) : null}

          <Hoja title="Sin configurar nada">
            <div className="flex flex-col gap-3 text-base text-tinta-2">
              {webmail ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="min-w-0 max-w-[60ch] flex-1 basis-60">
                    Desde cualquier navegador puedes leer y enviar correo con el webmail: entra con tu dirección y tu
                    contraseña.
                  </p>
                  <a href={webmail} target="_blank" rel="noreferrer noopener" className={estiloBoton('perfil')}>
                    Abrir el webmail
                    <ExternalLink className="h-4 w-4" aria-hidden />
                  </a>
                </div>
              ) : null}
              <p className="max-w-[68ch]">
                En <span className="valor break-all text-tinta">{panel}/mi-buzon</span> cada persona de tu equipo puede
                cambiar su contraseña y consultar los datos de conexión de su buzón.
              </p>
            </div>
          </Hoja>
        </>
      )}

      <PieDePaso
        atras="Direcciones obligatorias"
        onAtras={() => ctx.irA('obligatorias')}
        saltar={
          <Button variant="plano" onClick={() => ctx.irA('listo')}>
            Lo haré más tarde
          </Button>
        }
        principal={
          <Button variant="principal" busy={terminar.isPending} disabled={!buzon} onClick={() => terminar.mutate()}>
            {configurado ? 'Continuar' : 'Ya lo he configurado'}
          </Button>
        }
        nota={
          terminar.isError ? (
            <span className="text-fuera">{mensajeDe(terminar.error, 'No se ha podido guardar. Vuelve a intentarlo.')}</span>
          ) : undefined
        }
      />
    </>
  );
}

/**
 * El enlace de quien hace la puesta en marcha. En el ordenador, el QR manda:
 * se escanea con el móvil. En el móvil, el QR no sirve (no se puede escanear
 * la propia pantalla) y lo que manda es abrir el enlace.
 */
function EnlacePropio({ enlace }: { enlace: EnlaceGuardado }) {
  const movil = esDispositivoMovil();
  return (
    <Hoja title="Tu enlace de configuración" meta={`Válido hasta el ${fechaLarga(enlace.expiresAt)}`}>
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        {!movil && (
          <QR
            texto={enlace.url}
            tamano={184}
            etiqueta={`Código QR para configurar ${enlace.email} en el móvil`}
            className="self-center rounded-lg sm:self-auto"
          />
        )}
        <div className="flex min-w-0 flex-col gap-3">
          <p className="max-w-[60ch] text-base text-tinta">
            {movil
              ? 'Abre el enlace en este móvil y sigue los pasos: en un par de minutos tendrás el correo configurado. Para el ordenador, ábrelo también allí.'
              : 'Escanea el código con la cámara del móvil y sigue los pasos: en un par de minutos tendrás el correo en el teléfono. Para este ordenador, abre el enlace aquí.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={enlace.url} target="_blank" rel="noreferrer noopener" className={estiloBoton('perfil')}>
              Abrir el enlace
              <ExternalLink className="h-4 w-4" aria-hidden />
            </a>
            <BotonCopiarTexto texto={enlace.url} rotulo="Copiar" />
            {enlace.correoPersonal && (
              <a href={mailtoEnlacePersona(enlace)} className={estiloBoton('plano')}>
                <Mail className="h-4 w-4" aria-hidden />
                Enviármelo por correo
              </a>
            )}
          </div>
          {enlace.hasPassword && (
            <p className="max-w-[60ch] text-sm text-tinta-3">
              El enlace incluye tu contraseña: no lo compartas. Cuando indiques en él que ya está configurado, la
              contraseña se borra del enlace.
            </p>
          )}
        </div>
      </div>
    </Hoja>
  );
}
