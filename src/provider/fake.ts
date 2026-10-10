import { ChannelType, type APIChannel, type APIGuild, type APIGuildMember, type APIGuildOnboarding, type APIRole, type APIUser } from "discord-api-types/v10";
import type { DiscordApi } from "./api.js";
import { DiscordApiError } from "../util/errors.js";
import { ALL_PERMISSIONS, P, SAFE_EVERYONE_DEFAULTS, has, parseBits } from "../permissions/flags.js";

/**
 * In-memory Discord emulation for tests, demos and local development.
 *
 * It models the behaviours discordctl depends on: role hierarchy enforcement, "can only grant
 * permissions you have", channel-name normalization, position handling, Community-only channel
 * types and forum tag IDs. It is not a full Discord implementation.
 */

type Json = Record<string, unknown>;

export interface FakeGuildInit {
  id: string;
  name: string;
  ownerId?: string;
  features?: string[];
  /** Permissions for the bot's integration role. Default: ManageRoles | ManageChannels | ManageGuild | safe defaults. */
  botPermissions?: bigint;
  /** Position of the bot's role from the top: 0 = highest (default). */
}

interface FakeGuildState {
  guild: Json;
  roles: Json[];
  channels: Json[];
  members: Map<string, string[]>;
  onboarding: Json;
}

export interface FakeCall {
  method: string;
  args: unknown[];
}

interface FailureRule {
  match: (method: string, args: unknown[]) => boolean;
  error: () => Error;
  remaining: number;
}

export class FakeDiscord implements DiscordApi {
  readonly botUser: APIUser;
  readonly guilds = new Map<string, FakeGuildState>();
  readonly calls: FakeCall[] = [];
  private nextId = 100000000000000000n;
  private failures: FailureRule[] = [];
  /** Real Discord returns unordered collections in varying order; rotate them per read. */
  private reads = 0;

  constructor(botUserId = "900000000000000001") {
    this.botUser = { id: botUserId, username: "discordctl-test-bot", discriminator: "0", global_name: null, avatar: null, bot: true } as APIUser;
  }

  id(): string {
    this.nextId += 1n;
    return this.nextId.toString();
  }

  addGuild(init: FakeGuildInit): FakeGuildState {
    const everyone: Json = {
      id: init.id, name: "@everyone", color: 0, hoist: false, mentionable: false, managed: false,
      permissions: SAFE_EVERYONE_DEFAULTS.toString(), position: 0, flags: 0,
    };
    const botRoleId = this.id();
    const botRole: Json = {
      id: botRoleId, name: "discordctl", color: 0, hoist: false, mentionable: false, managed: true,
      permissions: (init.botPermissions ?? (P.ManageRoles | P.ManageChannels | P.ManageGuild | ALL_PERMISSIONS & ~P.Administrator)).toString(),
      position: 1, flags: 0, tags: { bot_id: this.botUser.id },
    };
    const state: FakeGuildState = {
      guild: {
        id: init.id, name: init.name, owner_id: init.ownerId ?? "800000000000000001", features: init.features ?? [],
        description: null, verification_level: 0, default_message_notifications: 0, explicit_content_filter: 0,
        afk_timeout: 300, afk_channel_id: null, system_channel_id: null, rules_channel_id: null, public_updates_channel_id: null,
        premium_tier: 0,
      },
      roles: [everyone, botRole],
      channels: [],
      members: new Map([[this.botUser.id, [botRoleId]]]),
      onboarding: { guild_id: init.id, prompts: [], default_channel_ids: [], enabled: false, mode: 0 },
    };
    this.guilds.set(init.id, state);
    return state;
  }

  /** Make the next `times` calls matching `method` (and optional predicate) fail with `error`. */
  failNext(method: string, error: () => Error, times = 1, predicate: (args: unknown[]) => boolean = () => true): void {
    this.failures.push({ match: (m, a) => m === method && predicate(a), error, remaining: times });
  }

