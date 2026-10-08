import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { UserRound } from 'lucide-react';
import { api, type Mailbox } from '../lib/api';
import { mensajeError } from '../lib/portal';
import { Button } from '../ui/Button';
import { AvisoError } from '../ui/kit';

/*
  Foto del buzón: el avatar redondo y el control para subirla, cambiarla o
  quitarla. Lo usan la página del enlace de configuración, «Mi buzón» y la
  ficha del buzón del panel; cada uno pasa su ruta (la misma URL sirve para
  PUT y DELETE) y qué hacer después.

  La imagen se prepara en el navegador antes de subirla: recorte al centro en
  cuadrado y 256 × 256 en JPEG. Así una foto del móvil de varios MB llega en
  unas decenas de KB, cabe de sobra en el límite del servidor y, al volver a
  dibujarla en un lienzo, pierde los metadatos EXIF (ubicación, modelo del
  teléfono), que no deben salir del dispositivo del titular.
*/

/** Lado de la foto que se sube, en píxeles. */
const LADO = 256;
const CALIDAD_JPEG = 0.85;
/**
 * Tope del archivo original. No es el límite del servidor (la foto ya
 * preparada ocupa mucho menos): evita decodificar en un móvil una imagen tan
 * grande que agote su memoria.
 */
const MAXIMO_ORIGINAL_MB = 25;

const TEXTO_NO_ES_IMAGEN = 'El archivo elegido no es una imagen. Elige una foto en formato JPEG, PNG o WebP.';
const TEXTO_NO_SE_ABRE = 'No se ha podido abrir la imagen. Elige una foto en formato JPEG, PNG o WebP.';
const TEXTO_DEMASIADO_GRANDE = `La imagen ocupa más de ${MAXIMO_ORIGINAL_MB} MB. Elige una foto más pequeña.`;
const TEXTO_SIN_LIENZO = 'El navegador no ha podido preparar la foto. Prueba con otra imagen o con otro navegador.';

/** Error de preparación con el texto listo para mostrar. */
class ErrorFoto extends Error {}

/** URL de la foto de un buzón para el panel, o null si no tiene. */
export function urlFotoBuzon(mailbox: Pick<Mailbox, 'id' | 'photoUpdatedAt'>): string | null {
  // ?v= cambia con cada foto: la caché del navegador (5 minutos) no sirve la anterior.
  return mailbox.photoUpdatedAt ? `/api/mailboxes/${mailbox.id}/photo?v=${mailbox.photoUpdatedAt}` : null;
}

/* --------------------------------- Avatar --------------------------------- */

export type TamanoAvatar = 'normal' | 'grande';

const TAMANOS: Record<TamanoAvatar, { caja: string; letra: string; icono: string }> = {
  normal: { caja: 'h-12 w-12', letra: 'text-md', icono: 'h-6 w-6' },
  grande: { caja: 'h-[72px] w-[72px]', letra: 'text-2xl', icono: 'h-8 w-8' },
};

/** Iniciales del nombre visible («Ana García» → «AG»); vacío si no hay nombre. */
function iniciales(nombre: string): string {
  const palabras = nombre.trim().split(/\s+/).filter(Boolean);
  // Array.from separa por caracteres y no por unidades UTF-16 (tildes compuestas, emojis).
  const letras = palabras.slice(0, 2).map((p) => Array.from(p)[0] ?? '');
  return letras.join('').toLocaleUpperCase('es-ES');
}

/**
 * Foto del buzón en un círculo o, si no tiene (o no carga), las iniciales del
 * nombre visible sobre petróleo tenue; sin nombre, el icono de persona.
 */
