/*
  Ilustraciones de las dos entradas, para que no se confundan a simple vista:
  la del panel dibuja un panel de gestión (dominios con su estado, cifras) y
  la de «Mi buzón», un ordenador y un móvil con el correo. Solo formas, sin
  texto legible: valen para cualquier idioma y cualquier marca blanca. Son
  decorativas (aria-hidden): lo que importa lo dicen los títulos.
*/

const PETROLEO = '#0d5c5e';
const PETROLEO_CLARO = '#e2f0ed';
const AGUAMARINA = '#7ad3c8';
const PAPEL = '#ffffff';
const MESA = '#f4f6f4';
const GRIS = '#dfe5e3';
const GRIS_SUAVE = '#edf1ef';

/** Panel de gestión dibujado: ventana con barra lateral, cifras y dominios con su estado. */
export function IlustracionPanel({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 460 360" className={className} aria-hidden fill="none">
      {/* Hoja de fondo, girada: da profundidad sin otro color. */}
      <rect x="58" y="52" width="380" height="270" rx="20" fill={PAPEL} opacity="0.12" transform="rotate(5 248 187)" />
      {/* Ventana */}
      <rect x="24" y="40" width="400" height="280" rx="18" fill={PAPEL} />
      <circle cx="46" cy="62" r="4.5" fill={GRIS} />
      <circle cx="61" cy="62" r="4.5" fill={GRIS} />
      <circle cx="76" cy="62" r="4.5" fill={GRIS} />
      <rect x="150" y="54" width="180" height="16" rx="8" fill={GRIS_SUAVE} />
      <line x1="24" y1="84" x2="424" y2="84" stroke={GRIS_SUAVE} strokeWidth="2" />
      {/* Barra lateral: la sección activa en petróleo tenue */}
      <rect x="38" y="100" width="64" height="16" rx="8" fill={PETROLEO_CLARO} />
      <rect x="44" y="105" width="34" height="6" rx="3" fill={PETROLEO} />
      <rect x="44" y="132" width="44" height="6" rx="3" fill={GRIS} />
      <rect x="44" y="154" width="36" height="6" rx="3" fill={GRIS} />
      <rect x="44" y="176" width="48" height="6" rx="3" fill={GRIS} />
      <rect x="44" y="198" width="30" height="6" rx="3" fill={GRIS} />
      <line x1="116" y1="84" x2="116" y2="320" stroke={GRIS_SUAVE} strokeWidth="2" />
      {/* Cifras */}
      {[132, 230, 328].map((x, i) => (
        <g key={x}>
          <rect x={x} y="100" width="82" height="58" rx="10" fill={MESA} />
          <rect x={x + 12} y="114" width={i === 0 ? 34 : i === 1 ? 26 : 40} height="9" rx="4.5" fill={PETROLEO} />
          <rect x={x + 12} y="134" width="52" height="6" rx="3" fill={GRIS} />
        </g>
      ))}
      {/* Dominios con su estado */}
      {[
        { y: 178, estado: 'normal' as const, ancho: 112 },
        { y: 222, estado: 'vigilar' as const, ancho: 92 },
        { y: 266, estado: 'normal' as const, ancho: 124 },
      ].map(({ y, estado, ancho }) => (
        <g key={y}>
          <rect x="132" y={y} width="278" height="34" rx="9" fill={PAPEL} stroke={GRIS_SUAVE} strokeWidth="2" />
          <circle cx="150" cy={y + 17} r="7" fill={PETROLEO_CLARO} />
          <rect x="166" y={y + 10} width={ancho} height="7" rx="3.5" fill={GRIS} />
          <rect x="166" y={y + 21} width={ancho * 0.6} height="5" rx="2.5" fill={GRIS_SUAVE} />
          <rect
            x="352"
            y={y + 10}
            width="44"
            height="14"
            rx="7"
            fill={estado === 'normal' ? '#e4f5ec' : '#fdf2e0'}
          />
          <circle cx="362" cy={y + 17} r="3" fill={estado === 'normal' ? '#087a4c' : '#a85e00'} />
          <rect x="369" y={y + 15} width="20" height="4" rx="2" fill={estado === 'normal' ? '#087a4c' : '#a85e00'} opacity="0.55" />
        </g>
      ))}
      {/* Ficha flotante: comprobado */}
      <g transform="rotate(-6 404 46)">
        <rect x="376" y="18" width="56" height="56" rx="16" fill={AGUAMARINA} />
        <path
          d="M404 31.5l11 4.2v8.1c0 7-4.6 12.3-11 14.7-6.4-2.4-11-7.7-11-14.7v-8.1l11-4.2z"
          stroke="#062b29"
          strokeWidth="2.6"
          strokeLinejoin="round"
        />
        <path d="M398.5 45.2l3.9 3.8 7.1-7.3" stroke="#062b29" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

/** Ordenador y móvil con el correo: lo que se configura desde «Mi buzón». */
export function IlustracionBuzon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 300 170" className={className} aria-hidden fill="none">
      {/* Ordenador */}
      <rect x="40" y="18" width="180" height="116" rx="12" fill={PAPEL} stroke={PETROLEO} strokeWidth="3" />
      <rect x="52" y="30" width="156" height="92" rx="6" fill={PETROLEO_CLARO} />
      <path d="M26 142h208a6 6 0 0 1-6 8H32a6 6 0 0 1-6-8z" fill={PETROLEO} />
      {/* Sobre en la pantalla */}
      <rect x="96" y="50" width="68" height="50" rx="8" fill={PAPEL} stroke={PETROLEO} strokeWidth="3" />
      <path d="M100 56l26.5 20.5a6 6 0 0 0 7 0L160 56" stroke={PETROLEO} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {/* Móvil */}
      <rect x="206" y="44" width="62" height="112" rx="13" fill={PAPEL} stroke={PETROLEO} strokeWidth="3" />
      <rect x="226" y="52" width="22" height="4" rx="2" fill={GRIS} />
      <rect x="216" y="66" width="42" height="9" rx="4.5" fill={PETROLEO_CLARO} />
      <rect x="216" y="82" width="34" height="6" rx="3" fill={GRIS} />
      <rect x="216" y="94" width="42" height="6" rx="3" fill={GRIS_SUAVE} />
      <rect x="216" y="106" width="28" height="6" rx="3" fill={GRIS} />
      <rect x="216" y="118" width="38" height="6" rx="3" fill={GRIS_SUAVE} />
      {/* Configurado */}
      <circle cx="262" cy="46" r="16" fill={AGUAMARINA} />
      <path d="M254.5 46.3l5 4.8 8.5-9" stroke="#062b29" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
