import { resolve as resolvePath } from "node:path";
import type { DiscordApi } from "./provider/api.js";
import { fetchSnapshot } from "./provider/normalize.js";
import { loadConfigFile, loadConfigText, type LoadedConfig } from "./config/load.js";
import { resolveConfig } from "./config/resolve.js";
import type { DesiredState, GuildSnapshot } from "./core/model.js";
import { hasErrors, type Diagnostic } from "./core/diagnostics.js";
import { createPlan } from "./plan/planner.js";
import { fingerprintSnapshot } from "./plan/fingerprint.js";
import type { Plan } from "./plan/types.js";
import { RISK_ORDER } from "./plan/types.js";
import { executePlan, type ExecutionReport, type ExecuteContext } from "./engine/executor.js";
import type { StateStore } from "./state/store.js";
import { auditPermissions, bySeverity, modelFromDesired, modelFromSnapshot, permissionMatrix, type Finding } from "./permissions/audit.js";
import { exportConfig, type ExportOptions } from "./export/exporter.js";
import { requiredBotPermissions } from "./permissions/requirements.js";
import { P, has, namesFromBits } from "./permissions/flags.js";
import { SafetyError } from "./util/errors.js";
import type { Logger } from "./util/logger.js";
import { silentLogger } from "./util/logger.js";
import { hashValue } from "./util/hash.js";

export type ConfigSource = { path: string } | { text: string; label?: string };

export interface ServiceOptions {
  api: DiscordApi;
  store: StateStore;
  logger?: Logger;
  /** Restrict config file access to this directory (MCP). */
  sandboxRoot?: string;
  /** If set, only these guild IDs may be accessed (multi-server isolation). */
  allowedGuilds?: string[];
  env?: Record<string, string | undefined>;
}

export interface DesiredResult {
  desired: DesiredState;
  diagnostics: Diagnostic[];
  loaded: LoadedConfig;
}

export interface ApplyOptions {
  actor?: string;
  continueOnError?: boolean;
  onProgress?: ExecuteContext["onProgress"];
  sleep?: (ms: number) => Promise<void>;
  /** Desired state used for post-apply verification (re-plan). */
  desired?: DesiredState;
}

export interface ApplyResult {
  report: ExecutionReport;
  /** Changes still pending after apply (should be empty; non-empty indicates drift or Discord normalization). */
  remaining?: Plan;
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail" | "skip";
  detail: string;
  hint?: string;
}

/**
 * Application service used by both the CLI and the MCP server. All Discord access goes
 * through the narrow DiscordApi interface; all mutations go through plan → apply.
 */
export class DiscordctlService {
  readonly api: DiscordApi;
  readonly store: StateStore;
  readonly logger: Logger;
  private readonly options: ServiceOptions;

  constructor(options: ServiceOptions) {
    this.options = options;
    this.api = options.api;
    this.store = options.store;
    this.logger = options.logger ?? silentLogger;
  }

  assertGuildAllowed(guildId: string): void {
    if (!/^\d{17,20}$/.test(guildId)) throw new SafetyError("INVALID_GUILD", `"${guildId}" is not a valid guild ID`);
    const allowed = this.options.allowedGuilds;
    if (allowed && allowed.length > 0 && !allowed.includes(guildId)) {
      throw new SafetyError("GUILD_NOT_ALLOWED", `Guild ${guildId} is not in the allowed guild list`, { hint: "Add it to DISCORDCTL_ALLOWED_GUILDS." });
    }
  }

  async listGuilds() {
    const guilds = await this.api.listGuilds();
    const allowed = this.options.allowedGuilds;
    return guilds
      .filter((g) => !allowed || allowed.length === 0 || allowed.includes(g.id))
      .map((g) => ({ id: g.id, name: g.name, owner: g.owner ?? false, features: g.features ?? [] }));
  }

  async snapshot(guildId: string): Promise<GuildSnapshot> {
    this.assertGuildAllowed(guildId);
    return fetchSnapshot(this.api, guildId);
  }

  loadDesired(source: ConfigSource, guildId?: string): DesiredResult {
    const opts = { ...(this.options.env ? { env: this.options.env } : {}), ...(this.options.sandboxRoot ? { sandboxRoot: this.options.sandboxRoot } : {}) };
    const loaded =
      "path" in source
        ? loadConfigFile(this.options.sandboxRoot ? resolvePath(this.options.sandboxRoot, source.path) : source.path, opts)
        : loadConfigText(source.text, { ...opts, source: source.label ?? "<inline>", ...(this.options.sandboxRoot ? { baseDir: this.options.sandboxRoot } : {}) });
    const { desired, diagnostics } = resolveConfig(loaded, guildId ? { guildId } : {});
    if (!hasErrors(diagnostics)) this.assertGuildAllowed(desired.guildId);
    return { desired, diagnostics, loaded };
  }

