import { randomBytes } from "node:crypto";
import type { APIChannel, APIRole } from "discord-api-types/v10";
import type { DiscordApi } from "../provider/api.js";
import type { GuildSnapshot } from "../core/model.js";
import { channelSortClass } from "../core/model.js";
import { normalizeChannel } from "../provider/normalize.js";
import type { StateStore } from "../state/store.js";
import type { ChannelBody, GuildBody, Plan, PlanOp, Ref } from "../plan/types.js";
import { DiscordApiError, SafetyError, errorMessage, DiscordctlError } from "../util/errors.js";
import { DEFAULT_RETRY, withRetry, type RetryPolicy } from "./retry.js";
import type { Logger } from "../util/logger.js";
import { silentLogger } from "../util/logger.js";
import { compareSnowflakes, nameMatchKey, normalizeTextChannelName } from "../util/names.js";
import { redact } from "../util/redact.js";
import { AUDIT_REASON_PREFIX } from "../core/constants.js";
import { hasErrors } from "../core/diagnostics.js";

export type OpStatus = "applied" | "failed" | "skipped";

export interface OpResult {
  opId: string;
  action: PlanOp["action"];
  resource: PlanOp["resource"];
  name: string;
  status: OpStatus;
  discordId?: string;
  attempts: number;
  durationMs: number;
  error?: { message: string; code?: string; hint?: string };
}

export interface ExecutionReport {
  planId: string;
  guildId: string;
  status: "success" | "partial" | "failed" | "noop";
  startedAt: string;
  finishedAt: string;
  applied: number;
  failed: number;
  skipped: number;
  results: OpResult[];
}

export interface ExecuteContext {
  api: DiscordApi;
  /** Fresh snapshot of the guild, taken right before execution (used for ownership checks). */
  snapshot: GuildSnapshot;
  store?: StateStore;
  logger?: Logger;
  actor?: string;
  retry?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  /** Continue with independent operations after a failure. Default false (stop at first failure). */
  continueOnError?: boolean;
  onProgress?: (event: { op: PlanOp; status: "start" | OpStatus; error?: string }) => void;
}

/**
 * Execute a plan sequentially in dependency order. Operations are serialized (Discord rate
 * limits make parallelism unhelpful and ordering matters for hierarchy and positions).
 */
