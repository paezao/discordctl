import type { DesiredState } from "../core/model.js";
import { P, has, namesFromBits } from "./flags.js";

/**
 * The minimal guild-level permissions the bot needs to apply a configuration. Discord only lets
 * a bot grant (or set in overwrites) permissions it holds itself, so every permission that
 * appears in the config is required too.
 */
export function requiredBotPermissions(desired?: DesiredState): bigint {
  let bits = P.ViewChannel | P.ManageRoles | P.ManageChannels;
  if (!desired) return bits;
  if (Object.keys(desired.settings).length > 0) bits |= P.ManageGuild;
  if (desired.everyone.permissions !== undefined) bits |= desired.everyone.permissions;
  for (const r of desired.roles) bits |= r.permissions ?? 0n;
  for (const c of [...desired.categories, ...desired.channels]) for (const o of c.overwrites ?? []) bits |= o.allow | o.deny;
  // Holding Administrator would satisfy everything; only request it when the config grants it.
  return bits;
}

export function inviteUrl(applicationId: string, permissions: bigint, guildId?: string): string {
  const params = new URLSearchParams({ client_id: applicationId, scope: "bot", permissions: permissions.toString() });
  if (guildId) {
    params.set("guild_id", guildId);
    params.set("disable_guild_select", "true");
  }
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export function describeRequirement(bits: bigint): string[] {
  const names = namesFromBits(bits);
  return has(bits, P.Administrator) ? ["Administrator (the config grants Administrator to a role)", ...names.filter((n) => n !== "Administrator")] : names;
}
