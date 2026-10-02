/**
 * Exclusión mutua por clave dentro del proceso.
 *
 * Las altas comprueban el límite del plan, hablan con el motor (await) y
 * después insertan: sin serializarlas, varias peticiones simultáneas del
 * mismo cliente pasarían todas la comprobación antes de que ninguna
 * insertara, y un plan de 5 buzones acabaría con 15. Mailway es un único
 * proceso, así que basta con encadenar promesas por clave.
 */
const colas = new Map<string, Promise<void>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const anterior = colas.get(key) ?? Promise.resolve();
  let liberar!: () => void;
  const turno = new Promise<void>((resolve) => {
    liberar = resolve;
  });
  const cola = anterior.then(() => turno);
  colas.set(key, cola);
  await anterior;
  try {
    return await fn();
  } finally {
    liberar();
    // Si nadie se ha puesto detrás, se limpia la entrada para no acumular claves.
    if (colas.get(key) === cola) colas.delete(key);
  }
}

/** Clave común para las altas de un cliente (dominios, buzones, alias). */
export function clientLockKey(clientId: string): string {
  return `altas:${clientId}`;
}
