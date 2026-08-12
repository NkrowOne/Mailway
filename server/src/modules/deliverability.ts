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

function classifyRecord(record: EngineDnsRecord, domain: string): {
  id: string;
  label: string;
  required: boolean;
  help: string;
} {
  const name = record.name.replace(/\.$/, '');
  const content = record.content;
  if (record.type === 'MX') {
    return {
      id: `mx:${name}`,
      label: 'MX (recepción de correo)',
      required: true,
      help: 'Indica qué servidor recibe el correo del dominio. Sin él, nadie puede escribirte.',
    };
  }
  if (record.type === 'TXT' && content.includes('v=spf1')) {
    return {
      id: `spf:${name}`,
      label: 'SPF (autorización de envío)',
      required: true,
      help: 'Declara qué servidores pueden enviar correo con tu dominio. Evita que otros suplanten tu identidad y mejora la entrega.',
    };
  }
  if (name.includes('_domainkey')) {
    return {
      id: `dkim:${name}`,
      label: `DKIM (firma digital · ${name.split('.')[0]})`,
      required: true,
      help: 'Firma criptográfica de tus mensajes. Gmail y Outlook la exigen para no marcar como spam.',
    };
  }
  if (record.type === 'TXT' && name.startsWith('_dmarc')) {
    return {
      id: `dmarc:${name}`,
      label: 'DMARC (política anti-suplantación)',
      required: true,
      help: 'Dice a los receptores qué hacer con los mensajes que no pasen SPF/DKIM. Obligatorio para Gmail/Yahoo desde 2024.',
    };
  }
  if (record.type === 'SRV') {
    return {
      id: `srv:${name}`,
      label: `SRV (autodetección de ${name.includes('imap') ? 'IMAP' : name.includes('submission') ? 'SMTP' : 'servicio'})`,
      required: false,
      help: 'Permite que los programas de correo configuren la cuenta automáticamente al escribir el email.',
    };
  }
  if (record.type === 'CNAME') {
    return {
      id: `cname:${name}`,
      label: `CNAME (${name.replace(`.${domain}`, '')})`,
      required: false,
      help: 'Registro auxiliar para servicios del dominio (autoconfiguración, MTA-STS...).',
    };
  }
  if (record.type === 'TXT' && name.startsWith('_mta-sts')) {
    return {
      id: `mtasts:${name}`,
      label: 'MTA-STS (TLS obligatorio)',
      required: false,
      help: 'Exige que el correo entrante llegue cifrado por TLS. Recomendado cuando todo lo demás esté en verde.',
    };
  }
  if (record.type === 'TXT' && name.startsWith('_smtp._tls')) {
    return {
      id: `tlsrpt:${name}`,
      label: 'TLS-RPT (informes de TLS)',
      required: false,
      help: 'Recibe informes si alguien no consigue entregarte correo cifrado.',
    };
  }
  return {
    id: `${record.type.toLowerCase()}:${name}`,
    label: `${record.type} (${name})`,
    required: false,
    help: 'Registro adicional recomendado por el motor de correo.',
  };
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
    const ok = found.some((r) => normalizeValue(r.exchange) === expectedHost);
    return { ...base, found: foundText, status: ok ? 'ok' : 'mismatch' };
  }

  if (record.type === 'TXT') {
    const found = await lookupTxt(name);
    if (found === null) return { ...base, found: null, status: 'unknown' };
    const isSpf = record.content.includes('v=spf1');
    const isDmarc = name.startsWith('_dmarc');
    const isDkim = name.includes('_domainkey');
    const relevant = found.filter((txt) => {
      if (isSpf) return txt.toLowerCase().startsWith('v=spf1');
      if (isDmarc) return txt.toLowerCase().startsWith('v=dmarc1');
      if (isDkim) return txt.toLowerCase().includes('k=') || txt.toLowerCase().includes('p=');
      return true;
    });
    if (relevant.length === 0) return { ...base, found: '', status: 'missing' };
    const foundText = relevant.join(' | ');
    let ok: boolean;
    if (isDkim) {
      ok = relevant.some((txt) => dkimKey(txt) === dkimKey(record.content));
    } else if (isSpf || isDmarc) {
      ok = relevant.some((txt) => normalizeValue(txt) === normalizeValue(record.content));
      // Un SPF/DMARC personalizado que mantenga lo esencial también vale.
      if (!ok && isSpf) {
        const mechanism = record.content.match(/include:[^\s]+|mx/)?.[0];
        ok = mechanism ? relevant.some((txt) => txt.includes(mechanism)) : false;
      }
      if (!ok && isDmarc) {
        ok = relevant.some((txt) => /p=(none|quarantine|reject)/.test(txt.toLowerCase()));
      }
    } else {
      ok = relevant.some((txt) => normalizeValue(txt) === normalizeValue(record.content));
    }
    return { ...base, found: foundText, status: ok ? 'ok' : 'mismatch' };
  }

  if (record.type === 'CNAME') {
    const found = await lookupCname(name);
    if (found === null) return { ...base, found: null, status: 'unknown' };
    if (found.length === 0) return { ...base, found: '', status: 'missing' };
    const ok = found.some((c) => normalizeValue(c) === normalizeValue(record.content));
    return { ...base, found: found.join(', '), status: ok ? 'ok' : 'mismatch' };
  }

  if (record.type === 'SRV') {
    const found = await lookupSrv(name);
    if (found === null) return { ...base, found: null, status: 'unknown' };
    if (found.length === 0) return { ...base, found: '', status: 'missing' };
    const foundText = found.map((r) => `${r.priority} ${r.weight} ${r.port} ${r.name}`).join(', ');
    const expectedHost = normalizeValue(record.content.split(/\s+/).slice(-1)[0] || '');
    const ok = found.some((r) => normalizeValue(r.name) === expectedHost);
    return { ...base, found: foundText, status: ok ? 'ok' : 'mismatch' };
  }

  if (record.type === 'A' || record.type === 'AAAA') {
    const found = record.type === 'A' ? await lookupA(name) : null;
    if (found === null) return { ...base, found: null, status: 'unknown' };
    if (found.length === 0) return { ...base, found: '', status: 'missing' };
    const ok = found.some((ip) => ip === record.content.trim());
    return { ...base, found: found.join(', '), status: ok ? 'ok' : 'mismatch' };
  }

  // Tipos que no verificamos en vivo (TLSA...): se muestran como informativos.
  return { ...base, found: null, status: 'unknown' };
}

