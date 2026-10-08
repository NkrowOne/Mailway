import { useId, useMemo, useState } from 'react';
import { Check, Plus, QrCode, RotateCcw, Send } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Mailbox } from '../../lib/api';
import type { EnlaceCreado } from '../../lib/portal';
import type { DominioCorreo } from '../../lib/cloudflare';
import { plural } from '../../lib/format';
import { esCorreoValido, mensajeDe } from '../../lib/gestion';
import { BotonCopiarTexto, NotaEnlaces, textoEnlaces } from '../../components/EnlacesEquipo';
import { QR } from '../../components/QR';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { AvisoError, Dialogo, Hoja, Marca } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import {
  enlaceConContrasenaNueva,
  enviarConfiguracion,
  invalidarCorreo,
  lecturaCuenta,
  marcarConfigurado,
  remitenteConfiguracion,
  VALIDEZ_ENLACE_HORAS,
  type EnlaceGuardado,
} from './comun';
import { MarcaTu, type ContextoPuesta } from './marco';

/*
  Los buzones del equipo con el estado de su configuración. Quien hace la
  puesta en marcha tiene que hacer llegar a cada persona su enlace; aquí ve
  de un vistazo a quién le falta (en rojo) y lo resuelve sin salir de la
  fila: enviarlo por correo desde configuration@ de su dominio, copiar el
  enlace o, si ya lo configuró a mano, marcarlo.
*/

/** Sin configurar primero (es lo que hay que resolver), luego enviados y configurados. */
const ORDEN = { 'sin-configurar': 0, enviado: 1, configurado: 2 } as const;

export function ordenarCuentas(buzones: Mailbox[]): Mailbox[] {
  return [...buzones].sort(
    (a, b) =>
      ORDEN[lecturaCuenta(a).estado] - ORDEN[lecturaCuenta(b).estado] ||
      (a.displayName || a.email).localeCompare(b.displayName || b.email, 'es'),
  );
}

export function CuentasEquipo({
  ctx,
  dominio,
  onAnadir,
  onEnviar,
}: {
  ctx: ContextoPuesta;
  dominio: DominioCorreo;
  /** Abre el formulario de alta (o lleva a él). */
  onAnadir?: () => void;
  /** Abre el envío por correo con estos buzones marcados. */
  onEnviar: (ids: string[]) => void;
}) {
  const cuentas = useMemo(() => ordenarCuentas(ctx.buzones), [ctx.buzones]);
  // Los de otras personas: el propio se configura en el paso 4 (su fila lo dice).
  const sinConfigurar = cuentas.filter((b) => b.id !== ctx.mioId && lecturaCuenta(b).estado === 'sin-configurar');
  const configurados = cuentas.filter((b) => b.configuredAt).length;
  const enlaces = ctx.enlaces.filter((e) => e.email.endsWith(`@${dominio.domain}`));
  const caducan = enlaces.length > 0 ? Math.min(...enlaces.map((e) => e.expiresAt)) : 0;
  const porEnviar = sinConfigurar.filter((b) => b.status === 'active');

  return (
    <Hoja
      title="Buzones del equipo"
      meta={`${configurados} de ${plural(cuentas.length, 'configurado', 'configurados')}`}
      actions={
        <div className="flex flex-wrap gap-2">
          {enlaces.length > 1 && <BotonCopiarTexto texto={textoEnlaces(enlaces)} rotulo="Copiar los enlaces" />}
          {onAnadir && (
            <Button variant="perfil" onClick={onAnadir} disabled={ctx.suspendido}>
              <Plus className="h-4 w-4" aria-hidden />
              Añadir buzones
            </Button>
          )}
        </div>
      }
      flush
    >
      {sinConfigurar.length > 0 && (
        <div className="regla-fila fila-fuera flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3">
          <p className="min-w-0 flex-1 basis-64 text-base text-tinta">
            <strong className="font-semibold text-fuera">
              {sinConfigurar.length === 1 ? '1 buzón sin configurar.' : `${sinConfigurar.length} buzones sin configurar.`}
            </strong>{' '}
            Envía a cada persona su configuración por correo o copia su enlace y pásaselo.
          </p>
          {porEnviar.length > 0 && (
            <Button variant="principal" onClick={() => onEnviar(porEnviar.map((b) => b.id))} disabled={ctx.suspendido}>
              <Send className="h-4 w-4" aria-hidden />
              {porEnviar.length === 1 ? 'Enviar la configuración' : `Enviar la configuración a ${porEnviar.length}`}
            </Button>
          )}
        </div>
      )}
      {enlaces.length > 0 && (
        <div className="regla-fila px-4 py-3">
          <NotaEnlaces
            expiresAt={caducan}
            conContrasena={enlaces.some((e) => e.hasPassword)}
            conservacion="Los enlaces se pueden copiar mientras no cierres esta pestaña."
          />
        </div>
      )}
      <ul>
        {cuentas.map((b) => (
          <FilaCuenta
            key={b.id}
            ctx={ctx}
            buzon={b}
            enlace={ctx.enlaces.find((e) => e.mailboxId === b.id)}
            onEnviar={() => onEnviar([b.id])}
          />
        ))}
      </ul>
    </Hoja>
  );
}

