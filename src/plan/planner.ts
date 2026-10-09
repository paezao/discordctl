import { randomBytes } from "node:crypto";
import type {
  ActualChannel,
  ActualRole,
  ChannelKind,
  DesiredChannel,
  DesiredOverwrite,
  DesiredRole,
  DesiredState,
  GuildSnapshot,
} from "../core/model.js";
import { THREAD_CONTAINER_KINDS, VOICE_LIKE_KINDS, channelSortClass } from "../core/model.js";
import type { Diagnostic } from "../core/diagnostics.js";
import type { ResourceMapping } from "../state/store.js";
import { TYPE_BY_KIND } from "../provider/normalize.js";
import { ADMINISTRATIVE_PERMISSIONS, ELEVATED_PERMISSIONS, P, has, namesFromBits } from "../permissions/flags.js";
import { nameMatchKey, normalizeTextChannelName, compareSnowflakes } from "../util/names.js";
import { hashValue } from "../util/hash.js";
import { fingerprintSnapshot } from "./fingerprint.js";
import type {
  Binding,
  ChannelBody,
  FieldChange,
  GuildBody,
  Plan,
  PlanOp,
  Ref,
  Risk,
  RoleBody,
  WireOverwrite,
  WireTag,
} from "./types.js";
import { maxRisk } from "./types.js";

export interface PlanOptions {
  /** Plan deletion of resources that are tracked in state but no longer in the config. */
  allowDelete?: boolean;
  now?: Date;
}

/** Channel kinds Discord only allows in guilds with the COMMUNITY feature. */
const COMMUNITY_KINDS: ReadonlySet<ChannelKind> = new Set(["announcement", "stage", "media"]);
/** Type conversions Discord supports in place (PATCH type). */
const CONVERTIBLE: ReadonlyArray<ReadonlySet<ChannelKind>> = [new Set(["text", "announcement"])];

interface RoleMatch {
  desired: DesiredRole;
  actual?: ActualRole;
  adopted: boolean;
  staleMapping: boolean;
}

interface ChannelMatch {
  desired: DesiredChannel;
  effectiveKind: ChannelKind;
  actual?: ActualChannel;
  adopted: boolean;
  staleMapping: boolean;
}

