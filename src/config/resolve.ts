import type {
  ChannelKind,
  DesiredChannel,
  DesiredForumSettings,
  DesiredOverwrite,
  DesiredRole,
  DesiredState,
  DesiredVoiceSettings,
  ManualStep,
  RoleTier,
  TargetRef,
} from "../core/model.js";
import { THREAD_CONTAINER_KINDS, VOICE_LIKE_KINDS } from "../core/model.js";
import type { Diagnostic } from "../core/diagnostics.js";
import type { CategoryConfig, ChannelConfig, Config, OverwriteMap, PresetConfig } from "./schema.js";
import type { LoadedConfig } from "./load.js";
import {
  ADMINISTRATIVE_PERMISSIONS,
  GUILD_ONLY_PERMISSIONS,
  MODERATION_PERMISSIONS,
  P,
  namesFromBits,
  permissionBit,
  resolvePermissionName,
} from "../permissions/flags.js";
import { normalizeTextChannelName, parseDuration } from "../util/names.js";

export interface ResolveResult {
  desired: DesiredState;
  diagnostics: Diagnostic[];
}

export interface ResolveOptions {
  /** Overrides `guild.id` (e.g. from `--guild`). Must match the config if the config sets one. */
  guildId?: string;
}

type PermState = "allow" | "deny" | "inherit";
/** target string -> permission name -> state */
type OverwriteDraft = Map<string, Map<string, PermState>>;

const MAX_SLOWMODE = 21600;
const SNOWFLAKE = /^\d{17,20}$/;