  // ---- helpers ------------------------------------------------------------

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args: structuredClone(args) });
    const rule = this.failures.find((f) => f.remaining > 0 && f.match(method, args));
    if (rule) {
      rule.remaining--;
      throw rule.error();
    }
  }

  mutationCalls(): FakeCall[] {
    return this.calls.filter((c) => !c.method.startsWith("get") && c.method !== "listGuilds");
  }

  private g(guildId: string): FakeGuildState {
    const g = this.guilds.get(guildId);
    if (!g) throw new DiscordApiError({ status: 404, discordCode: 10004, message: "Unknown Guild" });
    return g;
  }

  private findChannel(channelId: string): { state: FakeGuildState; channel: Json } {
    for (const state of this.guilds.values()) {
      const channel = state.channels.find((c) => c.id === channelId);
      if (channel) return { state, channel };
    }
    throw new DiscordApiError({ status: 404, discordCode: 10003, message: "Unknown Channel" });
  }

  private botPerms(state: FakeGuildState): bigint {
    if (state.guild.owner_id === this.botUser.id) return ALL_PERMISSIONS;
    const roleIds = state.members.get(this.botUser.id) ?? [];
    let perms = parseBits(state.roles.find((r) => r.id === state.guild.id)!.permissions as string);
    for (const r of state.roles) if (roleIds.includes(r.id as string)) perms |= parseBits(r.permissions as string);
    return has(perms, P.Administrator) ? ALL_PERMISSIONS : perms;
  }

  private botTop(state: FakeGuildState): number {
    const roleIds = state.members.get(this.botUser.id) ?? [];
    return Math.max(0, ...state.roles.filter((r) => roleIds.includes(r.id as string)).map((r) => r.position as number));
  }

  private missing(message = "Missing Permissions"): DiscordApiError {
    return new DiscordApiError({ status: 403, discordCode: 50013, message, retryable: false, ambiguous: false });
  }

  private requirePerm(state: FakeGuildState, perm: bigint): void {
    if (!has(this.botPerms(state), perm)) throw this.missing();
  }

  private checkGrant(state: FakeGuildState, permissions: unknown): void {
    if (permissions === undefined || permissions === null) return;
    const wanted = parseBits(permissions as string);
    const have = this.botPerms(state);
    if ((wanted & ~have) !== 0n) throw this.missing("Cannot grant permissions the bot does not have");
  }

  private normalizePositions(state: FakeGuildState): void {
    const sorted = [...state.roles].sort((a, b) => (a.position as number) - (b.position as number) || (BigInt(a.id as string) < BigInt(b.id as string) ? -1 : 1));
    sorted.forEach((r, i) => (r.position = r.id === state.guild.id ? 0 : i));
  }

  private normalizeName(type: number, name: string): string {
    const textLike = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].includes(type);
    return textLike ? name.trim().toLowerCase().replace(/\s+/g, "-").replace(/-{2,}/g, "-") : name;
  }

  private validateType(state: FakeGuildState, type: number): void {
    const features = state.guild.features as string[];
    if ((type === ChannelType.GuildAnnouncement || type === ChannelType.GuildStageVoice) && !features.includes("COMMUNITY") && !features.includes("NEWS")) {
      throw new DiscordApiError({ status: 400, discordCode: 50024, message: "Cannot execute action on this channel type", retryable: false, ambiguous: false });
    }
  }

  private applyChannelBody(state: FakeGuildState, channel: Json, body: Json): void {
    const type = (body.type as number | undefined) ?? (channel.type as number);
    // Discord validates REQUIRE_TAG against the tags the channel has *before* this request.
    if (body.flags !== undefined && ((body.flags as number) & 16) !== 0 && ((channel.flags as number) & 16) === 0) {
      const current = (channel.available_tags as Json[] | undefined) ?? [];
      if (!current.some((t) => !t.moderated)) {
        throw new DiscordApiError({ status: 400, discordCode: 40066, message: "There are no tags available that can be set by non-moderators", retryable: false, ambiguous: false });
      }
    }
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      if (k === "name") channel.name = this.normalizeName(type, v as string);
      else if (k === "topic") channel.topic = typeof v === "string" ? v.trimEnd() || null : v; // Discord strips trailing whitespace
      else if (k === "permission_overwrites") {
        channel.permission_overwrites = (v as Json[]).map((o) => ({ id: o.id, type: o.type, allow: String(o.allow ?? "0"), deny: String(o.deny ?? "0") }));
      } else if (k === "available_tags") {
        channel.available_tags = (v as Json[]).map((t) => ({ id: (t.id as string) ?? this.id(), name: t.name, moderated: Boolean(t.moderated), emoji_id: t.emoji_id ?? null, emoji_name: t.emoji_name ?? null }));
      } else if (k === "type") {
        const from = channel.type as number;
        const ok = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
        if (from !== v && !(ok.includes(from) && ok.includes(v as number))) {
          throw new DiscordApiError({ status: 400, discordCode: 50035, message: "Invalid Form Body: type", retryable: false, ambiguous: false });
        }
        this.validateType(state, v as number);
        channel.type = v;
      } else channel[k] = v;
    }
  }

  // ---- reads ----------------------------------------------------------------

  async getCurrentUser(): Promise<APIUser> {
    this.record("getCurrentUser", []);
    return structuredClone(this.botUser);
  }

  async listGuilds() {
    this.record("listGuilds", []);
    return [...this.guilds.values()].map((s) => ({ id: s.guild.id, name: s.guild.name, icon: null, owner: false, permissions: "0", features: s.guild.features })) as never;
  }

  async getGuild(guildId: string): Promise<APIGuild> {
    this.record("getGuild", [guildId]);
    const s = this.g(guildId);
    const guild: Json = structuredClone({ ...s.guild, roles: s.roles });
    guild.features = rotate(guild.features as string[], ++this.reads);
    return guild as unknown as APIGuild;
  }

  async getGuildRoles(guildId: string): Promise<APIRole[]> {
    this.record("getGuildRoles", [guildId]);
    return structuredClone(this.g(guildId).roles) as unknown as APIRole[];
  }

  async getGuildChannels(guildId: string): Promise<APIChannel[]> {
    this.record("getGuildChannels", [guildId]);
    const channels = structuredClone(this.g(guildId).channels);
    const n = ++this.reads;
    for (const c of channels) if (Array.isArray(c.permission_overwrites)) c.permission_overwrites = rotate(c.permission_overwrites, n);
    return channels as unknown as APIChannel[];
  }

  async getGuildMember(guildId: string, userId: string): Promise<APIGuildMember> {
    this.record("getGuildMember", [guildId, userId]);
    const roles = this.g(guildId).members.get(userId);
    if (!roles) throw new DiscordApiError({ status: 404, discordCode: 10007, message: "Unknown Member" });
    return { roles: [...roles], user: userId === this.botUser.id ? this.botUser : undefined } as unknown as APIGuildMember;
  }

  // ---- roles ----------------------------------------------------------------

  async createRole(guildId: string, body: Json): Promise<APIRole> {
    this.record("createRole", [guildId, body]);
    const s = this.g(guildId);
    this.requirePerm(s, P.ManageRoles);
    this.checkGrant(s, body.permissions);
    if (s.roles.length >= 250) throw new DiscordApiError({ status: 400, discordCode: 30005, message: "Maximum number of guild roles reached", retryable: false });
    for (const r of s.roles) if ((r.position as number) >= 1) r.position = (r.position as number) + 1;
    const role: Json = {
      id: this.id(), name: body.name ?? "new role", color: body.color ?? 0, hoist: body.hoist ?? false,
      mentionable: body.mentionable ?? false, managed: false, position: 1, flags: 0,
      permissions: body.permissions !== undefined ? String(body.permissions) : (s.roles[0]!.permissions as string),
    };
    s.roles.push(role);
    return structuredClone(role) as unknown as APIRole;
  }

  async modifyRole(guildId: string, roleId: string, body: Json): Promise<APIRole> {
    this.record("modifyRole", [guildId, roleId, body]);
    const s = this.g(guildId);
    const role = s.roles.find((r) => r.id === roleId);
    if (!role) throw new DiscordApiError({ status: 404, discordCode: 10011, message: "Unknown Role" });
    this.requirePerm(s, P.ManageRoles);
    if (s.guild.owner_id !== this.botUser.id && (role.position as number) >= this.botTop(s) && roleId !== guildId) throw this.missing();
    if (role.managed && (body.name !== undefined || body.permissions !== undefined)) throw this.missing();
    this.checkGrant(s, body.permissions);
    for (const [k, v] of Object.entries(body)) if (v !== undefined) role[k] = k === "permissions" ? String(v) : v;
    return structuredClone(role) as unknown as APIRole;
  }

  async modifyRolePositions(guildId: string, body: Json[]): Promise<APIRole[]> {
    this.record("modifyRolePositions", [guildId, body]);
    const s = this.g(guildId);
    this.requirePerm(s, P.ManageRoles);
    const top = this.botTop(s);
    for (const entry of body) {
      const role = s.roles.find((r) => r.id === entry.id);
      if (!role) throw new DiscordApiError({ status: 404, discordCode: 10011, message: "Unknown Role" });
      if ((role.position as number) >= top || (entry.position as number) >= top) throw this.missing();
      role.position = entry.position;
    }
    this.normalizePositions(s);
    return structuredClone(s.roles) as unknown as APIRole[];
  }

  async deleteRole(guildId: string, roleId: string): Promise<void> {
    this.record("deleteRole", [guildId, roleId]);
    const s = this.g(guildId);
    this.requirePerm(s, P.ManageRoles);
    const idx = s.roles.findIndex((r) => r.id === roleId);
    if (idx < 0) throw new DiscordApiError({ status: 404, discordCode: 10011, message: "Unknown Role" });
    if ((s.roles[idx]!.position as number) >= this.botTop(s)) throw this.missing();
    s.roles.splice(idx, 1);
    this.normalizePositions(s);
  }

  // ---- channels ---------------------------------------------------------------

  async createChannel(guildId: string, body: Json): Promise<APIChannel> {
    this.record("createChannel", [guildId, body]);
    const s = this.g(guildId);
    this.requirePerm(s, P.ManageChannels);
    const type = (body.type as number | undefined) ?? ChannelType.GuildText;
    this.validateType(s, type);
    if (body.permission_overwrites) this.requirePerm(s, P.ManageRoles);
    const siblings = s.channels.filter((c) => (c.parent_id ?? null) === (body.parent_id ?? null));
    const channel: Json = {
      id: this.id(), guild_id: guildId, type, name: "", parent_id: body.parent_id ?? null,
      position: siblings.length === 0 ? 0 : Math.max(...siblings.map((c) => c.position as number)) + 1,
      permission_overwrites: [], nsfw: false, flags: 0,
    };
    if ([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].includes(type)) {
      channel.topic = null;
      channel.rate_limit_per_user = 0;
      channel.default_thread_rate_limit_per_user = 0;
      channel.default_auto_archive_duration = 4320;
    }
    if (type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice) {
      Object.assign(channel, { bitrate: 64000, user_limit: 0, rtc_region: null, video_quality_mode: 1, rate_limit_per_user: 0 });
    }
    if (type === ChannelType.GuildForum || type === ChannelType.GuildMedia) {
      Object.assign(channel, { available_tags: [], default_reaction_emoji: null, default_sort_order: null, default_forum_layout: 0 });
    }
    const { position: _ignored, ...rest } = body;
    this.applyChannelBody(s, channel, rest);
    s.channels.push(channel);
    return structuredClone(channel) as unknown as APIChannel;
  }

  async modifyChannel(channelId: string, body: Json): Promise<APIChannel> {
    this.record("modifyChannel", [channelId, body]);
    const { state, channel } = this.findChannel(channelId);
    this.requirePerm(state, P.ManageChannels);
    if (body.permission_overwrites) this.requirePerm(state, P.ManageRoles);
    this.applyChannelBody(state, channel, body);
    return structuredClone(channel) as unknown as APIChannel;
  }

  async modifyChannelPositions(guildId: string, body: Json[]): Promise<void> {
    this.record("modifyChannelPositions", [guildId, body]);
    const s = this.g(guildId);
    this.requirePerm(s, P.ManageChannels);
    for (const entry of body) {
      const ch = s.channels.find((c) => c.id === entry.id);
      if (!ch) throw new DiscordApiError({ status: 404, discordCode: 10003, message: "Unknown Channel" });
      if (entry.position !== undefined) ch.position = entry.position;
      if (entry.parent_id !== undefined) ch.parent_id = entry.parent_id;
    }
  }

  async deleteChannel(channelId: string): Promise<void> {
    this.record("deleteChannel", [channelId]);
    const { state, channel } = this.findChannel(channelId);
    this.requirePerm(state, P.ManageChannels);
    state.channels.splice(state.channels.indexOf(channel), 1);
    if (channel.type === ChannelType.GuildCategory) for (const c of state.channels) if (c.parent_id === channelId) c.parent_id = null;
  }

  async modifyGuild(guildId: string, body: Json): Promise<APIGuild> {
    this.record("modifyGuild", [guildId, body]);
    const s = this.g(guildId);
    this.requirePerm(s, P.ManageGuild);
    for (const [k, v] of Object.entries(body)) if (v !== undefined) s.guild[k] = v;
    return structuredClone({ ...s.guild, roles: s.roles }) as unknown as APIGuild;
  }

  // ---- onboarding -------------------------------------------------------------------

  async getGuildOnboarding(guildId: string): Promise<APIGuildOnboarding> {
    this.record("getGuildOnboarding", [guildId]);
    const s = this.g(guildId);
    const ob = structuredClone(s.onboarding);
    // Question order is the display order and is preserved; the default channel list is a set.
    ob.default_channel_ids = rotate(ob.default_channel_ids as string[], ++this.reads);
    return ob as unknown as APIGuildOnboarding;
  }

  async modifyGuildOnboarding(guildId: string, body: Json): Promise<APIGuildOnboarding> {
    this.record("modifyGuildOnboarding", [guildId, body]);
    const s = this.g(guildId);
    this.requirePerm(s, P.ManageGuild | P.ManageRoles);
    if (!(s.guild.features as string[]).includes("COMMUNITY")) {
      throw new DiscordApiError({ status: 403, discordCode: 50001, message: "Onboarding requires the Community feature", retryable: false, ambiguous: false });
    }
    const channelIds = new Set(s.channels.map((c) => c.id as string));
    const roleIds = new Set(s.roles.map((r) => r.id as string));
    const defaults = (body.default_channel_ids as string[] | undefined) ?? (s.onboarding.default_channel_ids as string[]);
    for (const id of defaults) if (!channelIds.has(id)) throw this.invalid("default_channel_ids");
    const prompts = ((body.prompts as Json[] | undefined) ?? (s.onboarding.prompts as Json[])).map((p) => ({
      id: p.id, title: p.title, type: p.type ?? 0, single_select: Boolean(p.single_select), required: Boolean(p.required), in_onboarding: p.in_onboarding ?? true,
      options: (p.options as Json[]).map((o) => {
        for (const r of (o.role_ids as string[]) ?? []) if (!roleIds.has(r)) throw this.invalid("role_ids");
        for (const c of (o.channel_ids as string[]) ?? []) if (!channelIds.has(c)) throw this.invalid("channel_ids");
        return {
          id: (o.id as string | undefined) ?? this.id(), title: o.title, description: o.description ?? null,
          emoji: { id: o.emoji_id ?? null, name: o.emoji_name ?? null, animated: Boolean(o.emoji_animated) },
          role_ids: o.role_ids ?? [], channel_ids: o.channel_ids ?? [],
        };
      }),
    }));
    const enabled = (body.enabled as boolean | undefined) ?? (s.onboarding.enabled as boolean);
    const mode = (body.mode as number | undefined) ?? (s.onboarding.mode as number);
    if (enabled && mode === 0) {
      const everyone = parseBits(s.roles.find((r) => r.id === guildId)!.permissions as string);
      const sendable = defaults.filter((id) => {
        const ch = s.channels.find((c) => c.id === id)!;
        const ow = ((ch.permission_overwrites as Json[]) ?? []).find((o) => o.id === guildId);
        let perms = everyone;
        if (ow) perms = (perms & ~parseBits(ow.deny as string)) | parseBits(ow.allow as string);
        return has(perms, P.ViewChannel | P.SendMessages);
      });
      if (defaults.length < 7 || sendable.length < 5) {
        throw new DiscordApiError({ status: 400, discordCode: 350000, message: "Onboarding requires at least 7 default channels, 5 of which @everyone can send messages in", retryable: false, ambiguous: false });
      }
    }
    s.onboarding = { guild_id: guildId, prompts, default_channel_ids: [...defaults], enabled, mode };
    return structuredClone(s.onboarding) as unknown as APIGuildOnboarding;
  }

  private invalid(field: string): DiscordApiError {
    return new DiscordApiError({ status: 400, discordCode: 50035, message: `Invalid Form Body: ${field}`, retryable: false, ambiguous: false });
  }

  // ---- test helpers -------------------------------------------------------------

  /** Simulate an out-of-band change made by a human in the Discord client. */
  externalRenameRole(guildId: string, roleId: string, name: string): void {
    const role = this.g(guildId).roles.find((r) => r.id === roleId);
    if (role) role.name = name;
  }

  externalDeleteChannel(guildId: string, channelId: string): void {
    const s = this.g(guildId);
    s.channels = s.channels.filter((c) => c.id !== channelId);
  }

  rawGuild(guildId: string): FakeGuildState {
    return this.g(guildId);
  }
}

function rotate<T>(list: T[], n: number): T[] {
  if (list.length < 2) return list;
  const k = n % list.length;
  return [...list.slice(k), ...list.slice(0, k)];
}
