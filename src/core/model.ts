/**
 * Normalized domain model. Discord API objects are mapped into these types by the provider,
 * and YAML configuration is resolved into the `Desired*` types by the configuration engine.
 * The planner only ever compares these two shapes.
 */

export type Snowflake = string;

export type ChannelKind = "category" | "text" | "announcement" | "forum" | "media" | "voice" | "stage";

export const TEXT_LIKE_KINDS: ReadonlySet<ChannelKind> = new Set(["text", "announcement", "forum", "media"]);
export const VOICE_LIKE_KINDS: ReadonlySet<ChannelKind> = new Set(["voice", "stage"]);
export const THREAD_CONTAINER_KINDS: ReadonlySet<ChannelKind> = new Set(["forum", "media"]);

/** Sorting class used by the Discord client inside a category: text-like before voice-like. */
export function channelSortClass(kind: ChannelKind): "category" | "text" | "voice" {
  if (kind === "category") return "category";
  return VOICE_LIKE_KINDS.has(kind) ? "voice" : "text";
}

export interface Overwrite {
  id: Snowflake;
  type: "role" | "member";
  allow: bigint;
  deny: bigint;
}

export interface ForumTag {
  id?: Snowflake;
  name: string;
  moderated: boolean;
  emojiId: Snowflake | null;
  emojiName: string | null;
}

export interface ActualRole {
  id: Snowflake;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: bigint;
  position: number;
  /** Managed by an integration (bot role, booster role, ...). Never modified by discordctl. */
  managed: boolean;
  isEveryone: boolean;
  botId?: Snowflake;
}

export interface ActualChannel {
  id: Snowflake;
  kind: ChannelKind | "unsupported";
  rawType: number;
  name: string;
  parentId: Snowflake | null;
  position: number;
  topic: string | null;
  nsfw: boolean;
  slowmode: number;
  overwrites: Overwrite[];
  bitrate?: number;
  userLimit?: number;
  rtcRegion?: string | null;
  videoQualityMode?: number;
  tags?: ForumTag[];
  defaultReactionEmoji?: { emojiId: Snowflake | null; emojiName: string | null } | null;
  defaultSortOrder?: number | null;
  defaultForumLayout?: number;
  defaultThreadSlowmode?: number;
  defaultAutoArchiveDuration?: number;
  flags: number;
}

export interface ActualGuild {
  id: Snowflake;
  name: string;
  ownerId: Snowflake;
  features: string[];
  description: string | null;
  verificationLevel: number;
  defaultMessageNotifications: number;
  explicitContentFilter: number;
  afkTimeout: number;
  afkChannelId: Snowflake | null;
  systemChannelId: Snowflake | null;
  rulesChannelId: Snowflake | null;
  publicUpdatesChannelId: Snowflake | null;
  premiumTier: number;
}

export interface BotIdentity {
  userId: Snowflake;
  username: string;
  roleIds: Snowflake[];
  /** Position of the bot's highest role. Roles at or above it cannot be managed. */
  highestRolePosition: number;
  /** Guild-level permissions of the bot (Administrator expands to all). */
  permissions: bigint;
  isOwner: boolean;
}

export interface GuildSnapshot {
  guild: ActualGuild;
  roles: ActualRole[];
  channels: ActualChannel[];
  bot: BotIdentity;
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// Desired state

export type RoleTier = "admin" | "staff" | "member" | "bot";

/** Reference to an overwrite target. Logical references are resolved to IDs at plan/apply time. */
export type TargetRef =
  | { kind: "everyone" }
  | { kind: "role"; key: string }
  | { kind: "roleId"; id: Snowflake }
  | { kind: "member"; id: Snowflake };

export interface DesiredOverwrite {
  target: TargetRef;
  allow: bigint;
  deny: bigint;
}

export interface DesiredRole {
  key: string;
  name: string;
  id?: Snowflake;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  /** Undefined means the role's permissions are not managed. */
  permissions?: bigint;
  tier: RoleTier;
  /** Index in the configured hierarchy, 0 = highest. */
  order: number;
}

export interface DesiredForumSettings {
  tags?: Array<{ name: string; moderated: boolean; emojiId: Snowflake | null; emojiName: string | null }>;
  tagPolicy: "merge" | "authoritative";
  defaultReaction?: { emojiId: Snowflake | null; emojiName: string | null } | null;
  sortOrder?: number | null;
  layout?: number;
  requireTag?: boolean;
  defaultThreadSlowmode?: number;
  defaultAutoArchiveDuration?: number;
}

export interface DesiredVoiceSettings {
  bitrate?: number;
  userLimit?: number;
  rtcRegion?: string | null;
  videoQualityMode?: number;
}

export interface PermissionExpectations {
  view?: string[];
  noView?: string[];
  send?: string[];
  noSend?: string[];
  connect?: string[];
  noConnect?: string[];
}

export interface DesiredChannel {
  key: string;
  name: string;
  kind: ChannelKind;
  /** Kind to use when the guild lacks the feature required by `kind` (e.g. COMMUNITY). */
  fallbackKind?: ChannelKind;
  id?: Snowflake;
  parentKey: string | null;
  /** Index among siblings in the configuration. */
  order: number;
  topic?: string | null;
  nsfw?: boolean;
  slowmode?: number;
  /** Fully resolved overwrites (category merge applied). Undefined = overwrites unmanaged. */
  overwrites?: DesiredOverwrite[];
  overwritePolicy: "merge" | "authoritative";
  private: boolean;
  forum?: DesiredForumSettings;
  voice?: DesiredVoiceSettings;
  expect?: PermissionExpectations;
  /** Advisory text (e.g. suggested post template) surfaced as a manual step. */
  postTemplate?: string;
}

export interface DesiredGuildSettings {
  name?: string;
  description?: string | null;
  verificationLevel?: number;
  defaultMessageNotifications?: number;
  explicitContentFilter?: number;
  afkTimeout?: number;
  afkChannel?: string | null;
  systemChannel?: string | null;
  rulesChannel?: string | null;
  publicUpdatesChannel?: string | null;
}

export interface ManualStep {
  title: string;
  reason: string;
  /** Ordered instructions. Continuation lines (indented details) may be embedded with "\n". */
  steps: string[];
  /** Text to copy and paste verbatim (e.g. a post template). */
  snippet?: string;
}

export interface DesiredOptions {
  manageRoleOrder: boolean;
  manageChannelOrder: boolean;
}

export interface DesiredState {
  guildId: Snowflake;
  settings: DesiredGuildSettings;
  everyone: { permissions?: bigint };
  roles: DesiredRole[];
  /** Categories in configured order. */
  categories: DesiredChannel[];
  /** Non-category channels in configured order (parentKey links to a category key). */
  channels: DesiredChannel[];
  options: DesiredOptions;
  manualSteps: ManualStep[];
}

export function allDesiredChannels(state: DesiredState): DesiredChannel[] {
  return [...state.categories, ...state.channels];
}