export function createPlan(desired: DesiredState, snapshot: GuildSnapshot, mappings: ResourceMapping[], options: PlanOptions = {}): Plan {
  const guildId = snapshot.guild.id;
  if (desired.guildId !== guildId) throw new Error(`Desired state targets guild ${desired.guildId} but snapshot is for ${guildId}`);

  const diags: Diagnostic[] = [];
  const err = (code: string, message: string, path?: string, hint?: string) =>
    diags.push({ severity: "error", code, message, ...(path ? { path } : {}), ...(hint ? { hint } : {}) });
  const warn = (code: string, message: string, path?: string, hint?: string) =>
    diags.push({ severity: "warning", code, message, ...(path ? { path } : {}), ...(hint ? { hint } : {}) });
  const info = (code: string, message: string, path?: string) => diags.push({ severity: "info", code, message, ...(path ? { path } : {}) });

  const community = snapshot.guild.features.includes("COMMUNITY");
  const bot = snapshot.bot;
  const roleById = new Map(snapshot.roles.map((r) => [r.id, r]));
  const channelById = new Map(snapshot.channels.map((c) => [c.id, c]));
  const roleMappings = new Map(mappings.filter((m) => m.kind === "role").map((m) => [m.key, m]));
  const channelMappings = new Map(mappings.filter((m) => m.kind === "channel").map((m) => [m.key, m]));

  // ===================================================================== match roles
  const claimedRoles = new Set<string>();
  const roleMatches: RoleMatch[] = desired.roles.map((d) => ({ desired: d, adopted: false, staleMapping: false }));

  for (const m of roleMatches) {
    const d = m.desired;
    if (d.id) {
      const a = roleById.get(d.id);
      if (!a) err("PINNED_ID_NOT_FOUND", `Role "${d.key}" is pinned to id ${d.id}, which does not exist in this guild`, `roles.${d.key}`);
      else claim(m, a, !roleMappings.has(d.key) || roleMappings.get(d.key)!.discordId !== a.id);
      continue;
    }
    const mapping = roleMappings.get(d.key);
    if (mapping) {
      const a = roleById.get(mapping.discordId);
      if (a) claim(m, a, false);
      else {
        m.staleMapping = true;
        warn("DELETED_EXTERNALLY", `Role "${d.name}" (${mapping.discordId}) was deleted outside discordctl; it will be recreated or re-adopted`, `roles.${d.key}`);
      }
    }
  }
  for (const m of roleMatches) {
    if (m.actual || m.desired.id) continue;
    const candidates = snapshot.roles.filter((r) => !r.managed && !r.isEveryone && !claimedRoles.has(r.id) && nameMatchKey(r.name) === nameMatchKey(m.desired.name));
    if (candidates.length === 1) claim(m, candidates[0]!, true);
    else if (candidates.length > 1) {
      err("AMBIGUOUS_MATCH", `${candidates.length} existing roles are named "${m.desired.name}"; cannot decide which one "${m.desired.key}" refers to`, `roles.${m.desired.key}`,
        `Pin one with \`id: "${candidates[0]!.id}"\` in the config, or run \`discordctl import\`.`);
    }
  }
  function claim(m: RoleMatch, a: ActualRole, adopted: boolean) {
    if (claimedRoles.has(a.id)) {
      err("DUPLICATE_BINDING", `Role ${a.name} (${a.id}) is matched by more than one config entry`, `roles.${m.desired.key}`);
      return;
    }
    if (a.managed || a.isEveryone) {
      err("UNMANAGEABLE_ROLE", `"${m.desired.key}" points at ${a.isEveryone ? "@everyone" : `integration-managed role "${a.name}"`}, which discordctl cannot manage`, `roles.${m.desired.key}`,
        a.isEveryone ? "Use the top-level `everyone:` block." : "Bot and integration roles are controlled by their integration.");
      return;
    }
    claimedRoles.add(a.id);
    m.actual = a;
    m.adopted = adopted;
  }
  const roleMatchByKey = new Map(roleMatches.map((m) => [m.desired.key, m]));

  // ================================================================== match channels
  const claimedChannels = new Set<string>();
  const effectiveKind = (d: DesiredChannel): ChannelKind => {
    if (COMMUNITY_KINDS.has(d.kind) && !community) {
      if (d.fallbackKind) {
        info("FALLBACK_TYPE", `#${d.name} uses fallback type "${d.fallbackKind}" because the guild does not have the Community feature`, `channels.${d.key}`);
        return d.fallbackKind;
      }
      err("REQUIRES_COMMUNITY", `#${d.name} is a ${d.kind} channel, which requires the Community feature`, `channels.${d.key}`,
        `Enable Community in Server Settings → Enable Community, or set \`fallbackType: ${d.kind === "stage" ? "voice" : "text"}\`.`);
    }
    return d.kind;
  };
  const allDesired = [...desired.categories, ...desired.channels];
  const channelMatches: ChannelMatch[] = allDesired.map((d) => ({ desired: d, effectiveKind: effectiveKind(d), adopted: false, staleMapping: false }));
  const compatible = (m: ChannelMatch, a: ActualChannel): boolean => {
    if (a.kind === "unsupported") return false;
    if (a.kind === m.effectiveKind || a.kind === m.desired.kind || a.kind === m.desired.fallbackKind) return true;
    return CONVERTIBLE.some((set) => set.has(a.kind as ChannelKind) && set.has(m.effectiveKind));
  };
  const claimChannel = (m: ChannelMatch, a: ActualChannel, adopted: boolean) => {
    if (claimedChannels.has(a.id)) {
      err("DUPLICATE_BINDING", `Channel #${a.name} (${a.id}) is matched by more than one config entry`, `channels.${m.desired.key}`);
      return;
    }
    if (!compatible(m, a)) {
      err("TYPE_CHANGE_UNSUPPORTED", `#${a.name} is a ${a.kind} channel but "${m.desired.key}" is configured as ${m.effectiveKind}; Discord cannot convert between these types`, `channels.${m.desired.key}`,
        "Delete or rename the existing channel manually, or change the configured type. discordctl never recreates channels implicitly.");
      return;
    }
    claimedChannels.add(a.id);
    m.actual = a;
    m.adopted = adopted;
  };
  for (const m of channelMatches) {
    const d = m.desired;
    if (d.id) {
      const a = channelById.get(d.id);
      if (!a) err("PINNED_ID_NOT_FOUND", `Channel "${d.key}" is pinned to id ${d.id}, which does not exist in this guild`, `channels.${d.key}`);
      else claimChannel(m, a, channelMappings.get(d.key)?.discordId !== a.id);
      continue;
    }
    const mapping = channelMappings.get(d.key);
    if (mapping) {
      const a = channelById.get(mapping.discordId);
      if (a) claimChannel(m, a, false);
      else {
        m.staleMapping = true;
        warn("DELETED_EXTERNALLY", `Channel #${d.name} (${mapping.discordId}) was deleted outside discordctl; it will be recreated or re-adopted`, `channels.${d.key}`);
      }
    }
  }
  // Name adoption: categories first so parent preference works for channels.
  const categoryIdForKey = (key: string | null): string | undefined => (key ? channelMatches.find((x) => x.desired.key === key)?.actual?.id : undefined);
  for (const pass of ["category", "channel"] as const) {
    for (const m of channelMatches) {
      if (m.actual || m.desired.id) continue;
      if ((m.desired.kind === "category") !== (pass === "category")) continue;
      const key = channelNameKey(m.desired.name, m.effectiveKind);
      let candidates = snapshot.channels.filter((a) => !claimedChannels.has(a.id) && a.kind !== "unsupported" && compatibleForName(m, a) && channelNameKey(a.name, a.kind as ChannelKind) === key);
      if (candidates.length > 1) {
        const parentId = categoryIdForKey(m.desired.parentKey) ?? null;
        const sameParent = candidates.filter((a) => a.parentId === parentId);
        if (sameParent.length >= 1) candidates = sameParent;
      }
      if (candidates.length === 1) claimChannel(m, candidates[0]!, true);
      else if (candidates.length > 1) {
        err("AMBIGUOUS_MATCH", `${candidates.length} existing channels match "${m.desired.name}"; cannot decide which one "${m.desired.key}" refers to`, `channels.${m.desired.key}`,
          `Pin one with \`id: "${candidates[0]!.id}"\` in the config, or run \`discordctl import\`.`);
      }
    }
  }
  function compatibleForName(m: ChannelMatch, a: ActualChannel): boolean {
    if (m.desired.kind === "category" || a.kind === "category") return m.desired.kind === a.kind;
    return compatible(m, a);
  }
  const channelMatchByKey = new Map(channelMatches.map((m) => [m.desired.key, m]));

  // ============================================================ reference helpers
  const roleRef = (key: string): Ref => {
    const a = roleMatchByKey.get(key)?.actual;
    return a ? { id: a.id } : { ref: `role:${key}` };
  };
  const channelRef = (key: string): Ref => {
    const a = channelMatchByKey.get(key)?.actual;
    return a ? { id: a.id } : { ref: `channel:${key}` };
  };
  const refKey = (r: Ref): string => ("id" in r ? r.id : r.ref);
  const roleLabel = (idOrRef: string): string => {
    if (idOrRef === guildId) return "@everyone";
    if (idOrRef.startsWith("role:")) return roleMatchByKey.get(idOrRef.slice(5))?.desired.name ?? idOrRef;
    const configured = roleMatches.find((m) => m.actual?.id === idOrRef);
    if (configured) return configured.desired.name;
    return roleById.get(idOrRef)?.name ?? `<${idOrRef}>`;
  };
  const targetRef = (o: DesiredOverwrite): { ref: Ref; type: 0 | 1 } => {
    switch (o.target.kind) {
      case "everyone":
        return { ref: { id: guildId }, type: 0 };
      case "role":
        return { ref: roleRef(o.target.key), type: 0 };
      case "roleId":
        return { ref: { id: o.target.id }, type: 0 };
      case "member":
        return { ref: { id: o.target.id }, type: 1 };
    }
  };

  // ==================================================================== ops
  const ops: PlanOp[] = [];
  const add = (op: PlanOp) => ops.push(op);

  // ---- roles: create / update
  const needsRoleWrite: RoleMatch[] = [];
  for (const m of roleMatches) {
    const d = m.desired;
    const a = m.actual;
    if (!a) {
      const body: RoleBody = { name: d.name };
      if (d.color !== undefined) body.color = d.color;
      if (d.hoist !== undefined) body.hoist = d.hoist;
      if (d.mentionable !== undefined) body.mentionable = d.mentionable;
      body.permissions = (d.permissions ?? 0n).toString();
      const changes: FieldChange[] = [{ field: "permissions", before: null, after: describePerms(d.permissions ?? 0n) }];
      if (d.color !== undefined) changes.push({ field: "color", before: null, after: hex(d.color) });
      if (d.hoist) changes.push({ field: "hoist", before: null, after: "true" });
      if (d.mentionable) changes.push({ field: "mentionable", before: null, after: "true" });
      const risk = permissionGrantRisk(d.permissions ?? 0n, 0n, d.tier, false);
      const id = `role.create:${d.key}`;
      add({
        id, action: "create", resource: "role", key: d.key, name: d.name, changes, payload: { type: "role.create", body },
        dependsOn: [], risk: risk.risk, riskReasons: risk.reasons, destructive: false, bind: { kind: "role", key: d.key, name: d.name },
        ...(m.staleMapping ? { note: "previously managed role was deleted outside discordctl" } : {}),
      });
      if (d.permissions !== undefined) needsRoleWrite.push(m);
      continue;
    }
    const body: RoleBody = {};
    const changes: FieldChange[] = [];
    if (a.name !== d.name) {
      body.name = d.name;
      changes.push({ field: "name", before: a.name, after: d.name });
    }
    if (d.color !== undefined && a.color !== d.color) {
      body.color = d.color;
      changes.push({ field: "color", before: hex(a.color), after: hex(d.color) });
    }
    if (d.hoist !== undefined && a.hoist !== d.hoist) {
      body.hoist = d.hoist;
      changes.push({ field: "hoist", before: String(a.hoist), after: String(d.hoist) });
    }
    if (d.mentionable !== undefined && a.mentionable !== d.mentionable) {
      body.mentionable = d.mentionable;
      changes.push({ field: "mentionable", before: String(a.mentionable), after: String(d.mentionable) });
    }
    let risk: { risk: Risk; reasons: string[] } = { risk: "low", reasons: [] };
    if (d.permissions !== undefined && a.permissions !== d.permissions) {
      body.permissions = d.permissions.toString();
      changes.push(...permissionDelta("permissions", a.permissions, d.permissions));
      risk = permissionGrantRisk(d.permissions, a.permissions, d.tier, false);
      needsRoleWrite.push(m);
    }
    if (changes.length > 0 && a.position >= bot.highestRolePosition && !bot.isOwner) {
      err("ROLE_ABOVE_BOT", `Cannot modify role "${a.name}": it is at or above the bot's highest role`, `roles.${d.key}`,
        "Drag the bot's role above every role discordctl manages (Server Settings → Roles).");
    }
    if (changes.length > 0) {
      add({
        id: `role.update:${d.key}`, action: "update", resource: "role", key: d.key, name: d.name, discordId: a.id, changes,
        payload: { type: "role.update", roleId: a.id, body }, dependsOn: [], risk: risk.risk, riskReasons: risk.reasons, destructive: false,
        ...(m.adopted ? { bind: { kind: "role" as const, key: d.key, name: d.name }, note: "adopting existing role by name" } : {}),
      });
    } else if (m.adopted) {
      add({
        id: `role.import:${d.key}`, action: "import", resource: "role", key: d.key, name: d.name, discordId: a.id, changes: [],
        payload: { type: "role.import", roleId: a.id }, dependsOn: [], risk: "low", riskReasons: [], destructive: false,
        bind: { kind: "role", key: d.key, name: d.name }, note: "existing role adopted into state",
      });
    }
  }

  // ---- @everyone
  if (desired.everyone.permissions !== undefined) {
    const everyone = roleById.get(guildId);
    if (everyone && everyone.permissions !== desired.everyone.permissions) {
      const risk = permissionGrantRisk(desired.everyone.permissions, everyone.permissions, "member", true);
      add({
        id: "everyone.update", action: "update", resource: "everyone", key: "everyone", name: "@everyone", discordId: guildId,
        changes: permissionDelta("permissions", everyone.permissions, desired.everyone.permissions),
        payload: { type: "everyone.update", body: { permissions: desired.everyone.permissions.toString() } },
        dependsOn: [], risk: risk.risk, riskReasons: risk.reasons, destructive: false,
      });
    }
  }

  // ---- bot capability: granting role permissions
  for (const m of needsRoleWrite) {
    const missing = (m.desired.permissions ?? 0n) & ~bot.permissions;
    if (missing !== 0n) {
      err("BOT_CANNOT_GRANT", `The bot cannot grant ${namesFromBits(missing).join(", ")} to "${m.desired.name}" because it does not have ${missing === (missing & -missing) ? "that permission" : "those permissions"} itself`, `roles.${m.desired.key}`,
        "Discord only lets a bot grant permissions it holds. Give the bot's role these permissions, or grant them manually.");
    }
  }
  if (desired.everyone.permissions !== undefined && ops.some((o) => o.resource === "everyone")) {
    const missing = desired.everyone.permissions & ~bot.permissions;
    if (missing !== 0n) err("BOT_CANNOT_GRANT", `The bot cannot grant ${namesFromBits(missing).join(", ")} to @everyone`, "everyone");
  }

  // ---- last administrative access path
  checkAdminPath(roleMatches, snapshot, ops, warn);

  // ---- role order
  if (desired.options.manageRoleOrder && roleMatches.length > 1) {
    const existing = roleMatches.filter((m) => m.actual).sort((a, b) => b.actual!.position - a.actual!.position || compareSnowflakes(a.actual!.id, b.actual!.id));
    const created = roleMatches.filter((m) => !m.actual);
    const simulated = [...existing, ...created].map((m) => m.desired.key);
    const wanted = roleMatches.map((m) => m.desired.key);
    if (simulated.join("\u0000") !== wanted.join("\u0000")) {
      const blocked = existing.filter((m) => m.actual!.position >= bot.highestRolePosition && !bot.isOwner);
      if (blocked.length > 0) {
        err("ROLE_ABOVE_BOT", `Cannot reorder roles: ${blocked.map((m) => m.actual!.name).join(", ")} ${blocked.length === 1 ? "is" : "are"} at or above the bot's highest role`, "roles",
          "Move the bot's role above all managed roles, or set `options.manageRoleOrder: false`.");
      }
      add({
        id: "roles.reorder", action: "move", resource: "role-order", key: "roles", name: "role hierarchy",
        changes: [{ field: "order", before: simulated.map((k) => roleMatchByKey.get(k)!.desired.name).join(" > "), after: wanted.map((k) => roleMatchByKey.get(k)!.desired.name).join(" > ") }],
        payload: { type: "roles.reorder", order: wanted.map(roleRef) },
        dependsOn: created.map((m) => `role.create:${m.desired.key}`), risk: "low", riskReasons: [], destructive: false,
      });
    }
  }

  // ---- channels
  // Targets managed by the config, computed up front so the result does not depend on channel order.
  const managedTargetIds = new Set<string>([guildId, ...roleMatches.flatMap((m) => (m.actual ? [m.actual.id] : []))]);
  for (const m of channelMatches) {
    for (const o of m.desired.overwrites ?? []) {
      if (o.target.kind === "roleId" || o.target.kind === "member") managedTargetIds.add(o.target.id);
    }
  }
  const channelOps = new Map<string, PlanOp>();

  for (const m of channelMatches) {
    const d = m.desired;
    const a = m.actual;
    const kind = m.effectiveKind;
    const label = d.kind === "category" ? "category" : `${kind} channel`;
    const body: ChannelBody = {};
    const changes: FieldChange[] = [];
    const deps = new Set<string>();
    let isMove = false;
    let risk: Risk = "low";
    const riskReasons: string[] = [];

    // name
    const desiredName = kind === "category" || VOICE_LIKE_KINDS.has(kind) ? d.name : normalizeTextChannelName(d.name);
    if (!a || a.name !== desiredName) {
      body.name = d.name;
      changes.push({ field: "name", before: a?.name ?? null, after: desiredName });
    }
    // type
    if (!a) body.type = TYPE_BY_KIND[kind];
    else if (a.kind !== kind) {
      body.type = TYPE_BY_KIND[kind];
      changes.push({ field: "type", before: a.kind, after: kind });
      risk = "medium";
      riskReasons.push(`converts #${a.name} from ${a.kind} to ${kind}`);
    }
    // parent
    if (d.kind !== "category") {
      const parentMatch = d.parentKey ? channelMatchByKey.get(d.parentKey) : undefined;
      const parentRef: Ref | null = d.parentKey ? channelRef(d.parentKey) : null;
      const parentId = parentRef && "id" in parentRef ? parentRef.id : null;
      if (parentRef && "ref" in parentRef) deps.add(`channel.create:${d.parentKey}`);
      if (!a) {
        body.parent = parentRef;
      } else if ((a.parentId ?? null) !== parentId || (parentRef && "ref" in parentRef)) {
        body.parent = parentRef;
        isMove = true;
        changes.push({
          field: "category",
          before: a.parentId ? channelById.get(a.parentId)?.name ?? a.parentId : "(none)",
          after: parentMatch?.desired.name ?? "(none)",
        });
      }
    }
    // simple fields
    const textLike = kind === "text" || kind === "announcement" || THREAD_CONTAINER_KINDS.has(kind);
    if (d.topic !== undefined && textLike && (a?.topic ?? null) !== (d.topic ?? null)) {
      body.topic = d.topic;
      changes.push({ field: THREAD_CONTAINER_KINDS.has(kind) ? "guidelines" : "topic", before: a ? truncate(a.topic) : null, after: truncate(d.topic) });
    }
    if (d.nsfw !== undefined && kind !== "category" && (a?.nsfw ?? false) !== d.nsfw) {
      body.nsfw = d.nsfw;
      changes.push({ field: "nsfw", before: a ? String(a.nsfw) : null, after: String(d.nsfw) });
    }
    if (d.slowmode !== undefined && kind !== "announcement" && kind !== "category" && (a?.slowmode ?? 0) !== d.slowmode) {
      body.rate_limit_per_user = d.slowmode;
      changes.push({ field: "slowmode", before: a ? `${a.slowmode}s` : null, after: `${d.slowmode}s` });
    }
    if (d.voice && VOICE_LIKE_KINDS.has(kind)) {
      const v = d.voice;
      if (v.bitrate !== undefined && a?.bitrate !== v.bitrate) {
        body.bitrate = v.bitrate;
        changes.push({ field: "bitrate", before: a?.bitrate?.toString() ?? null, after: String(v.bitrate) });
      }
      if (v.userLimit !== undefined && (a?.userLimit ?? 0) !== v.userLimit) {
        body.user_limit = v.userLimit;
        changes.push({ field: "userLimit", before: a ? String(a.userLimit ?? 0) : null, after: String(v.userLimit) });
      }
      if (v.rtcRegion !== undefined && (a?.rtcRegion ?? null) !== v.rtcRegion) {
        body.rtc_region = v.rtcRegion;
        changes.push({ field: "rtcRegion", before: a ? a.rtcRegion ?? "automatic" : null, after: v.rtcRegion ?? "automatic" });
      }
      if (v.videoQualityMode !== undefined && kind === "voice" && (a?.videoQualityMode ?? 1) !== v.videoQualityMode) {
        body.video_quality_mode = v.videoQualityMode;
        changes.push({ field: "videoQuality", before: a ? (a.videoQualityMode === 2 ? "full" : "auto") : null, after: v.videoQualityMode === 2 ? "full" : "auto" });
      }
    }
    let followUp: ChannelBody | undefined;
    if (d.forum && THREAD_CONTAINER_KINDS.has(kind)) {
      const f = d.forum;
      if (f.tags !== undefined) {
        const existing = a?.tags ?? [];
        const used = new Set<string>();
        const final: WireTag[] = f.tags.map((t) => {
          const match = existing.find((e) => !used.has(e.id!) && e.name.toLowerCase() === t.name.toLowerCase());
          if (match) used.add(match.id!);
          return { ...(match ? { id: match.id! } : {}), name: t.name, moderated: t.moderated, emoji_id: t.emojiId, emoji_name: t.emojiName };
        });
        const leftovers = existing.filter((e) => !used.has(e.id!));
        if (f.tagPolicy === "merge") {
          for (const e of leftovers) final.push({ id: e.id!, name: e.name, moderated: e.moderated, emoji_id: e.emojiId, emoji_name: e.emojiName });
        } else if (leftovers.length > 0) {
          risk = maxRisk([risk, "medium"]);
          riskReasons.push(`removes forum tags ${leftovers.map((t) => t.name).join(", ")} (posts lose these tags)`);
        }
        const norm = (ts: Array<{ name: string; moderated: boolean; emoji_id?: string | null; emoji_name?: string | null }>) =>
          JSON.stringify(ts.map((t) => [t.name, t.moderated, t.emoji_id ?? null, t.emoji_name ?? null]));
        const actualNorm = norm(existing.map((e) => ({ name: e.name, moderated: e.moderated, emoji_id: e.emojiId, emoji_name: e.emojiName })));
        if (!a || norm(final) !== actualNorm) {
          body.available_tags = final;
          changes.push({ field: "tags", before: a ? existing.map(tagLabel).join(", ") || "(none)" : null, after: final.map((t) => tagLabel({ name: t.name, emojiName: t.emoji_name, moderated: t.moderated })).join(", ") });
        }
      }
      if (f.defaultReaction !== undefined) {
        const cur = a?.defaultReactionEmoji ?? null;
        const want = f.defaultReaction;
        if (!a || (cur?.emojiId ?? null) !== (want?.emojiId ?? null) || (cur?.emojiName ?? null) !== (want?.emojiName ?? null)) {
          body.default_reaction_emoji = want ? { emoji_id: want.emojiId, emoji_name: want.emojiName } : null;
          changes.push({ field: "defaultReaction", before: a ? cur?.emojiName ?? cur?.emojiId ?? "(none)" : null, after: want?.emojiName ?? want?.emojiId ?? "(none)" });
        }
      }
      if (f.sortOrder !== undefined && (a?.defaultSortOrder ?? null) !== f.sortOrder) {
        body.default_sort_order = f.sortOrder;
        changes.push({ field: "sortOrder", before: a ? sortLabel(a.defaultSortOrder ?? null) : null, after: sortLabel(f.sortOrder) });
      }
      if (f.layout !== undefined && kind === "forum" && (a?.defaultForumLayout ?? 0) !== f.layout) {
        body.default_forum_layout = f.layout;
        changes.push({ field: "layout", before: a ? layoutLabel(a.defaultForumLayout ?? 0) : null, after: layoutLabel(f.layout) });
      }
      if (f.requireTag !== undefined) {
        const cur = a ? (a.flags & 16) !== 0 : false;
        if (cur !== f.requireTag) {
          const settable = (a?.flags ?? 0) & (16 | 32768);
          const flags = f.requireTag ? settable | 16 : settable & ~16;
          // Discord does not accept flags on creation, and validates REQUIRE_TAG against the tags the
          // channel has before the request. Turning it on therefore happens in a follow-up request,
          // after the tags in `body` exist.
          if (a && !f.requireTag) body.flags = flags;
          else followUp = { flags };
          changes.push({ field: "requireTag", before: a ? String(cur) : null, after: String(f.requireTag) });
        }
      }
    }
    if (d.forum && textLike) {
      const f = d.forum;
      if (f.defaultThreadSlowmode !== undefined && (a?.defaultThreadSlowmode ?? 0) !== f.defaultThreadSlowmode) {
        body.default_thread_rate_limit_per_user = f.defaultThreadSlowmode;
        changes.push({ field: "defaultThreadSlowmode", before: a ? `${a.defaultThreadSlowmode ?? 0}s` : null, after: `${f.defaultThreadSlowmode}s` });
      }
      if (f.defaultAutoArchiveDuration !== undefined && (a?.defaultAutoArchiveDuration ?? 4320) !== f.defaultAutoArchiveDuration) {
        body.default_auto_archive_duration = f.defaultAutoArchiveDuration;
        changes.push({ field: "defaultAutoArchive", before: a ? `${a.defaultAutoArchiveDuration}m` : null, after: `${f.defaultAutoArchiveDuration}m` });
      }
    }

    // overwrites
    if (d.overwrites !== undefined) {
      const desiredWire: WireOverwrite[] = d.overwrites.map((o) => {
        const t = targetRef(o);
        if ("ref" in t.ref) deps.add(`role.create:${t.ref.ref.slice(5)}`);
        return { target: t.ref, type: t.type, allow: o.allow.toString(), deny: o.deny.toString() };
      });
      const actualOws = a?.overwrites ?? [];
      const preserved = actualOws.filter((o) => !managedTargetIds.has(o.id));
      const finalWire: WireOverwrite[] = [...desiredWire];
      if (d.overwritePolicy === "merge") {
        for (const o of preserved) finalWire.push({ target: { id: o.id }, type: o.type === "role" ? 0 : 1, allow: o.allow.toString(), deny: o.deny.toString() });
      } else if (preserved.length > 0) {
        risk = maxRisk([risk, "medium"]);
        riskReasons.push(`removes ${preserved.length} unmanaged permission overwrite(s) (authoritative policy)`);
      }
      const before = new Map(actualOws.map((o) => [o.id, o]));
      const after = new Map(finalWire.map((o) => [refKey(o.target), o]));
      const owChanges: FieldChange[] = [];
      for (const [k, o] of after) {
        const b = before.get(k);
        const allow = BigInt(o.allow);
        const deny = BigInt(o.deny);
        if (!b || b.allow !== allow || b.deny !== deny) {
          owChanges.push({ field: `permissions[${roleLabel(k)}]`, before: b ? overwriteLabel(b.allow, b.deny) : null, after: overwriteLabel(allow, deny) });
        }
      }
      for (const [k, b] of before) {
        if (!after.has(k)) owChanges.push({ field: `permissions[${roleLabel(k)}]`, before: overwriteLabel(b.allow, b.deny), after: null });
      }
      if (!a || owChanges.length > 0) {
        body.overwrites = finalWire;
        if (a || finalWire.length > 0) changes.push(...owChanges);
      }
      const missing = d.overwrites.reduce((acc, o) => acc | o.allow | o.deny, 0n) & ~bot.permissions;
      if (missing !== 0n && (!a || owChanges.length > 0)) {
        err("BOT_CANNOT_OVERWRITE", `The bot cannot set ${namesFromBits(missing).join(", ")} in overwrites on #${d.name} because it lacks ${missing === (missing & -missing) ? "that permission" : "those permissions"}`, `channels.${d.key}`,
          "Discord only allows bots to allow/deny permissions they hold. Grant them to the bot's role.");
      }
      // Raw member / role-ID targets bypass the role model: validate them and rate grants made through them.
      for (const o of d.overwrites) {
        if (o.target.kind === "roleId" && !roleById.has(o.target.id)) {
          err("UNKNOWN_ROLE_ID", `#${d.name} references role ID ${o.target.id}, which does not exist in this guild`, `channels.${d.key}`);
        }
        if (o.target.kind !== "member" && o.target.kind !== "roleId") continue;
        const who = o.target.kind === "member" ? `member ${o.target.id}` : `role ${roleById.get(o.target.id)?.name ?? o.target.id}`;
        if (d.private && has(o.allow, P.ViewChannel)) {
          risk = maxRisk([risk, "high"]);
          riskReasons.push(`grants ${who} access to private #${d.name}`);
        }
        const elevated = o.allow & ELEVATED_PERMISSIONS & ~P.ViewChannel;
        if (elevated !== 0n) {
          risk = maxRisk([risk, "high"]);
          riskReasons.push(`grants ${who} ${namesFromBits(elevated).join(", ")} on #${d.name}`);
        }
      }
      // Exposing a private channel is high risk.
      if (d.private) {
        const ev = d.overwrites.find((o) => o.target.kind === "everyone");
        if (!ev || !has(ev.deny, P.ViewChannel)) {
          risk = maxRisk([risk, "high"]);
          riskReasons.push(`#${d.name} is marked private but @everyone is not denied ViewChannel`);
        }
      }
    }

    const resource = d.kind === "category" ? "category" : "channel";
    if (!a) {
      const id = `channel.create:${d.key}`;
      const op: PlanOp = {
        id, action: "create", resource, key: d.key, name: d.name, changes, dependsOn: [...deps],
        payload: { type: "channel.create", body, ...(followUp ? { followUp } : {}) }, risk, riskReasons, destructive: false,
        bind: { kind: "channel", key: d.key, name: d.name },
        ...(m.staleMapping ? { note: "previously managed channel was deleted outside discordctl" } : {}),
      };
      if (VOICE_LIKE_KINDS.has(kind) || kind === "category") op.note ??= label;
      add(op);
      channelOps.set(d.key, op);
    } else if (changes.length > 0) {
      const op: PlanOp = {
        id: `channel.update:${d.key}`, action: isMove ? "move" : "update", resource, key: d.key, name: d.name, discordId: a.id, changes,
        dependsOn: [...deps], payload: { type: "channel.update", channelId: a.id, body, ...(followUp ? { followUp } : {}) }, risk, riskReasons, destructive: false,
        ...(m.adopted ? { bind: { kind: "channel" as const, key: d.key, name: d.name }, note: "adopting existing channel by name" } : {}),
      };
      add(op);
      channelOps.set(d.key, op);
    } else if (m.adopted) {
      add({
        id: `channel.import:${d.key}`, action: "import", resource, key: d.key, name: d.name, discordId: a.id, changes: [],
        payload: { type: "channel.import", channelId: a.id }, dependsOn: [], risk: "low", riskReasons: [], destructive: false,
        bind: { kind: "channel", key: d.key, name: d.name }, note: "existing channel adopted into state",
      });
    }
  }

  // bot capability: channel management
  const channelWrites = ops.filter((o) => o.resource === "channel" || o.resource === "category");
  if (channelWrites.some((o) => o.action !== "import") && !has(bot.permissions, P.ManageChannels)) {
    err("BOT_MISSING_PERMISSION", "The bot lacks Manage Channels, which is required to create or edit channels", "bot");
  }
  if (channelWrites.some((o) => o.payload.type !== "channel.import" && "body" in o.payload && (o.payload.body as ChannelBody).overwrites) && !has(bot.permissions, P.ManageRoles)) {
    err("BOT_MISSING_PERMISSION", "The bot lacks Manage Roles, which is required to edit channel permission overwrites", "bot");
  }
  const roleWrites = ops.some((o) => (o.resource === "role" && o.action !== "import") || o.resource === "everyone" || o.resource === "role-order");
  if (roleWrites && !has(bot.permissions, P.ManageRoles)) {
    err("BOT_MISSING_PERMISSION", "The bot lacks Manage Roles, which is required to create or edit roles", "bot");
  }

  // ---- channel ordering
  if (desired.options.manageChannelOrder) {
    const groups = new Map<string, ChannelMatch[]>();
    for (const m of channelMatches) {
      const cls = channelSortClass(m.effectiveKind);
      const gk = `${m.desired.parentKey ?? ""}|${cls}`;
      groups.set(gk, [...(groups.get(gk) ?? []), m]);
    }
    for (const [gk, members] of groups) {
      if (members.length < 2) continue;
      const [parentKey, cls] = gk.split("|") as [string, "category" | "text" | "voice"];
      const wanted = [...members].sort((x, y) => x.desired.order - y.desired.order);
      const parentRef: Ref | null = parentKey ? channelRef(parentKey) : null;
      const parentId = parentRef && "id" in parentRef ? parentRef.id : null;
      const stays = members.filter((m) => m.actual && (m.desired.kind === "category" || (m.actual.parentId ?? null) === parentId));
      const arriving = members.filter((m) => !stays.includes(m));
      const simulated = [
        ...stays.sort((x, y) => x.actual!.position - y.actual!.position || compareSnowflakes(x.actual!.id, y.actual!.id)),
        ...arriving.sort((x, y) => x.desired.order - y.desired.order),
      ];
      const forcedByMove = arriving.some((m) => m.actual);
      if (!forcedByMove && simulated.map((m) => m.desired.key).join("\u0000") === wanted.map((m) => m.desired.key).join("\u0000")) continue;
      const parentName = parentKey ? channelMatchByKey.get(parentKey)?.desired.name ?? parentKey : null;
      const scope = cls === "category" ? "categories" : `${cls === "voice" ? "voice" : "text"} channels in ${parentName ?? "(no category)"}`;
      add({
        id: `channels.reorder:${parentKey || "_root"}:${cls}`, action: "move", resource: "channel-order", key: `${parentKey || "_root"}:${cls}`, name: scope,
        changes: [{ field: "order", before: simulated.map((m) => m.desired.name).join(", "), after: wanted.map((m) => m.desired.name).join(", ") }],
        payload: { type: "channels.reorder", parent: parentRef, sortClass: cls, order: wanted.map((m) => channelRef(m.desired.key)) },
        dependsOn: members.flatMap((m) => [channelOps.get(m.desired.key)?.id].filter((x): x is string => !!x)),
        risk: "low", riskReasons: [], destructive: false,
      });
    }
  }

  // ---- guild settings
  const gs = desired.settings;
  const gBody: GuildBody = {};
  const gChanges: FieldChange[] = [];
  const gDeps: string[] = [];
  const g = snapshot.guild;
  const setScalar = <K extends keyof GuildBody>(field: K, label: string, before: GuildBody[K], after: GuildBody[K] | undefined, fmt: (v: unknown) => string = String) => {
    if (after === undefined || before === after) return;
    gBody[field] = after;
    gChanges.push({ field: label, before: before === null ? "(none)" : fmt(before), after: after === null ? "(none)" : fmt(after) });
  };
  setScalar("name", "name", g.name, gs.name);
  setScalar("description", "description", g.description, gs.description);
  setScalar("verification_level", "verificationLevel", g.verificationLevel, gs.verificationLevel, (v) => ["none", "low", "medium", "high", "very_high"][v as number] ?? String(v));
  setScalar("default_message_notifications", "defaultNotifications", g.defaultMessageNotifications, gs.defaultMessageNotifications, (v) => (v === 0 ? "all_messages" : "only_mentions"));
  setScalar("explicit_content_filter", "explicitContentFilter", g.explicitContentFilter, gs.explicitContentFilter, (v) => ["disabled", "members_without_roles", "all_members"][v as number] ?? String(v));
  setScalar("afk_timeout", "afkTimeout", g.afkTimeout, gs.afkTimeout);
  const channelSetting = (field: "afk_channel" | "system_channel" | "rules_channel" | "public_updates_channel", label: string, current: string | null, key: string | null | undefined, needsCommunity: boolean) => {
    if (key === undefined) return;
    if (needsCommunity && !community) {
      err("REQUIRES_COMMUNITY", `guild.${label} requires the Community feature`, `guild.${label}`, "Enable Community in Server Settings, then re-run plan.");
      return;
    }
    const ref = key === null ? null : channelRef(key);
    const same = ref === null ? current === null : "id" in ref && ref.id === current;
    if (same) return;
    if (ref && "ref" in ref) gDeps.push(`channel.create:${key}`);
    gBody[field] = ref;
    gChanges.push({ field: label, before: current ? `#${channelById.get(current)?.name ?? current}` : "(none)", after: key ? `#${channelMatchByKey.get(key)?.desired.name ?? key}` : "(none)" });
  };
  channelSetting("afk_channel", "afkChannel", g.afkChannelId, gs.afkChannel, false);
  channelSetting("system_channel", "systemChannel", g.systemChannelId, gs.systemChannel, false);
  channelSetting("rules_channel", "rulesChannel", g.rulesChannelId, gs.rulesChannel, true);
  channelSetting("public_updates_channel", "publicUpdatesChannel", g.publicUpdatesChannelId, gs.publicUpdatesChannel, true);
  if (gChanges.length > 0) {
    if (!has(bot.permissions, P.ManageGuild)) err("BOT_MISSING_PERMISSION", "The bot lacks Manage Server, which is required to change guild settings", "guild");
    add({
      id: "guild.update", action: "update", resource: "guild", key: "guild", name: g.name, discordId: g.id, changes: gChanges,
      payload: { type: "guild.update", body: gBody }, dependsOn: gDeps, risk: gBody.name ? "medium" : "low",
      riskReasons: gBody.name ? ["renames the server"] : [], destructive: false,
    });
  }

  // ---- orphans (tracked in state, removed from config)
  const desiredRoleKeys = new Set(desired.roles.map((r) => r.key));
  const desiredChannelKeys = new Set(allDesired.map((c) => c.key));
  // A mapping whose resource is now claimed by another key was renamed, not orphaned: it is rebound, never deleted.
  const renamedKey = (m: ResourceMapping) => (m.kind === "role" ? claimedRoles : claimedChannels).has(m.discordId);
  for (const m of mappings) {
    if (!(m.kind === "role" ? desiredRoleKeys : desiredChannelKeys).has(m.key) && renamedKey(m)) {
      info("KEY_RENAMED", `State key "${m.key}" now maps to a different config key; the binding will be moved`, `${m.kind}s.${m.key}`);
    }
  }
  const orphanChannels = mappings.filter((m) => m.kind === "channel" && !desiredChannelKeys.has(m.key) && channelById.has(m.discordId) && !renamedKey(m));
  const orphanRoles = mappings.filter((m) => m.kind === "role" && !desiredRoleKeys.has(m.key) && roleById.has(m.discordId) && !renamedKey(m));
  if (orphanChannels.length + orphanRoles.length > 0 && !options.allowDelete) {
    for (const o of [...orphanChannels, ...orphanRoles]) {
      const name = o.kind === "role" ? roleById.get(o.discordId)!.name : `#${channelById.get(o.discordId)!.name}`;
      warn("ORPHANED", `${name} was managed by discordctl but is no longer in the config; it will be left untouched`, `${o.kind}s.${o.key}`,
        "Re-run with --allow-delete to delete it, or `discordctl state rm` to stop tracking it.");
    }
  }
  if (options.allowDelete) {
    const sortedChannels = [...orphanChannels].sort((x, y) => Number(channelById.get(x.discordId)!.kind === "category") - Number(channelById.get(y.discordId)!.kind === "category"));
    for (const o of sortedChannels) {
      const ch = channelById.get(o.discordId)!;
      const children = snapshot.channels.filter((c) => c.parentId === ch.id && !orphanChannels.some((x) => x.discordId === c.id));
      add({
        id: `channel.delete:${o.key}`, action: "delete", resource: ch.kind === "category" ? "category" : "channel", key: o.key, name: ch.name, discordId: ch.id,
        changes: [], payload: { type: "channel.delete", channelId: ch.id }, dependsOn: [], risk: "high",
        riskReasons: [`permanently deletes #${ch.name} and its message history`, ...(children.length ? [`${children.length} channel(s) in this category become uncategorized`] : [])],
        destructive: true,
      });
    }
    for (const o of orphanRoles) {
      const r = roleById.get(o.discordId)!;
      const reasons = [`permanently deletes role ${r.name}; members lose it`];
      let risk: Risk = "high";
      if (has(r.permissions, P.Administrator) || (has(r.permissions, P.ManageGuild) && has(r.permissions, P.ManageRoles))) {
        const others = snapshot.roles.filter((x) => x.id !== r.id && !x.managed && (has(x.permissions, P.Administrator) || (has(x.permissions, P.ManageGuild) && has(x.permissions, P.ManageRoles))));
        if (others.length === 0) {
          risk = "critical";
          reasons.push("this is the last role with administrative access");
        }
      }
      if (r.position >= bot.highestRolePosition && !bot.isOwner) err("ROLE_ABOVE_BOT", `Cannot delete role "${r.name}": it is at or above the bot's highest role`, `roles.${o.key}`);
      add({
        id: `role.delete:${o.key}`, action: "delete", resource: "role", key: o.key, name: r.name, discordId: r.id, changes: [],
        payload: { type: "role.delete", roleId: r.id }, dependsOn: [], risk, riskReasons: reasons, destructive: true,
      });
    }
  }

  // ---- bindings for refresh + summary
  const bindings: Binding[] = [
    ...roleMatches.filter((m) => m.actual).map((m) => ({ kind: "role" as const, key: m.desired.key, id: m.actual!.id, name: m.desired.name })),
    ...channelMatches.filter((m) => m.actual).map((m) => ({ kind: "channel" as const, key: m.desired.key, id: m.actual!.id, name: m.desired.name })),
  ];
  const summary = { create: 0, update: 0, move: 0, delete: 0, import: 0 };
  for (const op of ops) summary[op.action]++;

  return {
    formatVersion: 1,
    id: `plan_${randomBytes(6).toString("hex")}`,
    guildId,
    guildName: snapshot.guild.name,
    createdAt: (options.now ?? new Date()).toISOString(),
    configHash: hashValue(desired),
    fingerprint: fingerprintSnapshot(snapshot),
    ops,
    bindings,
    summary,
    diagnostics: diags,
    manualSteps: desired.manualSteps,
    allowDelete: options.allowDelete ?? false,
    maxRisk: maxRisk(ops.map((o) => o.risk)),
  };
}