export async function executePlan(plan: Plan, ctx: ExecuteContext): Promise<ExecutionReport> {
  if (hasErrors(plan.diagnostics)) throw new SafetyError("PLAN_HAS_ERRORS", "Refusing to apply a plan with errors. Fix them and re-run plan.");
  if (ctx.snapshot.guild.id !== plan.guildId) throw new SafetyError("GUILD_MISMATCH", `Plan targets guild ${plan.guildId} but the snapshot is for ${ctx.snapshot.guild.id}`);
  if (plan.ops.some((o) => o.destructive) && !plan.allowDelete) throw new SafetyError("DELETE_NOT_AUTHORIZED", "Plan contains deletions but was not created with deletion allowed");

  const logger = ctx.logger ?? silentLogger;
  const actor = ctx.actor ?? "cli";
  const policy = ctx.retry ?? DEFAULT_RETRY;
  const guildId = plan.guildId;
  const reason = `${AUDIT_REASON_PREFIX} apply ${plan.id}`;
  const startedAt = new Date().toISOString();
  // Unique per run: re-entrancy must never let two runs of the same plan share the lock.
  const lockHolder = `${actor}:${plan.id}:${randomBytes(4).toString("hex")}`;

  // Every ID we may touch must belong to this guild (multi-server isolation).
  const ownedRoles = new Set(ctx.snapshot.roles.map((r) => r.id));
  const ownedChannels = new Set(ctx.snapshot.channels.map((c) => c.id));
  const idMap = new Map<string, string>();
  for (const b of plan.bindings) {
    if (!(b.kind === "role" ? ownedRoles : ownedChannels).has(b.id)) {
      throw new SafetyError("FOREIGN_RESOURCE", `Plan binding ${b.kind}:${b.key} → ${b.id} does not belong to guild ${guildId}. Re-run plan.`);
    }
    idMap.set(`${b.kind}:${b.key}`, b.id);
  }
  const resolve = (r: Ref, kind: "role" | "channel"): string => {
    if ("id" in r) {
      const owned = kind === "role" ? ownedRoles.has(r.id) || r.id === guildId : ownedChannels.has(r.id);
      if (!owned) throw new SafetyError("FOREIGN_RESOURCE", `Refusing to touch ${kind} ${r.id}: it does not belong to guild ${guildId}`);
      return r.id;
    }
    const id = idMap.get(r.ref);
    if (!id) throw new SafetyError("UNRESOLVED_REF", `Reference ${r.ref} was not created (did a dependency fail?)`);
    return id;
  };
  const resolveTarget = (r: Ref): string => {
    if ("id" in r) return r.id; // overwrite targets may be members; Discord validates them
    return resolve(r, "role");
  };

  const results: OpResult[] = [];
  const statusById = new Map<string, OpStatus>();
  let halted = false;

  if (ctx.store) ctx.store.acquireLock(guildId, lockHolder);
  try {
    for (const op of plan.ops) {
      const failedDep = op.dependsOn.find((d) => statusById.has(d) && statusById.get(d) !== "applied");
      if (halted || failedDep) {
        const message = halted ? "not attempted after an earlier failure" : `dependency ${failedDep} did not complete`;
        results.push({ opId: op.id, action: op.action, resource: op.resource, name: op.name, status: "skipped", attempts: 0, durationMs: 0, error: { message } });
        statusById.set(op.id, "skipped");
        ctx.onProgress?.({ op, status: "skipped", error: message });
        continue;
      }
      ctx.onProgress?.({ op, status: "start" });
      const t0 = Date.now();
      try {
        const { value: discordId, attempts } = await runOp(op);
        if (discordId && op.bind) {
          idMap.set(`${op.bind.kind}:${op.bind.key}`, discordId);
          (op.bind.kind === "role" ? ownedRoles : ownedChannels).add(discordId);
          ctx.store?.bind(guildId, op.bind.kind, op.bind.key, discordId, op.bind.name);
        }
        results.push({ opId: op.id, action: op.action, resource: op.resource, name: op.name, status: "applied", attempts, durationMs: Date.now() - t0, ...(discordId ? { discordId } : {}) });
        statusById.set(op.id, "applied");
        ctx.store?.audit({ guildId, actor, action: op.id, planId: plan.id, opId: op.id, status: "applied", details: JSON.stringify({ changes: op.changes, discordId }) });
        ctx.onProgress?.({ op, status: "applied" });
      } catch (err) {
        const message = redact(errorMessage(err));
        const error = { message, ...(err instanceof DiscordctlError ? { code: err.code, ...(err.hint ? { hint: err.hint } : {}) } : {}) };
        results.push({ opId: op.id, action: op.action, resource: op.resource, name: op.name, status: "failed", attempts: 0, durationMs: Date.now() - t0, error });
        statusById.set(op.id, "failed");
        logger.error(`Operation ${op.id} failed: ${message}`);
        ctx.store?.audit({ guildId, actor, action: op.id, planId: plan.id, opId: op.id, status: "failed", details: JSON.stringify(error) });
        ctx.onProgress?.({ op, status: "failed", error: message });
        if (!ctx.continueOnError) halted = true;
      }
    }

    // Refresh names of matched resources so state reflects the latest config.
    if (ctx.store && !results.some((r) => r.status !== "applied")) {
      for (const b of plan.bindings) ctx.store.bind(guildId, b.kind, b.key, b.id, b.name);
    }
    for (const r of results) {
      if (r.status === "applied" && r.action === "delete") {
        const op = plan.ops.find((o) => o.id === r.opId)!;
        ctx.store?.unbind(guildId, op.resource === "role" ? "role" : "channel", op.key);
      }
    }
  } finally {
    ctx.store?.releaseLock(guildId, lockHolder);
  }

  const applied = results.filter((r) => r.status === "applied").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const status = plan.ops.length === 0 ? "noop" : failed === 0 && skipped === 0 ? "success" : applied === 0 ? "failed" : "partial";
  const report: ExecutionReport = { planId: plan.id, guildId, status, startedAt, finishedAt: new Date().toISOString(), applied, failed, skipped, results };
  ctx.store?.audit({ guildId, actor, action: "apply", planId: plan.id, opId: null, status, details: JSON.stringify({ applied, failed, skipped }) });
  return report;

  // ---------------------------------------------------------------------------

  async function runOp(op: PlanOp): Promise<{ value: string | undefined; attempts: number }> {
    const p = op.payload;
    const retry = <T>(fn: () => Promise<T>, reconcile?: () => Promise<T | undefined>) =>
      withRetry(fn, policy, {
        ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
        onRetry: ({ attempt, delayMs, error }) => logger.warn(`Retrying ${op.id} in ${delayMs}ms (attempt ${attempt} failed: ${error.message})`),
        ...(reconcile ? { reconcile: async () => reconcile() } : {}),
      });

    switch (p.type) {
      case "role.import":
        return { value: p.roleId, attempts: 0 };
      case "channel.import":
        return { value: p.channelId, attempts: 0 };
      case "role.create": {
        const before = new Set(ownedRoles);
        return retry(
          async () => (await ctx.api.createRole(guildId, { ...p.body, permissions: p.body.permissions }, reason)).id,
          async () => {
            // The create may have succeeded despite the error: adopt it instead of duplicating.
            const roles = await ctx.api.getGuildRoles(guildId);
            return roles.find((r) => !before.has(r.id) && r.name === p.body.name)?.id;
          },
        );
      }
      case "role.update":
        resolve({ id: p.roleId }, "role");
        return retry(async () => (await ctx.api.modifyRole(guildId, p.roleId, p.body, reason)).id);
      case "everyone.update":
        return retry(async () => (await ctx.api.modifyRole(guildId, guildId, p.body, reason)).id);
      case "role.delete":
        resolve({ id: p.roleId }, "role");
        return retry(async () => {
          await ignoreNotFound(() => ctx.api.deleteRole(guildId, p.roleId, reason));
          return p.roleId;
        });
      case "roles.reorder": {
        const ids = p.order.map((r) => resolve(r, "role"));
        return retry(async () => {
          const roles = await ctx.api.getGuildRoles(guildId);
          const body = computeRolePositions(roles, ids);
          if (body.length > 0) await ctx.api.modifyRolePositions(guildId, body, reason);
          return undefined;
        });
      }
      case "channel.create": {
        const body = toApiChannelBody(p.body);
        const before = new Set(ownedChannels);
        const created = await retry(
          async () => (await ctx.api.createChannel(guildId, body as never, reason)).id,
          async () => {
            const channels = await ctx.api.getGuildChannels(guildId);
            const want = body.type === 2 || body.type === 13 || body.type === 4 ? nameMatchKey(String(body.name)) : nameMatchKey(normalizeTextChannelName(String(body.name)));
            return channels.find((c) => !before.has(c.id) && c.type === body.type && nameMatchKey(String((c as { name?: string }).name ?? "")) === want)?.id;
          },
        );
        if (p.followUp && created.value) {
          const followUp = toApiChannelBody(p.followUp);
          await retry(async () => (await ctx.api.modifyChannel(created.value!, followUp as never, reason)).id);
        }
        return created;
      }
      case "channel.update": {
        resolve({ id: p.channelId }, "channel");
        const body = toApiChannelBody(p.body);
        const updated = Object.keys(body).length > 0 ? await retry(async () => (await ctx.api.modifyChannel(p.channelId, body as never, reason)).id) : { value: p.channelId, attempts: 0 };
        if (p.followUp) {
          const followUp = toApiChannelBody(p.followUp);
          await retry(async () => (await ctx.api.modifyChannel(p.channelId, followUp as never, reason)).id);
        }
        return updated;
      }
      case "channel.delete":
        resolve({ id: p.channelId }, "channel");
        return retry(async () => {
          await ignoreNotFound(() => ctx.api.deleteChannel(p.channelId, reason));
          return p.channelId;
        });
      case "channels.reorder": {
        const ids = p.order.map((r) => resolve(r, "channel"));
        const parentId = p.parent ? resolve(p.parent, "channel") : null;
        return retry(async () => {
          const channels = await ctx.api.getGuildChannels(guildId);
          const body = computeChannelPositions(channels, ids, parentId, p.sortClass);
          if (body.length > 0) await ctx.api.modifyChannelPositions(guildId, body, reason);
          return undefined;
        });
      }
      case "guild.update": {
        const body = toApiGuildBody(p.body);
        return retry(async () => (await ctx.api.modifyGuild(guildId, body as never, reason)).id);
      }
    }
  }

  function toApiChannelBody(b: ChannelBody): Record<string, unknown> {
    const { parent, overwrites, ...rest } = b;
    const out: Record<string, unknown> = { ...rest };
    if (parent !== undefined) out.parent_id = parent === null ? null : resolve(parent, "channel");
    if (overwrites) {
      out.permission_overwrites = overwrites.map((o) => ({ id: resolveTarget(o.target), type: o.type, allow: o.allow, deny: o.deny }));
    }
    return out;
  }

  function toApiGuildBody(b: GuildBody): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) {
      if (k.endsWith("_channel")) out[`${k}_id`] = v === null ? null : resolve(v as Ref, "channel");
      else out[k] = v;
    }
    return out;
  }
}

