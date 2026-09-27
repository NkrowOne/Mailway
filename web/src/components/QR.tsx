import { useMemo } from 'react';
import { create } from 'qrcode';

/**
 * Código QR como SVG en línea: nítido a cualquier tamaño, sin imágenes ni
 * peticiones, y generado en el propio navegador (el texto puede contener un
 * enlace de configuración y no debe salir hacia ningún servicio externo).
 */
export function QR({
  texto,
  etiqueta,
  tamano = 176,
  className = '',
}: {
  texto: string;
  /** Descripción accesible: qué abre el código al escanearlo. */
  etiqueta: string;
  tamano?: number;
  className?: string;
}) {
  const dibujo = useMemo(() => {
    try {
      const qr = create(texto, { errorCorrectionLevel: 'M' });
      const n = qr.modules.size;
      const datos = qr.modules.data;
      // Margen de 4 módulos: la «zona de silencio» que exigen los lectores.
      const margen = 4;
      let d = '';
      for (let y = 0; y < n; y++) {
        let x = 0;
        while (x < n) {
          if (!datos[y * n + x]) {
            x += 1;
            continue;
          }
          // Tramos horizontales en un solo rectángulo: el trazado ocupa
          // mucho menos que un cuadrado por módulo.
          let fin = x;
          while (fin < n && datos[y * n + fin]) fin += 1;
          d += `M${x + margen} ${y + margen}h${fin - x}v1h-${fin - x}z`;
          x = fin;
        }
      }
      return { lado: n + margen * 2, d };
    } catch {
      return null;
    }
  }, [texto]);

  if (!dibujo) {
    return <p className="text-sm text-tinta-3">No se ha podido generar el código QR.</p>;
  }
  return (
    <svg
      viewBox={`0 0 ${dibujo.lado} ${dibujo.lado}`}
      width={tamano}
      height={tamano}
      role="img"
      aria-label={etiqueta}
      shapeRendering="crispEdges"
      className={`block shrink-0 border border-regla bg-white ${className}`}
    >
      <rect width={dibujo.lado} height={dibujo.lado} fill="#ffffff" />
      <path d={dibujo.d} fill="rgb(22 21 19)" />
    </svg>
  );
}
