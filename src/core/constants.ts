import { createRequire } from "node:module";

/** Product naming, in one place. */
export const PRODUCT_NAME = "discordctl";
export const MCP_SERVER_NAME = "discordctl";
/** Read from package.json (two levels up from both src/core and dist/core) so releases never drift. */
export const VERSION: string = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;
export const STATE_DIR_NAME = ".discordctl";
export const ENV_PREFIX = "DISCORDCTL";
/** Audit-log reason attached to every mutation, visible in Discord's audit log. */
export const AUDIT_REASON_PREFIX = `${PRODUCT_NAME}`;