export interface DomainDnsReport {
  checks: DnsCheck[];
  requiredTotal: number;
  requiredOk: number;
  allRequiredOk: boolean;
  checkedAt: number;
}

export async function checkDomainDns(
  domain: string,
  engineRecords: EngineDnsRecord[],
): Promise<DomainDnsReport> {
  const checks = await Promise.all(engineRecords.map((r) => checkRecord(r, domain)));
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
      title: 'Configura el nombre del servidor de correo',
      detail: 'En Ajustes, define el FQDN del servidor (p. ej. mail.tuempresa.com). Es la identidad con la que tu servidor se presenta al resto de Internet.',
    });
  }
  if (!publicIp) {
    recommendations.push({
      severity: 'critical',
      title: 'Configura la IP pública del servidor',
      detail: 'Sin la IP no se puede comprobar el registro inverso (PTR) ni las listas negras.',
    });
  }
  if (hostnameResolves === false) {
    recommendations.push({
      severity: 'critical',
      title: `El registro A de ${mailHostname} no apunta a ${publicIp}`,
      detail: `Crea un registro A: ${mailHostname} → ${publicIp}. Los servidores receptores comprueban que el nombre y la IP coincidan.`,
    });
  }
  if (ptrOk === false) {
    recommendations.push({
      severity: 'critical',
      title: 'El registro inverso (PTR) no coincide',
      detail: `La IP ${publicIp} resuelve a "${(ptr || []).join(', ') || 'nada'}" y debería resolver a "${mailHostname}". El PTR se configura en el panel de tu proveedor de servidor (no en tu DNS). Sin PTR correcto, Gmail y Outlook rechazan o marcan como spam.`,
    });
  } else if (ptrOk === null && publicIp) {
    recommendations.push({
      severity: 'warning',
      title: 'No se pudo verificar el registro inverso (PTR)',
      detail: 'Comprueba manualmente que la IP resuelva al nombre del servidor (comando: dig -x IP).',
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
        title: `No se pudo comprobar ${list.label}`,
        detail: list.detail,
      });
    }
  }
  recommendations.push({
    severity: 'info',
    title: 'Comprueba que tu proveedor permite el puerto 25 de salida',
    detail: 'Muchos proveedores (OVH, Hetzner, AWS...) bloquean el puerto 25 por defecto y hay que solicitarlo. Sin él no se puede entregar correo a otros servidores.',
  });
  recommendations.push({
    severity: 'info',
    title: 'Calienta la IP progresivamente',
    detail: 'Si la IP es nueva para enviar correo, empieza con pocos envíos diarios y súbelos gradualmente durante 2-4 semanas. Un pico repentino de volumen desde una IP fría dispara los filtros de spam.',
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
