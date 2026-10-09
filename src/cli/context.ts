import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { RestDiscordApi } from "../provider/rest.js";
import { resolveToken } from "../auth/credentials.js";
import { StateStore } from "../state/store.js";
import { DiscordctlService } from "../service.js";
import { createLogger, type Logger } from "../util/logger.js";
import { colors, type Colors } from "../plan/format.js";
import { ENV_PREFIX, STATE_DIR_NAME } from "../core/constants.js";
import type { DiscordApi } from "../provider/api.js";
import { OfflineApi } from "../provider/offline.js";

export interface GlobalOptions {
  state?: string;
  profile?: string;
  json?: boolean;
  color?: boolean;
  verbose?: boolean;
  envFile?: string;
}

export interface CliContext {
  opts: GlobalOptions;
  c: Colors;
  logger: Logger;
  json: boolean;
  /** Lazily creates the Discord client (only commands that need Discord resolve a token). */
  service(): DiscordctlService;
  /** Discord client for an explicit token (login/setup), honoring the test seam. */
  createApi(token: string): DiscordApi;
  /** Service for commands that only read config files (no token required). */
  offlineService(): DiscordctlService;
  store(): StateStore;
  close(): void;
}

/** Test seam: lets tests inject a fake Discord API into the CLI. */
let apiFactory: ((token: string, logger: Logger) => DiscordApi) | undefined;
export function setApiFactory(f: typeof apiFactory): void {
  apiFactory = f;
}

function makeApi(token: string, logger: Logger): DiscordApi {
  return apiFactory ? apiFactory(token, logger) : new RestDiscordApi({ token, logger });
}

export function defaultStatePath(): string {
  return process.env[`${ENV_PREFIX}_STATE`] || join(process.cwd(), STATE_DIR_NAME, "state.db");
}

export function loadEnvFile(path?: string): void {
  const file = path ?? (existsSync(".env") ? ".env" : undefined);
  if (!file) return;
  if (!existsSync(file)) throw new Error(`env file not found: ${file}`);
  process.loadEnvFile(resolve(file));
}

export function createContext(opts: GlobalOptions): CliContext {
  const json = Boolean(opts.json);
  const useColor = opts.color !== false && !json && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const logger = createLogger(opts.verbose ? "debug" : json ? "error" : "warn");
  let store: StateStore | undefined;
  let service: DiscordctlService | undefined;
  const getStore = () => (store ??= new StateStore(opts.state ? resolve(opts.state) : defaultStatePath()));
  return {
    opts,
    c: colors(useColor),
    logger,
    json,
    store: getStore,
    service() {
      if (!service) {
        const { token } = resolveToken(opts.profile);
        const api = makeApi(token, logger);
        const allowed = process.env[`${ENV_PREFIX}_ALLOWED_GUILDS`]?.split(",").map((s) => s.trim()).filter(Boolean);
        service = new DiscordctlService({ api, store: getStore(), logger, ...(allowed?.length ? { allowedGuilds: allowed } : {}) });
      }
      return service;
    },
    createApi: (token: string) => makeApi(token, logger),
    offlineService() {
      return new DiscordctlService({ api: new OfflineApi(), store: getStore(), logger });
    },
    close() {
      store?.close();
    },
  };
}