export function resolveConfig(loaded: LoadedConfig, options: ResolveOptions = {}): ResolveResult {
  const { config, presets } = loaded;
  const diags: Diagnostic[] = [...loaded.diagnostics];
  const err = (code: string, message: string, path?: string, hint?: string) =>
    diags.push({ severity: "error", code, message, ...(path ? { path } : {}), ...(hint ? { hint } : {}) });
  const warn = (code: string, message: string, path?: string, hint?: string) =>
    diags.push({ severity: "warning", code, message, ...(path ? { path } : {}), ...(hint ? { hint } : {}) });
  const info = (code: string, message: string, path?: string) =>
    diags.push({ severity: "info", code, message, ...(path ? { path } : {}) });

  // ---- guild id
  let guildId = config.guild.id;
  if (options.guildId) {
    if (SNOWFLAKE.test(guildId) && guildId !== options.guildId) {
      err("GUILD_MISMATCH", `--guild ${options.guildId} does not match guild.id ${guildId} in the config`, "guild.id",
        "Each config file targets exactly one guild. Use a separate config per server.");
    }
    guildId = options.guildId;
  }
  if (!SNOWFLAKE.test(guildId)) {
    err("GUILD_ID_INVALID", `guild.id must be a Discord guild ID, got "${guildId}"`, "guild.id", "Set DISCORD_GUILD_ID or pass --guild.");
  }

  // ---- roles
  const roleKeys = new Set<string>();
  const roleNames = new Map<string, string>();
  const roles: DesiredRole[] = [];
  config.roles.forEach((r, i) => {
    const path = `roles[${i}]`;
    if (r.key === "everyone") err("RESERVED_KEY", `Role key "everyone" is reserved; use the top-level "everyone:" block`, path);
    if (roleKeys.has(r.key)) err("DUPLICATE_KEY", `Duplicate role key "${r.key}"`, path);
    roleKeys.add(r.key);
    const lower = r.name.toLowerCase();
    if (lower === "@everyone" || lower === "@here") err("RESERVED_NAME", `Role name "${r.name}" is reserved by Discord`, path);
    if (roleNames.has(lower)) {
      warn("DUPLICATE_NAME", `Roles "${roleNames.get(lower)}" and "${r.key}" share the name "${r.name}"; name-based import will be ambiguous`, path);
    }
    roleNames.set(lower, r.key);
    const permissions = r.permissions ? parsePermissionList(r.permissions, `${path}.permissions`, err) : undefined;
    const role: DesiredRole = {
      key: r.key,
      name: r.name,
      tier: (r.tier as RoleTier | undefined) ?? inferTier(permissions ?? 0n),
      order: i,
    };
    if (r.id) role.id = r.id;
    if (r.color !== undefined) role.color = typeof r.color === "number" ? r.color : parseInt(r.color.replace("#", ""), 16);
    if (r.hoist !== undefined) role.hoist = r.hoist;
    if (r.mentionable !== undefined) role.mentionable = r.mentionable;
    if (permissions !== undefined) role.permissions = permissions;
    if (role.tier === "bot") {
      warn("BOT_TIER", `Role "${r.key}" has tier "bot". Integration-managed bot roles cannot be edited; only use this for roles you assign to bots manually.`, path);
    }
    roles.push(role);
  });

  const everyonePerms = config.everyone?.permissions ? parsePermissionList(config.everyone.permissions, "everyone.permissions", err) : undefined;

  // ---- channel keys (categories and channels share one namespace)
  const channelKeys = new Map<string, string>();
  const claimKey = (key: string, path: string) => {
    if (channelKeys.has(key)) err("DUPLICATE_KEY", `Duplicate channel key "${key}" (also used at ${channelKeys.get(key)})`, path);
    else channelKeys.set(key, path);
  };

  const resolveTarget = (target: string, path: string): TargetRef | undefined => {
    const t = target.trim();
    if (t === "everyone" || t === "@everyone") return { kind: "everyone" };
    const m = /^(role|roleId|id|member):(.+)$/.exec(t);
    if (m) {
      const [, prefix, value] = m as unknown as [string, string, string];
      if (prefix === "role") {
        if (!roleKeys.has(value)) err("UNKNOWN_ROLE", `Unknown role key "${value}"`, path);
        return { kind: "role", key: value };
      }
      if (!SNOWFLAKE.test(value)) {
        err("INVALID_ID", `"${t}" must reference a Discord ID`, path);
        return undefined;
      }
      return prefix === "member" ? { kind: "member", id: value } : { kind: "roleId", id: value };
    }
    if (roleKeys.has(t)) return { kind: "role", key: t };
    err("UNKNOWN_ROLE", `Unknown permission target "${t}"`, path, `Targets are "everyone", a role key, "roleId:<id>" or "member:<id>".`);
    return undefined;
  };

  const applyPreset = (names: string | string[] | undefined, own: ChannelConfig | CategoryConfig | PresetConfig, path: string): PresetConfig => {
    const list = names === undefined ? [] : Array.isArray(names) ? names : [names];
    let merged: PresetConfig = {};
    for (const name of list) {
      const preset = presets[name];
      if (!preset) {
        err("UNKNOWN_PRESET", `Unknown preset "${name}"`, `${path}.preset`);
        continue;
      }
      merged = mergeSpec(merged, preset);
    }
    const { key: _k, name: _n, id: _i, preset: _p, channels: _c, ...rest } = own as Record<string, unknown>;
    return mergeSpec(merged, rest as PresetConfig);
  };

  const buildDraft = (spec: PresetConfig, path: string, base?: OverwriteDraft): OverwriteDraft => {
    const draft: OverwriteDraft = base ? cloneDraft(base) : new Map();
    for (const [target, perms] of Object.entries(spec.permissions ?? {})) {
      const t = canonicalTarget(target);
      const entry = draft.get(t) ?? new Map<string, PermState>();
      for (const [perm, value] of Object.entries(perms)) {
        const name = resolvePermissionName(perm);
        if (!name) {
          err("UNKNOWN_PERMISSION", `Unknown permission "${perm}"`, `${path}.permissions.${target}`, "Run `discordctl permissions --list` for valid names.");
          continue;
        }
        if ((permissionBit(name) & GUILD_ONLY_PERMISSIONS) !== 0n) {
          err("GUILD_ONLY_PERMISSION", `"${name}" cannot be used in a channel overwrite; grant it on a role instead`, `${path}.permissions.${target}`);
          continue;
        }
        entry.set(name, value === true ? "allow" : value === false ? "deny" : value === null ? "inherit" : value);
      }
      draft.set(t, entry);
    }
    if (spec.private) {
      const ev = draft.get("everyone") ?? new Map<string, PermState>();
      if (!ev.has("ViewChannel")) ev.set("ViewChannel", "deny");
      draft.set("everyone", ev);
    }
    for (const target of spec.visibleTo ?? []) {
      const t = canonicalTarget(target);
      const entry = draft.get(t) ?? new Map<string, PermState>();
      if (!entry.has("ViewChannel")) entry.set("ViewChannel", "allow");
      draft.set(t, entry);
    }
    return draft;
  };

  const finalizeDraft = (draft: OverwriteDraft, path: string): DesiredOverwrite[] => {
    const out: DesiredOverwrite[] = [];
    for (const [target, perms] of draft) {
      const ref = resolveTarget(target, `${path}.permissions.${target}`);
      if (!ref) continue;
      let allow = 0n;
      let deny = 0n;
      for (const [perm, state] of perms) {
        const bit = permissionBit(perm as never);
        if (state === "allow") allow |= bit;
        else if (state === "deny") deny |= bit;
      }
      if (allow !== 0n || deny !== 0n) out.push({ target: ref, allow, deny });
    }
    return out;
  };

  // ---- categories and channels
  const categories: DesiredChannel[] = [];
  const channels: DesiredChannel[] = [];
  const manualSteps: ManualStep[] = [];
  const defaultPolicy = config.options.overwritePolicy;

  const buildChannel = (c: ChannelConfig, path: string, order: number, parent: { key: string; draft: OverwriteDraft; managed: boolean; private: boolean } | null) => {
    claimKey(c.key, path);
    const spec = applyPreset(c.preset, c, path);
    const kind: ChannelKind = c.type ?? spec.type ?? "text";
    const fallback = c.fallbackType ?? spec.fallbackType;
    const inherit = spec.inheritPermissions ?? true;
    const ownPermsDeclared = spec.permissions !== undefined || spec.private !== undefined || (spec.visibleTo?.length ?? 0) > 0;
    const draft = buildDraft(spec, path, inherit && parent ? parent.draft : undefined);
    const managed = ownPermsDeclared || (inherit && (parent?.managed ?? false));

    const ch: DesiredChannel = {
      key: c.key,
      name: c.name,
      kind,
      parentKey: parent?.key ?? null,
      order,
      overwritePolicy: spec.overwritePolicy ?? defaultPolicy,
      private: spec.private ?? parent?.private ?? false,
    };
    if (c.id) ch.id = c.id;
    if (managed) ch.overwrites = finalizeDraft(draft, path);
    if (fallback) {
      const allowed: Partial<Record<ChannelKind, ChannelKind[]>> = { announcement: ["text"], stage: ["voice"], forum: ["text"], media: ["forum", "text"] };
      if (!allowed[kind]?.includes(fallback)) err("INVALID_FALLBACK", `fallbackType "${fallback}" is not valid for type "${kind}"`, `${path}.fallbackType`);
      else ch.fallbackKind = fallback;
    }
    if (spec.expect) ch.expect = spec.expect;

    validateKindFields(kind, spec, path, err);

    // topic / guidelines
    if (spec.guidelines !== undefined && spec.topic !== undefined) err("TOPIC_CONFLICT", `Set either "topic" or "guidelines", not both`, path);
    const topic = spec.guidelines ?? spec.topic;
    if (topic !== undefined) {
      const max = THREAD_CONTAINER_KINDS.has(kind) ? 4096 : 1024;
      if (topic !== null && topic.length > max) err("TOPIC_TOO_LONG", `Topic is ${topic.length} characters; ${kind} channels allow ${max}`, `${path}.topic`);
      ch.topic = topic === "" ? null : topic;
    }
    if (spec.nsfw !== undefined) ch.nsfw = spec.nsfw;
    if (spec.slowmode !== undefined) {
      const s = safeDuration(spec.slowmode, `${path}.slowmode`, err);
      if (s !== undefined) {
        if (s > MAX_SLOWMODE) err("SLOWMODE_TOO_HIGH", `Slowmode ${s}s exceeds Discord's maximum of ${MAX_SLOWMODE}s (6h)`, `${path}.slowmode`);
        ch.slowmode = s;
      }
    }

    if (THREAD_CONTAINER_KINDS.has(kind)) ch.forum = buildForum(spec, kind, path, err);
    if (VOICE_LIKE_KINDS.has(kind)) ch.voice = buildVoice(spec, kind, path, err, warn);
    if (spec.postTemplate) {
      manualSteps.push({
        title: `Post template for #${c.name}`,
        reason: "Discord's API has no forum post template field, and discordctl never posts messages on your behalf.",
        steps: [
          `Open #${c.name} in Discord and click "New Post".`,
          `Title it "📌 Template: how to post here" and paste the template below as the message.`,
          ...(forumTagNames(spec).length ? [`Pick any tag (the forum requires one), then click "Post".`] : [`Click "Post".`]),
          `Right-click the new post → "Pin Post" so it stays at the top of the forum.`,
          `Optional: lock it (⋯ → "Lock Post") so replies don't bury the template.`,
        ],
        snippet: spec.postTemplate.trimEnd(),
      });
    }

    if (kind !== "voice" && kind !== "stage") {
      const normalized = normalizeTextChannelName(c.name);
      if (normalized !== c.name) {
        info("NAME_NORMALIZED", `Discord stores text channel names in lowercase without spaces: "${c.name}" becomes "${normalized}"`, `${path}.name`);
      }
    }
    return ch;
  };

  config.categories.forEach((cat, ci) => {
    const path = `categories[${ci}]`;
    claimKey(cat.key, path);
    const spec = applyPreset(cat.preset, cat, path);
    const draft = buildDraft(spec, path);
    const managed = spec.permissions !== undefined || spec.private !== undefined || (spec.visibleTo?.length ?? 0) > 0;
    const category: DesiredChannel = {
      key: cat.key,
      name: cat.name,
      kind: "category",
      parentKey: null,
      order: ci,
      overwritePolicy: spec.overwritePolicy ?? defaultPolicy,
      private: spec.private ?? false,
    };
    if (cat.id) category.id = cat.id;
    if (managed) category.overwrites = finalizeDraft(draft, path);
    if (spec.expect) category.expect = spec.expect;
    for (const field of ["topic", "guidelines", "slowmode", "nsfw", "tags", "bitrate", "userLimit"] as const) {
      if (spec[field] !== undefined) err("FIELD_NOT_SUPPORTED", `Categories do not support "${field}"`, `${path}.${field}`);
    }
    categories.push(category);
    cat.channels.forEach((c, i) => {
      channels.push(buildChannel(c, `${path}.channels[${i}]`, i, { key: cat.key, draft, managed, private: category.private }));
    });
  });
  config.channels.forEach((c, i) => channels.push(buildChannel(c, `channels[${i}]`, i, null)));

  if (categories.length + channels.length > 500) err("TOO_MANY_CHANNELS", "Discord guilds are limited to 500 channels (including categories)");

  // ---- expectations reference roles
  for (const ch of [...categories, ...channels]) {
    for (const list of Object.values(ch.expect ?? {})) {
      for (const target of list ?? []) {
        if (target !== "everyone" && !roleKeys.has(target)) err("UNKNOWN_ROLE", `expect references unknown role "${target}"`, `channel ${ch.key}`);
      }
    }
  }

  // ---- guild settings
  const g = config.guild;
  const settings: DesiredState["settings"] = {};
  if (g.name !== undefined) settings.name = g.name;
  if (g.description !== undefined) settings.description = g.description;
  if (g.verificationLevel) settings.verificationLevel = ["none", "low", "medium", "high", "very_high"].indexOf(g.verificationLevel);
  if (g.defaultNotifications) settings.defaultMessageNotifications = g.defaultNotifications === "all_messages" ? 0 : 1;
  if (g.explicitContentFilter) settings.explicitContentFilter = ["disabled", "members_without_roles", "all_members"].indexOf(g.explicitContentFilter);
  if (g.afkTimeout !== undefined) settings.afkTimeout = g.afkTimeout;
  const channelByKey = new Map([...categories, ...channels].map((c) => [c.key, c]));
  const settingsRef = (field: "afkChannel" | "systemChannel" | "rulesChannel" | "publicUpdatesChannel", kinds: ChannelKind[]) => {
    const v = g[field];
    if (v === undefined) return;
    if (v !== null) {
      const ch = channelByKey.get(v);
      if (!ch) err("UNKNOWN_CHANNEL", `guild.${field} references unknown channel key "${v}"`, `guild.${field}`);
      else if (!kinds.includes(ch.kind)) err("WRONG_CHANNEL_TYPE", `guild.${field} must be a ${kinds.join("/")} channel`, `guild.${field}`);
    }
    settings[field] = v;
  };
  settingsRef("afkChannel", ["voice"]);
  settingsRef("systemChannel", ["text"]);
  settingsRef("rulesChannel", ["text"]);
  settingsRef("publicUpdatesChannel", ["text"]);

  // ---- onboarding (advisory)
  if (config.onboarding) {
    const ob = config.onboarding;
    for (const k of ob.defaultChannels) if (!channelByKey.has(k)) err("UNKNOWN_CHANNEL", `onboarding.defaultChannels references unknown channel "${k}"`, "onboarding");
    for (const prompt of ob.prompts) {
      for (const opt of prompt.options) {
        for (const r of opt.roles) if (!roleKeys.has(r)) err("UNKNOWN_ROLE", `onboarding option "${opt.title}" references unknown role "${r}"`, "onboarding");
        for (const c of opt.channels) if (!channelByKey.has(c)) err("UNKNOWN_CHANNEL", `onboarding option "${opt.title}" references unknown channel "${c}"`, "onboarding");
      }
    }
    const nameOf = (k: string) => channelByKey.get(k)?.name ?? k;
    const roleName = (k: string) => roles.find((r) => r.key === k)?.name ?? k;
    manualSteps.push({
      title: "Server onboarding",
      reason: "Onboarding is applied manually in this version: it requires the Community feature and changes the new-member experience, so discordctl only documents the suggested setup.",
      steps: [
        "Open Server Settings → Onboarding. (If you don't see it, enable Community first: Server Settings → Enable Community.)",
        `Under "Default Channels", select:\n${ob.defaultChannels.map((k) => `  - #${nameOf(k)}`).join("\n") || "  (none)"}`,
        ...ob.prompts.map(
          (p) =>
            `Under "Questions", click "Add a Question" and enter "${p.title}". ` +
            `Turn "Allow multiple answers" ${p.singleSelect ? "off" : "on"}${p.required ? ` and "Required" on` : ""}. Add these answers:\n` +
            p.options
              .map((o) => {
                const extras = [o.roles.length ? `assign role(s): ${o.roles.map(roleName).join(", ")}` : "", o.channels.length ? `show channel(s): ${o.channels.map((k) => `#${nameOf(k)}`).join(", ")}` : ""].filter(Boolean);
                return `  - ${o.emoji ? o.emoji + " " : ""}${o.title}${extras.length ? ` (${extras.join("; ")})` : ""}`;
              })
              .join("\n"),
        ),
        `Click "Preview" to check the new-member flow, then ${ob.enabled ? 'click "Enable Onboarding"' : "save it without enabling (the config has enabled: false; flip it when you're happy)"}.`,
      ],
    });
  }

  const desired: DesiredState = {
    guildId,
    settings,
    everyone: everyonePerms !== undefined ? { permissions: everyonePerms } : {},
    roles,
    categories,
    channels,
    options: {
      manageRoleOrder: config.options.manageRoleOrder,
      manageChannelOrder: config.options.manageChannelOrder,
    },
    manualSteps,
  };
  return { desired, diagnostics: diags };
}

function forumTagNames(spec: PresetConfig): string[] {
  return spec.requireTag ? (spec.tags ?? []).map((t) => t.name) : [];
}

function canonicalTarget(target: string): string {
  const t = target.trim();
  return t === "@everyone" ? "everyone" : t.startsWith("role:") ? t.slice(5) : t;
}

function cloneDraft(d: OverwriteDraft): OverwriteDraft {
  return new Map([...d].map(([k, v]) => [k, new Map(v)]));
}

/** Merge two specs: scalars override, permissions merge per target and permission, arrays replace. */
export function mergeSpec(base: PresetConfig, over: PresetConfig): PresetConfig {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (k === "permissions" && base.permissions) {
      const merged: OverwriteMap = {};
      for (const [t, perms] of Object.entries(base.permissions)) merged[t] = { ...perms };
      for (const [t, perms] of Object.entries(v as OverwriteMap)) merged[t] = { ...(merged[t] ?? {}), ...perms };
      out.permissions = merged;
    } else if (k === "visibleTo" && base.visibleTo) {
      out.visibleTo = [...new Set([...base.visibleTo, ...(v as string[])])];
    } else {
      out[k] = v;
    }
  }
  return out as PresetConfig;
}

