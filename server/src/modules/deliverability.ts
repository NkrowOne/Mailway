import type { FastifyInstance } from 'fastify';
import {
  checkDnsbl,
  lookupA,
  lookupCname,
  lookupMx,
  lookupPtr,
  lookupSrv,
  lookupTxt,
  type DnsblResult,
} from '../core/dns';
import type { EngineDnsRecord } from '../engine/types';
import { requireAdmin } from './auth';
import { getInstanceSettings } from './settings';
import { esObligatorio, seleccionarRegistros } from './zonefile';

/* ----------------------- Comprobación DNS de dominio ---------------------- */

export type CheckStatus = 'ok' | 'missing' | 'mismatch' | 'unknown';

export interface DnsCheck {
  id: string;
  label: string;
  type: string;
  /** Nombre del registro tal y como hay que crearlo en el proveedor DNS. */
  name: string;
  /** Valor esperado (lo que el usuario debe pegar). */
  expected: string;
  /** Lo que devuelve el DNS público ahora mismo. */
  found: string | null;
  status: CheckStatus;
  required: boolean;
  help: string;
}

function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ').replace(/\.$/, '').toLowerCase();
}

/** Extrae la clave pública de un TXT DKIM para comparar solo lo que importa. */
function dkimKey(value: string): string {
  const match = value.replace(/\s|"/g, '').match(/p=([^;]*)/);
  return match ? match[1]! : normalizeValue(value);
}

/**
 * Mecanismos de un SPF (sin «v=spf1», sin modificadores como «ra=» o
 * «redirect=» y sin el «all» final), con el calificador «+» implícito
 * eliminado. Sirve para decidir si un SPF personalizado cubre lo esencial.
 */
export function mecanismosSpf(spf: string): string[] {
  return spf
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .slice(1)
    .filter((t) => t && !t.includes('=') && !/^[-~?+]?all$/.test(t))
    .map((t) => t.replace(/^\+/, ''));
}

/**
 * Un SPF distinto del propuesto también vale si incluye todos los mecanismos
 * que propone el motor (normalmente «mx»): así se respeta el SPF de un
 * dominio que además envía por otros servicios (Google, un CRM…).
 */
export function spfCubre(encontrado: string, esperado: string): boolean {
  const presentes = new Set(mecanismosSpf(encontrado));
  const necesarios = mecanismosSpf(esperado);
  return necesarios.length > 0 && necesarios.every((m) => presentes.has(m));
}

function etiquetaSrv(name: string): string {
  const servicio = name.split('.')[0] || '';
  const nombres: Record<string, string> = {
    _imaps: 'IMAP',
    _submissions: 'SMTP con TLS',
    _submission: 'SMTP',
    _jmap: 'JMAP',
    _caldavs: 'calendarios',
    _carddavs: 'contactos',
  };
  return nombres[servicio] || 'servicio';
}

function classifyRecord(record: EngineDnsRecord, domain: string): {
  id: string;
  label: string;
  required: boolean;
  help: string;
} {
  const name = record.name.replace(/\.$/, '');
  const content = record.content;
  const required = esObligatorio(record);
  if (record.type === 'MX') {
    return {
      id: `mx:${name}`,
      label: 'MX (recepción de correo)',
      required,
      help: 'Indica qué servidor recibe el correo del dominio. Sin él, no es posible recibir mensajes.',
    };
  }
  if (record.type === 'TXT' && content.includes('v=spf1')) {
    return {
      id: `spf:${name}`,
      label: name === domain ? 'SPF (autorización de envío)' : `SPF (autorización de envío · ${name})`,
      required,
      help: 'Declara qué servidores pueden enviar correo con el dominio. Evita la suplantación y mejora la entrega.',
    };
  }
  if (name.includes('_domainkey')) {
    return {
      id: `dkim:${name}`,
      label: `DKIM (firma digital · ${name.split('.')[0]})`,
      required,
      help: 'Firma criptográfica de los mensajes. Gmail y Outlook la exigen para no clasificarlos como spam.',
    };
  }
  if (record.type === 'TXT' && name.startsWith('_dmarc')) {
    return {
      id: `dmarc:${name}`,
      label: 'DMARC (política contra la suplantación)',
      required,
      help: 'Indica a los servidores receptores qué hacer con los mensajes que no superan SPF o DKIM. Gmail y Yahoo lo exigen desde 2024.',
    };
  }
  if (record.type === 'SRV') {
    return {
      id: `srv:${name}`,
      label: `SRV (autodetección de ${etiquetaSrv(name)})`,
      required: false,
      help: 'Permite que los programas de correo configuren la cuenta automáticamente al introducir la dirección.',
    };
  }
  if (record.type === 'CNAME') {
    const corto = name === domain ? name : name.slice(0, -(domain.length + 1));
    return {
      id: `cname:${name}`,
      label: `CNAME (${corto})`,
      required: false,
      help:
        corto === 'autoconfig' || corto === 'autodiscover'
          ? 'Permite que Thunderbird y Outlook obtengan la configuración de la cuenta automáticamente.'
          : 'Registro auxiliar para servicios del dominio (nombre del servidor, MTA-STS…).',
    };
  }
  if (record.type === 'TXT' && name.startsWith('_mta-sts')) {
    return {
      id: `mtasts:${name}`,
      label: 'MTA-STS (TLS obligatorio)',
      required: false,
      help: 'Exige que el correo entrante llegue cifrado. Se recomienda activarlo cuando el resto de registros esté en rango.',
    };
  }
  if (record.type === 'TXT' && name.startsWith('_smtp._tls')) {
    return {
      id: `tlsrpt:${name}`,
      label: 'TLS-RPT (informes de TLS)',
      required: false,
      help: 'Permite recibir informes cuando otro servidor no consigue entregar correo cifrado.',
    };
  }
  return {
    id: `${record.type.toLowerCase()}:${name}`,
    label: `${record.type} (${name})`,
    required,
    help: 'Registro adicional recomendado por el motor de correo.',
  };
}

/**
 * Veredicto del MX: ¿apunta aquí y nadie se le adelanta? Los servidores de
 * origen entregan al MX de menor número (mayor preferencia) y reparten entre
 * los empatados, así que un MX de otro proveedor con prioridad menor o igual
 * que la nuestra se queda con buena parte del correo aunque el nuestro
 * exista. Uno con prioridad mayor es un respaldo y no impide recibir aquí.
 * El plan de Cloudflare aplica el mismo criterio.
 */
export function veredictoMx(
  found: { priority: number; exchange: string }[],
  expectedHost: string,
): { propio: boolean; ajenosPorDelante: string[] } {
  const esperado = normalizeValue(expectedHost);
  const propios = found.filter((r) => normalizeValue(r.exchange) === esperado);
  if (propios.length === 0) return { propio: false, ajenosPorDelante: [] };
  const mejor = Math.min(...propios.map((r) => r.priority));
  const ajenosPorDelante = found
    .filter((r) => normalizeValue(r.exchange) !== esperado && r.priority <= mejor)
    .map((r) => normalizeValue(r.exchange));
  return { propio: true, ajenosPorDelante };
}

/**
 * IPs de `name` si todas apuntan a donde apuntaría el CNAME esperado (la IP
 * del destino o la IP pública del servidor); [] si no; null si no se pudo
 * consultar.
 */
async function aEquivalente(name: string, destino: string): Promise<string[] | null> {
  const ips = await lookupA(name);
  if (ips === null) return null;
  if (ips.length === 0) return [];
  const { publicIp } = getInstanceSettings();
  const delDestino = await lookupA(normalizeValue(destino));
  const validas = new Set([...(delDestino ?? []), ...(publicIp ? [publicIp.trim()] : [])]);
  if (validas.size === 0) return delDestino === null ? null : [];
  return ips.every((ip) => validas.has(ip)) ? ips : [];
}

async function checkRecord(record: EngineDnsRecord, domain: string): Promise<DnsCheck> {
  const meta = classifyRecord(record, domain);
  const name = record.name.replace(/\.$/, '');
  const base: Omit<DnsCheck, 'found' | 'status'> = {
    id: meta.id,
    label: meta.label,
    type: record.type,
    name,
    expected: record.content,
    required: meta.required,
    help: meta.help,
  };

  if (record.type === 'MX') {
    const found = await lookupMx(name);
    if (found === null) return { ...base, found: null, status: 'unknown' };
    if (found.length === 0) return { ...base, found: '', status: 'missing' };
    const foundText = found.map((r) => `${r.priority} ${r.exchange}`).join(', ');
    const expectedHost = normalizeValue(record.content.split(/\s+/).slice(-1)[0] || '');
    const veredicto = veredictoMx(found, expectedHost);
    if (veredicto.ajenosPorDelante.length > 0) {
      return {
        ...base,
        found: foundText,
        status: 'mismatch',
        help: `Además de este servidor, el dominio tiene MX de otro proveedor con la misma o mayor preferencia (${veredicto.ajenosPorDelante.join(', ')}): buena parte del correo entrante llegará allí. Elimine esos registros MX para que todo el correo llegue a este servidor.`,
      };
    }
    return { ...base, found: foundText, status: veredicto.propio ? 'ok' : 'mismatch' };
  }

  if (record.type === 'TXT') {
    const found = await lookupTxt(name);
    if (found === null) return { ...base, found: null, status: 'unknown' };
    const isSpf = record.content.includes('v=spf1');
    const isDmarc = name.startsWith('_dmarc');
    const isDkim = name.includes('_domainkey');
    const prefijo = record.content.trim().toLowerCase().match(/^v=[a-z0-9]+/)?.[0] ?? null;
    const relevant = found.filter((txt) => {
      const t = txt.toLowerCase();
      if (isSpf) return t.startsWith('v=spf1');
      if (isDmarc) return t.startsWith('v=dmarc1');
      if (isDkim) return t.includes('k=') || t.includes('p=');
      // MTA-STS, TLS-RPT…: solo cuentan los TXT del mismo tipo.
      return prefijo ? t.startsWith(prefijo) : true;
    });
    if (relevant.length === 0) return { ...base, found: '', status: 'missing' };
    const foundText = relevant.join(' | ');
    let ok: boolean;
    if (isDkim) {
      ok = relevant.some((txt) => dkimKey(txt) === dkimKey(record.content));
    } else if (isSpf) {
      // Dos SPF invalidan los dos (RFC 7208): aunque uno sea el correcto,
      // los receptores devuelven «permerror».
      ok =
        relevant.length === 1 &&
        (normalizeValue(relevant[0]!) === normalizeValue(record.content) ||
          spfCubre(relevant[0]!, record.content));
    } else if (isDmarc) {
      ok = relevant.some((txt) => /p=(none|quarantine|reject)/.test(txt.toLowerCase()));
    } else if (name.startsWith('_mta-sts')) {
      // El id cambia con cada política: basta con que exista un STSv1.
      ok = relevant.length > 0;
    } else {
      ok = relevant.some((txt) => normalizeValue(txt) === normalizeValue(record.content));
    }
    return { ...base, found: foundText, status: ok ? 'ok' : 'mismatch' };
  }

  if (record.type === 'CNAME') {
    const found = await lookupCname(name);
    if (found === null) return { ...base, found: null, status: 'unknown' };
    if (found.length === 0) {
      // Un registro A a la IP del servidor equivale al CNAME (el plan de
      // Cloudflare ya lo conserva así); sin esto la ficha lo daría por
      // pendiente para siempre.
      const equivalente = await aEquivalente(name, record.content);
      if (equivalente === null) return { ...base, found: null, status: 'unknown' };
      if (equivalente.length > 0) return { ...base, found: `A ${equivalente.join(', ')}`, status: 'ok' };
      return { ...base, found: '', status: 'missing' };
    }
    const ok = found.some((c) => normalizeValue(c) === normalizeValue(record.content));
    return { ...base, found: found.join(', '), status: ok ? 'ok' : 'mismatch' };
  }

  if (record.type === 'SRV') {
    const found = await lookupSrv(name);
    if (found === null) return { ...base, found: null, status: 'unknown' };
    if (found.length === 0) return { ...base, found: '', status: 'missing' };
    const foundText = found.map((r) => `${r.priority} ${r.weight} ${r.port} ${r.name}`).join(', ');
    const partes = record.content.trim().split(/\s+/);
    const expectedHost = normalizeValue(partes[partes.length - 1] || '');
    const expectedPort = Number(partes[2]);
    const ok = found.some(
      (r) => normalizeValue(r.name) === expectedHost && (!expectedPort || r.port === expectedPort),
    );
    return { ...base, found: foundText, status: ok ? 'ok' : 'mismatch' };
  }

  if (record.type === 'A' || record.type === 'AAAA') {
    const found = record.type === 'A' ? await lookupA(name) : null;
    if (found === null) return { ...base, found: null, status: 'unknown' };
    if (found.length === 0) return { ...base, found: '', status: 'missing' };
    const ok = found.some((ip) => ip === record.content.trim());
    return { ...base, found: found.join(', '), status: ok ? 'ok' : 'mismatch' };
  }

  // Tipos que no se verifican en vivo: se muestran como informativos.
  return { ...base, found: null, status: 'unknown' };
}

export interface DomainDnsReport {
  checks: DnsCheck[];
  requiredTotal: number;
  requiredOk: number;
  allRequiredOk: boolean;
  checkedAt: number;
}

/**
 * Mide el DNS público del dominio contra los registros del motor. Antes se
 * pasa por la selección común (zonefile.ts): así la comprobación nunca exige
 * un registro que el fichero de zona o Cloudflare no crearían.
 */
export async function checkDomainDns(
  domain: string,
  engineRecords: EngineDnsRecord[],
): Promise<DomainDnsReport> {
  const seleccion = seleccionarRegistros(domain, engineRecords);
  const checks = await Promise.all(seleccion.map((r) => checkRecord(r, domain)));
  // Orden: obligatorios primero, luego por etiqueta, estable para la UI.
  checks.sort((a, b) =>
    a.required === b.required ? a.label.localeCompare(b.label) : a.required ? -1 : 1,
  );
  const required = checks.filter((c) => c.required);
  const requiredOk = required.filter((c) => c.status === 'ok').length;
  return {
    checks,
    requiredTotal: required.length,
    requiredOk,
    allRequiredOk: required.length > 0 && requiredOk === required.length,
    checkedAt: Date.now(),
  };
}

/* --------------------- Salud del servidor (IP, listas) -------------------- */

export interface Recommendation {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
}

export interface ServerHealthReport {
  mailHostname: string;
  publicIp: string;
  hostnameResolves: boolean | null;
  hostnameIps: string[];
  ptr: string[] | null;
  ptrOk: boolean | null;
  dnsbl: DnsblResult[];
  score: number;
  recommendations: Recommendation[];
  checkedAt: number;
}

export async function checkServerHealth(): Promise<ServerHealthReport> {
  const instance = getInstanceSettings();
  const { mailHostname, publicIp } = instance;
  const recommendations: Recommendation[] = [];

  let hostnameIps: string[] = [];
  let hostnameResolves: boolean | null = null;
  if (mailHostname) {
    const ips = await lookupA(mailHostname);
    if (ips === null) hostnameResolves = null;
    else {
      hostnameIps = ips;
      hostnameResolves = ips.length > 0 && (!publicIp || ips.includes(publicIp));
    }
  }

  let ptr: string[] | null = null;
  let ptrOk: boolean | null = null;
  if (publicIp) {
    ptr = await lookupPtr(publicIp);
    if (ptr !== null && mailHostname) {
      ptrOk = ptr.some((h) => normalizeValue(h) === normalizeValue(mailHostname));
    }
  }

  const dnsbl = publicIp ? await checkDnsbl(publicIp) : [];

  if (!mailHostname) {
    recommendations.push({
      severity: 'critical',
      title: 'Configure el nombre del servidor de correo',
      detail: 'En Ajustes, defina el FQDN del servidor (p. ej. mail.suempresa.com). Es la identidad con la que el servidor se presenta al resto de Internet.',
    });
  }
  if (!publicIp) {
    recommendations.push({
      severity: 'critical',
      title: 'Configure la IP pública del servidor',
      detail: 'Sin la IP no se puede comprobar el registro inverso (PTR) ni las listas negras.',
    });
  }
  if (hostnameResolves === false) {
    recommendations.push({
      severity: 'critical',
      title: `El registro A de ${mailHostname} no apunta a ${publicIp}`,
      detail: `Cree un registro A: ${mailHostname} → ${publicIp}. Los servidores receptores comprueban que el nombre y la IP coincidan. Si el DNS está en Cloudflare, puede crearlo desde Conexiones → Cloudflare → DNS de la plataforma.`,
    });
  }
  if (ptrOk === false) {
    recommendations.push({
      severity: 'critical',
      title: 'El registro inverso (PTR) no coincide',
      detail: `La IP ${publicIp} resuelve a "${(ptr || []).join(', ') || 'nada'}" y debería resolver a "${mailHostname}". El PTR se configura en el panel del proveedor del servidor (no en el DNS del dominio). Sin un PTR correcto, Gmail y Outlook rechazan los mensajes o los clasifican como spam.`,
    });
  } else if (ptrOk === null && publicIp) {
    recommendations.push({
      severity: 'warning',
      title: 'No se ha podido verificar el registro inverso (PTR)',
      detail: 'Compruebe manualmente que la IP resuelve al nombre del servidor (comando: dig -x IP).',
    });
  }
  for (const list of dnsbl) {
    if (list.status === 'listed') {
      recommendations.push({
        severity: 'critical',
        title: `La IP está en la lista negra ${list.label}`,
        detail: list.detail,
      });
    } else if (list.status === 'inconclusive') {
      recommendations.push({
        severity: 'info',
        title: `No se ha podido comprobar ${list.label}`,
        detail: list.detail,
      });
    }
  }
  recommendations.push({
    severity: 'info',
    title: 'Compruebe que el proveedor permite el puerto 25 de salida',
    detail: 'Muchos proveedores (OVH, Hetzner, AWS…) bloquean el puerto 25 por defecto y es necesario solicitar su apertura. Sin él no es posible entregar correo a otros servidores.',
  });
  recommendations.push({
    severity: 'info',
    title: 'Aumente el volumen de envío de forma progresiva',
    detail: 'Si la IP es nueva en el envío de correo, comience con pocos envíos diarios y auméntelos gradualmente durante 2 a 4 semanas. Un aumento repentino del volumen desde una IP sin historial activa los filtros de spam.',
  });

  let score = 100;
  if (!mailHostname || !publicIp) score -= 40;
  if (hostnameResolves === false) score -= 20;
  if (ptrOk === false) score -= 25;
  if (dnsbl.some((d) => d.status === 'listed')) score -= 30;
  score = Math.max(0, Math.min(100, score));

  return {
    mailHostname,
    publicIp,
    hostnameResolves,
    hostnameIps,
    ptr,
    ptrOk,
    dnsbl,
    score,
    recommendations,
    checkedAt: Date.now(),
  };
}

export function registerDeliverabilityRoutes(app: FastifyInstance): void {
  app.get('/api/deliverability/server', async (req) => {
    requireAdmin(req);
    return await checkServerHealth();
  });
}