async function ignoreNotFound(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof DiscordApiError && err.status === 404) return;
    throw err;
  }
}

/**
 * Reassign the positions currently occupied by managed roles so they appear in the desired
 * order (highest first). Unmanaged roles keep their positions.
 */
export function computeRolePositions(roles: APIRole[], desiredTopDown: string[]): Array<{ id: string; position: number }> {
  const managed = new Set(desiredTopDown);
  const present = roles.filter((r) => managed.has(r.id));
  const slots = present.map((r) => r.position).sort((a, b) => b - a);
  const byId = new Map(present.map((r) => [r.id, r]));
  const order = desiredTopDown.filter((id) => byId.has(id));
  // Ensure distinct slots even if Discord reports ties.
  for (let i = 1; i < slots.length; i++) if (slots[i]! >= slots[i - 1]!) slots[i] = slots[i - 1]! - 1;
  const out: Array<{ id: string; position: number }> = [];
  order.forEach((id, i) => {
    const pos = Math.max(1, slots[i]!);
    if (byId.get(id)!.position !== pos) out.push({ id, position: pos });
  });
  return out;
}

/**
 * Compute channel positions for one sorting group (same parent, same sort class). Managed
 * channels fill the slots they currently occupy in the desired order; unmanaged channels keep
 * their relative place. Positions are renumbered 0..n-1 within the group.
 */
export function computeChannelPositions(channels: APIChannel[], desiredOrder: string[], parentId: string | null, sortClass: "category" | "text" | "voice"): Array<{ id: string; position: number }> {
  const normalized = channels.map(normalizeChannel).filter((c) => c.kind !== "unsupported");
  const group = normalized
    .filter((c) => channelSortClass(c.kind as never) === sortClass && (sortClass === "category" || (c.parentId ?? null) === parentId))
    .sort((a, b) => a.position - b.position || compareSnowflakes(a.id, b.id));
  const managed = new Set(desiredOrder);
  const queue = desiredOrder.filter((id) => group.some((c) => c.id === id));
  const final = group.map((c) => (managed.has(c.id) ? queue.shift()! : c.id));
  const current = new Map(group.map((c) => [c.id, c.position]));
  const out: Array<{ id: string; position: number }> = [];
  final.forEach((id, i) => {
    if (current.get(id) !== i) out.push({ id, position: i });
  });
  return out;
}
