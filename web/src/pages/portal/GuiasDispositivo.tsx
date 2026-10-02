import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { QR } from '../../components/QR';
import { Button } from '../../ui/Button';
import {
  detectarDispositivo,
  esDispositivoMovil,
  type DatosConexion,
  type Dispositivo,
} from '../../lib/portal';
import { BotonCopiarTactil, Nota, Paso, Pasos, Ui, claseEnlaceBoton } from './comun';

/*
  Guías por dispositivo. Se basan en cómo se configura cada cliente de correo
  en la práctica:
  - iPhone, iPad y Mac: perfil .mobileconfig (lo más sencillo, sin teclear
    servidores). iOS lo descarga desde Safari y hay que instalarlo en Ajustes
    antes de 8 minutos.
  - Thunderbird (escritorio y Android): se configuran solos con la dirección y
    la contraseña (autoconfiguración por el MX), sin registros DNS por cliente.
  - Outlook: ya no detecta cuentas IMAP de forma fiable, así que se dan los
    datos para la configuración manual.
  - Gmail y Samsung Email en Android: solo configuración manual IMAP.
*/

const NOMBRES: Record<Dispositivo, string> = {
  iphone: 'iPhone o iPad',
  mac: 'Mac',
  android: 'Android',
  outlook: 'Outlook',
  thunderbird: 'Thunderbird',
  otros: 'Otros',
};

const ORDEN: Dispositivo[] = ['iphone', 'mac', 'android', 'outlook', 'thunderbird', 'otros'];

export interface GuiasDispositivoProps {
  email: string;
  conexion: DatosConexion;
  /** Enlace directo al perfil de Apple (el iPhone debe abrirlo en Safari). */
  appleProfileUrl: string;
  /** El perfil se puede abrir sin sesión (enlace de configuración): admite QR. */
  perfilPublico: boolean;
  /** El perfil ya lleva la contraseña: el titular no tendrá que teclearla. */
  perfilIncluyeContrasena: boolean;
  /** Contenido del QR de importación de Thunderbird para Android. */
  thunderbirdAndroidQr?: string;
  /** Texto sobre qué contraseña usar, adaptado a cada página. */
  notaContrasena: ReactNode;
}

