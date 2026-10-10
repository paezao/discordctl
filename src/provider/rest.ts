import { REST, DiscordAPIError, HTTPError, RateLimitError, type RateLimitData, type RESTOptions } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import type {
  APIChannel,
  APIGuild,
  APIGuildMember,
  APIGuildOnboarding,
  APIRole,
  APIUser,
  RESTAPIPartialCurrentUserGuild,
} from "discord-api-types/v10";
import type { DiscordApi } from "./api.js";
import { DiscordApiError } from "../util/errors.js";
import { redact, registerSecret } from "../util/redact.js";
import type { Logger } from "../util/logger.js";
import { silentLogger } from "../util/logger.js";
import { PRODUCT_NAME, VERSION } from "../core/constants.js";

export interface RestApiOptions {
  token: string;
  logger?: Logger;
  /** Max time to wait for a single rate limit before failing the request (ms). Default 60s. */
  maxRateLimitWaitMs?: number;
  /** Retries for 5xx / network errors performed by the transport. Default 3. */
  retries?: number;
  timeoutMs?: number;
  /** Injectable request function (used by tests to simulate Discord). */
  makeRequest?: RESTOptions["makeRequest"];
  apiBase?: string;
}

/**
 * DiscordApi over the official REST API using @discordjs/rest (part of the discord.js project),
 * which implements Discord's per-route and global rate-limit buckets from response headers.
 */
export class RestDiscordApi implements DiscordApi {
  private readonly rest: REST;
  private readonly logger: Logger;

  constructor(options: RestApiOptions) {
    registerSecret(options.token);
    this.logger = options.logger ?? silentLogger;
    const maxWait = options.maxRateLimitWaitMs ?? 60_000;
    this.rest = new REST({
      version: "10",
      retries: options.retries ?? 3,
      timeout: options.timeoutMs ?? 15_000,
      userAgentAppendix: `${PRODUCT_NAME}/${VERSION}`,
      // Fail fast instead of sleeping for unreasonably long rate limits.
      rejectOnRateLimit: (data: RateLimitData) => data.retryAfter > maxWait,
      ...(options.makeRequest ? { makeRequest: options.makeRequest } : {}),
      ...(options.apiBase ? { api: options.apiBase } : {}),
    }).setToken(options.token);
    this.rest.on("rateLimited", (info) => {
      this.logger.warn("Rate limited by Discord; waiting", { route: info.route, retryAfterMs: info.retryAfter, global: info.global });
    });
  }

  private async call<T>(method: string, route: string, fn: () => Promise<unknown>): Promise<T> {
    this.logger.debug(`${method} ${route}`);
    try {
      return (await fn()) as T;
    } catch (err) {
      throw toApiError(err, method, route);
    }
  }

  private opts(reason?: string, body?: unknown) {
    return { ...(body !== undefined ? { body } : {}), ...(reason ? { reason: reason.slice(0, 512) } : {}) };
  }

