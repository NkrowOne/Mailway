/**
 * Dirección con la que se abrió la aplicación. Se captura al arrancar, antes
 * de que el enrutador redirija a /login y la pierda: así, quien abre un enlace
 * guardado sin sesión vuelve a él tras entrar. Vive en un módulo propio, que
 * se carga con la aplicación, porque la pantalla de acceso se descarga aparte
 * y para entonces la dirección ya sería /login.
 */
export const enlaceDeArranque =
  typeof window !== 'undefined'
    ? `${window.location.pathname}${window.location.search}${window.location.hash}`
    : '/';
