import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Mail, QrCode } from 'lucide-react';
import { esCorreoValido } from '../lib/gestion';
import { fechaLarga } from '../lib/portal';
import { Button, estiloBoton, type VarianteBoton } from '../ui/Button';
import { copiarAlPortapapeles } from '../ui/kit';
import { QR } from './QR';

/*
  Enlaces de configuración de un equipo recién creado: una fila por persona
  con su enlace (copiar, enviar por correo, QR) y «Copiar todos». Lo usan la
  puesta en marcha del cliente y el alta masiva de «Buzones», para que
  entregar los enlaces se haga igual en los dos sitios.
*/

/**
 * Validez de los enlaces que se crean para un equipo: una semana, para que
 * cada persona lo abra con calma (un enlace por buzón, con su contraseña).
 */
export const VALIDEZ_ENLACE_HORAS = 168;

export interface EnlaceDePersona {
  /** Nombre visible del buzón; puede venir vacío (un buzón genérico). */
  nombre: string;
  email: string;
  url: string;
  expiresAt: number;
  /** El enlace lleva la contraseña del buzón dentro. */
  hasPassword: boolean;
  /**
   * Correo personal del titular, si quien hace el alta lo ha escrito. Solo
   * vive en este navegador: sirve para preparar el mensaje con el enlace.
   */
  correoPersonal?: string;
}

/** Primer nombre para el saludo («Ana García» → «Ana»). */
function nombreDePila(nombre: string): string {
  return nombre.trim().split(/\s+/)[0] ?? '';
}

/**
 * Mensaje preparado para enviar el enlace a su titular desde el programa de
 * correo de quien hace el alta. Va al correo personal si se indicó: el
 * buzón nuevo todavía no está configurado en ningún sitio.
 */
export function mailtoEnlacePersona(persona: EnlaceDePersona, firma?: string): string {
  const pila = nombreDePila(persona.nombre);
  const asunto = `Tu correo ${persona.email} ya está listo`;
  const lineas = [
    pila ? `Hola, ${pila}:` : 'Hola:',
    '',
    `Ya tienes tu nuevo buzón de correo: ${persona.email}.`,
    '',
    persona.hasPassword
      ? 'Para usarlo en el móvil o en el ordenador, abre este enlace y sigue los pasos para tu dispositivo. La contraseña ya va incluida, así que solo lleva un par de minutos:'
      : 'Para usarlo en el móvil o en el ordenador, abre este enlace y sigue los pasos para tu dispositivo:',
    '',
    persona.url,
    '',
    persona.hasPassword
      ? `El enlace es personal y vale hasta el ${fechaLarga(persona.expiresAt)}. Como incluye tu contraseña, no lo reenvíes a nadie.`
      : `El enlace es personal y vale hasta el ${fechaLarga(persona.expiresAt)}.`,
    '',
    'Si tienes cualquier duda, dímelo.',
    '',
    firma ? `Un saludo,\n${firma}` : 'Un saludo.',
  ];
  const para =
    persona.correoPersonal && esCorreoValido(persona.correoPersonal)
      ? encodeURIComponent(persona.correoPersonal.trim()).replace('%40', '@')
      : '';
  return `mailto:${para}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(lineas.join('\n'))}`;
}

/** «Nombre — dirección — enlace», una persona por línea, para pegarlo donde se quiera. */
export function textoEnlaces(personas: EnlaceDePersona[]): string {
  return personas
    .map((p) => (p.nombre.trim() ? `${p.nombre.trim()} — ${p.email} — ${p.url}` : `${p.email} — ${p.url}`))
    .join('\n');
}

/**
 * Botón de copiar de tamaño normal (el del kit es compacto, para las
 * muestras). Solo dice «Copiado» si la copia ha funcionado.
 */
export function BotonCopiarTexto({
  texto,
  rotulo,
  variante = 'perfil',
  className = '',
}: {
  texto: string;
  rotulo: string;
  variante?: VarianteBoton;
  className?: string;
}) {
  const [estado, setEstado] = useState<'reposo' | 'ok' | 'fallo'>('reposo');
  const ref = useRef<HTMLButtonElement>(null);
  const temporizador = useRef<number>();
  useEffect(() => () => window.clearTimeout(temporizador.current), []);

  async function copiar() {
    const ok = await copiarAlPortapapeles(texto, ref.current);
    setEstado(ok ? 'ok' : 'fallo');
    window.clearTimeout(temporizador.current);
    temporizador.current = window.setTimeout(() => setEstado('reposo'), ok ? 1800 : 5000);
  }

  return (
    <>
      <Button
        ref={ref}
        type="button"
        variant={variante}
        onClick={() => void copiar()}
        className={`${estado === 'ok' ? '!text-normal' : estado === 'fallo' ? '!text-fuera' : ''} ${className}`}
      >
        {estado === 'ok' ? (
          <Check className="h-4 w-4 shrink-0" aria-hidden />
        ) : (
          <Copy className="h-4 w-4 shrink-0" aria-hidden />
        )}
        {estado === 'ok' ? 'Copiado' : estado === 'fallo' ? 'No se ha podido copiar' : rotulo}
      </Button>
      <span className="sr-only" role="status">
        {estado === 'ok'
          ? 'Copiado al portapapeles.'
          : estado === 'fallo'
            ? 'No se ha podido copiar. Abre el código QR para ver el enlace y cópialo manualmente.'
            : ''}
      </span>
    </>
  );
}

