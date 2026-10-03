import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

interface Toast {
  id: number;
  tone: 'ok' | 'error';
  text: string;
}

const ToastContext = createContext<(tone: Toast['tone'], text: string) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

/** Un error se lee con más calma que una confirmación: dura más en pantalla. */
const DURACION: Record<Toast['tone'], number> = { ok: 4200, error: 7000 };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const temporizadores = useRef(new Map<number, number>());

  const retirar = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = temporizadores.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    temporizadores.current.delete(id);
  }, []);

  const push = useCallback(
    (tone: Toast['tone'], text: string) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev.slice(-3), { id, tone, text }]);
      temporizadores.current.set(
        id,
        window.setTimeout(() => retirar(id), DURACION[tone]),
      );
    },
    [retirar],
  );

  useEffect(() => {
    const pendientes = temporizadores.current;
    return () => {
      for (const timer of pendientes.values()) window.clearTimeout(timer);
      pendientes.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(360px,calc(100vw-32px))] flex-col gap-2"
      >
        {/* Aviso flotante con el glifo del estado. La región anuncia las
            confirmaciones sin interrumpir; un error se anuncia de inmediato
            (alert). */}
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : undefined}
            className="pointer-events-auto flex animate-aparecer items-start gap-3 rounded-xl border border-regla
              bg-hoja py-3 pl-3.5 pr-2 text-base text-tinta shadow-flotante"
          >
            <span
              aria-hidden
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                toast.tone === 'ok' ? 'bg-normal-fondo text-normal' : 'bg-fuera-fondo text-fuera'
              }`}
            >
              <svg viewBox="0 0 10 10" className="h-2.5 w-2.5">
                {toast.tone === 'ok' ? (
                  <path d="M1.5 5.4L4 7.8 8.6 2.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                ) : (
                  <path d="M2.4 2.4l5.2 5.2M7.6 2.4L2.4 7.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                )}
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <span className="sr-only">{toast.tone === 'ok' ? 'Hecho: ' : 'No se ha podido: '}</span>
              <p className="[overflow-wrap:anywhere]">{toast.text}</p>
            </div>
            <button
              type="button"
              onClick={() => retirar(toast.id)}
              aria-label="Cerrar aviso"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-tinta-3 hover:bg-hoja-3 hover:text-tinta"
            >
              <svg viewBox="0 0 14 14" className="h-3 w-3" aria-hidden>
                <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
