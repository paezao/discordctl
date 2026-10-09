import type { ChannelKind, DesiredState, GuildSnapshot, PermissionExpectations, RoleTier } from "../core/model.js";
import { VOICE_LIKE_KINDS } from "../core/model.js";
import { computeChannelPermissions, type SimOverwrite, type SimRole } from "./effective.js";
import { ADMINISTRATIVE_PERMISSIONS, ELEVATED_PERMISSIONS, MODERATION_PERMISSIONS, P, SAFE_EVERYONE_DEFAULTS, has, namesFromBits } from "./flags.js";
import { inferTier } from "../config/resolve.js";

/**
 * Permission audit: simulates effective permissions for "personas" (an ordinary member with
 * only @everyone, and a member holding each role) and flags dangerous configurations.
 * Works on desired configuration (before apply) and on live guild state.
 */

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface Finding {
  severity: FindingSeverity;
  code: string;
  message: string;
  resource?: string;
  hint?: string;
}

export interface AuditRole {
  id: string;
  key?: string;
  name: string;
  permissions: bigint;
  tier: RoleTier;
  /** Higher = higher in the hierarchy. */
  rank: number;
}

export interface AuditChannel {
  id: string;
  key?: string;
  name: string;
  kind: ChannelKind;
  parentName: string | null;
  overwrites: SimOverwrite[];
  /** Explicitly declared private in config. */
  declaredPrivate: boolean;
  expect?: PermissionExpectations;
}

export interface AuditModel {
  source: "desired" | "live";
  everyoneId: string;
  everyonePermissions: bigint;
  roles: AuditRole[];
  channels: AuditChannel[];
}

const STAFF_NAME = /\b(staff|mods?|moderators?|moderation|admins?|private|internal|mod-logs?)\b/i;
const MOD_NAME = /\b(mods?|moderators?|moderation|staff|logs?|audit)\b/i;
const ANNOUNCE_NAME = /(announce|\brules\b|\bnews\b|updates?\b|changelog|releases?\b)/i;

export function modelFromDesired(desired: DesiredState, snapshot?: GuildSnapshot): AuditModel {
  const actualEveryone = snapshot?.roles.find((r) => r.isEveryone)?.permissions;
  const roles: AuditRole[] = desired.roles.map((r) => {
    const actual = snapshot?.roles.find((a) => !a.managed && a.name.toLowerCase() === r.name.toLowerCase());
    return {
      id: `role:${r.key}`, key: r.key, name: r.name, permissions: r.permissions ?? actual?.permissions ?? 0n, tier: r.tier,
      rank: desired.roles.length - r.order,
    };
  });
  const catName = new Map(desired.categories.map((c) => [c.key, c.name]));
  const channels: AuditChannel[] = [...desired.categories, ...desired.channels].map((c) => ({
    id: `channel:${c.key}`, key: c.key, name: c.name, kind: c.kind, parentName: c.parentKey ? catName.get(c.parentKey) ?? null : null,
    declaredPrivate: c.private,
    overwrites: (c.overwrites ?? []).map((o) => ({
      id: o.target.kind === "everyone" ? "everyone" : o.target.kind === "role" ? `role:${o.target.key}` : o.target.id,
      type: o.target.kind === "member" ? "member" : "role",
      allow: o.allow,
      deny: o.deny,
    })),
    ...(c.expect ? { expect: c.expect } : {}),
  }));
  return { source: "desired", everyoneId: "everyone", everyonePermissions: desired.everyone.permissions ?? actualEveryone ?? SAFE_EVERYONE_DEFAULTS, roles, channels };
}

export function modelFromSnapshot(s: GuildSnapshot): AuditModel {
  const everyone = s.roles.find((r) => r.isEveryone);
  const botRoleIds = new Set(s.bot.roleIds);
  const roles: AuditRole[] = s.roles
    .filter((r) => !r.isEveryone)
    .map((r) => ({ id: r.id, name: r.name, permissions: r.permissions, tier: r.managed || botRoleIds.has(r.id) ? "bot" : inferTier(r.permissions), rank: r.position }));
  const byId = new Map(s.channels.map((c) => [c.id, c]));
  const channels: AuditChannel[] = s.channels
    .filter((c) => c.kind !== "unsupported")
    .map((c) => ({
      id: c.id, name: c.name, kind: c.kind as ChannelKind, parentName: c.parentId ? byId.get(c.parentId)?.name ?? null : null,
      declaredPrivate: false, overwrites: c.overwrites,
    }));
  return { source: "live", everyoneId: s.guild.id, everyonePermissions: everyone?.permissions ?? 0n, roles, channels };
}

function simKind(kind: ChannelKind): "text" | "voice" | "category" {
  return kind === "category" ? "category" : VOICE_LIKE_KINDS.has(kind) ? "voice" : "text";
}