// ======================================================================== helpers

function channelNameKey(name: string, kind: ChannelKind): string {
  return kind === "category" || VOICE_LIKE_KINDS.has(kind) ? nameMatchKey(name) : nameMatchKey(normalizeTextChannelName(name));
}

function permissionGrantRisk(after: bigint, before: bigint, tier: string, isEveryone: boolean): { risk: Risk; reasons: string[] } {
  const granted = after & ~before;
  const reasons: string[] = [];
  let risk: Risk = "low";
  if (has(granted, P.Administrator)) {
    risk = "critical";
    reasons.push(`grants Administrator${isEveryone ? " to @everyone" : ""}`);
  }
  const admin = granted & ADMINISTRATIVE_PERMISSIONS & ~P.Administrator;
  if (admin !== 0n) {
    risk = maxRisk([risk, isEveryone || tier === "member" ? "critical" : "high"]);
    reasons.push(`grants ${namesFromBits(admin).join(", ")}${isEveryone ? " to @everyone" : ""}`);
  }
  const elevated = granted & ELEVATED_PERMISSIONS & ~ADMINISTRATIVE_PERMISSIONS;
  if (elevated !== 0n) {
    risk = maxRisk([risk, isEveryone ? "critical" : tier === "member" ? "high" : "medium"]);
    reasons.push(`grants ${namesFromBits(elevated).join(", ")}${isEveryone ? " to @everyone" : ""}`);
  }
  return { risk, reasons };
}