  /** Static validation plus a permission audit of the desired state. */
  validate(source: ConfigSource, guildId?: string): { valid: boolean; diagnostics: Diagnostic[]; findings: Finding[]; desired: DesiredState } {
    const { desired, diagnostics } = this.loadDesired(source, guildId);
    const findings = hasErrors(diagnostics) ? [] : bySeverity(auditPermissions(modelFromDesired(desired)));
    return { valid: !hasErrors(diagnostics), diagnostics, findings, desired };
  }

  async plan(source: ConfigSource, opts: { guildId?: string; allowDelete?: boolean } = {}): Promise<{ plan: Plan; desired: DesiredState; snapshot: GuildSnapshot; findings: Finding[] }> {
    const { desired, diagnostics } = this.loadDesired(source, opts.guildId);
    if (hasErrors(diagnostics)) {
      throw new SafetyError("CONFIG_INVALID", "Configuration has errors:\n" + diagnostics.filter((d) => d.severity === "error").map((d) => `  - ${d.path ? d.path + ": " : ""}${d.message}`).join("\n"));
    }
    return this.planDesired(desired, diagnostics, opts.allowDelete ?? false);
  }

  async planDesired(desired: DesiredState, configDiagnostics: Diagnostic[] = [], allowDelete = false) {
    const snapshot = await this.snapshot(desired.guildId);
    const plan = createPlan(desired, snapshot, this.store.getMappings(desired.guildId), { allowDelete });
    plan.diagnostics.unshift(...configDiagnostics.filter((d) => d.severity !== "info" || d.code !== "NAME_NORMALIZED"));
    const findings = bySeverity(auditPermissions(modelFromDesired(desired, snapshot)));
    return { plan, desired, snapshot, findings };
  }

