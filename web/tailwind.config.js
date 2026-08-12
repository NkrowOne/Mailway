/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Chasis: la carcasa oscura de la terminal de clasificación.
        cinta: 'rgb(var(--cinta) / <alpha-value>)',
        chasis: 'rgb(var(--chasis) / <alpha-value>)',
        'chasis-2': 'rgb(var(--chasis-2) / <alpha-value>)',
        'chasis-3': 'rgb(var(--chasis-3) / <alpha-value>)',
        // Tinta sobre chasis.
        tinta: 'rgb(var(--tinta) / <alpha-value>)',
        'tinta-2': 'rgb(var(--tinta-2) / <alpha-value>)',
        'tinta-3': 'rgb(var(--tinta-3) / <alpha-value>)',
        // Etiqueta: papel adhesivo para lo que sale del sistema.
        etiqueta: 'rgb(var(--etiqueta) / <alpha-value>)',
        'etiqueta-tinta': 'rgb(var(--etiqueta-tinta) / <alpha-value>)',
        'etiqueta-borde': 'rgb(var(--etiqueta-borde) / <alpha-value>)',
        // Naranja de seguridad: EL color de acción, único.
        accion: 'rgb(var(--accion) / <alpha-value>)',
        'accion-tinta': 'rgb(var(--accion-tinta) / <alpha-value>)',
        // Semáforo de reparto.
        entregado: 'rgb(var(--entregado) / <alpha-value>)',
        transito: 'rgb(var(--transito) / <alpha-value>)',
        devuelto: 'rgb(var(--devuelto) / <alpha-value>)',
      },
      borderColor: {
        DEFAULT: 'var(--borde)',
        suave: 'var(--borde-suave)',
        fuerte: 'var(--borde-fuerte)',
      },
      fontFamily: {
        ui: ['Barlow', 'system-ui', 'sans-serif'],
        rotulo: ['"Barlow Condensed"', 'Barlow', 'sans-serif'],
        guia: ['"Martian Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // Escala 1.25 sobre cuerpo 14.
        micro: ['11px', { lineHeight: '16px' }],
        sm: ['12.5px', { lineHeight: '18px' }],
        base: ['14px', { lineHeight: '21px' }],
        md: ['16px', { lineHeight: '23px' }],
        lg: ['18px', { lineHeight: '25px' }],
        xl: ['22px', { lineHeight: '28px' }],
        '2xl': ['28px', { lineHeight: '33px' }],
        '3xl': ['44px', { lineHeight: '48px' }],
      },
      boxShadow: {
        flotante: '0 0 0 1px rgba(255,255,255,.08), 0 12px 32px -12px rgba(0,0,0,.55)',
      },
      keyframes: {
        sello: {
          '0%': { transform: 'scale(1.5) rotate(-14deg)', opacity: '0' },
          '65%': { transform: 'scale(0.96) rotate(-8deg)', opacity: '1' },
          '100%': { transform: 'scale(1) rotate(-8deg)', opacity: '1' },
        },
        aparecer: {
          '0%': { transform: 'translateY(4px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        cintaAvance: {
          '0%': { backgroundPosition: '0 0' },
          '100%': { backgroundPosition: '28px 0' },
        },
      },
      animation: {
        sello: 'sello 260ms cubic-bezier(0.23, 1, 0.32, 1) both',
        aparecer: 'aparecer 200ms cubic-bezier(0.23, 1, 0.32, 1) both',
        cinta: 'cintaAvance 1.2s linear infinite',
      },
    },
  },
  plugins: [],
};
