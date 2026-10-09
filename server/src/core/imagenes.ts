/**
 * Imágenes que suben los usuarios (foto del buzón, marca del correo web):
 * el tipo y el tamaño se leen de los propios bytes, nunca del tipo declarado
 * ni de la extensión. Solo formatos de mapa de bits sin scripts posibles:
 * una «imagen» que fuera HTML o SVG se serviría como código desde el origen
 * del panel o del correo web.
 */

export type TipoImagen = 'image/png' | 'image/jpeg' | 'image/webp';

const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Tipo real de la imagen según sus primeros bytes, o null si no es PNG, JPEG ni WebP. */
export function tipoDeImagen(data: Buffer): TipoImagen | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(FIRMA_PNG)) return 'image/png';
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** Marcadores JPEG de inicio de fotograma (SOFn): llevan el alto y el ancho. */
const SOF_JPEG = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function dimensionesJpeg(data: Buffer): { ancho: number; alto: number } | null {
  let i = 2;
  while (i + 3 < data.length) {
    if (data[i] !== 0xff) return null;
    const marcador = data[i + 1]!;
    // Relleno entre segmentos (0xFF repetido).
    if (marcador === 0xff) {
      i += 1;
      continue;
    }
    // Marcadores sueltos, sin longitud.
    if (marcador === 0xd8 || marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd7)) {
      i += 2;
      continue;
    }
    // El escaneado empieza antes de ningún fotograma: no es una imagen válida.
    if (marcador === 0xda || marcador === 0xd9) return null;
    const longitud = data.readUInt16BE(i + 2);
    if (longitud < 2) return null;
    if (SOF_JPEG.has(marcador)) {
      if (i + 9 > data.length) return null;
      return { alto: data.readUInt16BE(i + 5), ancho: data.readUInt16BE(i + 7) };
    }
    i += 2 + longitud;
  }
  return null;
}

function dimensionesWebp(data: Buffer): { ancho: number; alto: number } | null {
  if (data.length < 30) return null;
  const trozo = data.toString('latin1', 12, 16);
  if (trozo === 'VP8 ') {
    // Fotograma clave: código de inicio 9d 01 2a y después 14 bits de cada lado.
    if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) return null;
    return { ancho: data.readUInt16LE(26) & 0x3fff, alto: data.readUInt16LE(28) & 0x3fff };
  }
  if (trozo === 'VP8L') {
    if (data[20] !== 0x2f) return null;
    const bits = data.readUInt32LE(21);
    return { ancho: (bits & 0x3fff) + 1, alto: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (trozo === 'VP8X') {
    return { ancho: data.readUIntLE(24, 3) + 1, alto: data.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/**
 * Ancho y alto declarados en la cabecera de la imagen, o null si la cabecera
 * no se puede leer. Sirve para rechazar imágenes desproporcionadas: unos
 * pocos KB de PNG pueden declarar millones de píxeles y agotar la memoria de
 * quien las decodifique (el icono de la aplicación lo redimensiona Bulwark).
 */
export function dimensionesImagen(data: Buffer, tipo: TipoImagen): { ancho: number; alto: number } | null {
  let dimensiones: { ancho: number; alto: number } | null = null;
  if (tipo === 'image/png') {
    // La cabecera IHDR va siempre la primera, justo después de la firma.
    if (data.length >= 24 && data.toString('latin1', 12, 16) === 'IHDR') {
      dimensiones = { ancho: data.readUInt32BE(16), alto: data.readUInt32BE(20) };
    }
  } else if (tipo === 'image/jpeg') {
    dimensiones = dimensionesJpeg(data);
  } else {
    dimensiones = dimensionesWebp(data);
  }
  if (!dimensiones || dimensiones.ancho <= 0 || dimensiones.alto <= 0) return null;
  return dimensiones;
}