export function AvatarBuzon({
  src,
  nombre = '',
  tamano = 'normal',
  alt = '',
}: {
  src: string | null;
  nombre?: string;
  tamano?: TamanoAvatar;
  /** Vacío cuando el nombre o la dirección ya están al lado (decorativa). */
  alt?: string;
}) {
  // Una URL que falla (foto borrada desde otro sitio, enlace caducado) deja
  // el sustituto en lugar del icono roto del navegador.
  const [fallida, setFallida] = useState<string | null>(null);
  const t = TAMANOS[tamano];
  if (src && fallida !== src) {
    return (
      <img
        src={src}
        alt={alt}
        className={`${t.caja} shrink-0 rounded-full border border-regla bg-hoja-3 object-cover`}
        onError={() => setFallida(src)}
      />
    );
  }
  const letras = iniciales(nombre);
  return (
    <span
      role={alt ? 'img' : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      className={`${t.caja} flex shrink-0 select-none items-center justify-center rounded-full bg-petroleo-claro
        font-semibold text-petroleo ${t.letra}`}
    >
      {letras || <UserRound className={t.icono} strokeWidth={1.75} aria-hidden />}
    </span>
  );
}

/* ------------------------------- Preparación ------------------------------ */

function crearLienzo(lado: number): { lienzo: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const lienzo = document.createElement('canvas');
  lienzo.width = lado;
  lienzo.height = lado;
  const ctx = lienzo.getContext('2d');
  if (!ctx) throw new ErrorFoto(TEXTO_SIN_LIENZO);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { lienzo, ctx };
}

function cargarImagen(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new ErrorFoto(TEXTO_NO_SE_ABRE));
    img.src = url;
  });
}

/**
 * Recorta la imagen al centro en cuadrado y la reduce a 256 × 256 en JPEG.
 * Se decodifica con un <img> y no con createImageBitmap porque así todos los
 * navegadores actuales respetan la orientación EXIF al dibujarla: la foto
 * vertical del móvil no sale tumbada.
 */