function checkAdminPath(
  matches: RoleMatch[],
  snapshot: GuildSnapshot,
  ops: PlanOp[],
  warn: (code: string, message: string, path?: string, hint?: string) => void,
) {
  const isAdminPath = (p: bigint) => has(p, P.Administrator) || (has(p, P.ManageGuild) && has(p, P.ManageRoles));
  const after = new Map(snapshot.roles.filter((r) => !r.managed && !r.isEveryone).map((r) => [r.id, r.permissions]));
  for (const m of matches) {
    if (m.actual && m.desired.permissions !== undefined) after.set(m.actual.id, m.desired.permissions);
  }
  const hadPath = snapshot.roles.some((r) => !r.managed && !r.isEveryone && isAdminPath(r.permissions));
  const willHave = [...after.values()].some(isAdminPath) || matches.some((m) => !m.actual && isAdminPath(m.desired.permissions ?? 0n));
  if (hadPath && !willHave) {
    for (const op of ops) {
      if (op.resource === "role" && op.action === "update" && op.changes.some((c) => c.field.startsWith("permissions"))) {
        op.risk = "critical";
        op.riskReasons.push("removes the last role with administrative access (only the server owner would retain it)");
      }
    }
    warn("LAST_ADMIN_PATH", "After this plan no role grants Administrator or Manage Server + Manage Roles; only the server owner keeps administrative access", "roles");
  }
}

