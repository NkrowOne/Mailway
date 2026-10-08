import type { ReactNode } from 'react';
import type { CheckStatus, DnsCheck } from '../../lib/api';
import type { RegistroPropiedad } from '../../lib/cloudflare';
import { Button } from '../../ui/Button';
import { Hoja, MarcaFondo, Muestra, type Veredicto } from '../../ui/kit';

/*
  Piezas de la ficha del dominio que también usa la puesta en marcha del
  cliente: cada registro DNS con el valor que hay que crear y lo que el DNS
  devuelve ahora, y el TXT que prueba la propiedad. Viven aquí para que la
  ficha y el asistente enseñen exactamente lo mismo.

  Cada registro DNS es una MEDICIÓN: `expected` es el valor de referencia,
  `found` es el valor medido y el estado es el veredicto.
*/

export const veredictoDe: Record<CheckStatus, Veredicto> = {
  ok: 'normal',
  missing: 'fuera',
  mismatch: 'fuera',
  unknown: 'sin-dato',
};

export const etiquetaDe: Record<CheckStatus, string> = {
  ok: 'Correcto',
  missing: 'Falta',
  mismatch: 'No coincide',
  unknown: 'Sin dato',
};

/** Orden de lectura del informe: primero lo que reclama una acción. */
const prioridad: Record<Veredicto, number> = { fuera: 0, vigilar: 1, 'sin-dato': 2, normal: 3 };

export function porVeredicto(checks: DnsCheck[]): DnsCheck[] {
  return [...checks].sort(
    (a, b) => prioridad[veredictoDe[a.status]] - prioridad[veredictoDe[b.status]],
  );
}

/**
 * MTA-STS y TLS-RPT endurecen la entrega pero exigen publicar una política:
 * se miden aparte para que no cuenten como autoconfiguración pendiente.
 */
export function esEndurecimiento(check: DnsCheck): boolean {
  return (
    check.id.startsWith('mtasts:') ||
    check.id.startsWith('tlsrpt:') ||
    check.name.startsWith('mta-sts.') ||
    check.name.startsWith('_mta-sts.') ||
    check.name.startsWith('_smtp._tls.')
  );
}

/** Los valores largos (claves DKIM) se parten; en móvil nunca se desplaza en horizontal. */
const partible = 'block break-all';

/**
 * Propiedad pendiente: el TXT que la prueba sin tocar el MX. Sirve para
 * preparar los buzones antes de trasladar el correo desde otro proveedor.
 * La puesta en marcha cambia el título y la explicación (habla a alguien que
 * no sabe qué es un MX); el registro y la acción son los mismos.
 */
export function BloquePropiedad({
  registro,
  midiendo,
  onVerificar,
  titulo = 'Comprobar la propiedad sin cambiar el MX',
  explicacion,
  pie,
}: {
  registro: RegistroPropiedad;
  midiendo: boolean;
  onVerificar: () => void;
  titulo?: string;
  explicacion?: ReactNode;
  pie?: ReactNode;
}) {
  return (
    <Hoja
      title={titulo}
      meta="Propiedad pendiente"
      actions={
        <Button variant="perfil" busy={midiendo} onClick={onVerificar}>
          Verificar
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="max-w-[75ch] text-base text-tinta-2">
          {explicacion ?? (
            <p>
              Antes de crear buzones o alias es necesario comprobar que el dominio es tuyo. Queda
              comprobado en cuanto el registro MX apunta a este servidor. Si el correo del dominio
              todavía llega a otro proveedor (por ejemplo, para preparar los buzones antes del
              traslado), crea este registro TXT, que no afecta al correo actual, y pulsa «Verificar».
            </p>
          )}
        </div>
        <Muestra rotulo="Registro TXT de verificación" copiar={registro.content}>
          <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="rotulo sm:pt-px">Tipo</dt>
            <dd className="codigo min-w-0 text-sm text-tinta">{registro.type}</dd>
            <dt className="rotulo mt-1 sm:mt-0 sm:pt-px">Nombre</dt>
            <dd className={`codigo min-w-0 text-sm text-tinta ${partible}`}>{registro.name}</dd>
            <dt className="rotulo mt-1 sm:mt-0 sm:pt-px">Valor</dt>
            <dd className={`codigo min-w-0 text-sm text-tinta ${partible}`}>{registro.content}</dd>
          </dl>
        </Muestra>
        {pie ?? (
          <p className="max-w-[75ch] text-sm text-tinta-3">
            Si el DNS del dominio está en Cloudflare, «Revisar cambios» en la configuración automática
            lo crea junto con el resto de registros. Mailway comprueba la propiedad en cada medición.
          </p>
        )}
      </div>
    </Hoja>
  );
}

/**
 * Una medición: el valor de referencia que hay que crear (lo que el usuario
 * se lleva a su proveedor) y, debajo, lo que el DNS devuelve ahora.
 */
export function RegistroMedido({
  check,
  recien,
  accion,
}: {
  check: DnsCheck;
  recien: boolean;
  /** Acción que resuelve el registro desde la propia fila (p. ej. generar la clave DKIM). */
  accion?: ReactNode;
}) {
  const veredicto = veredictoDe[check.status];
  const fuera = veredicto === 'fuera';

  return (
    <li className={`regla-fila px-4 py-3.5 last:border-b-0 ${fuera ? 'fila-fuera' : ''}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <h3 className="min-w-0 basis-full text-base font-medium text-tinta sm:basis-0 sm:grow">
          {check.label}
        </h3>
        <span className="rotulo shrink-0">{check.type}</span>
        <span className={`ml-auto shrink-0 sm:ml-0 ${recien ? 'revelar' : ''}`}>
          <MarcaFondo veredicto={veredicto}>{etiquetaDe[check.status]}</MarcaFondo>
        </span>
      </div>

      {check.engineMissing ? (
        // Sin valor que copiar: el motor todavía no ha generado el registro.
        <p className="mt-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="rotulo shrink-0">Valor que hay que crear</span>
          <span className="text-sm text-tinta-3">pendiente de generar en el servidor de correo</span>
        </p>
      ) : (
        <Muestra rotulo="Valor que hay que crear" copiar={check.expected} className="mt-2.5">
          <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="rotulo sm:pt-px">Nombre</dt>
            <dd className={`valor min-w-0 text-sm text-tinta ${partible}`}>{check.name}</dd>
            <dt className="rotulo mt-1 sm:mt-0 sm:pt-px">Valor</dt>
            <dd className={`valor min-w-0 text-sm text-tinta ${partible}`}>{check.expected}</dd>
          </dl>
        </Muestra>
      )}

      {check.status !== 'ok' && !check.engineMissing && (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="rotulo shrink-0">El DNS devuelve ahora</span>
          <span
            className={`valor min-w-0 basis-full text-sm sm:basis-0 sm:grow ${partible} ${
              check.found ? (fuera ? 'text-fuera' : 'text-tinta-2') : 'text-tinta-3'
            }`}
          >
            {/* null es «no se pudo consultar» aunque el veredicto sea definitivo
                (un MX interno está fuera de rango mida lo que mida el DNS). */}
            {check.found || (check.found === null ? 'no se ha podido consultar' : 'ningún registro')}
          </span>
        </p>
      )}

      <p className="mt-2 max-w-[75ch] text-sm text-tinta-2">{check.help}</p>
      {accion && <div className="mt-2.5">{accion}</div>}
    </li>
  );
}
