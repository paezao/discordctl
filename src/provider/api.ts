import type {
  APIChannel,
  APIGuild,
  APIGuildMember,
  APIRole,
  APIUser,
  RESTAPIPartialCurrentUserGuild,
  RESTPatchAPIChannelJSONBody,
  RESTPatchAPIGuildChannelPositionsJSONBody,
  RESTPatchAPIGuildJSONBody,
  RESTPatchAPIGuildRoleJSONBody,
  RESTPatchAPIGuildRolePositionsJSONBody,
  RESTPostAPIGuildChannelJSONBody,
  RESTPostAPIGuildRoleJSONBody,
} from "discord-api-types/v10";

/**
 * The complete set of Discord operations discordctl performs. Only documented,
 * bot-authenticated REST endpoints are used. Implementations must throw DiscordApiError.
 *
 * This interface is intentionally narrow: neither the CLI nor the MCP server can reach
 * arbitrary Discord endpoints.
 */
export interface DiscordApi {
  getCurrentUser(): Promise<APIUser>;
  listGuilds(): Promise<RESTAPIPartialCurrentUserGuild[]>;
  getGuild(guildId: string): Promise<APIGuild>;
  getGuildRoles(guildId: string): Promise<APIRole[]>;
  getGuildChannels(guildId: string): Promise<APIChannel[]>;
  getGuildMember(guildId: string, userId: string): Promise<APIGuildMember>;

  createRole(guildId: string, body: RESTPostAPIGuildRoleJSONBody, reason?: string): Promise<APIRole>;
  modifyRole(guildId: string, roleId: string, body: RESTPatchAPIGuildRoleJSONBody, reason?: string): Promise<APIRole>;
  modifyRolePositions(guildId: string, body: RESTPatchAPIGuildRolePositionsJSONBody, reason?: string): Promise<APIRole[]>;
  deleteRole(guildId: string, roleId: string, reason?: string): Promise<void>;

  createChannel(guildId: string, body: RESTPostAPIGuildChannelJSONBody, reason?: string): Promise<APIChannel>;
  modifyChannel(channelId: string, body: RESTPatchAPIChannelJSONBody, reason?: string): Promise<APIChannel>;
  modifyChannelPositions(guildId: string, body: RESTPatchAPIGuildChannelPositionsJSONBody, reason?: string): Promise<void>;
  deleteChannel(channelId: string, reason?: string): Promise<void>;

  modifyGuild(guildId: string, body: RESTPatchAPIGuildJSONBody, reason?: string): Promise<APIGuild>;
}
