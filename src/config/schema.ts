import { z } from "zod";

/**
 * discordctl configuration schema, version 1.
 * Documented in docs/configuration.md. All objects are strict so typos are reported
 * instead of silently ignored.
 */

const snowflake = z.string().regex(/^\d{17,20}$/, "must be a Discord ID (17-20 digits)");
const key = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "keys must be lowercase letters, digits, '-' or '_' (max 64 chars)");

export const PermissionValueSchema = z.union([
  z.enum(["allow", "deny", "inherit"]),
  z.boolean(),
  z.null(),
]);

/** `{ <target>: { <permission>: allow|deny|inherit } }` */
export const OverwriteMapSchema = z.record(z.string(), z.record(z.string(), PermissionValueSchema));

const duration = z.union([z.number().int().min(0), z.string()]);

const colorSchema = z.union([
  z.number().int().min(0).max(0xffffff),
  z.string().regex(/^#?[0-9a-fA-F]{6}$/, "colors must be #RRGGBB"),
]);

export const ForumTagSchema = z.strictObject({
  name: z.string().min(1).max(20),
  emoji: z.string().min(1).optional(),
  moderated: z.boolean().default(false),
});

const archiveDuration = z.union([
  z.literal(60),
  z.literal(1440),
  z.literal(4320),
  z.literal(10080),
  z.enum(["1h", "24h", "1d", "3d", "1w", "7d"]),
]);

export const ExpectationSchema = z.strictObject({
  view: z.array(z.string()).optional(),
  noView: z.array(z.string()).optional(),
  send: z.array(z.string()).optional(),
  noSend: z.array(z.string()).optional(),
  connect: z.array(z.string()).optional(),
  noConnect: z.array(z.string()).optional(),
});

export const CHANNEL_TYPES = ["text", "announcement", "forum", "media", "voice", "stage"] as const;

/** Fields shared by channels, categories and presets. */
const channelFields = {
  topic: z.string().max(4096).nullable().optional(),
  guidelines: z.string().max(4096).optional(),
  nsfw: z.boolean().optional(),
  slowmode: duration.optional(),
  permissions: OverwriteMapSchema.optional(),
  inheritPermissions: z.boolean().optional(),
  overwritePolicy: z.enum(["merge", "authoritative"]).optional(),
  private: z.boolean().optional(),
  visibleTo: z.array(z.string()).optional(),
  // forum / media
  tags: z.array(ForumTagSchema).max(20).optional(),
  tagPolicy: z.enum(["merge", "authoritative"]).optional(),
  defaultReaction: z.string().nullable().optional(),
  sortOrder: z.enum(["latest_activity", "creation_date"]).nullable().optional(),
  layout: z.enum(["default", "list", "gallery"]).optional(),
  requireTag: z.boolean().optional(),
  defaultThreadSlowmode: duration.optional(),
  defaultAutoArchive: archiveDuration.optional(),
  postTemplate: z.string().max(4000).optional(),
  // voice / stage
  bitrate: z.number().int().min(8000).max(384000).optional(),
  userLimit: z.number().int().min(0).max(10000).optional(),
  rtcRegion: z.string().nullable().optional(),
  videoQuality: z.enum(["auto", "full"]).optional(),
  // audit
  expect: ExpectationSchema.optional(),
};

export const PresetSchema = z.strictObject({
  type: z.enum(CHANNEL_TYPES).optional(),
  fallbackType: z.enum(CHANNEL_TYPES).optional(),
  ...channelFields,
});

const presetRef = z.union([z.string(), z.array(z.string())]);

export const ChannelSchema = z.strictObject({
  key,
  name: z.string().min(1).max(100),
  id: snowflake.optional(),
  type: z.enum(CHANNEL_TYPES).optional(),
  fallbackType: z.enum(CHANNEL_TYPES).optional(),
  preset: presetRef.optional(),
  ...channelFields,
});

export const CategorySchema = z.strictObject({
  key,
  name: z.string().min(1).max(100),
  id: snowflake.optional(),
  preset: presetRef.optional(),
  permissions: OverwriteMapSchema.optional(),
  overwritePolicy: z.enum(["merge", "authoritative"]).optional(),
  private: z.boolean().optional(),
  visibleTo: z.array(z.string()).optional(),
  expect: ExpectationSchema.optional(),
  channels: z.array(ChannelSchema).max(50).default([]),
});

export const RoleSchema = z.strictObject({
  key,
  name: z.string().min(1).max(100),
  id: snowflake.optional(),
  color: colorSchema.optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
  permissions: z.array(z.string()).optional(),
  tier: z.enum(["admin", "staff", "member", "bot"]).optional(),
  description: z.string().optional(),
});

export const GuildSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(120).nullable().optional(),
  verificationLevel: z.enum(["none", "low", "medium", "high", "very_high"]).optional(),
  defaultNotifications: z.enum(["all_messages", "only_mentions"]).optional(),
  explicitContentFilter: z.enum(["disabled", "members_without_roles", "all_members"]).optional(),
  afkTimeout: z.union([z.literal(60), z.literal(300), z.literal(900), z.literal(1800), z.literal(3600)]).optional(),
  afkChannel: z.string().nullable().optional(),
  systemChannel: z.string().nullable().optional(),
  rulesChannel: z.string().nullable().optional(),
  publicUpdatesChannel: z.string().nullable().optional(),
});

