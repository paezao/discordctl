#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { DiscordctlService } from "../service.js";
import { RestDiscordApi } from "../provider/rest.js";
import { resolveToken } from "../auth/credentials.js";
import { StateStore } from "../state/store.js";
import { createLogger } from "../util/logger.js";
import { defaultStatePath, loadEnvFile } from "../cli/context.js";
import { ENV_PREFIX } from "../core/constants.js";

/**
 * MCP server over stdio. stdout carries the protocol, so all logs go to stderr.
 *
 *   discordctl-mcp [--allow-apply] [--state <path>] [--root <dir>] [--approval cli|elicitation-or-cli]
 */
const { values } = parseArgs({
  options: {
    "allow-apply": { type: "boolean", default: false },
    state: { type: "string" },
    root: { type: "string" },
    profile: { type: "string", default: "default" },
    "env-file": { type: "string" },
    approval: { type: "string" },
    verbose: { type: "boolean", default: false },
  },
});

loadEnvFile(values["env-file"]);
const env = process.env;
const logger = createLogger(values.verbose ? "debug" : "warn");
const allowApply = values["allow-apply"] || env[`${ENV_PREFIX}_MCP_ALLOW_APPLY`] === "1";
const approval = (values.approval ?? env[`${ENV_PREFIX}_MCP_APPROVAL`] ?? "elicitation-or-cli") as "cli" | "elicitation-or-cli";
const ttlSeconds = Number(env[`${ENV_PREFIX}_PLAN_TTL_SECONDS`] ?? 900);
const allowedGuilds = env[`${ENV_PREFIX}_ALLOWED_GUILDS`]?.split(",").map((s) => s.trim()).filter(Boolean);

const { token } = resolveToken(values.profile);
const store = new StateStore(values.state ? resolve(values.state) : defaultStatePath());
const service = new DiscordctlService({
  api: new RestDiscordApi({ token, logger }),
  store,
  logger,
  sandboxRoot: resolve(values.root ?? env[`${ENV_PREFIX}_MCP_ROOT`] ?? process.cwd()),
  ...(allowedGuilds?.length ? { allowedGuilds } : {}),
});

const server = createMcpServer({ service, allowApply, approval, planTtlMs: Math.min(Math.max(ttlSeconds, 60), 3600) * 1000 });
await server.connect(new StdioServerTransport());
logger.info(`MCP server ready (${allowApply ? "apply enabled" : "read-only"})`);

const shutdown = () => {
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