function parsePermissionList(list: string[], path: string, err: (code: string, message: string, path?: string, hint?: string) => void): bigint {
  let bits = 0n;
  for (const n of list) {
    const name = resolvePermissionName(n);
    if (!name) err("UNKNOWN_PERMISSION", `Unknown permission "${n}"`, path, "Run `discordctl permissions --list` for valid names.");
    else bits |= permissionBit(name);
  }
  return bits;
}

export function inferTier(perms: bigint): RoleTier {
  if ((perms & P.Administrator) !== 0n) return "admin";
  if ((perms & (ADMINISTRATIVE_PERMISSIONS | MODERATION_PERMISSIONS)) !== 0n) return "staff";
  return "member";
}

function safeDuration(v: number | string, path: string, err: (code: string, message: string, path?: string) => void): number | undefined {
  try {
    return parseDuration(v);
  } catch (e) {
    err("INVALID_DURATION", (e as Error).message, path);
    return undefined;
  }
}

const KIND_FIELDS: Record<string, ChannelKind[]> = {
  tags: ["forum", "media"],
  tagPolicy: ["forum", "media"],
  defaultReaction: ["forum", "media"],
  sortOrder: ["forum", "media"],
  layout: ["forum"],
  requireTag: ["forum", "media"],
  defaultThreadSlowmode: ["forum", "media", "text", "announcement"],
  defaultAutoArchive: ["forum", "media", "text", "announcement"],
  guidelines: ["forum", "media"],
  postTemplate: ["forum", "media"],
  bitrate: ["voice", "stage"],
  userLimit: ["voice", "stage"],
  rtcRegion: ["voice", "stage"],
  videoQuality: ["voice"],
  topic: ["text", "announcement", "forum", "media"],
  slowmode: ["text", "forum", "media", "voice", "stage"],
};