/**
 * Fila de una persona con su enlace listo para entregar. La URL no se pinta
 * de entrada (un token largo por fila no deja leer la lista): se copia, se
 * envía o se ve junto a su QR al pedirlo.
 */
export function FilaEnlace({
  persona,
  firma,
  marca,
  nota,
  children,
}: {
  persona: EnlaceDePersona;
  /** Nombre con el que se firma el mensaje preparado. */
  firma?: string;
  /** Distintivo junto al nombre («Tú»). */
  marca?: ReactNode;
  /** Línea bajo la dirección («Es tu buzón: lo configurarás en el paso 4»). */
  nota?: ReactNode;
  /** Contenido adicional bajo la fila (la contraseña, en el alta masiva). */
  children?: ReactNode;
}) {
  const [verQr, setVerQr] = useState(false);
  const idQr = useId();
  const titulo = persona.nombre.trim() || persona.email;
  const personal = persona.correoPersonal?.trim();

  return (
    // La fila decide por el ancho de su lista (consulta de contenedor): en el
    // diálogo del alta masiva las acciones bajan de línea antes que en la
    // puesta en marcha, para que la dirección no se parta.
    <li className="regla-fila px-4 py-3.5 [container-type:inline-size] last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <div className="min-w-0 grow basis-full [@container(min-width:46rem)]:basis-0">
          <p className="flex flex-wrap items-baseline gap-x-2 text-base font-medium text-tinta [overflow-wrap:anywhere]">
            {titulo}
            {marca}
          </p>
          {persona.nombre.trim() && <p className="text-sm text-tinta-2 [overflow-wrap:anywhere]">{persona.email}</p>}
          {personal ? (
            <p className="text-sm text-tinta-3 [overflow-wrap:anywhere]">Correo personal: {personal}</p>
          ) : null}
          {nota && <div className="text-sm text-tinta-3">{nota}</div>}
        </div>
        {/* Estrecha: los botones crecen para llenar cada línea al bajar. */}
        <div className="flex grow flex-wrap items-center gap-2 [@container(min-width:46rem)]:grow-0">
          <BotonCopiarTexto texto={persona.url} rotulo="Copiar enlace" className="grow [@container(min-width:46rem)]:grow-0" />
          <a
            href={mailtoEnlacePersona(persona, firma)}
            className={estiloBoton('perfil', 'grow [@container(min-width:46rem)]:grow-0')}
          >
            <Mail className="h-4 w-4 shrink-0" aria-hidden />
            Enviar por correo
          </a>
          <Button
            variant="plano"
            className="grow [@container(min-width:46rem)]:min-w-[8.75rem] [@container(min-width:46rem)]:grow-0 [@container(min-width:46rem)]:justify-start"
            aria-expanded={verQr}
            aria-controls={idQr}
            onClick={() => setVerQr((v) => !v)}
          >
            <QrCode className="h-4 w-4 shrink-0" aria-hidden />
            {verQr ? 'Ocultar QR' : 'Ver QR'}
          </Button>
        </div>
      </div>
      {verQr && (
        <div id={idQr} className="revelar mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <QR texto={persona.url} tamano={148} etiqueta={`Código QR del enlace de configuración de ${persona.email}`} />
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-sm text-tinta-2">
              {persona.nombre.trim() ? `${nombreDePila(persona.nombre)} puede` : 'Su titular puede'} escanear este
              código con la cámara del móvil para abrir el enlace.
            </p>
            <p className="valor break-all text-sm text-tinta">{persona.url}</p>
          </div>
        </div>
      )}
      {children}
    </li>
  );
}

/**
 * Nota que acompaña a una lista de enlaces: incluyen la contraseña y
 * caducan. Se dice antes de la lista, no después, para leerla antes de enviar.
 */
export function NotaEnlaces({
  expiresAt,
  conContrasena,
  conservacion = 'Solo se muestran ahora; si alguno se pierde, crea otro desde «Buzones».',
}: {
  expiresAt: number;
  conContrasena: boolean;
  /** Qué pasa si se cierra la vista sin enviarlos. */
  conservacion?: string;
}) {
  return (
    <div
      role="note"
      className="rounded-lg border border-[rgb(var(--vigilar)/0.45)] bg-vigilar-fondo px-3 py-2.5 text-sm text-tinta"
    >
      <p className="max-w-[75ch]">
        {conContrasena ? (
          <>
            Cada enlace <strong className="font-semibold">incluye la contraseña de su buzón</strong>: envíalo solo a
            su titular. Caducan el {fechaLarga(expiresAt)}.
          </>
        ) : (
          <>Los enlaces caducan el {fechaLarga(expiresAt)}.</>
        )}{' '}
        {conservacion}
      </p>
    </div>
  );
}
