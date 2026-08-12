/** Cliente HTTP del panel: errores en español listos para mostrar. */

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // respuesta no JSON
  }
  if (!res.ok) {
    const err = data as { error?: string; code?: string } | null;
    throw new ApiError(
      res.status,
      err?.error || `Error ${res.status} del servidor.`,
      err?.code || 'error',
    );
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  delete: <T>(url: string) => request<T>('DELETE', url),
};

/* ------------------------------- Tipos ----------------------------------- */

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'client';
  clientId: string | null;
}

export interface Plan {
  id: string;
  name: string;
  maxDomains: number;
  maxMailboxes: number;
  maxAliases: number;
  mailboxQuotaMb: number;
  apiDailyLimit: number;
  apiPerMinuteLimit: number;
  notes: string;
}

export interface ClientUsage {
  domains: number;
  mailboxes: number;
  aliases: number;
  apiKeys: number;
  messagesLast30d: number;
}

export interface Client {
  id: string;
  name: string;
  slug: string;
  contactEmail: string;
  planId: string;
  suspended: boolean;
  notes: string;
  createdAt: number;
  plan?: Plan;
  usage?: ClientUsage;
  users?: { id: string; email: string; name: string; disabled: boolean; lastLoginAt: number | null }[];
}

export type CheckStatus = 'ok' | 'missing' | 'mismatch' | 'unknown';

export interface DnsCheck {
  id: string;
  label: string;
  type: string;
  name: string;
  expected: string;
  found: string | null;
  status: CheckStatus;
  required: boolean;
  help: string;
}

export interface DomainRecord {
  id: string;
  clientId: string;
  domain: string;
  status: 'pending_dns' | 'active' | 'error';
  dkimSelector: string;
  dnsStatus: {
    checks?: DnsCheck[];
    requiredTotal?: number;
    requiredOk?: number;
    allRequiredOk?: boolean;
    checkedAt?: number;
  };
  lastCheckedAt: number | null;
  verifiedAt: number | null;
  createdAt: number;
}

export interface Mailbox {
  id: string;
  domainId: string;
  domain: string;
  localPart: string;
  email: string;
  displayName: string;
  quotaMb: number;
  status: 'active' | 'suspended';
  createdAt: number;
}

export interface Alias {
  id: string;
  domainId: string;
  localPart: string;
  email: string;
  destinations: string[];
  createdAt: number;
}

export interface ApiKeyInfo {
  id: string;
  clientId: string;
  name: string;
  prefix: string;
  senderMailboxId: string;
  senderEmail: string;
  dailyLimit: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  usedToday: number;
}

export interface Message {
  id: string;
  clientId: string;
  apiKeyId: string | null;
  from: string;
  to: string[];
  subject: string;
  status: 'sent' | 'failed';
  error: string;
  messageId: string;
  sizeBytes: number;
  createdAt: number;
}

export interface EngineDnsRecord {
  type: string;
  name: string;
  content: string;
}

export interface Recommendation {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
}

export interface ServerHealth {
  mailHostname: string;
  publicIp: string;
  hostnameResolves: boolean | null;
  hostnameIps: string[];
  ptr: string[] | null;
  ptrOk: boolean | null;
  dnsbl: { zone: string; label: string; status: 'clean' | 'listed' | 'inconclusive'; detail: string }[];
  score: number;
  recommendations: Recommendation[];
  checkedAt: number;
}

export interface SetupStatus {
  setupComplete: boolean;
  hasAdmin: boolean;
  engineConfigured: boolean;
  demoMode: boolean;
  engineDefaults: {
    url: string;
    adminUser: string;
    hasPassword: boolean;
    smtpHost: string;
    smtpPort: number;
  };
  instance: InstanceSettings;
}

export interface InstanceSettings {
  brandName: string;
  mailHostname: string;
  publicIp: string;
  webmailUrl: string;
  systemFrom: string;
}

export interface AdminDashboard {
  totals: {
    clients: number;
    domains: number;
    domainsActive: number;
    mailboxes: number;
    apiKeys: number;
  };
  messages: { last24h: number; failed24h: number; last30d: number };
  engine: { ok: boolean; detail?: string };
  queue: { pending: number; oldestSeconds: number | null };
  instance: InstanceSettings;
}

export interface ClientDashboard {
  client: { id: string; name: string; suspended: boolean };
  plan: Plan;
  usage: ClientUsage;
  domains: DomainRecord[];
  messages: { last7d: number; failed7d: number };
  onboarding: {
    hasDomain: boolean;
    hasActiveDomain: boolean;
    hasMailbox: boolean;
    hasApiKey: boolean;
    hasSentMessage: boolean;
  };
  webmailUrl: string;
}

export interface AuditEntry {
  id: number;
  userId: string | null;
  clientId: string | null;
  action: string;
  detail: Record<string, unknown>;
  ip: string;
  createdAt: number;
}

export interface ConnectionInfo {
  email: string;
  username: string;
  imap: { host: string; port: number; security: string };
  smtp: { host: string; port: number; security: string };
  smtpAlt: { host: string; port: number; security: string };
  webmailUrl: string;
}