function permissionDelta(field: string, before: bigint, after: bigint): FieldChange[] {
  const added = namesFromBits(after & ~before);
  const removed = namesFromBits(before & ~after);
  const out: FieldChange[] = [];
  if (added.length) out.push({ field: `${field} +`, before: null, after: added.join(", ") });
  if (removed.length) out.push({ field: `${field} -`, before: removed.join(", "), after: null });
  return out;
}

function describePerms(bits: bigint): string {
  return namesFromBits(bits).join(", ") || "(none)";
}

export function overwriteLabel(allow: bigint, deny: bigint): string {
  const parts: string[] = [];
  if (allow) parts.push(`allow ${namesFromBits(allow).join(", ")}`);
  if (deny) parts.push(`deny ${namesFromBits(deny).join(", ")}`);
  return parts.join("; ") || "(inherit)";
}

function hex(n: number): string {
  return `#${n.toString(16).padStart(6, "0")}`;
}

function truncate(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const flat = s.replace(/\s+/g, " ");
  return flat.length > 60 ? flat.slice(0, 57) + "..." : flat;
}

function tagLabel(t: { name: string; emojiName: string | null; moderated: boolean }): string {
  return `${t.emojiName ? t.emojiName + " " : ""}${t.name}${t.moderated ? " (mod)" : ""}`;
}

function sortLabel(v: number | null): string {
  return v === null ? "(default)" : v === 0 ? "latest_activity" : "creation_date";
}

function layoutLabel(v: number): string {
  return ["default", "list", "gallery"][v] ?? String(v);
}
