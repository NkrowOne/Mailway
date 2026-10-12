// Configuración plana de ESLint (desde ESLint 9 los .eslintrc.* ya no se leen y
// ESLint 10 los ignora del todo). La intención es la de siempre: solo las reglas
// de hooks de React, que son las que compilan sin quejas y rompen la página en
// producción (un hook tras un `return` temprano). El resto del estilo lo cubre
// `tsc` en `npm run typecheck`.
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  // Equivale al `ignorePatterns` de antes: dist es la salida de Vite.
  { ignores: ['**/dist/', '**/node_modules/'] },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    // Las dos reglas se activan a mano y NO con `reactHooks.configs.recommended`:
    // desde la versión 7 ese preajuste añade las reglas del compilador de React
    // (set-state-in-effect, refs, purity…), que marcarían código que hoy es
    // válido. Si se quieren, se adoptan en un cambio propio, con su limpieza.
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