export function effectiveFor(model: AuditModel, channel: AuditChannel, roleIds: string[]): bigint {
  const roles = new Map<string, SimRole>(model.roles.map((r) => [r.id, { id: r.id, name: r.name, permissions: r.permissions }]));
  return computeChannelPermissions({
    member: { roleIds },
    everyone: { id: model.everyoneId, name: "@everyone", permissions: model.everyonePermissions },
    roles,
    overwrites: channel.overwrites,
    channelKind: simKind(channel.kind),
  });
}

export interface MatrixRow {
  channel: string;
  kind: ChannelKind;
  category: string | null;
  personas: Record<string, { view: boolean; send: boolean; connect: boolean; manage: boolean }>;
}

/** Effective-permission matrix: channel × persona (@everyone, then each role on top of @everyone). */
export function permissionMatrix(model: AuditModel, options: { roles?: string[]; channels?: string[] } = {}): MatrixRow[] {
  const personas: Array<{ label: string; roleIds: string[] }> = [{ label: "@everyone", roleIds: [] }];
  for (const r of [...model.roles].sort((a, b) => b.rank - a.rank)) {
    if (r.tier === "bot") continue;
    if (options.roles && !options.roles.some((x) => x === r.key || x.toLowerCase() === r.name.toLowerCase())) continue;
    personas.push({ label: r.name, roleIds: [r.id] });
  }
  return model.channels
    .filter((c) => !options.channels || options.channels.some((x) => x === c.key || x.toLowerCase() === c.name.toLowerCase()))
    .map((c) => {
      const row: MatrixRow = { channel: c.name, kind: c.kind, category: c.parentName, personas: {} };
      for (const p of personas) {
        const perms = effectiveFor(model, c, p.roleIds);
        row.personas[p.label] = {
          view: has(perms, P.ViewChannel),
          send: VOICE_LIKE_KINDS.has(c.kind) ? has(perms, P.Speak) : has(perms, P.SendMessages),
          connect: has(perms, P.Connect),
          manage: has(perms, P.ManageChannels) || has(perms, P.ManageMessages),
        };
      }
      return row;
    });
}