  getCurrentUser() {
    return this.call<APIUser>("GET", Routes.user("@me"), () => this.rest.get(Routes.user("@me")));
  }
  async listGuilds() {
    const all: RESTAPIPartialCurrentUserGuild[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const query = new URLSearchParams({ limit: "200", ...(after ? { after } : {}) });
      const batch = await this.call<RESTAPIPartialCurrentUserGuild[]>("GET", Routes.userGuilds(), () => this.rest.get(Routes.userGuilds(), { query }));
      all.push(...batch);
      if (batch.length < 200) break;
      after = batch[batch.length - 1]!.id;
    }
    return all;
  }
  getGuild(guildId: string) {
    return this.call<APIGuild>("GET", Routes.guild(guildId), () => this.rest.get(Routes.guild(guildId)));
  }
  getGuildRoles(guildId: string) {
    return this.call<APIRole[]>("GET", Routes.guildRoles(guildId), () => this.rest.get(Routes.guildRoles(guildId)));
  }
  getGuildChannels(guildId: string) {
    return this.call<APIChannel[]>("GET", Routes.guildChannels(guildId), () => this.rest.get(Routes.guildChannels(guildId)));
  }
  getGuildMember(guildId: string, userId: string) {
    return this.call<APIGuildMember>("GET", Routes.guildMember(guildId, userId), () => this.rest.get(Routes.guildMember(guildId, userId)));
  }
  createRole(guildId: string, body: object, reason?: string) {
    return this.call<APIRole>("POST", Routes.guildRoles(guildId), () => this.rest.post(Routes.guildRoles(guildId), this.opts(reason, body)));
  }
  modifyRole(guildId: string, roleId: string, body: object, reason?: string) {
    return this.call<APIRole>("PATCH", Routes.guildRole(guildId, roleId), () => this.rest.patch(Routes.guildRole(guildId, roleId), this.opts(reason, body)));
  }
  modifyRolePositions(guildId: string, body: object, reason?: string) {
    return this.call<APIRole[]>("PATCH", Routes.guildRoles(guildId), () => this.rest.patch(Routes.guildRoles(guildId), this.opts(reason, body)));
  }
  async deleteRole(guildId: string, roleId: string, reason?: string) {
    await this.call("DELETE", Routes.guildRole(guildId, roleId), () => this.rest.delete(Routes.guildRole(guildId, roleId), this.opts(reason)));
  }
  createChannel(guildId: string, body: object, reason?: string) {
    return this.call<APIChannel>("POST", Routes.guildChannels(guildId), () => this.rest.post(Routes.guildChannels(guildId), this.opts(reason, body)));
  }
  modifyChannel(channelId: string, body: object, reason?: string) {
    return this.call<APIChannel>("PATCH", Routes.channel(channelId), () => this.rest.patch(Routes.channel(channelId), this.opts(reason, body)));
  }
  async modifyChannelPositions(guildId: string, body: object, reason?: string) {
    await this.call("PATCH", Routes.guildChannels(guildId), () => this.rest.patch(Routes.guildChannels(guildId), this.opts(reason, body)));
  }
  async deleteChannel(channelId: string, reason?: string) {
    await this.call("DELETE", Routes.channel(channelId), () => this.rest.delete(Routes.channel(channelId), this.opts(reason)));
  }
  modifyGuild(guildId: string, body: object, reason?: string) {
    return this.call<APIGuild>("PATCH", Routes.guild(guildId), () => this.rest.patch(Routes.guild(guildId), this.opts(reason, body)));
  }
  getGuildOnboarding(guildId: string) {
    return this.call<APIGuildOnboarding>("GET", Routes.guildOnboarding(guildId), () => this.rest.get(Routes.guildOnboarding(guildId)));
  }
  modifyGuildOnboarding(guildId: string, body: object, reason?: string) {
    return this.call<APIGuildOnboarding>("PUT", Routes.guildOnboarding(guildId), () => this.rest.put(Routes.guildOnboarding(guildId), this.opts(reason, body)));
  }
}

export function toApiError(err: unknown, method: string, route: string): DiscordApiError {
  if (err instanceof DiscordApiError) return err;
  if (err instanceof RateLimitError) {
    return new DiscordApiError({
      status: 429,
      message: `Rate limit too long to wait (${Math.ceil(err.retryAfter / 1000)}s)`,
      retryAfterMs: err.retryAfter,
      retryable: false,
      ambiguous: false,
      method,
      route,
    });
  }
  if (err instanceof DiscordAPIError) {
    return new DiscordApiError({
      status: err.status,
      discordCode: typeof err.code === "number" ? err.code : undefined,
      message: redact(err.message),
      ambiguous: err.status >= 500,
      method,
      route,
    });
  }
  if (err instanceof HTTPError) {
    return new DiscordApiError({ status: err.status, message: redact(err.message), method, route });
  }
  const message = err instanceof Error ? err.message : String(err);
  // Network failure / timeout: the request may or may not have reached Discord.
  return new DiscordApiError({ status: 0, message: `Network error: ${redact(message)}`, retryable: true, ambiguous: true, method, route });
}
