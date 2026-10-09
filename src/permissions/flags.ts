import { PermissionFlagsBits } from "discord-api-types/v10";

/**
 * Discord permission bitfields. All values are BigInt: Discord permissions exceed 2^53.
 */
export type PermissionName = keyof typeof PermissionFlagsBits;

/** Deprecated names that alias another flag with the same bit. */
const DEPRECATED_NAMES = new Set<string>(["ManageEmojisAndStickers"]);

/** Canonical permission names (one per bit), in Discord's bit order. */
export const PERMISSION_NAMES: readonly PermissionName[] = (Object.keys(PermissionFlagsBits) as PermissionName[])
  .filter((n) => !DEPRECATED_NAMES.has(n))
  .sort((a, b) => (PermissionFlagsBits[a] < PermissionFlagsBits[b] ? -1 : 1));

export const ALL_PERMISSIONS: bigint = PERMISSION_NAMES.reduce((acc, n) => acc | PermissionFlagsBits[n], 0n);

export const P = PermissionFlagsBits;

/** Short, human-friendly aliases accepted in configuration files. */
export const PERMISSION_ALIASES: Readonly<Record<string, PermissionName>> = {
  view: "ViewChannel",
  read: "ViewChannel",
  send: "SendMessages",
  post: "SendMessages",
  createposts: "SendMessages",
  history: "ReadMessageHistory",
  readhistory: "ReadMessageHistory",
  react: "AddReactions",
  reactions: "AddReactions",
  embed: "EmbedLinks",
  embeds: "EmbedLinks",
  attach: "AttachFiles",
  files: "AttachFiles",
  mentioneveryone: "MentionEveryone",
  externalemojis: "UseExternalEmojis",
  externalstickers: "UseExternalStickers",
  managechannel: "ManageChannels",
  managepermissions: "ManageRoles",
  managemessages: "ManageMessages",
  managethreads: "ManageThreads",
  publicthreads: "CreatePublicThreads",
  privatethreads: "CreatePrivateThreads",
  sendinthreads: "SendMessagesInThreads",
  threadreplies: "SendMessagesInThreads",
  connect: "Connect",
  speak: "Speak",
  stream: "Stream",
  video: "Stream",
  vad: "UseVAD",
  voiceactivity: "UseVAD",
  mute: "MuteMembers",
  deafen: "DeafenMembers",
  move: "MoveMembers",
  slashcommands: "UseApplicationCommands",
  commands: "UseApplicationCommands",
  activities: "UseEmbeddedActivities",
  timeout: "ModerateMembers",
  tts: "SendTTSMessages",
  polls: "SendPolls",
  voicemessages: "SendVoiceMessages",
  soundboard: "UseSoundboard",
  invite: "CreateInstantInvite",
  admin: "Administrator",
  manageemojisandstickers: "ManageGuildExpressions",
  pin: "PinMessages",
};

const LOOKUP: Map<string, PermissionName> = (() => {
  const map = new Map<string, PermissionName>();
  for (const name of Object.keys(PermissionFlagsBits) as PermissionName[]) {
    const canonical = DEPRECATED_NAMES.has(name) ? PERMISSION_ALIASES[normalizeToken(name)]! : name;
    map.set(normalizeToken(name), canonical);
  }
  for (const [alias, name] of Object.entries(PERMISSION_ALIASES)) map.set(alias, name);
  return map;
})();

function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Resolve a permission name or alias (any case, snake/kebab/Pascal) to its canonical name. */
export function resolvePermissionName(input: string): PermissionName | undefined {
  return LOOKUP.get(normalizeToken(input));
}

export function permissionBit(name: PermissionName): bigint {
  return PermissionFlagsBits[name];
}

export function bitsFromNames(names: Iterable<string>): bigint {
  let bits = 0n;
  for (const n of names) {
    const resolved = resolvePermissionName(n);
    if (!resolved) throw new Error(`Unknown permission "${n}"`);
    bits |= PermissionFlagsBits[resolved];
  }
  return bits;
}

/** Canonical names for every bit set in `bits`. Unknown bits are rendered as `Bit(<n>)`. */
export function namesFromBits(bits: bigint): string[] {
  const out: string[] = [];
  let known = 0n;
  for (const name of PERMISSION_NAMES) {
    const bit = PermissionFlagsBits[name];
    known |= bit;
    if ((bits & bit) === bit) out.push(name);
  }
  let unknown = bits & ~known;
  let i = 0n;
  while (unknown > 0n) {
    if (unknown & 1n) out.push(`Bit(${i})`);
    unknown >>= 1n;
    i++;
  }
  return out;
}

export function has(bits: bigint, flag: bigint): boolean {
  return (bits & flag) === flag;
}

export function parseBits(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  return BigInt(value);
}

/** Permissions that grant administrative or moderation power. Granting them is high-risk. */
export const ELEVATED_PERMISSIONS: bigint =
  P.Administrator |
  P.ManageGuild |
  P.ManageRoles |
  P.ManageChannels |
  P.ManageWebhooks |
  P.BanMembers |
  P.KickMembers |
  P.ModerateMembers |
  P.ManageMessages |
  P.ManageNicknames |
  P.ManageGuildExpressions |
  P.ManageEvents |
  P.ManageThreads |
  P.MentionEveryone |
  P.ViewAuditLog |
  P.MuteMembers |
  P.DeafenMembers |
  P.MoveMembers;

/** Permissions that give control over the server itself (privilege escalation paths). */
export const ADMINISTRATIVE_PERMISSIONS: bigint = P.Administrator | P.ManageGuild | P.ManageRoles | P.ManageWebhooks;

export const MODERATION_PERMISSIONS: bigint = P.KickMembers | P.BanMembers | P.ModerateMembers | P.ManageMessages;

/** Permissions that are meaningless (and rejected) in channel overwrites. */
export const GUILD_ONLY_PERMISSIONS: bigint =
  P.Administrator |
  P.KickMembers |
  P.BanMembers |
  P.ManageGuild |
  P.ViewAuditLog |
  P.ViewGuildInsights |
  P.ChangeNickname |
  P.ManageNicknames |
  P.ManageGuildExpressions |
  P.ModerateMembers |
  P.ViewCreatorMonetizationAnalytics |
  P.CreateGuildExpressions;

/** Safe default @everyone permissions for a public community server. */
export const SAFE_EVERYONE_DEFAULTS: bigint =
  P.ViewChannel |
  P.CreateInstantInvite |
  P.ChangeNickname |
  P.SendMessages |
  P.SendMessagesInThreads |
  P.CreatePublicThreads |
  P.EmbedLinks |
  P.AttachFiles |
  P.AddReactions |
  P.UseExternalEmojis |
  P.UseExternalStickers |
  P.ReadMessageHistory |
  P.UseApplicationCommands |
  P.Connect |
  P.Speak |
  P.Stream |
  P.UseVAD |
  P.UseEmbeddedActivities |
  P.UseSoundboard |
  P.SendVoiceMessages |
  P.SendPolls;