export function auditPermissions(model: AuditModel): Finding[] {
  const findings: Finding[] = [];
  const f = (severity: FindingSeverity, code: string, message: string, resource?: string, hint?: string) =>
    findings.push({ severity, code, message, ...(resource ? { resource } : {}), ...(hint ? { hint } : {}) });
  const human = model.roles.filter((r) => r.tier !== "bot");
  const roleByRef = new Map(model.roles.flatMap((r) => [[r.id, r], ...(r.key ? [[r.key, r] as const] : [])]));

  // ---- guild-level role permissions
  if (has(model.everyonePermissions, P.Administrator)) {
    f("critical", "EVERYONE_ADMIN", "@everyone has Administrator: every member has full control of the server", "@everyone", "Remove Administrator from @everyone immediately.");
  } else {
    const elevated = model.everyonePermissions & ELEVATED_PERMISSIONS;
    if (elevated !== 0n) {
      const onlyMention = elevated === P.MentionEveryone;
      f(onlyMention ? "medium" : "high", "EVERYONE_ELEVATED", `@everyone has elevated permissions: ${namesFromBits(elevated).join(", ")}`, "@everyone",
        "Grant moderation and management permissions only to staff roles.");
    }
  }
  for (const r of human) {
    if (has(r.permissions, P.Administrator)) {
      if (r.tier === "member") f("critical", "ADMIN_TO_MEMBERS", `Role "${r.name}" grants Administrator but is an ordinary member role`, r.name);
      else if (r.tier === "staff") {
        f("high", "ADMIN_TO_STAFF", `Role "${r.name}" grants Administrator (full administration, bypasses every channel restriction)`, r.name,
          "Grant the specific permissions this role needs instead, or mark it `tier: admin` if full control is intended.");
      }
    } else if (r.tier === "member") {
      const admin = r.permissions & ADMINISTRATIVE_PERMISSIONS;
      if (admin !== 0n) f("high", "MEMBER_ROLE_ADMINISTRATIVE", `Member role "${r.name}" has ${namesFromBits(admin).join(", ")}`, r.name);
      const mod = r.permissions & MODERATION_PERMISSIONS;
      if (mod !== 0n && model.source === "desired") f("medium", "MEMBER_ROLE_MODERATION", `Role "${r.name}" (tier member) has moderation permissions ${namesFromBits(mod).join(", ")}`, r.name, "Set `tier: staff` if this is a staff role.");
    }
  }

  // ---- hierarchy
  const tierRank: Record<RoleTier, number> = { admin: 3, staff: 2, member: 1, bot: 0 };
  const sorted = [...human].sort((a, b) => b.rank - a.rank);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const hi = sorted[i]!;
      const lo = sorted[j]!;
      if (tierRank[lo.tier] > tierRank[hi.tier]) {
        f("medium", "HIERARCHY_INVERTED", `"${hi.name}" (${hi.tier}) is above "${lo.name}" (${lo.tier}) in the role hierarchy`, hi.name,
          "Members of higher roles can manage lower roles; keep staff and admin roles at the top.");
      }
    }
  }
  if (!human.some((r) => has(r.permissions, P.Administrator) || (has(r.permissions, P.ManageGuild) && has(r.permissions, P.ManageRoles)))) {
    f("info", "NO_ADMIN_ROLE", "No role grants administrative access; only the server owner can manage the server", undefined);
  }

  // ---- channels
  const staffRoles = human.filter((r) => r.tier === "staff" || r.tier === "admin");
  const modRoles = human.filter((r) => r.tier !== "member" && (r.permissions & MODERATION_PERMISSIONS) !== 0n && !has(r.permissions, P.Administrator));
  for (const c of model.channels) {
    const label = c.kind === "category" ? `category ${c.name}` : `#${c.name}`;
    const everyone = effectiveFor(model, c, []);
    const staffLike = STAFF_NAME.test(c.name) || (c.parentName !== null && STAFF_NAME.test(c.parentName));

    if (c.declaredPrivate && has(everyone, P.ViewChannel)) {
      f("critical", "PRIVATE_EXPOSED", `${label} is marked private but ordinary members can view it`, label, "Deny ViewChannel for @everyone on this channel or its category.");
    } else if (!c.declaredPrivate && staffLike && has(everyone, P.ViewChannel)) {
      f("medium", "STAFF_CHANNEL_PUBLIC", `${label} looks like a staff channel but ordinary members can view it`, label, "If it should be private, set `private: true`.");
    }

    const isPrivate = !has(everyone, P.ViewChannel);
    if ((c.declaredPrivate || (isPrivate && staffLike)) && staffRoles.length > 0) {
      const anyStaff = staffRoles.some((r) => has(effectiveFor(model, c, [r.id]), P.ViewChannel));
      if (!anyStaff) f("high", "STAFF_LOCKED_OUT", `No staff role can view private ${label}`, label, "Add `visibleTo: [<staff role>]` or an explicit ViewChannel allow.");
    }
    if (MOD_NAME.test(c.name) && c.kind !== "category") {
      for (const r of modRoles) {
        if (!has(effectiveFor(model, c, [r.id]), P.ViewChannel)) {
          f("medium", "MODERATOR_LOCKED_OUT", `"${r.name}" has moderation permissions but cannot view ${label}`, label);
        }
      }
    }

    const announceLike = c.kind === "announcement" || ANNOUNCE_NAME.test(c.name);
    if (announceLike && c.kind !== "category" && !VOICE_LIKE_KINDS.has(c.kind) && has(everyone, P.ViewChannel) && has(everyone, P.SendMessages)) {
      f("high", "ANNOUNCEMENT_WRITABLE", `Ordinary members can post in ${label}`, label, "Deny SendMessages for @everyone and allow it only for staff roles.");
    }

    // Conflicting role overwrites: members holding both roles get the allow (allow wins).
    const roleOws = c.overwrites.filter((o) => o.type === "role" && o.id !== model.everyoneId);
    for (let i = 0; i < roleOws.length; i++) {
      for (let j = i + 1; j < roleOws.length; j++) {
        const a = roleOws[i]!;
        const b = roleOws[j]!;
        const conflict = (a.allow & b.deny) | (a.deny & b.allow);
        if (conflict !== 0n) {
          const an = roleByRef.get(a.id)?.name ?? a.id;
          const bn = roleByRef.get(b.id)?.name ?? b.id;
          f("low", "CONFLICTING_OVERWRITES", `${label}: "${an}" and "${bn}" set opposite values for ${namesFromBits(conflict).join(", ")}; members with both roles are allowed (allow wins)`, label);
        }
      }
    }

    // Explicit expectations from the config.
    if (c.expect) {
      const check = (list: string[] | undefined, perm: bigint, want: boolean, verb: string) => {
        for (const ref of list ?? []) {
          const roleIds = ref === "everyone" ? [] : [roleByRef.get(ref)?.id ?? `role:${ref}`];
          const got = has(effectiveFor(model, c, roleIds), perm);
          if (got !== want) {
            const who = ref === "everyone" ? "@everyone" : roleByRef.get(ref)?.name ?? ref;
            f("high", "EXPECTATION_FAILED", `${label}: expected ${who} ${want ? "to" : "not to"} ${verb}, but ${want ? "they cannot" : "they can"}`, label);
          }
        }
      };
      check(c.expect.view, P.ViewChannel, true, "view");
      check(c.expect.noView, P.ViewChannel, false, "view");
      check(c.expect.send, P.SendMessages, true, "send messages");
      check(c.expect.noSend, P.SendMessages, false, "send messages");
      check(c.expect.connect, P.Connect, true, "connect");
      check(c.expect.noConnect, P.Connect, false, "connect");
    }
  }
  return findings;
}

export function bySeverity(findings: Finding[]): Finding[] {
  const order: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
}
