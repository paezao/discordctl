import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "../src/cli/commands.js";
import { setApiFactory } from "../src/cli/context.js";
import { FakeDiscord } from "../src/provider/fake.js";
import { GUILD_ID } from "./helpers.js";

const TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB";
let dir: string;
let api: FakeDiscord;

async function cli(...args: string[]) {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => (out.push(String(chunk)), true));
  const espy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => (out.push(String(chunk)), true));
  process.exitCode = 0;
  try {
    // An empty env file keeps tests from loading the developer's real ./.env.
    await buildProgram().exitOverride().parseAsync(["node", "discordctl", "--state", join(dir, "state.db"), "--env-file", join(dir, ".env.test"), ...args]);
  } finally {
    spy.mockRestore();
    espy.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = 0;
  return { code, out: out.join("") };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dctl-cli-"));
  writeFileSync(join(dir, ".env.test"), "");
  process.env.DISCORD_TOKEN = TOKEN;
  process.env.DISCORD_GUILD_ID = GUILD_ID;
  api = new FakeDiscord();
  api.addGuild({ id: GUILD_ID, name: "CLI Guild" });
  setApiFactory(() => api);
});
afterEach(() => {
  setApiFactory(undefined);
  delete process.env.DISCORD_TOKEN;
});

describe("CLI", () => {
  it("init writes a template and validate accepts it", async () => {
    const file = join(dir, "discord.yaml");
    expect((await cli("init", "--template", "gaming-community", "--output", file)).code).toBe(0);
    expect(existsSync(file)).toBe(true);
    expect((await cli("init", "--output", file)).code).toBe(1); // refuses to overwrite
    const v = await cli("validate", "--config", file, "--json");
    expect(JSON.parse(v.out).valid).toBe(true);
  });

  it("validate reports errors with exit code 1", async () => {
    const file = join(dir, "bad.yaml");
    writeFileSync(file, `version: 1\nguild: { id: "${GUILD_ID}" }\nchannels: [{ key: x, name: x, permissions: { ghost: { view: deny } } }]\n`);
    const r = await cli("validate", "--config", file);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Unknown permission target "ghost"/);
  });

  it("plan → apply (dry run by default) → apply --yes → plan shows no changes", async () => {
    const file = join(dir, "discord.yaml");
    writeFileSync(file, readFileSync("templates/small-private-team.yaml", "utf8"));
    const p = await cli("plan", "--config", file, "--detailed-exitcode");
    expect(p.code).toBe(2);
    expect(p.out).toMatch(/Plan: \d+ to create/);

    const dry = await cli("apply", "--config", file);
    expect(dry.out).toMatch(/Dry run/);
    expect(api.mutationCalls()).toEqual([]);

    const risky = await cli("apply", "--config", file, "--yes");
    expect(risky.code).toBe(1);
    expect(risky.out).toMatch(/high-risk|critical-risk/);

    const ok = await cli("apply", "--config", file, "--yes", "--allow-high-risk");
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/Verified: Discord now matches/);

    const again = await cli("plan", "--config", file, "--detailed-exitcode");
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/No changes/);
  });

  it("shows step-by-step manual instructions in plan and after apply", async () => {
    const file = join(dir, "discord.yaml");
    writeFileSync(file, `version: 1
guild: { id: "${GUILD_ID}" }
channels:
  - { key: bugs, name: bugs, type: forum, requireTag: true, tags: [{ name: Bug }], postTemplate: "**What happened:**" }
`);
    const p = await cli("plan", "--config", file);
    expect(p.out).toMatch(/Manual steps \(1\)/);
    expect(p.out).toMatch(/a\) Open #bugs in Discord and click "New Post"/);
    expect(p.out).toMatch(/copy from the next line -----\n\*\*What happened:\*\*\n----- end/);

    const a = await cli("apply", "--config", file, "--yes");
    expect(a.code).toBe(0);
    const after = a.out.slice(a.out.indexOf("Apply success"));
    expect(after).toMatch(/Pin Post/);
    expect(after).toMatch(/^\*\*What happened:\*\*$/m);
  });

  it("saved plans refuse to apply after the guild changes", async () => {
    const file = join(dir, "discord.yaml");
    writeFileSync(file, `version: 1\nguild: { id: "${GUILD_ID}" }\nroles: [{ key: a, name: A }]\n`);
    const planFile = join(dir, "plan.json");
    await cli("plan", "--config", file, "--out", planFile);
    await api.createRole(GUILD_ID, { name: "changed" });
    const r = await cli("apply", "--plan", planFile, "--yes");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/changed since this plan/);
  });

  it("export → import → plan is a no-op", async () => {
    await api.createRole(GUILD_ID, { name: "Existing" });
    await api.createChannel(GUILD_ID, { name: "hello", type: 0 });
    const file = join(dir, "exported.yaml");
    expect((await cli("export", "--guild", GUILD_ID, "--output", file)).code).toBe(0);
    const imp = await cli("import", "--config", file, "--json");
    expect(JSON.parse(imp.out).bindings.length).toBeGreaterThan(0);
    const p = await cli("plan", "--config", file, "--json");
    expect(JSON.parse(p.out).plan.ops).toEqual([]);
  });

  it("doctor and audit produce JSON for automation", async () => {
    const d = await cli("doctor", "--guild", GUILD_ID, "--json");
    const checks = JSON.parse(d.out).checks as Array<{ name: string; status: string }>;
    expect(checks.find((c) => c.name === "connectivity")!.status).toBe("ok");
    expect(checks.find((c) => c.name === "least-privilege")).toBeUndefined();
    const a = await cli("audit", "--guild", GUILD_ID, "--json");
    expect(JSON.parse(a.out).guildName).toBe("CLI Guild");
  });

  it("approve marks an agent plan approved", async () => {
    const file = join(dir, "discord.yaml");
    writeFileSync(file, `version: 1\nguild: { id: "${GUILD_ID}" }\nroles: [{ key: a, name: A }]\n`);
    const { DiscordctlService } = await import("../src/service.js");
    const { StateStore } = await import("../src/state/store.js");
    const store = new StateStore(join(dir, "state.db"));
    const { plan } = await new DiscordctlService({ api, store }).plan({ path: file });
    store.savePlan({ id: plan.id, guildId: GUILD_ID, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), configHash: plan.configHash, fingerprint: plan.fingerprint, planJson: JSON.stringify(plan), status: "pending", approvedAt: null, approvedBy: null, origin: "mcp" });
    store.close();
    expect((await cli("approve", plan.id, "--yes")).code).toBe(0);
    const applied = await cli("apply", "--plan-id", plan.id, "--yes");
    expect(applied.code).toBe(0);
    expect(api.rawGuild(GUILD_ID).roles.some((r) => r.name === "A")).toBe(true);
  });

  it("uses DISCORD_GUILD_ID when --guild is omitted", async () => {
    const audit = await cli("audit", "--json");
    expect(audit.code).toBe(0);
    expect(JSON.parse(audit.out).guildId).toBe(GUILD_ID);
    expect(JSON.parse((await cli("inspect", "--json")).out).guild.id).toBe(GUILD_ID);
    expect((await cli("state", "list")).code).toBe(0);
    const doctor = JSON.parse((await cli("doctor", "--json")).out).checks as Array<{ name: string; status: string }>;
    expect(doctor.find((c) => c.name === "guild-access")!.status).toBe("ok");
  });

  it("prefers --guild, then the config's guild, over DISCORD_GUILD_ID", async () => {
    const other = "222222222222222222";
    api.addGuild({ id: other, name: "Other" });
    expect(JSON.parse((await cli("audit", "--guild", other, "--json")).out).guildId).toBe(other);
    const file = join(dir, "other.yaml");
    writeFileSync(file, `version: 1\nguild: { id: "${other}" }\n`);
    expect(JSON.parse((await cli("audit", "--config", file, "--json")).out).guildId).toBe(other);
  });

  it("explains how to choose a guild when none is set", async () => {
    delete process.env.DISCORD_GUILD_ID;
    const r = await cli("audit");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/No guild given/);
    expect(r.out).toMatch(/DISCORD_GUILD_ID in \.env/);
  });

  it("errors are reported as JSON with --json", async () => {
    const r = await cli("plan", "--config", join(dir, "missing.yaml"), "--json");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).error.message).toMatch(/not found/);
  });

  it("never prints the token", async () => {
    const r = await cli("inspect", "--guild", GUILD_ID, "--json");
    expect(r.out).not.toContain(TOKEN);
  });
});
