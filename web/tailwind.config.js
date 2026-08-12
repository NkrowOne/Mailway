/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Superficies: mesa de trabajo y hoja de informe.
        mesa: 'rgb(var(--mesa) / <alpha-value>)',
        hoja: 'rgb(var(--hoja) / <alpha-value>)',
        'hoja-2': 'rgb(var(--hoja-2) / <alpha-value>)',
        'hoja-3': 'rgb(var(--hoja-3) / <alpha-value>)',
        // Tinta impresa.
        tinta: 'rgb(var(--tinta) / <alpha-value>)',
        'tinta-2': 'rgb(var(--tinta-2) / <alpha-value>)',
        'tinta-3': 'rgb(var(--tinta-3) / <alpha-value>)',
        // Membrete del laboratorio: identidad y orientación, no adorno.
        laboratorio: 'rgb(var(--laboratorio) / <alpha-value>)',
        'laboratorio-hondo': 'rgb(var(--laboratorio-hondo) / <alpha-value>)',
        'laboratorio-vivo': 'rgb(var(--laboratorio-vivo) / <alpha-value>)',
        'laboratorio-tinta': 'rgb(var(--laboratorio-tinta) / <alpha-value>)',
        'laboratorio-claro': 'rgb(var(--laboratorio-claro) / <alpha-value>)',
        // Veredictos: el único color que califica un dato.
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
        'regla-lab': 'var(--regla-lab)',
      },
      fontFamily: {
        ui: ['"Archivo Variable"', 'system-ui', 'sans-serif'],
        estrecha: ['"Archivo Narrow"', '"Archivo Variable"', 'sans-serif'],
        valor: ['"Azeret Mono Variable"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // Escala de informe: densa y precisa, cuerpo 14.
        micro: ['11px', { lineHeight: '15px' }],
        sm: ['12px', { lineHeight: '17px' }],
        base: ['14px', { lineHeight: '21px' }],
        md: ['15px', { lineHeight: '22px' }],
        lg: ['17px', { lineHeight: '24px' }],
        xl: ['21px', { lineHeight: '27px' }],
        '2xl': ['26px', { lineHeight: '31px' }],
        '3xl': ['34px', { lineHeight: '36px' }],
        '4xl': ['46px', { lineHeight: '44px' }],
        '5xl': ['68px', { lineHeight: '62px' }],
      },
      boxShadow: {
        // Elevación declarada UNA vez: los diálogos flotan; nada más.
        flotante: '0 18px 48px -20px rgb(26 25 22 / 0.38)',
      },
      keyframes: {
        aparecer: {
          '0%': { transform: 'translateY(6px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
      animation: {
        aparecer: 'aparecer 220ms cubic-bezier(0.16, 1, 0.3, 1) both',
      },
    },
  },
  plugins: [],
};
