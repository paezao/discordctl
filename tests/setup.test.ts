import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, writeEnvVar, readEnvVar, type WizardIO, type SetupOptions } from "../src/cli/setup.js";
import { FakeDiscord } from "../src/provider/fake.js";
import { DiscordctlService } from "../src/service.js";
import { StateStore } from "../src/state/store.js";
import { NO_COLOR } from "../src/plan/format.js";
import { GUILD_ID } from "./helpers.js";

const TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dctl-setup-"));
  process.env.DISCORDCTL_CREDENTIALS = join(dir, "credentials.json");
  for (const v of ["DISCORD_TOKEN", "DISCORDCTL_TOKEN", "DISCORD_BOT_TOKEN"]) delete process.env[v];
});
afterEach(() => {
  delete process.env.DISCORDCTL_CREDENTIALS;
  delete process.env.DISCORD_TOKEN;
});

interface Script {
  answers?: string[];
  secrets?: string[];
  onSleep?: (n: number) => void;
  onAsk?: (q: string) => void;
}

function harness(api: FakeDiscord, script: Script, overrides: Partial<SetupOptions> = {}) {
  const out: string[] = [];
  const opened: string[] = [];
  let clock = 0;
  let sleeps = 0;
  const answers = [...(script.answers ?? [])];
  const secrets = [...(script.secrets ?? [])];
  const io: WizardIO = {
    print: (t = "") => void out.push(t),
    ask: async (q) => {
      out.push(q);
      script.onAsk?.(q);
      return answers.shift() ?? "";
    },
    askSecret: async () => secrets.shift() ?? "",
    openUrl: async (u) => (opened.push(u), true),
    sleep: async (ms) => {
      clock += ms;
      script.onSleep?.(++sleeps);
    },
    now: () => clock,
  };
  const store = StateStore.memory();
  const opts: SetupOptions = { profile: "default", browser: true, wait: true, timeoutMs: 60_000, envFile: join(dir, ".env"), ...overrides };
  const run = () =>
    runSetup(opts, { io, c: NO_COLOR, createApi: () => api, createService: (a) => new DiscordctlService({ api: a, store }) });
  return { run, out, opened };
}

