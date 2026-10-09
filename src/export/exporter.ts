import { stringify } from "yaml";
import type { ActualChannel, GuildSnapshot, Overwrite } from "../core/model.js";
import { channelSortClass } from "../core/model.js";
import { P, namesFromBits, permissionBit, PERMISSION_NAMES } from "../permissions/flags.js";
import { compareSnowflakes, slugify, uniqueKey } from "../util/names.js";
import type { ResourceMapping } from "../state/store.js";

export interface ExportOptions {
  /** Pin every resource with `id:` (default: only when names are ambiguous). */
  withIds?: boolean;
  /** Use `${DISCORD_GUILD_ID}` instead of the literal guild ID. */
  guildIdVariable?: boolean;
  /** Existing state mappings; their keys are reused so exports stay stable. */
  mappings?: ResourceMapping[];
}

export interface ExportResult {
  yaml: string;
  config: Record<string, unknown>;
  /** key -> id bindings implied by the export (can be written to state). */
  bindings: Array<{ kind: "role" | "channel"; key: string; id: string; name: string }>;
  notes: string[];
}

type PermMap = Record<string, Record<string, "allow" | "deny" | "inherit">>;

/** Convert live guild state into a discordctl configuration that reproduces it. */
export function exportConfig(s: GuildSnapshot, options: ExportOptions = {}): ExportResult {
  const notes: string[] = [];
  const bindings: ExportResult["bindings"] = [];
  const mappedKey = new Map((options.mappings ?? []).map((m) => [`${m.kind}:${m.discordId}`, m.key]));
  const roleKeys = new Set<string>(["everyone"]);
  const channelKeys = new Set<string>();

  // ---- roles
  const roles = s.roles.filter((r) => !r.isEveryone && !r.managed).sort((a, b) => b.position - a.position);
  const nameCount = (names: string[]) => names.reduce((m, n) => m.set(n.toLowerCase(), (m.get(n.toLowerCase()) ?? 0) + 1), new Map<string, number>());
  const roleNameCount = nameCount(roles.map((r) => r.name));
  const roleKeyById = new Map<string, string>();
  const roleEntries = roles.map((r) => {
    const key = uniqueKey(mappedKey.get(`role:${r.id}`) ?? slugify(r.name), roleKeys);
    roleKeyById.set(r.id, key);
    bindings.push({ kind: "role", key, id: r.id, name: r.name });
    const entry: Record<string, unknown> = { key, name: r.name };
    if (options.withIds || (roleNameCount.get(r.name.toLowerCase()) ?? 0) > 1) entry.id = r.id;
    if (r.color) entry.color = `#${r.color.toString(16).padStart(6, "0")}`;
    if (r.hoist) entry.hoist = true;
    if (r.mentionable) entry.mentionable = true;
    entry.permissions = namesFromBits(r.permissions);
    return entry;
  });
  const managedRoles = s.roles.filter((r) => r.managed);
  if (managedRoles.length) notes.push(`Skipped ${managedRoles.length} integration-managed role(s): ${managedRoles.map((r) => r.name).join(", ")}`);

  const targetName = (o: Overwrite): string => {
    if (o.type === "member") return `member:${o.id}`;
    if (o.id === s.guild.id) return "everyone";
    return roleKeyById.get(o.id) ?? `roleId:${o.id}`;
  };
  const owMap = (ows: Overwrite[]): PermMap => {
    const out: PermMap = {};
    for (const o of ows) {
      const entry: Record<string, "allow" | "deny" | "inherit"> = {};
      for (const n of namesFromBits(o.allow)) entry[n] = "allow";
      for (const n of namesFromBits(o.deny)) entry[n] = "deny";
      if (Object.keys(entry).length) out[targetName(o)] = entry;
    }
    return out;
  };
  /** The channel-level map that, merged over the category's map, reproduces `child`. */
  const diffMap = (parent: Overwrite[], child: Overwrite[]): PermMap | undefined => {
    const out: PermMap = {};
    const targets = new Map<string, { type: Overwrite["type"] }>();
    for (const o of [...parent, ...child]) targets.set(o.id, { type: o.type });
    for (const [id, { type }] of targets) {
      const p = parent.find((o) => o.id === id) ?? { id, type, allow: 0n, deny: 0n };
      const c = child.find((o) => o.id === id) ?? { id, type, allow: 0n, deny: 0n };
      const entry: Record<string, "allow" | "deny" | "inherit"> = {};
      for (const name of PERMISSION_NAMES) {
        const bit = permissionBit(name);
        const ps = p.allow & bit ? "allow" : p.deny & bit ? "deny" : "inherit";
        const cs = c.allow & bit ? "allow" : c.deny & bit ? "deny" : "inherit";
        if (ps !== cs) entry[name] = cs;
      }
      if (Object.keys(entry).length) out[targetName(c)] = entry;
    }
    return Object.keys(out).length ? out : undefined;
  };

  const sortChannels = (list: ActualChannel[]) =>
    [...list].sort((a, b) => {
      const ca = channelSortClass(a.kind as never) === "voice" ? 1 : 0;
      const cb = channelSortClass(b.kind as never) === "voice" ? 1 : 0;
      return ca - cb || a.position - b.position || compareSnowflakes(a.id, b.id);
    });
  const channelNameCount = nameCount(s.channels.map((c) => c.name));
  const channelEntry = (c: ActualChannel, parent?: ActualChannel): Record<string, unknown> => {
    const key = uniqueKey(mappedKey.get(`channel:${c.id}`) ?? slugify(c.name), channelKeys);
    bindings.push({ kind: "channel", key, id: c.id, name: c.name });
    const e: Record<string, unknown> = { key, name: c.name };
    if (options.withIds || (channelNameCount.get(c.name.toLowerCase()) ?? 0) > 1) e.id = c.id;
    if (c.kind !== "text") e.type = c.kind;
    if (c.topic) e[c.kind === "forum" || c.kind === "media" ? "guidelines" : "topic"] = c.topic;
    if (c.nsfw) e.nsfw = true;
    if (c.slowmode) e.slowmode = c.slowmode;
    if (c.kind === "voice" || c.kind === "stage") {
      if (c.bitrate && c.bitrate !== 64000) e.bitrate = c.bitrate;
      if (c.userLimit) e.userLimit = c.userLimit;
      if (c.rtcRegion) e.rtcRegion = c.rtcRegion;
      if (c.kind === "voice" && c.videoQualityMode === 2) e.videoQuality = "full";
    }
    if (c.kind === "forum" || c.kind === "media") {
      if (c.tags?.length) {
        e.tags = c.tags.map((t) => ({ name: t.name, ...(t.emojiName ? { emoji: t.emojiName } : t.emojiId ? { emoji: t.emojiId } : {}), ...(t.moderated ? { moderated: true } : {}) }));
      }
      if (c.defaultReactionEmoji) e.defaultReaction = c.defaultReactionEmoji.emojiName ?? c.defaultReactionEmoji.emojiId;
      if (c.defaultSortOrder !== null && c.defaultSortOrder !== undefined) e.sortOrder = c.defaultSortOrder === 0 ? "latest_activity" : "creation_date";
      if (c.kind === "forum" && c.defaultForumLayout) e.layout = ["default", "list", "gallery"][c.defaultForumLayout];
      if (c.flags & 16) e.requireTag = true;
    }
    if (c.defaultThreadSlowmode) e.defaultThreadSlowmode = c.defaultThreadSlowmode;
    if (c.defaultAutoArchiveDuration && c.defaultAutoArchiveDuration !== 4320) e.defaultAutoArchive = c.defaultAutoArchiveDuration;
    if (parent) {
      const d = diffMap(parent.overwrites, c.overwrites);
      if (d) e.permissions = d;
    } else {
      const m = owMap(c.overwrites);
      if (Object.keys(m).length) e.permissions = m;
    }
    return e;
  };

  const categories = sortChannels(s.channels.filter((c) => c.kind === "category")).map((cat) => {
    const key = uniqueKey(mappedKey.get(`channel:${cat.id}`) ?? slugify(cat.name), channelKeys);
    bindings.push({ kind: "channel", key, id: cat.id, name: cat.name });
    const e: Record<string, unknown> = { key, name: cat.name };
    if (options.withIds || (channelNameCount.get(cat.name.toLowerCase()) ?? 0) > 1) e.id = cat.id;
    const m = owMap(cat.overwrites);
    // Always declare permissions on categories so children have a well-defined base.
    e.permissions = m;
    e.channels = sortChannels(s.channels.filter((c) => c.parentId === cat.id && c.kind !== "unsupported" && c.kind !== "category")).map((c) => channelEntry(c, cat));
    return e;
  });
  const topLevel = sortChannels(s.channels.filter((c) => !c.parentId && c.kind !== "category" && c.kind !== "unsupported")).map((c) => channelEntry(c));
  const unsupported = s.channels.filter((c) => c.kind === "unsupported");
  if (unsupported.length) notes.push(`Skipped ${unsupported.length} channel(s) of unsupported types`);

  const everyone = s.roles.find((r) => r.isEveryone);
  const config: Record<string, unknown> = {
    version: 1,
    metadata: { name: s.guild.name, description: `Exported from guild ${s.guild.id} on ${s.fetchedAt.slice(0, 10)}` },
    guild: { id: options.guildIdVariable ? "${DISCORD_GUILD_ID}" : s.guild.id },
    everyone: { permissions: namesFromBits(everyone?.permissions ?? 0n) },
    roles: roleEntries,
    categories,
    ...(topLevel.length ? { channels: topLevel } : {}),
  };
  if (everyone && (everyone.permissions & P.Administrator) !== 0n) notes.push("WARNING: @everyone has Administrator in this guild");
  const header = `# discordctl configuration exported from "${s.guild.name}"\n# Review before applying. Docs: docs/configuration.md\n`;
  return { yaml: header + stringify(config, { lineWidth: 0 }), config, bindings, notes };
}
