import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { DiscordApi } from "../provider/api.js";
import type { DiscordctlService } from "../service.js";
import { normalizeToken, resolveToken, saveToken } from "../auth/credentials.js";
import { inviteUrl, requiredBotPermissions, describeRequirement } from "../permissions/requirements.js";
import { hasErrors } from "../core/diagnostics.js";
import type { Colors } from "../plan/format.js";
import { DiscordctlError, errorMessage } from "../util/errors.js";
import { PRODUCT_NAME } from "../core/constants.js";

/**
 * Guided first-time setup. Discord has no API for creating applications or approving bot
 * invites, so those steps stay manual; the wizard opens the right pages, validates every
 * input, and waits for Discord to confirm each step.
 */

export interface WizardIO {
  print(text?: string): void;
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  /** Try to open a URL in a browser. Returns false if it could not. */
  openUrl(url: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface SetupOptions {
  profile: string;
  config?: string;
  guild?: string;
  browser: boolean;
  wait: boolean;
  timeoutMs: number;
  /** File to record DISCORD_GUILD_ID in (never the token). */
  envFile: string;
}

export interface SetupDeps {
  io: WizardIO;
  c: Colors;
  createApi(token: string): DiscordApi;
  /** Service bound to an API for the validated token (used for doctor). */
  createService(api: DiscordApi): DiscordctlService;
}

export interface SetupResult {
  botId: string;
  botName: string;
  guildId?: string;
  ready: boolean;
}

const PORTAL_URL = "https://discord.com/developers/applications";
const POLL_MS = 3000;
const SNOWFLAKE = /^\d{17,20}$/;

export async function runSetup(opts: SetupOptions, deps: SetupDeps): Promise<SetupResult> {
  const { io, c } = deps;
  const step = (n: number, title: string) => io.print(`\n${c.bold(`Step ${n}/4 · ${title}`)}`);
  const ok = (text: string) => io.print(`${c.green("✓")} ${text}`);
  const yes = async (q: string, def = true) => {
    const a = (await io.ask(`${q} ${def ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    return a === "" ? def : a === "y" || a === "yes";
  };

  io.print(c.bold(`${PRODUCT_NAME} setup`));
  io.print(c.dim("Connects a Discord bot you own to your server. Bot tokens only: never paste your account password or user token."));

  // ---------------------------------------------------------------- 1. token
  step(1, "Bot token");
  let token: string | undefined;
  let api: DiscordApi | undefined;
  let me: { id: string; username: string } | undefined;

  const existing = tryResolveToken(opts.profile);
  if (existing) {
    const candidate = deps.createApi(existing.token);
    try {
      const user = await candidate.getCurrentUser();
      if (user.bot && (await yes(`Found a working token for bot ${c.bold(user.username)} (${existing.source}). Use it?`))) {
        token = existing.token;
        api = candidate;
        me = user;
      }
    } catch (e) {
      io.print(c.yellow(`The configured token (${existing.source}) does not work: ${errorMessage(e)}`));
    }
  }

  if (!token) {
    io.print("Create a bot in the Discord Developer Portal:");
    io.print(`  1. ${c.bold("New Application")} → give it a name (e.g. "My Server Config").`);
    io.print(`  2. Open ${c.bold("Bot")} → ${c.bold("Reset Token")} → copy the token.`);
    io.print(`  3. Turn ${c.bold("Public Bot")} off. Leave all Privileged Gateway Intents off (not needed).`);
    await openOrShow(PORTAL_URL);
    for (let attempt = 1; !token; attempt++) {
      const raw = await io.askSecret("Paste the bot token (input hidden): ");
      try {
        const candidate = normalizeToken(raw);
        const candidateApi = deps.createApi(candidate);
        const user = await candidateApi.getCurrentUser();
        if (!user.bot) throw new DiscordctlError("NOT_A_BOT", "That token belongs to a user account. Only bot tokens are supported.");
        token = candidate;
        api = candidateApi;
        me = user;
      } catch (e) {
        io.print(c.red(`✗ ${errorMessage(e)}`));
        if (attempt >= 3) throw new DiscordctlError("SETUP_ABORTED", "No valid bot token after 3 attempts", { hint: `Re-run \`${PRODUCT_NAME} setup\` when you have the token.` });
      }
    }
    const path = saveToken(token, opts.profile, { botUserId: me!.id, botName: me!.username });
    ok(`Saved token to ${path} (readable only by you, profile "${opts.profile}")`);
  }
  ok(`Authenticated as bot ${c.bold(me!.username)} (${me!.id})`);

  // ---------------------------------------------------------------- 2. permissions + invite
  step(2, "Invite the bot to your server");
  let permissions = requiredBotPermissions();
  let guildId = opts.guild;
  const service = deps.createService(api!);
  if (opts.config) {
    const { desired, diagnostics } = service.loadDesired({ path: opts.config }, opts.guild);
    if (hasErrors(diagnostics)) {
      throw new DiscordctlError("CONFIG_INVALID", `${opts.config} has errors`, { hint: `Run \`${PRODUCT_NAME} validate --config ${opts.config}\`.` });
    }
    permissions = requiredBotPermissions(desired);
    guildId ??= desired.guildId;
    io.print(`Requesting the permissions ${opts.config} needs: ${c.dim(describeRequirement(permissions).join(", "))}`);
  } else {
    io.print(c.dim(`Requesting base permissions. Re-run with --config <file> to request exactly what a config needs.`));
  }
  if (guildId && !SNOWFLAKE.test(guildId)) throw new DiscordctlError("INVALID_GUILD", `"${guildId}" is not a guild ID`);

