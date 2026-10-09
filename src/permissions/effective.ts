import { ALL_PERMISSIONS, P, has } from "./flags.js";

/**
 * Effective permission computation following Discord's documented algorithm:
 * https://discord.com/developers/docs/topics/permissions#permission-overwrites
 *
 * Works on any id space (real snowflakes or synthetic logical ids), so it can simulate both
 * live guild state and desired configuration.
 */

export interface SimRole {
  id: string;
  name: string;
  permissions: bigint;
}

export interface SimOverwrite {
  id: string;
  type: "role" | "member";
  allow: bigint;
  deny: bigint;
}

export interface SimMember {
  id?: string;
  roleIds: string[];
  isOwner?: boolean;
}

export function computeBasePermissions(member: SimMember, everyone: SimRole, roles: Map<string, SimRole>): bigint {
  if (member.isOwner) return ALL_PERMISSIONS;
  let perms = everyone.permissions;
  for (const roleId of member.roleIds) {
    const role = roles.get(roleId);
    if (role) perms |= role.permissions;
  }
  if (has(perms, P.Administrator)) return ALL_PERMISSIONS;
  return perms;
}

export function applyOverwrites(base: bigint, member: SimMember, everyoneId: string, overwrites: SimOverwrite[]): bigint {
  if (has(base, P.Administrator)) return ALL_PERMISSIONS;
  let perms = base;

  const everyoneOw = overwrites.find((o) => o.type === "role" && o.id === everyoneId);
  if (everyoneOw) {
    perms &= ~everyoneOw.deny;
    perms |= everyoneOw.allow;
  }

  let allow = 0n;
  let deny = 0n;
  const roleSet = new Set(member.roleIds);
  for (const ow of overwrites) {
    if (ow.type === "role" && ow.id !== everyoneId && roleSet.has(ow.id)) {
      allow |= ow.allow;
      deny |= ow.deny;
    }
  }
  perms &= ~deny;
  perms |= allow;

  if (member.id) {
    const memberOw = overwrites.find((o) => o.type === "member" && o.id === member.id);
    if (memberOw) {
      perms &= ~memberOw.deny;
      perms |= memberOw.allow;
    }
  }
  return perms;
}

/**
 * Apply Discord's implicit permission rules: without ViewChannel nothing else applies,
 * and without SendMessages the dependent text permissions are lost.
 */
export function applyImplicit(perms: bigint, channelKind: "text" | "voice" | "category" | "other" = "text"): bigint {
  if (has(perms, P.Administrator)) return perms;
  if (!has(perms, P.ViewChannel)) return 0n;
  let out = perms;
  if (channelKind === "text" && !has(out, P.SendMessages)) {
    out &= ~(P.MentionEveryone | P.SendTTSMessages | P.AttachFiles | P.EmbedLinks);
  }
  if (channelKind === "voice" && !has(out, P.Connect)) {
    out &= ~(P.Speak | P.Stream | P.UseVAD | P.MuteMembers | P.DeafenMembers | P.MoveMembers | P.PrioritySpeaker);
  }
  return out;
}

export function computeChannelPermissions(input: {
  member: SimMember;
  everyone: SimRole;
  roles: Map<string, SimRole>;
  overwrites: SimOverwrite[];
  channelKind?: "text" | "voice" | "category" | "other";
}): bigint {
  const base = computeBasePermissions(input.member, input.everyone, input.roles);
  const withOverwrites = applyOverwrites(base, input.member, input.everyone.id, input.overwrites);
  return applyImplicit(withOverwrites, input.channelKind ?? "text");
}
