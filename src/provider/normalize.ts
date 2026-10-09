import { ChannelType, type APIChannel, type APIGuild, type APIRole, type APIOverwrite } from "discord-api-types/v10";
import type { ActualChannel, ActualGuild, ActualRole, BotIdentity, ChannelKind, GuildSnapshot, Overwrite } from "../core/model.js";
import type { DiscordApi } from "./api.js";
import { ALL_PERMISSIONS, P, has, parseBits } from "../permissions/flags.js";

const KIND_BY_TYPE: Partial<Record<number, ChannelKind>> = {
  [ChannelType.GuildCategory]: "category",
  [ChannelType.GuildText]: "text",
  [ChannelType.GuildAnnouncement]: "announcement",
  [ChannelType.GuildForum]: "forum",
  [ChannelType.GuildMedia]: "media",
  [ChannelType.GuildVoice]: "voice",
  [ChannelType.GuildStageVoice]: "stage",
};

export const TYPE_BY_KIND: Record<ChannelKind, number> = {
  category: ChannelType.GuildCategory,
  text: ChannelType.GuildText,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  media: ChannelType.GuildMedia,
  voice: ChannelType.GuildVoice,
  stage: ChannelType.GuildStageVoice,
};

export function normalizeRole(r: APIRole, guildId: string): ActualRole {
  const role: ActualRole = {
    id: r.id,
    name: r.name,
    color: r.color,
    hoist: r.hoist,
    mentionable: r.mentionable,
    permissions: parseBits(r.permissions),
    position: r.position,
    managed: r.managed,
    isEveryone: r.id === guildId,
  };
  if (r.tags?.bot_id) role.botId = r.tags.bot_id;
  return role;
}

function normalizeOverwrite(o: APIOverwrite): Overwrite {
  return { id: o.id, type: o.type === 0 ? "role" : "member", allow: parseBits(o.allow), deny: parseBits(o.deny) };
}

export function normalizeChannel(c: APIChannel): ActualChannel {
  const any = c as unknown as Record<string, unknown>;
  const kind = KIND_BY_TYPE[c.type] ?? "unsupported";
  const ch: ActualChannel = {
    id: c.id,
    kind,
    rawType: c.type,
    name: (any.name as string | undefined) ?? "",
    parentId: (any.parent_id as string | null | undefined) ?? null,
    position: (any.position as number | undefined) ?? 0,
    topic: (any.topic as string | null | undefined) ?? null,
    nsfw: Boolean(any.nsfw),
    slowmode: (any.rate_limit_per_user as number | undefined) ?? 0,
    overwrites: ((any.permission_overwrites as APIOverwrite[] | undefined) ?? []).map(normalizeOverwrite),
    flags: (any.flags as number | undefined) ?? 0,
  };
  if (kind === "voice" || kind === "stage") {
    ch.bitrate = any.bitrate as number;
    ch.userLimit = (any.user_limit as number | undefined) ?? 0;
    ch.rtcRegion = (any.rtc_region as string | null | undefined) ?? null;
    ch.videoQualityMode = (any.video_quality_mode as number | undefined) ?? 1;
  }
  if (kind === "forum" || kind === "media") {
    const tags = (any.available_tags as Array<Record<string, unknown>> | undefined) ?? [];
    ch.tags = tags.map((t) => ({
      id: t.id as string,
      name: t.name as string,
      moderated: Boolean(t.moderated),
      emojiId: (t.emoji_id as string | null) ?? null,
      emojiName: (t.emoji_name as string | null) ?? null,
    }));
    const dr = any.default_reaction_emoji as { emoji_id: string | null; emoji_name: string | null } | null | undefined;
    ch.defaultReactionEmoji = dr ? { emojiId: dr.emoji_id ?? null, emojiName: dr.emoji_name ?? null } : null;
    ch.defaultSortOrder = (any.default_sort_order as number | null | undefined) ?? null;
    ch.defaultForumLayout = (any.default_forum_layout as number | undefined) ?? 0;
  }
  if (kind === "forum" || kind === "media" || kind === "text" || kind === "announcement") {
    ch.defaultThreadSlowmode = (any.default_thread_rate_limit_per_user as number | undefined) ?? 0;
    ch.defaultAutoArchiveDuration = (any.default_auto_archive_duration as number | undefined) ?? 4320;
  }
  return ch;
}

export function normalizeGuild(g: APIGuild): ActualGuild {
  return {
    id: g.id,
    name: g.name,
    ownerId: g.owner_id,
    features: [...g.features].map(String),
    description: g.description ?? null,
    verificationLevel: g.verification_level,
    defaultMessageNotifications: g.default_message_notifications,
    explicitContentFilter: g.explicit_content_filter,
    afkTimeout: g.afk_timeout,
    afkChannelId: g.afk_channel_id,
    systemChannelId: g.system_channel_id,
    rulesChannelId: g.rules_channel_id,
    publicUpdatesChannelId: g.public_updates_channel_id,
    premiumTier: g.premium_tier,
  };
}

/** Fetch and normalize everything discordctl needs to reason about a guild. */
export async function fetchSnapshot(api: DiscordApi, guildId: string): Promise<GuildSnapshot> {
  const me = await api.getCurrentUser();
  const [guildRaw, rolesRaw, channelsRaw, member] = await Promise.all([
    api.getGuild(guildId),
    api.getGuildRoles(guildId),
    api.getGuildChannels(guildId),
    api.getGuildMember(guildId, me.id),
  ]);
  const guild = normalizeGuild(guildRaw);
  const roles = rolesRaw.map((r) => normalizeRole(r, guildId)).sort((a, b) => b.position - a.position || a.id.localeCompare(b.id));
  const channels = channelsRaw.map(normalizeChannel);
  const bot = computeBotIdentity(me.id, me.username, member.roles, roles, guild.ownerId === me.id, guildId);
  return { guild, roles, channels, bot, fetchedAt: new Date().toISOString() };
}

export function computeBotIdentity(userId: string, username: string, roleIds: string[], roles: ActualRole[], isOwner: boolean, guildId: string): BotIdentity {
  const byId = new Map(roles.map((r) => [r.id, r]));
  let perms = byId.get(guildId)?.permissions ?? 0n;
  let highest = 0;
  for (const id of roleIds) {
    const r = byId.get(id);
    if (!r) continue;
    perms |= r.permissions;
    highest = Math.max(highest, r.position);
  }
  if (isOwner || has(perms, P.Administrator)) perms = ALL_PERMISSIONS;
  return { userId, username, roleIds: [...roleIds], highestRolePosition: highest, permissions: perms, isOwner };
}
