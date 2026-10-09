import type { GuildSnapshot } from "../core/model.js";
import { hashValue } from "../util/hash.js";

/**
 * Hash of every part of the live guild state that a plan depends on. Volatile fields
 * (message ids, member counts, fetch time) are excluded, so the fingerprint only changes when
 * the server's structure, permissions or the bot's capabilities change.
 */
export function fingerprintSnapshot(s: GuildSnapshot): string {
  return hashValue({
    guild: { ...s.guild, features: [...s.guild.features].sort() },
    roles: [...s.roles].sort((a, b) => a.id.localeCompare(b.id)),
    channels: [...s.channels]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => ({ ...c, overwrites: [...c.overwrites].sort((a, b) => a.id.localeCompare(b.id)) })),
    bot: { permissions: s.bot.permissions, highest: s.bot.highestRolePosition, roles: [...s.bot.roleIds].sort() },
  });
}
