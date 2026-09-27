/**
 * Fecha y hora cortas («27 sept, 14:05»). Si no es del año en curso se añade
 * el año: un aviso de hace catorce meses no debe leerse como de este mes.
 */
export function formatDate(ts: number | null | undefined): string {
  if (!ts) return '—';
  const fecha = new Date(ts);
  const otroAnio = fecha.getFullYear() !== new Date().getFullYear();
  return fecha.toLocaleString('es-ES', {
    day: '2-digit',
    month: 'short',
    ...(otroAnio ? { year: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDay(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

const numeroEs = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });

export function formatMb(mb: number): string {
  if (mb >= 1024) return `${numeroEs.format(mb / 1024)} GB`;
  return `${numeroEs.format(mb)} MB`;
}

/** Tamaño en bytes con la unidad adecuada (B, KB, MB, GB), en base 1024. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const unidades = ['B', 'KB', 'MB', 'GB', 'TB'];
  let valor = Math.max(0, bytes);
  let i = 0;
  while (valor >= 1024 && i < unidades.length - 1) {
    valor /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(valor) : numeroEs.format(valor)} ${unidades[i]}`;
}

export function plural(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}
