import type { DiscordApi } from "./api.js";
import { DiscordctlError } from "../util/errors.js";

/** A DiscordApi that refuses every call; used by commands that only work on config files. */
export class OfflineApi implements DiscordApi {
  constructor() {
    const fail = () => {
      throw new DiscordctlError("OFFLINE", "This command runs offline and cannot contact Discord");
    };
    for (const name of [
      "getCurrentUser", "listGuilds", "getGuild", "getGuildRoles", "getGuildChannels", "getGuildMember", "createRole", "modifyRole",
      "modifyRolePositions", "deleteRole", "createChannel", "modifyChannel", "modifyChannelPositions", "deleteChannel", "modifyGuild",
    ]) {
      (this as Record<string, unknown>)[name] = async () => fail();
    }
  }
}
export interface OfflineApi extends DiscordApi {}