  const before = new Set((await api!.listGuilds()).map((g) => g.id));
  if (guildId && before.has(guildId)) {
    ok(`The bot is already in guild ${guildId}`);
  } else {
    const url = inviteUrl(me!.id, permissions, guildId);
    io.print("Open this link, choose your server and click Authorize (you need Manage Server there):");
    await openOrShow(url);

    if (!opts.wait) {
      io.print(c.dim("Not waiting (--no-wait). Run `discordctl doctor` after inviting the bot."));
      return { botId: me!.id, botName: me!.username, ...(guildId ? { guildId } : {}), ready: false };
    }
    io.print(c.dim(`Waiting for the bot to join${guildId ? ` guild ${guildId}` : ""}… (Ctrl+C to stop)`));
    const deadline = io.now() + opts.timeoutMs;
    let joined: { id: string; name: string } | undefined;
    while (!joined) {
      if (io.now() > deadline) {
        throw new DiscordctlError("SETUP_TIMEOUT", "The bot did not join a server in time", { hint: `Finish the invite, then run \`${PRODUCT_NAME} setup\` again (your token is saved).` });
      }
      await io.sleep(POLL_MS);
      const guilds = await api!.listGuilds();
      joined = guildId ? guilds.find((g) => g.id === guildId) : guilds.find((g) => !before.has(g.id));
    }
    guildId = joined.id;
    ok(`The bot joined ${c.bold(joined.name)} (${joined.id})`);
  }

  // ---------------------------------------------------------------- 3. guild id
  step(3, "Remember the server");
  if (!guildId) {
    const guilds = await api!.listGuilds();
    if (guilds.length === 1) guildId = guilds[0]!.id;
    else if (guilds.length > 1) {
      guilds.forEach((g, i) => io.print(`  ${i + 1}. ${g.name} (${g.id})`));
      const pick = Number(await io.ask("Which server should discordctl manage? Number: "));
      guildId = guilds[pick - 1]?.id;
    }
    if (!guildId) throw new DiscordctlError("NO_GUILD", "The bot is not in any server yet");
  }
  const currentEnv = readEnvVar(opts.envFile, "DISCORD_GUILD_ID");
  if (currentEnv === guildId) ok(`${opts.envFile} already sets DISCORD_GUILD_ID=${guildId}`);
  else if (await yes(`Save DISCORD_GUILD_ID=${guildId} to ${opts.envFile}?`)) {
    writeEnvVar(opts.envFile, "DISCORD_GUILD_ID", guildId);
    ok(`Updated ${opts.envFile} (the token is not written there)`);
  }

  // ---------------------------------------------------------------- 4. role position + doctor
  step(4, "Check permissions and role position");
  io.print(`Discord only lets the bot edit roles below its own. In ${c.bold("Server Settings → Roles")}, drag the bot's role`);
  io.print(`(${c.bold(me!.username)}) above every role your config manages.`);
  const source = opts.config ? { path: opts.config } : undefined;
  let ready = false;
  for (let round = 1; round <= 5; round++) {
    const report = await service.doctor(guildId, source);
    const problems = report.checks.filter((ch) => ch.status === "fail");
    for (const ch of report.checks) {
      const icon = ch.status === "ok" ? c.green("✓") : ch.status === "warn" ? c.yellow("!") : ch.status === "fail" ? c.red("✗") : c.dim("-");
      io.print(`  ${icon} ${ch.name.padEnd(18)} ${ch.detail}${ch.hint && ch.status !== "ok" ? c.dim(`\n    ${"".padEnd(18)} ${ch.hint}`) : ""}`);
    }
    if (problems.length === 0) {
      ready = true;
      break;
    }
    if (!(await yes("Fix the items above, then re-check?"))) break;
  }

  io.print("");
  if (ready) {
    ok(c.bold("Setup complete."));
    io.print("Next:");
    if (opts.config) io.print(`  ${PRODUCT_NAME} plan --config ${opts.config}`);
    else {
      io.print(`  ${PRODUCT_NAME} export --guild ${guildId} --output discord.yaml --guild-var   # start from your server`);
      io.print(`  ${PRODUCT_NAME} init --template gaming-community                               # or from a template`);
    }
  } else {
    io.print(c.yellow(`Setup saved, but some checks still fail. Run \`${PRODUCT_NAME} doctor${opts.config ? ` --config ${opts.config}` : ` --guild ${guildId}`}\` after fixing them.`));
  }
  return { botId: me!.id, botName: me!.username, guildId, ready };

  async function openOrShow(url: string) {
    io.print(`  ${c.cyan(url)}`);
    if (opts.browser && (await io.openUrl(url))) io.print(c.dim("  (opened in your browser)"));
  }
}

function tryResolveToken(profile: string): { token: string; source: string } | undefined {
  try {
    return resolveToken(profile);
  } catch {
    return undefined;
  }
}

export function readEnvVar(file: string, name: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const m = new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\n]*)"?\\s*$`, "m").exec(readFileSync(file, "utf8"));
  return m?.[1] || undefined;
}

/** Set NAME=value in a dotenv file, replacing an existing (possibly commented-out) line. */
export function writeEnvVar(file: string, name: string, value: string): void {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^\\s*#?\\s*${name}\\s*=.*$`, "m");
  const next = pattern.test(text) ? text.replace(pattern, line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  writeFileSync(file, next, { mode: 0o600 });
}

/** Best-effort browser launch; never throws. */
export function openInBrowser(url: string): Promise<boolean> {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.on("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