async function prepararFoto(archivo: File): Promise<string> {
  // Sin tipo (algunos móviles no lo indican) se deja decidir al decodificador.
  if (archivo.type && !archivo.type.startsWith('image/')) throw new ErrorFoto(TEXTO_NO_ES_IMAGEN);
  if (archivo.size > MAXIMO_ORIGINAL_MB * 1024 * 1024) throw new ErrorFoto(TEXTO_DEMASIADO_GRANDE);

  const url = URL.createObjectURL(archivo);
  try {
    const img = await cargarImagen(url);
    const ancho = img.naturalWidth;
    const alto = img.naturalHeight;
    if (!ancho || !alto) throw new ErrorFoto(TEXTO_NO_SE_ABRE);
    const lado = Math.min(ancho, alto);

    // Primer paso: el recorte, ya reducido a 1024 px como mucho. Un lienzo del
    // tamaño de una foto de 48 Mpx supera el límite de memoria de Safari en iOS.
    let tam = Math.min(lado, LADO * 4);
    let actual = crearLienzo(tam);
    // JPEG no tiene transparencia: un PNG transparente saldría con fondo negro.
    actual.ctx.fillStyle = '#ffffff';
    actual.ctx.fillRect(0, 0, tam, tam);
    actual.ctx.drawImage(img, (ancho - lado) / 2, (alto - lado) / 2, lado, lado, 0, 0, tam, tam);

    // Después, a la mitad cada vez: una reducción grande de un solo salto
    // deja dientes de sierra en los navegadores que ignoran imageSmoothingQuality.
    while (Math.round(tam / 2) >= LADO) {
      const siguiente = Math.round(tam / 2);
      const nuevo = crearLienzo(siguiente);
      nuevo.ctx.drawImage(actual.lienzo, 0, 0, siguiente, siguiente);
      actual = nuevo;
      tam = siguiente;
    }
    if (tam !== LADO) {
      const final = crearLienzo(LADO);
      final.ctx.fillStyle = '#ffffff';
      final.ctx.fillRect(0, 0, LADO, LADO);
      final.ctx.drawImage(actual.lienzo, 0, 0, LADO, LADO);
      actual = final;
    }

    let dataUrl: string;
    try {
      dataUrl = actual.lienzo.toDataURL('image/jpeg', CALIDAD_JPEG);
    } catch {
      // Lienzo «contaminado» (algunas imágenes SVG en Safari) o sin memoria.
      throw new ErrorFoto(TEXTO_SIN_LIENZO);
    }
    if (!dataUrl.startsWith('data:image/')) throw new ErrorFoto(TEXTO_SIN_LIENZO);
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* --------------------------------- Control -------------------------------- */

export type CambioFoto = 'subida' | 'quitada';

/**
 * Avatar con «Subir foto» (o «Cambiar foto») y «Quitar foto». La foto se
 * guarda en cuanto se elige: no depende del botón «Guardar» del nombre.
 */
export function FotoBuzon({
  fotoUrl,
  url,
  nombre,
  tactil = false,
  rotulo,
  ayuda,
  onCambio,
}: {
  /** Foto actual (con su ?v=), o null si no hay. */
  fotoUrl: string | null;
  /** Ruta para subirla (PUT { photo }) y quitarla (DELETE). */
  url: string;
  /** Nombre visible, para las iniciales del sustituto. */
  nombre?: string;
  /** Controles de 44 px en el móvil (portal del titular). */
  tactil?: boolean;
  rotulo?: string;
  ayuda?: ReactNode;
  /** Tras subirla o quitarla: recargar los datos que traen la URL nueva. */
  onCambio: (cambio: CambioFoto) => Promise<unknown> | void;
}) {
  const entrada = useRef<HTMLInputElement>(null);
  const [estado, setEstado] = useState<'reposo' | 'subiendo' | 'quitando'>('reposo');
  const [error, setError] = useState('');
  const [anuncio, setAnuncio] = useState('');
  // Lo que se acaba de subir o quitar, hasta que el padre traiga su URL
  // nueva: si la recarga tarda o falla, el titular ve ya el resultado.
  const [previa, setPrevia] = useState<{ base: string | null; src: string | null } | null>(null);
  const mostrada = previa && previa.base === fotoUrl ? previa.src : fotoUrl;
  const altura = tactil ? 'min-h-11 sm:min-h-0' : '';

  async function avisarCambio(cambio: CambioFoto) {
    try {
      await onCambio(cambio);
    } catch {
      // La foto ya está guardada; la vista previa la sigue mostrando.
    }
  }

  async function elegir(e: ChangeEvent<HTMLInputElement>) {
    const archivo = e.target.files?.[0];
    // Se vacía para que elegir otra vez el mismo archivo vuelva a avisar.
    e.target.value = '';
    if (!archivo) return;
    setError('');
    setAnuncio('');
    setEstado('subiendo');
    try {
      const dataUrl = await prepararFoto(archivo);
      await api.put(url, { photo: dataUrl });
      setPrevia({ base: fotoUrl, src: dataUrl });
      setAnuncio('Se ha guardado la foto.');
      await avisarCambio('subida');
    } catch (err) {
      setError(err instanceof ErrorFoto ? err.message : mensajeError(err, 'No se ha podido subir la foto.'));
    } finally {
      setEstado('reposo');
    }
  }

  async function quitar() {
    setError('');
    setAnuncio('');
    setEstado('quitando');
    try {
      await api.delete(url);
      setPrevia({ base: fotoUrl, src: null });
      setAnuncio('Se ha quitado la foto.');
      await avisarCambio('quitada');
    } catch (err) {
      setError(mensajeError(err, 'No se ha podido quitar la foto.'));
    } finally {
      setEstado('reposo');
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {rotulo && <span className="rotulo">{rotulo}</span>}
      {/* En el móvil los dos botones se apilan siempre: en fila no caben junto
          al avatar a 360 px y, al partirse según el ancho, quedaban descolocados. */}
      <div className="flex items-start gap-4 sm:items-center">
        <AvatarBuzon src={mostrada} nombre={nombre} tamano="grande" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-col items-start gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
            <Button
              type="button"
              variant="perfil"
              className={altura}
              busy={estado === 'subiendo'}
              disabled={estado !== 'reposo'}
              onClick={() => entrada.current?.click()}
            >
              {mostrada ? 'Cambiar foto' : 'Subir foto'}
            </Button>
            {mostrada && (
              <Button
                type="button"
                variant="plano"
                className={altura}
                busy={estado === 'quitando'}
                disabled={estado !== 'reposo'}
                onClick={() => void quitar()}
              >
                Quitar foto
              </Button>
            )}
          </div>
          {ayuda && <p className="max-w-[60ch] text-sm text-tinta-3">{ayuda}</p>}
        </div>
      </div>
      {error && <AvisoError>{error}</AvisoError>}
      <span className="sr-only" role="status">
        {anuncio}
      </span>
      <input ref={entrada} type="file" accept="image/*" hidden tabIndex={-1} onChange={(e) => void elegir(e)} />
    </div>
  );
}
