import {
  createContext,
  useCallback,
  useContext,
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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev.slice(-3), { id, tone, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(360px,calc(100vw-32px))] flex-col gap-2"
      >
        {/* Nota al margen del parte: filete superior con el color del veredicto. */}
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto animate-aparecer border border-regla border-t-2 bg-hoja
              px-3.5 py-2.5 text-base text-tinta shadow-flotante
              ${toast.tone === 'ok' ? 'border-t-[rgb(var(--normal))]' : 'border-t-[rgb(var(--fuera))]'}`}
          >
            <span className={`rotulo ${toast.tone === 'ok' ? 'text-normal' : 'text-fuera'}`}>
              {toast.tone === 'ok' ? 'Hecho' : 'No se pudo'}
            </span>
            <p className="mt-0.5">{toast.text}</p>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