export function GuiasDispositivo(props: GuiasDispositivoProps) {
  const detectado = useMemo(() => detectarDispositivo(), []);
  // El método de este dispositivo va primero; los demás, en su orden habitual.
  const pestanas = useMemo(() => [detectado, ...ORDEN.filter((d) => d !== detectado)], [detectado]);
  const [activa, setActiva] = useState<Dispositivo>(detectado);
  const refs = useRef<Partial<Record<Dispositivo, HTMLButtonElement | null>>>({});
  const idBase = useId();

  function mover(e: KeyboardEvent<HTMLDivElement>) {
    const i = pestanas.indexOf(activa);
    let siguiente: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') siguiente = (i + 1) % pestanas.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') siguiente = (i - 1 + pestanas.length) % pestanas.length;
    if (e.key === 'Home') siguiente = 0;
    if (e.key === 'End') siguiente = pestanas.length - 1;
    if (siguiente === null) return;
    e.preventDefault();
    const destino = pestanas[siguiente]!;
    setActiva(destino);
    refs.current[destino]?.focus();
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Rejilla en el móvil (sin desplazamiento horizontal), fila desde sm. */}
      <div
        role="tablist"
        aria-label="Dispositivo o programa de correo"
        onKeyDown={mover}
        className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-6"
      >
        {pestanas.map((d) => {
          const seleccionada = d === activa;
          return (
            <button
              key={d}
              ref={(el) => {
                refs.current[d] = el;
              }}
              type="button"
              role="tab"
              id={`${idBase}-tab-${d}`}
              aria-selected={seleccionada}
              aria-controls={`${idBase}-panel-${d}`}
              tabIndex={seleccionada ? 0 : -1}
              onClick={() => setActiva(d)}
              className={`flex min-h-11 flex-col items-center justify-center border px-2 py-1.5 text-center text-base
                transition-colors duration-100 ${
                  seleccionada
                    ? 'border-[rgb(var(--laboratorio)/0.35)] bg-laboratorio-claro font-semibold text-laboratorio'
                    : 'border-regla text-tinta-2 hover:bg-hoja-3 hover:text-tinta'
                }`}
            >
              {NOMBRES[d]}
              {/* «Recomendado»: en Linux o Windows lo detectado es un programa
                  (Thunderbird, Outlook), no «este dispositivo». */}
              {d === detectado && d !== 'otros' && (
                <span className="rotulo mt-0.5 text-micro leading-3">Recomendado</span>
              )}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`${idBase}-panel-${activa}`}
        aria-labelledby={`${idBase}-tab-${activa}`}
        className="flex flex-col gap-4"
      >
        {activa === 'iphone' && <GuiaIphone {...props} enEsteDispositivo={detectado === 'iphone'} />}
        {activa === 'mac' && <GuiaMac {...props} />}
        {activa === 'android' && <GuiaAndroid {...props} />}
        {activa === 'outlook' && <GuiaOutlook {...props} />}
        {activa === 'thunderbird' && <GuiaThunderbird {...props} />}
        {activa === 'otros' && <GuiaOtros {...props} />}
      </div>
    </div>
  );
}

/* --------------------------------- Guías ----------------------------------- */

function Subtitulo({ children }: { children: ReactNode }) {
  return (
    <h3 className="font-estrecha text-md font-semibold uppercase tracking-[0.06em] text-tinta">{children}</h3>
  );
}

function GuiaIphone(props: GuiasDispositivoProps & { enEsteDispositivo: boolean }) {
  return (
    <>
      <p className="max-w-[70ch] text-base text-tinta-2">
        Un perfil de configuración añade la cuenta a la app Mail sin tener que escribir servidores ni puertos.
      </p>
      {!props.enEsteDispositivo && props.perfilPublico && (
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <QR texto={props.appleProfileUrl} etiqueta="Código QR para descargar el perfil en el iPhone o iPad" />
          <Nota>
            Escanea este código con la cámara del iPhone o iPad: se abrirá Safari y descargará el perfil. Después,
            sigue los pasos a partir del segundo.
          </Nota>
        </div>
      )}
      <a href={props.appleProfileUrl} className={`${claseEnlaceBoton('tinta')} self-stretch sm:self-start`}>
        Instalar perfil
      </a>
      <p className="max-w-[70ch] border border-regla bg-hoja-2 px-3 py-2 text-sm text-tinta">
        <strong className="font-semibold">Importante:</strong> abre esta página en Safari; otros navegadores no
        permiten instalar perfiles. El perfil descargado caduca si no se instala en 8 minutos.
      </p>
      <Pasos>
        <Paso n={1}>
          Pulsa <Ui>Instalar perfil</Ui>. Cuando Safari pregunte si quieres descargar un perfil de configuración, pulsa{' '}
          <Ui>Permitir</Ui> y después <Ui>Cerrar</Ui>.
        </Paso>
        <Paso n={2}>
          Abre la app <Ui>Ajustes</Ui> y pulsa <Ui>Perfil descargado</Ui>, que aparece justo debajo de tu nombre. Si no
          aparece, está en Ajustes → General → VPN y gestión de dispositivos.
        </Paso>
        <Paso n={3}>
          Pulsa <Ui>Instalar</Ui> (arriba a la derecha), introduce el código de desbloqueo del dispositivo y vuelve a
          pulsar <Ui>Instalar</Ui> para confirmar.
        </Paso>
        <Paso n={4}>
          {props.perfilIncluyeContrasena
            ? 'La contraseña del buzón ya va incluida en el perfil: no es necesario escribirla.'
            : 'Cuando se solicite, introduce la contraseña del buzón.'}
        </Paso>
        <Paso n={5}>
          Abre la app <Ui>Mail</Ui>. El buzón aparecerá en unos segundos.
        </Paso>
      </Pasos>
      <Nota>
        El sistema puede indicar que el perfil «No está verificado». Es habitual en los perfiles de correo y no impide
        instalarlo. Para quitar la cuenta más adelante, elimina el perfil desde el mismo apartado de Ajustes.
      </Nota>
    </>
  );
}

function GuiaMac(props: GuiasDispositivoProps) {
  return (
    <>
      <p className="max-w-[70ch] text-base text-tinta-2">
        Para la app Mail del Mac. Si utilizas Outlook o Thunderbird, consulta su pestaña.
      </p>
      <a href={props.appleProfileUrl} className={`${claseEnlaceBoton('tinta')} self-stretch sm:self-start`}>
        Descargar perfil
      </a>
      <Pasos>
        <Paso n={1}>
          Pulsa <Ui>Descargar perfil</Ui> y abre el archivo descargado (normalmente en la carpeta Descargas).
        </Paso>
        <Paso n={2}>
          Abre <Ui>Ajustes del Sistema</Ui> → General → <Ui>Gestión de dispositivos</Ui>. En macOS Sonoma o versiones
          anteriores: Ajustes del Sistema → Privacidad y seguridad → <Ui>Perfiles</Ui>.
        </Paso>
        <Paso n={3}>
          Haz doble clic en el perfil de correo, pulsa <Ui>Instalar</Ui> e introduce la contraseña del Mac.
        </Paso>
        <Paso n={4}>
          {props.perfilIncluyeContrasena
            ? 'La contraseña del buzón ya va incluida en el perfil.'
            : 'Cuando se solicite, introduce la contraseña del buzón.'}
        </Paso>
        <Paso n={5}>
          Abre la app <Ui>Mail</Ui>: el buzón aparecerá en la barra lateral.
        </Paso>
      </Pasos>
    </>
  );
}

function GuiaAndroid(props: GuiasDispositivoProps) {
  const movil = esDispositivoMovil();
  return (
    <>
      <Subtitulo>Thunderbird para Android (recomendado)</Subtitulo>
      <Pasos>
        <Paso n={1}>
          Instala la aplicación <Ui>Thunderbird</Ui> desde Google Play.
        </Paso>
        <Paso n={2}>
          Ábrela, escribe tu dirección de correo y pulsa <Ui>Siguiente</Ui>. La configuración se detecta
          automáticamente.
        </Paso>
        <Paso n={3}>Introduce la contraseña del buzón y continúa hasta terminar.</Paso>
      </Pasos>
      {props.thunderbirdAndroidQr &&
        (movil ? (
          <Nota>
            Si abres esta página en un ordenador, verás además un código QR para importar la configuración en
            Thunderbird.
          </Nota>
        ) : (
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <QR texto={props.thunderbirdAndroidQr} etiqueta="Código QR de importación para Thunderbird para Android" />
            <Nota>
              También puedes importar la configuración escaneando este código: en la pantalla de bienvenida de
              Thunderbird, pulsa <Ui>Importar ajustes</Ui> y después <Ui>Escanear código QR</Ui>. La aplicación pedirá la
              contraseña al terminar.
            </Nota>
          </div>
        ))}

      <div className="regla-cabecera" aria-hidden />

      <Subtitulo>Gmail, Samsung Email u otras aplicaciones</Subtitulo>
      <p className="max-w-[70ch] text-base text-tinta-2">
        Estas aplicaciones no detectan la configuración automáticamente. Añade una cuenta de tipo <Ui>Otra</Ui> o{' '}
        <Ui>IMAP</Ui> (en Gmail: Ajustes → Añadir cuenta → Otra → <Ui>Personal (IMAP)</Ui>) y copia estos datos:
      </p>
      <DatosManuales email={props.email} conexion={props.conexion} notaContrasena={props.notaContrasena} />
    </>
  );
}

function GuiaOutlook(props: GuiasDispositivoProps) {
  return (
    <>
      <p className="max-w-[70ch] text-base text-tinta-2">
        Outlook no siempre detecta automáticamente las cuentas IMAP. Si al escribir la dirección la cuenta no se
        configura sola, elige la configuración manual de tipo IMAP y copia los datos siguientes.
      </p>
      <Pasos>
        <Paso n={1}>
          En Outlook, abre Configuración → Cuentas → <Ui>Agregar cuenta</Ui>. En Outlook clásico: Archivo →{' '}
          <Ui>Agregar cuenta</Ui>.
        </Paso>
        <Paso n={2}>
          Escribe tu dirección de correo y pulsa <Ui>Continuar</Ui>.
        </Paso>
        <Paso n={3}>
          Si Outlook solicita el tipo de cuenta, elige <Ui>IMAP</Ui> y abre la configuración avanzada o de
          sincronización.
        </Paso>
        <Paso n={4}>
          Completa los servidores con los datos siguientes y pulsa <Ui>Continuar</Ui>.
        </Paso>
      </Pasos>
      <DatosManuales email={props.email} conexion={props.conexion} notaContrasena={props.notaContrasena} />
      <Nota>
        El nuevo Outlook y la aplicación de Outlook para móviles acceden al buzón a través de los servidores de
        Microsoft. Se recomienda utilizar una contraseña de aplicación exclusiva para Outlook, que puede crearse en «Mi
        buzón».
      </Nota>
    </>
  );
}

function GuiaThunderbird(props: GuiasDispositivoProps) {
  return (
    <>
      <p className="max-w-[70ch] text-base text-tinta-2">
        Thunderbird obtiene la configuración automáticamente: solo necesitas la dirección y la contraseña.
      </p>
      <Pasos>
        <Paso n={1}>
          Abre Thunderbird. Si es la primera vez, se abrirá el asistente de cuentas; si no, abre el menú → Nuevo →{' '}
          <Ui>Cuenta de correo existente</Ui>.
        </Paso>
        <Paso n={2}>
          Escribe tu nombre, la dirección <span className="valor break-words">{props.email}</span> y la contraseña del
          buzón, y pulsa <Ui>Continuar</Ui>.
        </Paso>
        <Paso n={3}>
          Comprueba que la configuración encontrada es de tipo IMAP y pulsa <Ui>Hecho</Ui>.
        </Paso>
      </Pasos>
      <Nota>
        Si la configuración no se detecta, pulsa «Configurar manualmente» y utiliza los datos de la pestaña «Otros».
      </Nota>
    </>
  );
}

function GuiaOtros(props: GuiasDispositivoProps) {
  return (
    <>
      <p className="max-w-[70ch] text-base text-tinta-2">
        Para cualquier otro programa, configura una cuenta IMAP con estos datos. El usuario es siempre la dirección de
        correo completa.
      </p>
      <DatosManuales email={props.email} conexion={props.conexion} notaContrasena={props.notaContrasena} />
    </>
  );
}

/* ---------------------------- Datos manuales ------------------------------- */

/**
 * Ficha de datos para la configuración manual. Cada valor que hay que teclear
 * lleva su botón de copiar; los puertos y el cifrado van juntos porque en los
 * programas aparecen en el mismo apartado.
 */
export function DatosManuales({
  email,
  conexion,
  notaContrasena,
  compacto = false,
}: {
  email: string;
  conexion: DatosConexion;
  notaContrasena?: ReactNode;
  /** En un contenedor estrecho (diálogo) el rótulo va siempre encima del valor. */
  compacto?: boolean;
}) {
  const fila = { compacto };
  return (
    <div className="border border-regla bg-hoja-2">
      <FilaDato {...fila} rotulo="Usuario" valor={email} copiar={email} nota="La dirección de correo completa." />
      <FilaDato {...fila} rotulo="Contraseña" nota={notaContrasena ?? 'La contraseña del buzón.'} />
      <FilaDato
        {...fila}
        rotulo="Servidor de entrada (IMAP)"
        valor={conexion.imap.host}
        copiar={conexion.imap.host}
        nota={`Puerto ${conexion.imap.port} · Seguridad ${conexion.imap.security}`}
      />
      <FilaDato
        {...fila}
        rotulo="Servidor de salida (SMTP)"
        valor={conexion.smtp.host}
        copiar={conexion.smtp.host}
        nota={`Puerto ${conexion.smtp.port} · Seguridad ${conexion.smtp.security} · Requiere autenticación con el mismo usuario y contraseña`}
      />
      <FilaDato
        {...fila}
        rotulo="Si el puerto de salida está bloqueado"
        nota={`Puerto ${conexion.smtpAlt.port} · Seguridad ${conexion.smtpAlt.security}`}
      />
      <FilaDato
        {...fila}
        rotulo="Autenticación"
        nota="Contraseña normal. No actives la autenticación de contraseña segura (SPA)."
      />
    </div>
  );
}

function FilaDato({
  rotulo,
  valor,
  copiar,
  nota,
  compacto,
}: {
  rotulo: string;
  valor?: string;
  copiar?: string;
  nota?: ReactNode;
  compacto: boolean;
}) {
  return (
    <div className="regla-fila flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5 last:border-b-0">
      <span className={`rotulo basis-full ${compacto ? '' : 'sm:w-44 sm:basis-auto sm:shrink-0'}`}>{rotulo}</span>
      <div className="min-w-0 flex-1">
        {valor && <p className="valor break-all text-base text-tinta">{valor}</p>}
        {nota && <p className="text-sm text-tinta-2">{nota}</p>}
      </div>
      {copiar && <BotonCopiarTactil texto={copiar} />}
    </div>
  );
}

/** Botón para abrir el webmail en otra pestaña, sin enviar el enlace actual como referencia. */
export function BotonWebmail({ url, variante = 'perfil' }: { url: string; variante?: 'tinta' | 'perfil' }) {
  if (!url) {
    return (
      <Button variant="perfil" disabled>
        Correo web no disponible
      </Button>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className={`${claseEnlaceBoton(variante)} self-stretch sm:self-start`}>
      Abrir el correo web
    </a>
  );
}
