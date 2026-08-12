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
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto animate-aparecer rounded border bg-chasis-3 px-3.5 py-2.5
              text-sm text-tinta shadow-flotante
              ${toast.tone === 'ok' ? 'border-[rgb(var(--entregado)/0.4)]' : 'border-[rgb(var(--devuelto)/0.5)]'}`}
          >
            <span
              className={`mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${
                toast.tone === 'ok' ? 'bg-entregado' : 'bg-devuelto'
              }`}
              aria-hidden
            />
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