function FilaCuenta({
  ctx,
  buzon,
  enlace,
  onEnviar,
}: {
  ctx: ContextoPuesta;
  buzon: Mailbox;
  /** Enlace creado en esta pestaña, con su contraseña: se puede copiar sin generar otro. */
  enlace?: EnlaceGuardado;
  onEnviar: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const lectura = lecturaCuenta(buzon);
  const mio = buzon.id === ctx.mioId;
  const activo = buzon.status === 'active' && !ctx.suspendido;
  const [accion, setAccion] = useState<'enlace' | 'marcar' | 'reiniciar' | null>(null);
  const [verQr, setVerQr] = useState(false);
  const idQr = useId();

  const crearEnlace = useMutation({
    mutationFn: () => enlaceConContrasenaNueva(buzon.id),
    onSuccess: (link) => {
      ctx.setEnlaces((prev) => [
        {
          mailboxId: buzon.id,
          nombre: buzon.displayName,
          email: buzon.email,
          url: link.url,
          expiresAt: link.expiresAt,
          hasPassword: link.hasPassword,
          mio,
        },
        ...prev.filter((p) => p.mailboxId !== buzon.id),
      ]);
      setAccion(null);
      void invalidarCorreo(queryClient);
    },
  });

  // Reiniciar (tras una prueba): como en la ficha del buzón, pero desde la
  // puesta en marcha, que es donde se gestiona la configuración del equipo.
  const reiniciar = useMutation({
    mutationFn: () =>
      api.post<{ link: EnlaceCreado }>(`/api/mailboxes/${buzon.id}/setup-reset`, {
        ttlHours: VALIDEZ_ENLACE_HORAS,
        includePassword: true,
        revokeAppPasswords: false,
      }),
    onSuccess: async ({ link }) => {
      ctx.setEnlaces((prev) => [
        {
          mailboxId: buzon.id,
          nombre: buzon.displayName,
          email: buzon.email,
          url: link.url,
          expiresAt: link.expiresAt,
          hasPassword: link.hasPassword,
          mio,
        },
        ...prev.filter((p) => p.mailboxId !== buzon.id),
      ]);
      setAccion(null);
      await invalidarCorreo(queryClient);
      toast('ok', `${buzon.displayName || buzon.email} empieza de cero: envíale la configuración o copia su enlace.`);
    },
  });

  const marcar = useMutation({
    mutationFn: () => marcarConfigurado(buzon.id, true),
    onSuccess: async () => {
      setAccion(null);
      await invalidarCorreo(queryClient);
      toast('ok', `${buzon.displayName || buzon.email} queda como configurado.`);
    },
  });

  return (
    <li className={`regla-fila px-4 py-3.5 last:border-b-0 ${lectura.veredicto === 'fuera' ? 'fila-fuera' : ''}`}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1 basis-60">
          <p className="flex flex-wrap items-baseline gap-x-2 text-base font-medium text-tinta [overflow-wrap:anywhere]">
            {buzon.displayName || buzon.email}
            {mio && <MarcaTu />}
          </p>
          {buzon.displayName && <p className="break-all text-sm text-tinta-2">{buzon.email}</p>}
        </div>
        <span className="shrink-0">
          <Marca veredicto={lectura.veredicto}>{lectura.rotulo}</Marca>
        </span>
      </div>
      <p className="mt-1 max-w-[68ch] text-sm text-tinta-2">
        {buzon.status !== 'active'
          ? 'Buzón suspendido: no se puede configurar mientras lo esté.'
          : mio && lectura.estado !== 'configurado'
            ? 'Es tu buzón: configúralo en tus dispositivos en el paso 4.'
            : lectura.nota}
      </p>

      {activo && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {mio && lectura.estado !== 'configurado' ? (
            <Button variant="perfil" onClick={() => ctx.irA('dispositivos')}>
              Configurar el mío
            </Button>
          ) : (
            <Button variant={lectura.estado === 'sin-configurar' ? 'perfil' : 'plano'} onClick={onEnviar}>
              <Send className="h-4 w-4" aria-hidden />
              {lectura.estado === 'configurado' ? 'Enviar para otro dispositivo' : lectura.estado === 'enviado' ? 'Volver a enviar' : 'Enviar por correo'}
            </Button>
          )}
          {lectura.estado !== 'configurado' &&
            (enlace ? (
              <>
                <BotonCopiarTexto texto={enlace.url} rotulo="Copiar enlace" variante="plano" />
                <Button variant="plano" aria-expanded={verQr} aria-controls={idQr} onClick={() => setVerQr((v) => !v)}>
                  <QrCode className="h-4 w-4" aria-hidden />
                  {verQr ? 'Ocultar QR' : 'Ver QR'}
                </Button>
              </>
            ) : (
              accion !== 'enlace' && (
                <Button variant="plano" onClick={() => setAccion('enlace')}>
                  Crear enlace
                </Button>
              )
            ))}
          {lectura.estado !== 'configurado' && accion !== 'marcar' && (
            <Button variant="plano" onClick={() => setAccion('marcar')}>
              <Check className="h-4 w-4" aria-hidden />
              Ya está configurado
            </Button>
          )}
          {lectura.estado === 'configurado' && accion !== 'reiniciar' && (
            <Button variant="plano" onClick={() => setAccion('reiniciar')}>
              <RotateCcw className="h-4 w-4" aria-hidden />
              Reiniciar
            </Button>
          )}
        </div>
      )}

      {enlace && verQr && (
        <div id={idQr} className="revelar mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <QR texto={enlace.url} tamano={148} etiqueta={`Código QR del enlace de configuración de ${buzon.email}`} />
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-sm text-tinta-2">Se escanea con la cámara del móvil para abrir el enlace.</p>
            <p className="valor break-all text-sm text-tinta">{enlace.url}</p>
          </div>
        </div>
      )}

      {accion === 'enlace' && (
        <div className="revelar mt-2.5 flex flex-col gap-2.5 rounded-lg border border-[rgb(var(--vigilar)/0.45)] bg-vigilar-fondo px-3 py-2.5">
          <p className="max-w-[68ch] text-sm text-tinta">
            Se generará una contraseña nueva para <span className="break-all font-medium">{buzon.email}</span> y un
            enlace que la incluye. Si ya usa este buzón en algún dispositivo, tendrá que volver a configurarlo con el
            enlace.
          </p>
          {crearEnlace.isError && <AvisoError>{mensajeDe(crearEnlace.error, 'No se ha podido crear el enlace.')}</AvisoError>}
          <div className="flex flex-wrap gap-2">
            <Button variant="perfil" busy={crearEnlace.isPending} onClick={() => crearEnlace.mutate()}>
              Generar contraseña y enlace
            </Button>
            <Button variant="plano" onClick={() => setAccion(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {accion === 'reiniciar' && (
        <div className="revelar mt-2.5 flex flex-col gap-2.5 rounded-lg border border-[rgb(var(--vigilar)/0.45)] bg-vigilar-fondo px-3 py-2.5">
          <p className="max-w-[68ch] text-sm text-tinta">
            <span className="break-all font-medium">{buzon.email}</span> empezará de cero, como tras una prueba:
            contraseña nueva, fuera sus enlaces anteriores, las sesiones de «Mi buzón» y la foto, y quedará sin
            configurar con un enlace nuevo. Su correo no se toca; donde ya esté configurado habrá que volver a hacerlo.
          </p>
          {reiniciar.isError && <AvisoError>{mensajeDe(reiniciar.error, 'No se ha podido reiniciar el buzón.')}</AvisoError>}
          <div className="flex flex-wrap gap-2">
            <Button variant="perfil" busy={reiniciar.isPending} onClick={() => reiniciar.mutate()}>
              Reiniciar el buzón
            </Button>
            <Button variant="plano" onClick={() => setAccion(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {accion === 'marcar' && (
        <div className="revelar mt-2.5 flex flex-col gap-2.5 rounded-lg border border-regla bg-hoja-2 px-3 py-2.5">
          <p className="max-w-[68ch] text-sm text-tinta">
            Márcalo solo si {buzon.displayName ? buzon.displayName.split(/\s+/)[0] : 'su titular'} ya lee y envía correo
            con este buzón (por ejemplo, si lo configuró escribiendo los datos a mano). Se marcará solo cuando
            termine su enlace o entre en el webmail.
          </p>
          {marcar.isError && <AvisoError>{mensajeDe(marcar.error, 'No se ha podido marcar.')}</AvisoError>}
          <div className="flex flex-wrap gap-2">
            <Button variant="perfil" busy={marcar.isPending} onClick={() => marcar.mutate()}>
              Marcar como configurado
            </Button>
            <Button variant="plano" onClick={() => setAccion(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/* ------------------------- Envío de la configuración ----------------------- */

type EstadoEnvio = { fase: 'listo' } | { fase: 'enviando' } | { fase: 'enviado'; para: string } | { fase: 'error'; texto: string };

/**
 * Envío por correo de la configuración a una o varias personas. Cada una
 * recibe solo su enlace, desde «Configura tu correo» <configuration@dominio>,
 * en un correo que ya use (su buzón nuevo aún no está en ningún dispositivo).
 */
export function EnviarConfiguracion({
  open,
  onClose,
  ctx,
  dominio,
  marcadosIniciales,
}: {
  open: boolean;
  onClose: () => void;
  ctx: ContextoPuesta;
  dominio: DominioCorreo;
  marcadosIniciales: string[];
}) {
  // Se monta de nuevo en cada apertura (key en el padre): el estado empieza
  // siempre con la selección pedida.
  const queryClient = useQueryClient();
  const toast = useToast();
  const remitente = remitenteConfiguracion(dominio.domain);
  const candidatos = useMemo(
    () => ordenarCuentas(ctx.buzones.filter((b) => b.status === 'active' && b.id !== ctx.mioId)),
    [ctx.buzones, ctx.mioId],
  );
  const [verTodos, setVerTodos] = useState(() =>
    marcadosIniciales.some((id) => candidatos.find((b) => b.id === id)?.configuredAt),
  );
  const [marcados, setMarcados] = useState<Set<string>>(() => new Set(marcadosIniciales));
  const [para, setPara] = useState<Record<string, string>>(() => {
    const inicial: Record<string, string> = {};
    for (const b of candidatos) {
      const conocido = ctx.personales[b.id] ?? b.setup?.lastEmail?.to ?? '';
      if (conocido) inicial[b.id] = conocido;
    }
    return inicial;
  });
  const [estados, setEstados] = useState<Record<string, EstadoEnvio>>({});
  const [intentado, setIntentado] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const visibles = verTodos ? candidatos : candidatos.filter((b) => !b.configuredAt || marcados.has(b.id));
  const ocultos = candidatos.length - visibles.length;

  function errorDe(b: Mailbox): string | null {
    const v = (para[b.id] ?? '').trim();
    if (!v) return 'Escribe el correo donde la recibirá.';
    if (!esCorreoValido(v)) return 'Este correo no parece válido.';
    if (v.toLowerCase() === b.email.toLowerCase()) return 'Escribe otro correo de esta persona: este buzón aún no está configurado.';
    return null;
  }

  const pendientes = candidatos.filter((b) => marcados.has(b.id) && estados[b.id]?.fase !== 'enviado');
  const enviados = candidatos.filter((b) => estados[b.id]?.fase === 'enviado').length;
  const terminado = enviados > 0 && pendientes.length === 0;

  async function enviar() {
    setIntentado(true);
    if (pendientes.length === 0 || pendientes.some((b) => errorDe(b))) return;
    setEnviando(true);
    let ok = 0;
    let fallos = 0;
    // Uno detrás de otro: el servidor limita los envíos por hora y así cada
    // fila dice enseguida cómo le ha ido.
    for (const b of pendientes) {
      const destino = (para[b.id] ?? '').trim();
      setEstados((prev) => ({ ...prev, [b.id]: { fase: 'enviando' } }));
      try {
        const res = await enviarConfiguracion(b.id, destino, !b.configuredAt);
        ok += 1;
        ctx.setPersonal(b.id, destino);
        // Con una contraseña nueva, el enlace de esta pestaña ya no la lleva bien.
        if (res.link.hasPassword && !res.reused) {
          ctx.setEnlaces((prev) => prev.filter((p) => p.mailboxId !== b.id));
        }
        setEstados((prev) => ({ ...prev, [b.id]: { fase: 'enviado', para: destino } }));
      } catch (err) {
        fallos += 1;
        setEstados((prev) => ({
          ...prev,
          [b.id]: { fase: 'error', texto: mensajeDe(err, 'No se ha podido enviar. Vuelve a intentarlo.') },
        }));
      }
    }
    setEnviando(false);
    await invalidarCorreo(queryClient);
    if (fallos === 0) {
      toast('ok', ok === 1 ? 'Configuración enviada.' : `Configuración enviada a ${ok} personas.`);
    } else {
      toast('error', `${plural(ok, 'enviada', 'enviadas')}, ${plural(fallos, 'con error', 'con error')}. Revisa la lista.`);
    }
  }

  const marcadosVisibles = pendientes.length;

  return (
    <Dialogo
      open={open}
      onClose={onClose}
      title="Enviar la configuración por correo"
      ancho="amplio"
      pie={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end [&>*]:min-h-11 [&>*]:w-full sm:[&>*]:min-h-0 sm:[&>*]:w-auto">
          <Button variant={terminado ? 'principal' : 'plano'} onClick={onClose} disabled={enviando}>
            {terminado ? 'Hecho' : 'Cancelar'}
          </Button>
          {!terminado && (
            <Button variant="principal" busy={enviando} disabled={marcadosVisibles === 0} onClick={() => void enviar()}>
              <Send className="h-4 w-4" aria-hidden />
              {enviando ? 'Enviando…' : marcadosVisibles === 1 ? 'Enviar 1 correo' : `Enviar ${marcadosVisibles} correos`}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="max-w-[68ch] text-base text-tinta-2">
          Cada persona recibe un correo de <span className="font-medium text-tinta">«Configura tu correo»</span>{' '}
          <span className="valor break-all text-sm text-tinta">&lt;{remitente}&gt;</span> con su enlace personal. Envíalo
          a un correo que ya use, como el personal: su buzón nuevo aún no está en ningún dispositivo.
        </p>
        {dominio.status !== 'active' && (
          <div
            role="note"
            className="rounded-lg border border-[rgb(var(--vigilar)/0.45)] bg-vigilar-fondo px-3 py-2.5 text-sm text-tinta"
          >
            El DNS de tu dominio aún no está completo: estos correos podrían llegar a la carpeta de spam. Si alguien no
            lo recibe, copia su enlace y pásaselo por otra vía.
          </div>
        )}

        {candidatos.length === 0 ? (
          <p className="text-base text-tinta-2">No hay buzones de otras personas a los que enviar la configuración.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-[rgb(var(--tinta)/0.08)] rounded-lg border border-regla">
            {visibles.map((b) => {
              const marcado = marcados.has(b.id);
              const estado = estados[b.id] ?? { fase: 'listo' };
              const error = marcado && estado.fase !== 'enviado' && intentado ? errorDe(b) : null;
              const lectura = lecturaCuenta(b);
              return (
                <li key={b.id} className="px-3 py-3">
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0 accent-[rgb(var(--petroleo))]"
                      checked={marcado}
                      disabled={enviando || estado.fase === 'enviado'}
                      onChange={(e) =>
                        setMarcados((prev) => {
                          const n = new Set(prev);
                          if (e.target.checked) n.add(b.id);
                          else n.delete(b.id);
                          return n;
                        })
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                        <span className="text-base font-medium text-tinta [overflow-wrap:anywhere]">
                          {b.displayName || b.email}
                        </span>
                        <Marca veredicto={lectura.veredicto}>{lectura.rotulo}</Marca>
                      </span>
                      {b.displayName && <span className="block break-all text-sm text-tinta-2">{b.email}</span>}
                    </span>
                  </label>
                  {marcado && estado.fase !== 'enviado' && (
                    <div className="mt-2.5 pl-7">
                      <Input
                        label="Correo donde la recibirá"
                        type="email"
                        inputMode="email"
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        placeholder="Su correo personal"
                        value={para[b.id] ?? ''}
                        disabled={enviando}
                        error={error ?? undefined}
                        help={
                          b.configuredAt
                            ? 'Ya usa este buzón: el enlace irá sin contraseña, para no cambiar la que tiene.'
                            : undefined
                        }
                        onChange={(e) => setPara((prev) => ({ ...prev, [b.id]: e.target.value }))}
                      />
                    </div>
                  )}
                  {estado.fase === 'enviando' && <p className="mt-2 pl-7 text-sm text-tinta-2">Enviando…</p>}
                  {estado.fase === 'enviado' && (
                    <p className="mt-2 flex items-center gap-1.5 pl-7 text-sm font-medium text-normal" role="status">
                      <Check className="h-4 w-4" aria-hidden />
                      Enviada a <span className="break-all">{estado.para}</span>
                    </p>
                  )}
                  {estado.fase === 'error' && (
                    <p className="mt-2 pl-7 text-sm text-fuera" role="alert">
                      {estado.texto}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {ocultos > 0 && (
          <Button variant="plano" className="self-start" onClick={() => setVerTodos(true)}>
            Mostrar también los ya configurados ({ocultos})
          </Button>
        )}
      </div>
    </Dialogo>
  );
}