  /**
   * Apply a plan. Re-fetches the guild and refuses if its state changed since planning
   * (fingerprint mismatch), so stale or replayed plans cannot be applied.
   */
  async apply(plan: Plan, opts: ApplyOptions = {}): Promise<ApplyResult> {
    this.assertGuildAllowed(plan.guildId);
    if (hasErrors(plan.diagnostics)) throw new SafetyError("PLAN_HAS_ERRORS", "The plan has errors; fix them and re-run plan");
    const snapshot = await this.snapshot(plan.guildId);
    const fp = fingerprintSnapshot(snapshot);
    if (fp !== plan.fingerprint) {
      throw new SafetyError("STATE_CHANGED", "The guild changed since this plan was created; refusing to apply a stale plan", { hint: "Run plan again and review the new changes." });
    }
    if (opts.desired && hashValue(opts.desired) !== plan.configHash) {
      throw new SafetyError("CONFIG_CHANGED", "The configuration changed since this plan was created", { hint: "Run plan again." });
    }
    const report = await executePlan(plan, {
      api: this.api, snapshot, store: this.store, logger: this.logger, actor: opts.actor ?? "cli",
      ...(opts.continueOnError !== undefined ? { continueOnError: opts.continueOnError } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
    let remaining: Plan | undefined;
    if (opts.desired && report.status === "success") {
      const after = await this.snapshot(plan.guildId);
      remaining = createPlan(opts.desired, after, this.store.getMappings(plan.guildId), { allowDelete: false });
    }
    return { report, ...(remaining ? { remaining } : {}) };
  }

  async exportGuild(guildId: string, options: ExportOptions & { writeState?: boolean } = {}) {
    const snapshot = await this.snapshot(guildId);
    const result = exportConfig(snapshot, { ...options, mappings: this.store.getMappings(guildId) });
    if (options.writeState) for (const b of result.bindings) this.store.bind(guildId, b.kind, b.key, b.id, b.name);
    return result;
  }

  /** Adopt existing resources that match the config into state, without changing Discord. */
  async importState(source: ConfigSource, opts: { guildId?: string; dryRun?: boolean } = {}) {
    const { plan, desired } = await this.plan(source, opts.guildId ? { guildId: opts.guildId } : {});
    const errors = plan.diagnostics.filter((d) => d.severity === "error" && ["AMBIGUOUS_MATCH", "PINNED_ID_NOT_FOUND", "DUPLICATE_BINDING", "UNMANAGEABLE_ROLE", "TYPE_CHANGE_UNSUPPORTED"].includes(d.code));
    if (errors.length) throw new SafetyError("IMPORT_BLOCKED", "Cannot import:\n" + errors.map((e) => `  - ${e.message}${e.hint ? ` (${e.hint})` : ""}`).join("\n"));
    if (!opts.dryRun) {
      for (const b of plan.bindings) this.store.bind(desired.guildId, b.kind, b.key, b.id, b.name);
      this.store.audit({ guildId: desired.guildId, actor: "cli", action: "import", planId: null, opId: null, status: "applied", details: JSON.stringify({ count: plan.bindings.length }) });
    }
    const unmatched = [...desired.roles.map((r) => `role:${r.key}`), ...[...desired.categories, ...desired.channels].map((c) => `channel:${c.key}`)].filter(
      (k) => !plan.bindings.some((b) => `${b.kind}:${b.key}` === k),
    );
    return { bindings: plan.bindings, unmatched, guildId: desired.guildId };
  }

  async audit(guildId: string, source?: ConfigSource) {
    const snapshot = await this.snapshot(guildId);
    const live = bySeverity(auditPermissions(modelFromSnapshot(snapshot)));
    let drift: Plan | undefined;
    let desiredFindings: Finding[] | undefined;
    if (source) {
      const { desired, diagnostics } = this.loadDesired(source, guildId);
      if (hasErrors(diagnostics)) throw new SafetyError("CONFIG_INVALID", "Configuration has errors; run validate");
      drift = createPlan(desired, snapshot, this.store.getMappings(guildId));
      desiredFindings = bySeverity(auditPermissions(modelFromDesired(desired, snapshot)));
    }
    return { guildId, guildName: snapshot.guild.name, live, ...(drift ? { drift } : {}), ...(desiredFindings ? { desired: desiredFindings } : {}) };
  }

  async permissions(guildId: string | undefined, source: ConfigSource | undefined, filter: { roles?: string[]; channels?: string[] } = {}) {
    if (source) {
      const { desired, diagnostics } = this.loadDesired(source, guildId);
      if (hasErrors(diagnostics)) throw new SafetyError("CONFIG_INVALID", "Configuration has errors; run validate");
      return { source: "desired" as const, matrix: permissionMatrix(modelFromDesired(desired), filter) };
    }
    if (!guildId) throw new SafetyError("MISSING_GUILD", "Provide a guild or a config");
    const snapshot = await this.snapshot(guildId);
    return { source: "live" as const, matrix: permissionMatrix(modelFromSnapshot(snapshot), filter) };
  }

  /** Health checks: connectivity, guild access, bot permissions and hierarchy, config validity. */
  async doctor(guildId: string | undefined, source?: ConfigSource): Promise<{ checks: DoctorCheck[]; ok: boolean }> {
    const checks: DoctorCheck[] = [];
    let desired: DesiredState | undefined;
    if (source) {
      try {
        const r = this.loadDesired(source, guildId);
        const errors = r.diagnostics.filter((d) => d.severity === "error");
        checks.push(errors.length ? { name: "config", status: "fail", detail: `${errors.length} error(s): ${errors[0]!.message}` } : { name: "config", status: "ok", detail: "configuration is valid" });
        if (!errors.length) desired = r.desired;
        guildId ??= r.desired.guildId;
      } catch (e) {
        checks.push({ name: "config", status: "fail", detail: (e as Error).message });
      }
    }
    let me;
    try {
      me = await this.api.getCurrentUser();
      checks.push({ name: "connectivity", status: "ok", detail: `authenticated as ${me.username} (${me.id})` });
      if (!me.bot) checks.push({ name: "token-type", status: "fail", detail: "token does not belong to a bot account", hint: "Only bot tokens are supported." });
    } catch (e) {
      checks.push({ name: "connectivity", status: "fail", detail: (e as Error).message, hint: "Check DISCORD_TOKEN or run `discordctl login`." });
      return { checks, ok: false };
    }
    if (!guildId) {
      checks.push({ name: "guild", status: "skip", detail: "no guild given (use --guild or --config)" });
      return { checks, ok: !checks.some((c) => c.status === "fail") };
    }
    let snapshot: GuildSnapshot;
    try {
      snapshot = await this.snapshot(guildId);
      checks.push({ name: "guild-access", status: "ok", detail: `can read "${snapshot.guild.name}" (${snapshot.roles.length} roles, ${snapshot.channels.length} channels)` });
    } catch (e) {
      checks.push({ name: "guild-access", status: "fail", detail: (e as Error).message, hint: "Invite the bot to the guild with `discordctl invite`." });
      return { checks, ok: false };
    }
    const bot = snapshot.bot;
    const required = requiredBotPermissions(desired);
    const missing = required & ~bot.permissions;
    checks.push(
      missing === 0n
        ? { name: "bot-permissions", status: "ok", detail: `bot has all ${namesFromBits(required).length} required permissions` }
        : { name: "bot-permissions", status: "fail", detail: `bot is missing: ${namesFromBits(missing).join(", ")}`, hint: "Grant these to the bot's role, or re-invite it with `discordctl invite --config <file>`." },
    );
    if (has(bot.permissions, P.Administrator) && !bot.isOwner && !(desired && has(required, P.Administrator))) {
      checks.push({ name: "least-privilege", status: "warn", detail: "bot has Administrator, which is broader than required", hint: "Prefer granting only the permissions listed by `discordctl invite`." });
    }
    const botTop = snapshot.roles.find((r) => bot.roleIds.includes(r.id) && r.position === bot.highestRolePosition);
    const above = snapshot.roles.filter((r) => !r.isEveryone && !bot.roleIds.includes(r.id) && r.position >= bot.highestRolePosition);
    const managedNames = new Set((desired?.roles ?? []).map((r) => r.name.toLowerCase()));
    const blocking = above.filter((r) => managedNames.has(r.name.toLowerCase()) || this.store.getMappings(guildId!).some((m) => m.discordId === r.id));
    checks.push(
      blocking.length
        ? { name: "role-hierarchy", status: "fail", detail: `managed role(s) above the bot: ${blocking.map((r) => r.name).join(", ")}`, hint: "Move the bot's role above every role discordctl manages." }
        : { name: "role-hierarchy", status: "ok", detail: `bot's highest role is "${botTop?.name ?? "?"}" (position ${bot.highestRolePosition}); ${above.length} role(s) above it` },
    );
    const community = snapshot.guild.features.includes("COMMUNITY");
    const needsCommunity = desired ? [...desired.channels].filter((c) => ["announcement", "stage", "media"].includes(c.kind)) : [];
    checks.push({
      name: "features",
      status: needsCommunity.length && !community && needsCommunity.some((c) => !c.fallbackKind) ? "fail" : needsCommunity.length && !community ? "warn" : "ok",
      detail: `Community ${community ? "enabled" : "disabled"}${needsCommunity.length ? `; ${needsCommunity.length} channel(s) need Community${community ? "" : " (fallback types will be used where configured)"}` : ""}`,
      ...(needsCommunity.length && !community ? { hint: "Enable Community in Server Settings → Enable Community to use announcement/stage/media channels." } : {}),
    });
    const findings = desired ? auditPermissions(modelFromDesired(desired, snapshot)) : auditPermissions(modelFromSnapshot(snapshot));
    const serious = findings.filter((f) => f.severity === "critical" || f.severity === "high");
    checks.push(
      serious.length
        ? { name: "permission-audit", status: "warn", detail: `${serious.length} critical/high finding(s); first: ${serious[0]!.message}`, hint: "Run `discordctl audit` for details." }
        : { name: "permission-audit", status: "ok", detail: `${findings.length} finding(s), none critical or high` },
    );
    if (desired) {
      const plan = createPlan(desired, snapshot, this.store.getMappings(guildId));
      const errors = plan.diagnostics.filter((d) => d.severity === "error");
      checks.push(
        errors.length
          ? { name: "plan", status: "fail", detail: `${errors.length} blocking issue(s): ${errors[0]!.message}`, ...(errors[0]!.hint ? { hint: errors[0]!.hint } : {}) }
          : { name: "plan", status: "ok", detail: `plan computes cleanly (${plan.ops.length} pending change(s), max risk ${plan.maxRisk})` },
      );
    }
    return { checks, ok: !checks.some((c) => c.status === "fail") };
  }
}

export function requiresHighRiskApproval(plan: Plan): boolean {
  return RISK_ORDER[plan.maxRisk] >= RISK_ORDER.high || plan.ops.some((o) => o.destructive);
}
