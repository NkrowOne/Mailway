/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Superficies: fondo de la aplicación y tarjetas.
        mesa: 'rgb(var(--mesa) / <alpha-value>)',
        hoja: 'rgb(var(--hoja) / <alpha-value>)',
        'hoja-2': 'rgb(var(--hoja-2) / <alpha-value>)',
        'hoja-3': 'rgb(var(--hoja-3) / <alpha-value>)',
        // Texto: principal, secundario y metadatos.
        tinta: 'rgb(var(--tinta) / <alpha-value>)',
        'tinta-2': 'rgb(var(--tinta-2) / <alpha-value>)',
        'tinta-3': 'rgb(var(--tinta-3) / <alpha-value>)',
        // Verde petróleo: identidad, acción principal y orientación.
        petroleo: 'rgb(var(--petroleo) / <alpha-value>)',
        'petroleo-hondo': 'rgb(var(--petroleo-hondo) / <alpha-value>)',
        'petroleo-claro': 'rgb(var(--petroleo-claro) / <alpha-value>)',
        // Estados: el único color que califica un dato.
        normal: 'rgb(var(--normal) / <alpha-value>)',
        vigilar: 'rgb(var(--vigilar) / <alpha-value>)',
        fuera: 'rgb(var(--fuera) / <alpha-value>)',
        'normal-fondo': 'rgb(var(--normal-fondo) / <alpha-value>)',
        'vigilar-fondo': 'rgb(var(--vigilar-fondo) / <alpha-value>)',
        'fuera-fondo': 'rgb(var(--fuera-fondo) / <alpha-value>)',
      },
      borderColor: {
        DEFAULT: 'var(--regla)',
        regla: 'var(--regla)',
        'regla-fuerte': 'var(--regla-fuerte)',
      },
      fontFamily: {
        ui: ['"Figtree Variable"', 'system-ui', 'sans-serif'],
        codigo: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // Escala cómoda: cuerpo de 15 px con interlineado amplio.
        micro: ['12px', { lineHeight: '16px' }],
        sm: ['13px', { lineHeight: '19px' }],
        base: ['15px', { lineHeight: '23px' }],
        md: ['16px', { lineHeight: '24px' }],
        lg: ['18px', { lineHeight: '26px' }],
        xl: ['21px', { lineHeight: '28px' }],
        '2xl': ['24px', { lineHeight: '31px' }],
        '3xl': ['28px', { lineHeight: '35px' }],
        '4xl': ['34px', { lineHeight: '41px' }],
      },
      boxShadow: {
        suave: 'var(--sombra-suave)',
        boton: 'var(--sombra-boton)',
        flotante: 'var(--sombra-flotante)',
      },
      keyframes: {
        aparecer: {
          '0%': { transform: 'translateY(4px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
      animation: {
        aparecer: 'aparecer 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
      },
    },
  },
  plugins: [],
};
