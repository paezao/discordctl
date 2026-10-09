import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AuthError } from "../util/errors.js";
import { registerSecret } from "../util/redact.js";
import { ENV_PREFIX, PRODUCT_NAME } from "../core/constants.js";

/**
 * Bot token resolution. Only Discord *bot* tokens are supported: discordctl never asks for user
 * passwords or user tokens.
 *
 * Precedence: DISCORDCTL_TOKEN → DISCORD_TOKEN → DISCORD_BOT_TOKEN → credentials file profile.
 */
export const TOKEN_ENV_VARS = [`${ENV_PREFIX}_TOKEN`, "DISCORD_TOKEN", "DISCORD_BOT_TOKEN"] as const;

export function credentialsPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return process.env[`${ENV_PREFIX}_CREDENTIALS`] || join(base, PRODUCT_NAME, "credentials.json");
}

interface CredentialsFile {
  version: 1;
  profiles: Record<string, { token: string; botUserId?: string; botName?: string; savedAt: string }>;
}

function readFile(): CredentialsFile {
  const path = credentialsPath();
  if (!existsSync(path)) return { version: 1, profiles: {} };
  if (process.platform !== "win32") {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      throw new AuthError(`Credentials file ${path} is readable by other users (mode ${mode.toString(8)})`, { hint: `Run: chmod 600 ${path}` });
    }
  }
  return JSON.parse(readFileSync(path, "utf8")) as CredentialsFile;
}

export interface ResolvedToken {
  token: string;
  source: string;
}

export function resolveToken(profile = "default"): ResolvedToken {
  for (const name of TOKEN_ENV_VARS) {
    const v = process.env[name];
    if (v && v.trim()) {
      const token = normalizeToken(v);
      registerSecret(token);
      return { token, source: `env:${name}` };
    }
  }
  const file = readFile();
  const entry = file.profiles[profile];
  if (entry?.token) {
    registerSecret(entry.token);
    return { token: entry.token, source: `file:${credentialsPath()}#${profile}` };
  }
  throw new AuthError("No Discord bot token configured", {
    hint: `Set DISCORD_TOKEN (e.g. in .env) or run \`${PRODUCT_NAME} login\`.`,
  });
}

export function normalizeToken(raw: string): string {
  const t = raw.trim().replace(/^Bot\s+/i, "");
  if (!/^[A-Za-z0-9_.-]{50,}$/.test(t) || t.split(".").length !== 3) {
    throw new AuthError("That does not look like a Discord bot token", {
      hint: "Copy it from Discord Developer Portal → your application → Bot → Reset Token. Never use a user account token.",
    });
  }
  return t;
}

export function saveToken(token: string, profile = "default", meta: { botUserId?: string; botName?: string } = {}): string {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const file = existsSync(path) ? readFile() : { version: 1 as const, profiles: {} };
  file.profiles[profile] = { token, ...meta, savedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return path;
}

export function removeToken(profile = "default"): boolean {
  const path = credentialsPath();
  if (!existsSync(path)) return false;
  const file = readFile();
  if (!file.profiles[profile]) return false;
  delete file.profiles[profile];
  if (Object.keys(file.profiles).length === 0) unlinkSync(path);
  else writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  return true;
}
