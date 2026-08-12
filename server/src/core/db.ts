import Database from 'better-sqlite3';
import { config } from '../config';

export const db: Database.Database = new Database(config.dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/**
 * Migraciones incrementales: cada entrada se ejecuta una sola vez, en orden.
 * Nunca se edita una migración ya publicada; se añade una nueva.
 */
const migrations: { id: string; sql: string }[] = [
  {
    id: '001-esquema-inicial',
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        max_domains INTEGER NOT NULL DEFAULT 1,
        max_mailboxes INTEGER NOT NULL DEFAULT 5,
        max_aliases INTEGER NOT NULL DEFAULT 10,
        mailbox_quota_mb INTEGER NOT NULL DEFAULT 1024,
        api_daily_limit INTEGER NOT NULL DEFAULT 500,
        api_per_minute_limit INTEGER NOT NULL DEFAULT 30,
        notes TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        contact_email TEXT NOT NULL DEFAULT '',
        plan_id TEXT NOT NULL REFERENCES plans(id),
        suspended INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'client')),
        client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
      );

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ip TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);

      CREATE TABLE domains (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        domain TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending_dns'
          CHECK (status IN ('pending_dns', 'active', 'error')),
        dkim_selector TEXT NOT NULL DEFAULT 'mail',
        dns_status_json TEXT NOT NULL DEFAULT '{}',
        last_checked_at INTEGER,
        verified_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_domains_client ON domains(client_id);

      CREATE TABLE mailboxes (
        id TEXT PRIMARY KEY,
        domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
        local_part TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        quota_mb INTEGER NOT NULL DEFAULT 1024,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
        created_at INTEGER NOT NULL,
        UNIQUE (domain_id, local_part)
      );
      CREATE INDEX idx_mailboxes_domain ON mailboxes(domain_id);

      CREATE TABLE aliases (
        id TEXT PRIMARY KEY,
        domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
        local_part TEXT NOT NULL,
        destinations_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (domain_id, local_part)
      );

      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL UNIQUE,
        key_hash TEXT NOT NULL,
        sender_mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
        smtp_password_enc TEXT NOT NULL,
        daily_limit INTEGER,
        revoked_at INTEGER,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_api_keys_client ON api_keys(client_id);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
        from_address TEXT NOT NULL,
        to_json TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
        error TEXT NOT NULL DEFAULT '',
        smtp_message_id TEXT NOT NULL DEFAULT '',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_messages_client ON messages(client_id, created_at);
      CREATE INDEX idx_messages_key ON messages(api_key_id, created_at);

      CREATE TABLE api_usage (
        api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (api_key_id, day)
      );

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        client_id TEXT,
        action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_audit_created ON audit_log(created_at);

      CREATE TABLE login_attempts (
        ip TEXT NOT NULL,
        attempted_at INTEGER NOT NULL
      );
      CREATE INDEX idx_login_attempts ON login_attempts(ip, attempted_at);
    `,
  },
  {
    id: '002-marca-blanca-y-alertas',
    sql: `
      -- Dominios propios de cada cliente (webmail o panel con su marca).
      -- Traefik los descubre sondeando /api/traefik/config de este panel.
      CREATE TABLE client_domains (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        hostname TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('webmail', 'panel')),
        status TEXT NOT NULL DEFAULT 'pending_dns'
          CHECK (status IN ('pending_dns', 'issuing', 'active', 'error')),
        detail TEXT NOT NULL DEFAULT '',
        last_checked_at INTEGER,
        activated_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_client_domains_client ON client_domains(client_id);

      -- Alertas del vigilante. dedupe_key evita repetir la misma alerta
      -- abierta; al resolverse se marca resolved_at en lugar de borrarla.
      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
        type TEXT NOT NULL,
        client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        remedy TEXT NOT NULL DEFAULT '',
        dedupe_key TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX idx_alerts_open ON alerts(resolved_at, created_at);
      -- Solo puede haber UNA alerta abierta por clave: el índice parcial hace
      -- que el dedupe lo garantice la base de datos, no la lógica.
      CREATE UNIQUE INDEX idx_alerts_dedupe
        ON alerts(dedupe_key) WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL;
    `,
  },
];

function runMigrations(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT id FROM _migrations').all() as { id: string }[]).map((r) => r.id),
  );
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        Date.now(),
      );
    });
    apply();
  }
}

runMigrations();

export function now(): number {
  return Date.now();
}