describe("setup wizard", () => {
  it("walks a first-time user from token to a verified server", async () => {
    const api = new FakeDiscord();
    const h = harness(api, {
      secrets: ["not-a-token", TOKEN],
      answers: ["y"], // save DISCORD_GUILD_ID
      onSleep: (n) => {
        if (n === 2) api.addGuild({ id: GUILD_ID, name: "My Server" }); // user clicks Authorize
      },
    });
    const r = await h.run();

    expect(r).toMatchObject({ guildId: GUILD_ID, ready: true });
    const text = h.out.join("\n");
    expect(text).toMatch(/does not look like a Discord bot token/);
    expect(text).toMatch(/The bot joined My Server/);
    expect(text).toMatch(/Setup complete/);
    expect(h.opened[0]).toBe("https://discord.com/developers/applications");
    expect(h.opened[1]).toMatch(/^https:\/\/discord\.com\/oauth2\/authorize\?client_id=\d+&scope=bot&permissions=\d+$/);

    const creds = process.env.DISCORDCTL_CREDENTIALS!;
    expect(JSON.parse(readFileSync(creds, "utf8")).profiles.default.token).toBe(TOKEN);
    if (process.platform !== "win32") expect(statSync(creds).mode & 0o777).toBe(0o600);
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toBe(`DISCORD_GUILD_ID=${GUILD_ID}\n`);
    expect(env).not.toContain(TOKEN);
  });

  it("reuses a working token and skips the invite when the bot is already in the guild", async () => {
    process.env.DISCORD_TOKEN = TOKEN;
    const api = new FakeDiscord();
    api.addGuild({ id: GUILD_ID, name: "Existing" });
    const h = harness(api, { answers: ["", "n"] }, { guild: GUILD_ID });
    const r = await h.run();
    expect(r.ready).toBe(true);
    expect(h.out.join("\n")).toMatch(/already in guild/);
    expect(h.opened).toEqual([]);
  });

  it("rejects user-account tokens", async () => {
    const api = new FakeDiscord();
    (api.botUser as { bot?: boolean }).bot = false;
    const h = harness(api, { secrets: [TOKEN, TOKEN, TOKEN] });
    await expect(h.run()).rejects.toThrow(/No valid bot token after 3 attempts/);
    expect(h.out.join("\n")).toMatch(/belongs to a user account/);
  });

  it("requests exactly the permissions a config needs, preselecting its guild", async () => {
    const api = new FakeDiscord();
    const cfg = join(dir, "discord.yaml");
    writeFileSync(cfg, `version: 1\nguild: { id: "${GUILD_ID}" }\nroles: [{ key: m, name: Mod, permissions: [KickMembers] }]\n`);
    const h = harness(api, { secrets: [TOKEN], answers: ["n"], onSleep: () => void (api.guilds.size || api.addGuild({ id: GUILD_ID, name: "G" })) }, { config: cfg });
    const r = await h.run();
    expect(r.ready).toBe(true);
    const invite = new URL(h.opened[1]!);
    expect(invite.searchParams.get("guild_id")).toBe(GUILD_ID);
    expect(BigInt(invite.searchParams.get("permissions")!) & 2n).toBe(2n); // KickMembers
    expect(h.out.join("\n")).toMatch(/discordctl plan --config/);
  });

  it("times out if the bot never joins", async () => {
    const api = new FakeDiscord();
    const h = harness(api, { secrets: [TOKEN] }, { timeoutMs: 10_000 });
    await expect(h.run()).rejects.toThrow(/did not join a server in time/);
  });

  it("does not wait with --no-wait", async () => {
    const api = new FakeDiscord();
    const r = await harness(api, { secrets: [TOKEN] }, { wait: false }).run();
    expect(r.ready).toBe(false);
  });

  it("re-checks after the user fixes the bot's role position", async () => {
    const api = new FakeDiscord();
    const g = api.addGuild({ id: GUILD_ID, name: "G" });
    g.roles.push({ id: "500000000000000001", name: "Mod", color: 0, hoist: false, mentionable: false, managed: false, permissions: "0", position: 5, flags: 0 });
    const cfg = join(dir, "discord.yaml");
    writeFileSync(cfg, `version: 1\nguild: { id: "${GUILD_ID}" }\nroles: [{ key: m, name: Mod }]\n`);
    const h = harness(api, {
      secrets: [TOKEN],
      answers: ["n", "y"], // don't save .env; re-check after fixing
      onAsk: (q) => {
        if (q.startsWith("Fix the items above")) g.roles.find((r) => r.name === "Mod")!.position = 0.5; // dragged below the bot
      },
    }, { config: cfg });
    const r = await h.run();
    const text = h.out.join("\n");
    expect(text).toMatch(/✗ role-hierarchy/);
    expect(r.ready).toBe(true);
  });
});

describe(".env helpers", () => {
  it("replaces existing or commented lines and appends otherwise", () => {
    const f = join(mkdtempSync(join(tmpdir(), "dctl-env-")), ".env");
    writeFileSync(f, "DISCORD_TOKEN=\n# DISCORD_GUILD_ID=\nOTHER=1");
    writeEnvVar(f, "DISCORD_GUILD_ID", GUILD_ID);
    expect(readFileSync(f, "utf8")).toBe(`DISCORD_TOKEN=\nDISCORD_GUILD_ID=${GUILD_ID}\nOTHER=1`);
    expect(readEnvVar(f, "DISCORD_GUILD_ID")).toBe(GUILD_ID);
    writeEnvVar(f, "NEW_VAR", "x");
    expect(readFileSync(f, "utf8").endsWith("OTHER=1\nNEW_VAR=x\n")).toBe(true);
  });
});