function validateKindFields(kind: ChannelKind, spec: PresetConfig, path: string, err: (code: string, message: string, path?: string) => void) {
  for (const [field, kinds] of Object.entries(KIND_FIELDS)) {
    if ((spec as Record<string, unknown>)[field] !== undefined && !kinds.includes(kind)) {
      err("FIELD_NOT_SUPPORTED", `"${field}" is not supported on ${kind} channels (supported: ${kinds.join(", ")})`, `${path}.${field}`);
    }
  }
}

function parseEmoji(value: string): { emojiId: string | null; emojiName: string | null } {
  const custom = /^(?:<a?:\w+:)?(\d{17,20})>?$/.exec(value.trim());
  if (custom) return { emojiId: custom[1]!, emojiName: null };
  return { emojiId: null, emojiName: value };
}

const ARCHIVE: Record<string, number> = { "1h": 60, "24h": 1440, "1d": 1440, "3d": 4320, "1w": 10080, "7d": 10080 };

function buildForum(spec: PresetConfig, kind: ChannelKind, path: string, err: (code: string, message: string, path?: string) => void): DesiredForumSettings {
  const forum: DesiredForumSettings = { tagPolicy: spec.tagPolicy ?? "merge" };
  if (spec.tags) {
    const names = new Set<string>();
    forum.tags = spec.tags.map((t, i) => {
      if (names.has(t.name.toLowerCase())) err("DUPLICATE_TAG", `Duplicate forum tag "${t.name}"`, `${path}.tags[${i}]`);
      names.add(t.name.toLowerCase());
      const emoji = t.emoji ? parseEmoji(t.emoji) : { emojiId: null, emojiName: null };
      return { name: t.name, moderated: t.moderated, ...emoji };
    });
  }
  if (spec.defaultReaction !== undefined) forum.defaultReaction = spec.defaultReaction === null ? null : parseEmoji(spec.defaultReaction);
  if (spec.sortOrder !== undefined) forum.sortOrder = spec.sortOrder === null ? null : spec.sortOrder === "latest_activity" ? 0 : 1;
  if (spec.layout !== undefined && kind === "forum") forum.layout = { default: 0, list: 1, gallery: 2 }[spec.layout];
  if (spec.requireTag !== undefined) forum.requireTag = spec.requireTag;
  if (spec.defaultThreadSlowmode !== undefined) {
    const s = safeDuration(spec.defaultThreadSlowmode, `${path}.defaultThreadSlowmode`, err);
    if (s !== undefined) {
      if (s > MAX_SLOWMODE) err("SLOWMODE_TOO_HIGH", `defaultThreadSlowmode exceeds ${MAX_SLOWMODE}s`, `${path}.defaultThreadSlowmode`);
      forum.defaultThreadSlowmode = s;
    }
  }
  if (spec.defaultAutoArchive !== undefined) {
    forum.defaultAutoArchiveDuration = typeof spec.defaultAutoArchive === "number" ? spec.defaultAutoArchive : ARCHIVE[spec.defaultAutoArchive]!;
  }
  if (spec.requireTag && spec.tags && !spec.tags.some((t) => !t.moderated)) {
    err("REQUIRE_TAG_NO_TAGS", "requireTag needs at least one tag members can use (not moderated); Discord rejects it otherwise", path);
  }
  return forum;
}

function buildVoice(
  spec: PresetConfig,
  kind: ChannelKind,
  path: string,
  err: (code: string, message: string, path?: string) => void,
  warn: (code: string, message: string, path?: string, hint?: string) => void,
): DesiredVoiceSettings {
  const voice: DesiredVoiceSettings = {};
  if (spec.bitrate !== undefined) {
    if (spec.bitrate > 96000) warn("BITRATE_BOOST", `Bitrate ${spec.bitrate} requires server boosts (96000 is the unboosted maximum)`, `${path}.bitrate`);
    voice.bitrate = spec.bitrate;
  }
  if (spec.userLimit !== undefined) {
    const max = kind === "stage" ? 10000 : 99;
    if (spec.userLimit > max) err("USER_LIMIT", `userLimit for ${kind} channels must be at most ${max}`, `${path}.userLimit`);
    voice.userLimit = spec.userLimit;
  }
  if (spec.rtcRegion !== undefined) voice.rtcRegion = spec.rtcRegion;
  if (spec.videoQuality !== undefined) voice.videoQualityMode = spec.videoQuality === "auto" ? 1 : 2;
  return voice;
}

export function describeBits(bits: bigint): string {
  return namesFromBits(bits).join(", ") || "(none)";
}

export type { Config };
