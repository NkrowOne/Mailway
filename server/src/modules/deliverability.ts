import type { FastifyInstance } from 'fastify';
import {
  checkDnsbl,
  lookupA,
  lookupAaaa,
  lookupCname,
  lookupMx,
  lookupPtr,
  lookupSrv,
  lookupTxt,
  type DnsblResult,
} from '../core/dns';
import { canonicalIpv6, isInternalHost, normalizeHostname } from '../core/hostnames';
import { diagnosticoSpf, esDmarc, esSpf, politicaDmarc, spfCubre } from '../core/mailauth';
import type { EngineDnsRecord } from '../engine/types';
import { requireAdmin } from './auth';
import { getInstanceSettings } from './settings';
import { avisoMxInterno, destinoMx, esObligatorio, seleccionarRegistros } from './zonefile';

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
  /**
   * El motor no ha generado este registro obligatorio (p. ej. la clave DKIM
   * no se creó): no hay valor que publicar y el dominio no puede darse por
   * bueno. Solo aparece cuando es true.
   */
  engineMissing?: true;
}

function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ').replace(/\.$/, '').toLowerCase();
}

/** Extrae la clave pública de un TXT DKIM para comparar solo lo que importa. */
function dkimKey(value: string): string {
  const match = value.replace(/\s|"/g, '').match(/p=([^;]*)/);
  return match ? match[1]! : normalizeValue(value);
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

/** Datos de la instancia que la comprobación necesita y no cambian entre registros. */
interface ContextoComprobacion {
  /** IPv4 pública del servidor: un SPF con «ip4:» que la contenga lo autoriza. */
  publicIp: string;
}

async function checkRecord(
  record: EngineDnsRecord,
  domain: string,
  ctx: ContextoComprobacion,
): Promise<DnsCheck> {
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
    const expectedHost = destinoMx(record.content);
    const found = await lookupMx(name);
    const foundText = found ? found.map((r) => `${r.priority} ${r.exchange}`).join(', ') : null;
    // Un MX interno (el identificador del contenedor, una IP…) no recibe
    // correo de Internet aunque el DNS lo publique tal cual: nunca está en
    // rango, ni siquiera cuando el registro «coincide».
    if (isInternalHost(expectedHost)) {
      return { ...base, found: foundText, status: 'mismatch', help: avisoMxInterno([expectedHost]) };
    }
    if (found === null) return { ...base, found: null, status: 'unknown' };
    if (found.length === 0) return { ...base, found: '', status: 'missing' };
    const veredicto = veredictoMx(found, expectedHost);
    if (veredicto.ajenosPorDelante.length > 0) {
      return {
        ...base,
        found: foundText,
        status: 'mismatch',
        help: `Además de este servidor, el dominio tiene MX de otro proveedor con la misma o mayor preferencia (${veredicto.ajenosPorDelante.join(', ')}): buena parte del correo entrante llegará allí. Elimina esos registros MX para que todo el correo llegue a este servidor.`,
      };
    }
    return { ...base, found: foundText, status: veredicto.propio ? 'ok' : 'mismatch' };
  }

  if (record.type === 'TXT') {
    const found = await lookupTxt(name);
    if (found === null) return { ...base, found: null, status: 'unknown' };
    const isSpf = esSpf(record.content);
    const isDmarc = name.startsWith('_dmarc');
    const isDkim = name.includes('_domainkey');
    const prefijo = record.content.trim().toLowerCase().match(/^v=[a-z0-9]+/)?.[0] ?? null;
    const relevant = found.filter((txt) => {
      const t = txt.toLowerCase();
      if (isSpf) return esSpf(txt);
      if (isDmarc) return esDmarc(txt);
      if (isDkim) return t.includes('k=') || t.includes('p=');
      // MTA-STS, TLS-RPT…: solo cuentan los TXT del mismo tipo.
      return prefijo ? t.startsWith(prefijo) : true;
    });
    if (relevant.length === 0) return { ...base, found: '', status: 'missing' };
    const foundText = relevant.join(' | ');
    if ((isSpf || isDmarc) && relevant.length > 1) {
      // Dos SPF o dos DMARC en el mismo nombre invalidan todos (RFC 7208
      // §4.5 y RFC 7489 §6.6.3): aunque uno sea el correcto, los receptores
      // devuelven «permerror» o no aplican ninguna política.
      return {
        ...base,
        found: foundText,
        status: 'mismatch',
        help: isSpf
          ? `Hay ${relevant.length} registros SPF en este nombre y solo puede existir uno: los servidores receptores los descartan todos. Combínalos en un único registro v=spf1 que incluya «mx».`
          : `Hay ${relevant.length} registros DMARC en este nombre y solo puede existir uno: los servidores receptores no aplican ninguno. Conserva una única política y elimina el resto.`,
      };
    }
    const actual = relevant[0]!;
    if (isDkim) {
      const ok = relevant.some((txt) => dkimKey(txt) === dkimKey(record.content));
      return { ...base, found: foundText, status: ok ? 'ok' : 'mismatch' };
    }
    if (isSpf) {
      const contexto = { nombre: name, ipServidor: ctx.publicIp };
      if (normalizeValue(actual) === normalizeValue(record.content) || spfCubre(actual, record.content, contexto)) {
        return { ...base, found: foundText, status: 'ok' };
      }
      const { faltan, detrasDeAll } = diagnosticoSpf(actual, record.content, contexto);
      const lista = (detrasDeAll.length > 0 ? detrasDeAll : faltan).map((m) => `«${m}»`).join(', ');
      return {
        ...base,
        found: foundText,
        status: 'mismatch',
        help:
          detrasDeAll.length > 0
            ? `El SPF incluye ${lista}, pero detrás de «all»: los receptores dejan de leer en «all», así que no autoriza a este servidor. Colócalo delante de «all».`
            : lista
              ? `El SPF actual no autoriza a este servidor de correo. Añade ${lista} delante de «all» y conserva el resto de mecanismos.`
              : base.help,
      };
    }
    if (isDmarc) {
      if (politicaDmarc(actual) === null) {
        return {
          ...base,
          found: foundText,
          status: 'mismatch',
          help: 'El registro DMARC no declara una política válida: debe incluir p=none, p=quarantine o p=reject.',
        };
      }
      return { ...base, found: foundText, status: 'ok' };
    }
    // El id de MTA-STS cambia con cada política: basta con que exista un STSv1.
    const ok = name.startsWith('_mta-sts')
      ? relevant.length > 0
      : relevant.some((txt) => normalizeValue(txt) === normalizeValue(record.content));
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

  if (record.type === 'A') {
    const found = await lookupA(name);
    if (found === null) return { ...base, found: null, status: 'unknown' };
    if (found.length === 0) return { ...base, found: '', status: 'missing' };
    const ok = found.some((ip) => ip === record.content.trim());
    return { ...base, found: found.join(', '), status: ok ? 'ok' : 'mismatch' };
  }

  if (record.type === 'AAAA') {
    // Se consulta de verdad: una IPv6 se puede escribir de varias formas
    // (2001:db8::1 y 2001:0db8:0:0::1), así que se comparan en forma canónica.
    const found = await lookupAaaa(name);
    if (found === null) return { ...base, found: null, status: 'unknown' };
    if (found.length === 0) return { ...base, found: '', status: 'missing' };
    const esperada = canonicalIpv6(record.content);
    const ok = esperada !== null && found.some((ip) => canonicalIpv6(ip) === esperada);
    return {
      ...base,
      found: found.join(', '),
      status: ok ? 'ok' : 'mismatch',
      ...(ok
        ? {}
        : {
            help: 'El nombre tiene una dirección IPv6 que no es la de este servidor. Los servidores con IPv6 la prueban antes que la IPv4: corrígela o elimina el registro AAAA.',
          }),
    };
  }

  // Tipos que no se verifican en vivo: se muestran como informativos.
  return { ...base, found: null, status: 'unknown' };
}

/**
 * Registros obligatorios que el motor NO ha generado. Si la creación de las
 * claves DKIM falló, el motor devuelve el resto sin DKIM; medir solo lo que
 * devuelve daría el dominio por bueno y el correo saldría sin firmar. Cada
 * familia que falta se marca como pendiente, de forma explícita, sin valor que
 * copiar: no hay nada que publicar hasta que el motor lo genere.
 */
function pendientesEnElMotor(domain: string, seleccion: EngineDnsRecord[]): DnsCheck[] {
  const raiz = normalizeHostname(domain);
  const nombre = (r: EngineDnsRecord) => normalizeHostname(r.name);
  const familias: {
    familia: string;
    label: string;
    type: string;
    name: string;
    presente: (r: EngineDnsRecord) => boolean;
    help: string;
  }[] = [
    {
      familia: 'mx',
      label: 'MX (recepción de correo)',
      type: 'MX',
      name: raiz,
      presente: (r) => r.type === 'MX' && nombre(r) === raiz,
      help: 'El servidor de correo no ha propuesto el registro MX de este dominio, así que no hay valor que publicar. Revisa el dominio en el motor de correo y vuelve a medir.',
    },
    {
      familia: 'spf',
      label: 'SPF (autorización de envío)',
      type: 'TXT',
      name: raiz,
      presente: (r) => r.type === 'TXT' && nombre(r) === raiz && esSpf(r.content),
      help: 'El servidor de correo no ha propuesto el registro SPF de este dominio, así que no hay valor que publicar. Revisa el dominio en el motor de correo y vuelve a medir.',
    },
    {
      familia: 'dkim',
      label: 'DKIM (firma digital)',
      type: 'TXT',
      name: `_domainkey.${raiz}`,
      // Una clave con «p=» vacío está revocada: no firma nada.
      presente: (r) =>
        nombre(r).endsWith(`._domainkey.${raiz}`) &&
        (r.type === 'CNAME' || (r.type === 'TXT' && /(^|;)\s*p=[^;\s]/i.test(r.content))),
      help: 'El servidor de correo no ha generado la clave DKIM de este dominio: no hay ningún registro que publicar y los mensajes saldrían sin firmar, de modo que Gmail y Outlook los clasificarían como spam. Genera la clave desde la ficha del dominio y vuelve a medir.',
    },
    {
      familia: 'dmarc',
      label: 'DMARC (política contra la suplantación)',
      type: 'TXT',
      name: `_dmarc.${raiz}`,
      presente: (r) => r.type === 'TXT' && nombre(r) === `_dmarc.${raiz}` && esDmarc(r.content),
      help: 'El servidor de correo no ha propuesto el registro DMARC de este dominio, así que no hay valor que publicar. Revisa el dominio en el motor de correo y vuelve a medir.',
    },
  ];
  return familias
    .filter((f) => !seleccion.some(f.presente))
    .map((f) => ({
      id: `motor:${f.familia}`,
      label: f.label,
      type: f.type,
      name: f.name,
      expected: '',
      found: null,
      status: 'missing' as const,
      required: true,
      help: f.help,
      engineMissing: true as const,
    }));
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
  const ctx: ContextoComprobacion = { publicIp: getInstanceSettings().publicIp.trim() };
  const checks = await Promise.all(seleccion.map((r) => checkRecord(r, domain, ctx)));
  checks.push(...pendientesEnElMotor(domain, seleccion));
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
  /** AAAA del nombre del servidor: null = no se pudo consultar; [] = no tiene (solo IPv4). */
  hostnameIpv6: string[] | null;
  /**
   * Las IPv6 del nombre son de este servidor (su inverso apunta a él). true
   * sin AAAA; false si alguna no lo es; null si no se pudo comprobar.
   */
  ipv6Ok: boolean | null;
  ptr: string[] | null;
  ptrOk: boolean | null;
  dnsbl: DnsblResult[];
  score: number;
  recommendations: Recommendation[];
  checkedAt: number;
}

/**
 * Veredicto del AAAA del nombre del servidor. Mailway solo conoce la IPv4 del
 * servidor; la prueba de que una IPv6 es suya es su inverso, que solo puede
 * fijar quien tiene la dirección. Un AAAA cuyo inverso no lleva al servidor
 * es de otra máquina (la página de aparcamiento del registrador, un servidor
 * anterior) o de un servidor sin IPv6: los remitentes con IPv6 lo prueban
 * antes que la IPv4, y su correo se retrasa o no llega. Función pura.
 */
export function evaluarIpv6(
  host: string,
  direcciones: string[] | null,
  inversos: (string[] | null)[],
): { ok: boolean | null; ajenas: string[] } {
  if (direcciones === null) return { ok: null, ajenas: [] };
  const propio = normalizeHostname(host);
  const ajenas: string[] = [];
  let sinDato = false;
  direcciones.forEach((ip, i) => {
    const inverso = inversos[i] ?? null;
    if (inverso === null) sinDato = true;
    else if (!inverso.some((h) => normalizeHostname(h) === propio)) ajenas.push(ip);
  });
  if (ajenas.length > 0) return { ok: false, ajenas };
  return { ok: sinDato ? null : true, ajenas };
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

  // El AAAA se consulta de verdad: si existe, los servidores con IPv6 lo
  // prueban antes que el registro A.
  let hostnameIpv6: string[] | null = null;
  let ipv6: { ok: boolean | null; ajenas: string[] } = { ok: null, ajenas: [] };
  if (mailHostname) {
    hostnameIpv6 = await lookupAaaa(mailHostname);
    const inversos = hostnameIpv6 ? await Promise.all(hostnameIpv6.map((ip) => lookupPtr(ip))) : [];
    ipv6 = evaluarIpv6(mailHostname, hostnameIpv6, inversos);
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
      detail: 'En Ajustes, define el FQDN del servidor (p. ej. mail.tuempresa.com). Es la identidad con la que el servidor se presenta al resto de Internet.',
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
      detail: `Crea un registro A: ${mailHostname} → ${publicIp}. Los servidores receptores comprueban que el nombre y la IP coincidan. Si el DNS está en Cloudflare, puedes crearlo desde Conexiones → Cloudflare → DNS de la plataforma.`,
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
      detail: 'Comprueba manualmente que la IP resuelve al nombre del servidor (comando: dig -x IP).',
    });
  }
  if (ipv6.ok === false) {
    recommendations.push({
      severity: 'warning',
      title: `Revisa el registro AAAA de ${mailHostname}`,
      detail: `${mailHostname} tiene la dirección IPv6 ${ipv6.ajenas.join(', ')}, pero su inverso (PTR) no apunta a ${mailHostname}. Los servidores con IPv6 prueban esa dirección antes que la IPv4: si no es de este servidor, o el servidor no tiene IPv6, elimina el registro AAAA. Si es suya, configura su PTR (${mailHostname}) en el panel del proveedor del servidor; sin él, Gmail y Outlook rechazan el correo que sale por IPv6.`,
    });
  } else if (ipv6.ok === null && hostnameIpv6 && hostnameIpv6.length > 0) {
    recommendations.push({
      severity: 'info',
      title: `No se ha podido verificar el inverso de la IPv6 de ${mailHostname}`,
      detail: `Comprueba manualmente que ${hostnameIpv6.join(', ')} es de este servidor y que su inverso devuelve ${mailHostname} (comando: dig -x IP).`,
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
    title: 'Comprueba que el proveedor permite el puerto 25 de salida',
    detail: 'Muchos proveedores (OVH, Hetzner, AWS…) bloquean el puerto 25 por defecto y es necesario solicitar su apertura. Sin él no es posible entregar correo a otros servidores.',
  });
  recommendations.push({
    severity: 'info',
    title: 'Aumenta el volumen de envío de forma progresiva',
    detail: 'Si la IP es nueva en el envío de correo, comienza con pocos envíos diarios y auméntalos gradualmente durante 2 a 4 semanas. Un aumento repentino del volumen desde una IP sin historial activa los filtros de spam.',
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
    hostnameIpv6,
    ipv6Ok: ipv6.ok,
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
