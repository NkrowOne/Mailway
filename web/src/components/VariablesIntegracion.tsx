import { useId, useState } from 'react';
import type { BloqueVariables } from '../lib/api';
import { Muestra } from '../ui/kit';
import { Pestanas } from '../ui/Pestanas';

/**
 * Bloques listos para copiar (.env, Node, Laravel y Django) que acompañan a
 * una clave de API o a una contraseña de aplicación recién creadas. Llegan
 * solo en la respuesta del alta: el secreto no se guarda en claro, así que no
 * se pueden volver a generar.
 */
export function VariablesIntegracion({
  bloques,
  tactil = false,
}: {
  bloques: BloqueVariables[];
  tactil?: boolean;
}) {
  const [activo, setActivo] = useState(bloques[0]?.id ?? 'env');
  const panelId = useId();
  const bloque = bloques.find((b) => b.id === activo) ?? bloques[0];
  if (!bloque) return null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Pestanas
        opciones={bloques.map((b) => ({ id: b.id, label: b.label }))}
        activo={bloque.id}
        onCambio={setActivo}
        panelId={panelId}
        etiqueta="Formato de las variables"
        tactil={tactil}
      />
      <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${bloque.id}`}>
        <Muestra rotulo={bloque.filename} copiar={bloque.content}>
          {/* Sin desplazamiento horizontal: a 360 px las líneas largas se
              parten, y lo copiado es siempre el texto original. */}
          <pre className="valor whitespace-pre-wrap text-sm leading-relaxed text-tinta [overflow-wrap:anywhere]">
            {bloque.content}
          </pre>
        </Muestra>
      </div>
    </div>
  );
}