export const OnboardingSchema = z.strictObject({
  /** Apply onboarding through the API. When false (default) it is only printed as manual steps. */
  manage: z.boolean().default(false),
  /** Omit to keep the server's current setting. */
  enabled: z.boolean().optional(),
  mode: z.enum(["default", "advanced"]).optional(),
  defaultChannels: z.array(z.string()).default([]),
  prompts: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(100),
        type: z.enum(["multiple_choice", "dropdown"]).default("multiple_choice"),
        singleSelect: z.boolean().default(false),
        required: z.boolean().default(false),
        inOnboarding: z.boolean().default(true),
        options: z
          .array(
            z.strictObject({
              title: z.string().min(1).max(50),
              description: z.string().max(100).optional(),
              emoji: z.string().optional(),
              roles: z.array(z.string()).default([]),
              channels: z.array(z.string()).default([]),
            }),
          )
          .min(1)
          .max(50),
      }),
    )
    .max(15)
    .default([]),
});

export const OptionsSchema = z.strictObject({
  manageRoleOrder: z.boolean().default(true),
  manageChannelOrder: z.boolean().default(true),
  overwritePolicy: z.enum(["merge", "authoritative"]).default("merge"),
});

export const ConfigSchema = z.strictObject({
  version: z.literal(1),
  metadata: z
    .strictObject({
      name: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
  imports: z.array(z.string()).default([]),
  guild: GuildSchema,
  options: OptionsSchema.default({ manageRoleOrder: true, manageChannelOrder: true, overwritePolicy: "merge" }),
  everyone: z.strictObject({ permissions: z.array(z.string()).optional() }).optional(),
  roles: z.array(RoleSchema).max(250).default([]),
  presets: z.record(key, PresetSchema).default({}),
  categories: z.array(CategorySchema).max(50).default([]),
  channels: z.array(ChannelSchema).default([]),
  onboarding: OnboardingSchema.optional(),
});

/** A preset library file referenced through `imports`. */
export const PresetLibrarySchema = z.strictObject({
  version: z.literal(1),
  metadata: z.strictObject({ name: z.string().optional(), description: z.string().optional() }).optional(),
  presets: z.record(key, PresetSchema),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ChannelConfig = z.infer<typeof ChannelSchema>;
export type CategoryConfig = z.infer<typeof CategorySchema>;
export type PresetConfig = z.infer<typeof PresetSchema>;
export type RoleConfig = z.infer<typeof RoleSchema>;
export type OverwriteMap = z.infer<typeof OverwriteMapSchema>;

/** JSON Schema for editors and AI agents. */
export function configJsonSchema(): unknown {
  return z.toJSONSchema(ConfigSchema, { io: "input", unrepresentable: "any" });
}
