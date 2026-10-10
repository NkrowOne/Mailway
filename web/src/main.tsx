import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ToastProvider } from './ui/toast';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Sin startTransition, como con la versión 6: al navegar, la vista
          cambia en el acto y, mientras llega su código, se ve «Cargando…».
          Con la transición (lo predeterminado en la 7), la vista anterior se
          quedaría un momento en pantalla bajo la pestaña nueva. */}
      <BrowserRouter useTransitions={false}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
