import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadSqlite } from "./sqlite.js";
import { SafetyError } from "../util/errors.js";

export type ResourceKind = "role" | "channel";

export interface ResourceMapping {
  guildId: string;
  kind: ResourceKind;
  key: string;
  discordId: string;
  name: string;
  updatedAt: string;
}

export type PlanStatus = "pending" | "approved" | "applying" | "applied" | "failed" | "rejected";

export interface StoredPlan {
  id: string;
  guildId: string;
  createdAt: string;
  expiresAt: string;
  configHash: string;
  fingerprint: string;
  planJson: string;
  status: PlanStatus;
  approvedAt: string | null;
  approvedBy: string | null;
  origin: string;
}

export interface AuditEntry {
  id?: number;
  ts: string;
  guildId: string;
  actor: string;
  action: string;
  planId: string | null;
  opId: string | null;
  status: string;
  details: string;
}

const SCHEMA_VERSION = 1;

/**
 * Local state: logical-key → Discord ID mappings per guild, stored plans awaiting approval,
 * an append-only audit log and per-guild apply locks.
 *
 * Every table is keyed by guild ID, so multiple servers never share state.
 */
export class StateStore {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const DatabaseSync = loadSqlite();
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  static memory(): StateStore {
    return new StateStore(":memory:");
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resources (
        guild_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('role','channel')),
        key TEXT NOT NULL,
        discord_id TEXT NOT NULL,
        name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, kind, key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS resources_by_id ON resources (guild_id, discord_id);
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        status TEXT NOT NULL,
        approved_at TEXT,
        approved_by TEXT,
        origin TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        plan_id TEXT,
        op_id TEXT,
        status TEXT NOT NULL,
        details TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_by_guild ON audit_log (guild_id, ts);
      CREATE TABLE IF NOT EXISTS locks (
        guild_id TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  }

  // ---- resource mappings ----------------------------------------------------

  getMappings(guildId: string, kind?: ResourceKind): ResourceMapping[] {
    const rows = kind
      ? this.db.prepare("SELECT * FROM resources WHERE guild_id = ? AND kind = ? ORDER BY kind, key").all(guildId, kind)
      : this.db.prepare("SELECT * FROM resources WHERE guild_id = ? ORDER BY kind, key").all(guildId);
    return rows.map(rowToMapping);
  }

  getMapping(guildId: string, kind: ResourceKind, key: string): ResourceMapping | undefined {
    const row = this.db.prepare("SELECT * FROM resources WHERE guild_id = ? AND kind = ? AND key = ?").get(guildId, kind, key);
    return row ? rowToMapping(row) : undefined;
  }

  /** Bind a logical key to a Discord ID. Any other key bound to the same ID is released. */
  bind(guildId: string, kind: ResourceKind, key: string, discordId: string, name: string): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("DELETE FROM resources WHERE guild_id = ? AND discord_id = ? AND NOT (kind = ? AND key = ?)").run(guildId, discordId, kind, key);
      this.db
        .prepare(
          `INSERT INTO resources (guild_id, kind, key, discord_id, name, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (guild_id, kind, key) DO UPDATE SET discord_id = excluded.discord_id, name = excluded.name, updated_at = excluded.updated_at`,
        )
        .run(guildId, kind, key, discordId, name, now);
    });
  }

  unbind(guildId: string, kind: ResourceKind, key: string): boolean {
    const res = this.db.prepare("DELETE FROM resources WHERE guild_id = ? AND kind = ? AND key = ?").run(guildId, kind, key);
    return Number(res.changes) > 0;
  }

  clearGuild(guildId: string): number {
    const res = this.db.prepare("DELETE FROM resources WHERE guild_id = ?").run(guildId);
    return Number(res.changes);
  }

  guilds(): string[] {
    return this.db.prepare("SELECT DISTINCT guild_id FROM resources ORDER BY guild_id").all().map((r) => String(r.guild_id));
  }

  // ---- plans ------------------------------------------------------------------

  savePlan(plan: StoredPlan): void {
    this.db
      .prepare(
        `INSERT INTO plans (id, guild_id, created_at, expires_at, config_hash, fingerprint, plan_json, status, approved_at, approved_by, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(plan.id, plan.guildId, plan.createdAt, plan.expiresAt, plan.configHash, plan.fingerprint, plan.planJson, plan.status, plan.approvedAt, plan.approvedBy, plan.origin);
  }

  getPlan(id: string): StoredPlan | undefined {
    const row = this.db.prepare("SELECT * FROM plans WHERE id = ?").get(id);
    return row ? rowToPlan(row) : undefined;
  }

  listPlans(guildId?: string, limit = 20): StoredPlan[] {
    const rows = guildId
      ? this.db.prepare("SELECT * FROM plans WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?").all(guildId, limit)
      : this.db.prepare("SELECT * FROM plans ORDER BY created_at DESC LIMIT ?").all(limit);
    return rows.map(rowToPlan);
  }

  setPlanStatus(id: string, status: PlanStatus, approvedBy?: string): void {
    if (status === "approved") {
      this.db.prepare("UPDATE plans SET status = ?, approved_at = ?, approved_by = ? WHERE id = ?").run(status, new Date().toISOString(), approvedBy ?? "unknown", id);
    } else {
      this.db.prepare("UPDATE plans SET status = ? WHERE id = ?").run(status, id);
    }
  }

  /**
   * Atomically move a plan from pending/approved to "applying". Returns false if another
   * caller already claimed it, so a plan can never be executed twice.
   */
  claimPlanForApply(id: string, allowedFrom: PlanStatus[] = ["approved"]): boolean {
    const placeholders = allowedFrom.map(() => "?").join(", ");
    const res = this.db.prepare(`UPDATE plans SET status = 'applying' WHERE id = ? AND status IN (${placeholders})`).run(id, ...allowedFrom);
    return Number(res.changes) === 1;
  }

  // ---- audit log ----------------------------------------------------------------

  audit(entry: Omit<AuditEntry, "ts" | "id"> & { ts?: string }): void {
    this.db
      .prepare("INSERT INTO audit_log (ts, guild_id, actor, action, plan_id, op_id, status, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(entry.ts ?? new Date().toISOString(), entry.guildId, entry.actor, entry.action, entry.planId, entry.opId, entry.status, entry.details);
  }

  auditLog(guildId?: string, limit = 50): AuditEntry[] {
    const rows = guildId
      ? this.db.prepare("SELECT * FROM audit_log WHERE guild_id = ? ORDER BY id DESC LIMIT ?").all(guildId, limit)
      : this.db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit);
    return rows.map((r) => ({
      id: Number(r.id), ts: String(r.ts), guildId: String(r.guild_id), actor: String(r.actor), action: String(r.action),
      planId: r.plan_id === null ? null : String(r.plan_id), opId: r.op_id === null ? null : String(r.op_id),
      status: String(r.status), details: String(r.details),
    }));
  }

  // ---- locks --------------------------------------------------------------------

  /** Acquire an exclusive apply lock for a guild. Stale locks expire after `ttlMs`. */
  acquireLock(guildId: string, holder: string, ttlMs = 10 * 60_000): void {
    const now = new Date();
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM locks WHERE guild_id = ?").get(guildId);
      if (row && new Date(String(row.expires_at)) > now && row.holder !== holder) {
        throw new SafetyError("LOCKED", `Guild ${guildId} is locked by another apply (${String(row.holder)} since ${String(row.acquired_at)})`, {
          hint: "Wait for it to finish. If the process crashed, run `discordctl state unlock --guild <id>`.",
        });
      }
      this.db
        .prepare("INSERT INTO locks (guild_id, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (guild_id) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at")
        .run(guildId, holder, now.toISOString(), new Date(now.getTime() + ttlMs).toISOString());
    });
  }

  releaseLock(guildId: string, holder?: string): void {
    if (holder) this.db.prepare("DELETE FROM locks WHERE guild_id = ? AND holder = ?").run(guildId, holder);
    else this.db.prepare("DELETE FROM locks WHERE guild_id = ?").run(guildId);
  }

  // ---- backup / restore ---------------------------------------------------------

  exportGuild(guildId: string): { version: number; guildId: string; resources: ResourceMapping[] } {
    return { version: SCHEMA_VERSION, guildId, resources: this.getMappings(guildId) };
  }

  importGuild(data: { guildId: string; resources: ResourceMapping[] }, replace = false): number {
    let n = 0;
    this.transaction(() => {
      if (replace) this.clearGuild(data.guildId);
      for (const r of data.resources) {
        if (r.guildId !== data.guildId) throw new SafetyError("STATE_GUILD_MISMATCH", `State entry ${r.key} belongs to guild ${r.guildId}, not ${data.guildId}`);
        this.bind(r.guildId, r.kind, r.key, r.discordId, r.name);
        n++;
      }
    });
    return n;
  }

  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

function rowToMapping(r: Record<string, unknown>): ResourceMapping {
  return {
    guildId: String(r.guild_id), kind: r.kind as ResourceKind, key: String(r.key), discordId: String(r.discord_id),
    name: String(r.name), updatedAt: String(r.updated_at),
  };
}

function rowToPlan(r: Record<string, unknown>): StoredPlan {
  return {
    id: String(r.id), guildId: String(r.guild_id), createdAt: String(r.created_at), expiresAt: String(r.expires_at),
    configHash: String(r.config_hash), fingerprint: String(r.fingerprint), planJson: String(r.plan_json),
    status: r.status as PlanStatus, approvedAt: r.approved_at === null ? null : String(r.approved_at),
    approvedBy: r.approved_by === null ? null : String(r.approved_by), origin: String(r.origin),
  };
}
