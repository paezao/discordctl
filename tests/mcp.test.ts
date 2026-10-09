import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, type McpOptions } from "../src/mcp/server.js";
import { DiscordctlService } from "../src/service.js";
import { setup, GUILD_ID } from "./helpers.js";
import { registerSecret } from "../src/util/redact.js";

const CONFIG = `version: 1
guild: { id: "${GUILD_ID}" }
roles: [{ key: mod, name: Moderator, permissions: [KickMembers] }]
categories:
  - { key: c, name: Community, channels: [{ key: general, name: general }] }
`;
const RISKY = CONFIG.replace("permissions: [KickMembers]", "permissions: [ManageGuild, ManageRoles]");

async function connect(opts: Partial<McpOptions> & { elicit?: "accept" | "decline"; allowedGuilds?: string[]; sandboxRoot?: string } = {}) {
  const { api, store } = setup();
  const service = new DiscordctlService({ api, store, ...(opts.allowedGuilds ? { allowedGuilds: opts.allowedGuilds } : {}), ...(opts.sandboxRoot ? { sandboxRoot: opts.sandboxRoot } : {}) });
  const server = createMcpServer({ service, ...opts });
  const client = new Client({ name: "test", version: "1" }, { capabilities: opts.elicit ? { elicitation: {} } : {} });
  if (opts.elicit) {
    client.setRequestHandler(ElicitRequestSchema, async () =>
      opts.elicit === "accept" ? { action: "accept", content: { confirm: true } } : { action: "decline" },
    );
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    return { isError: Boolean(r.isError), data: JSON.parse(text), text };
  };
  return { api, store, client, call };
}

describe("MCP server", () => {
  it("is read-only by default", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      "discord_list_guilds", "discord_inspect_guild", "discord_list_roles", "discord_list_channels", "discord_get_permissions",
      "discord_export_config", "discord_validate_config", "discord_plan_changes", "discord_audit_permissions", "discord_check_bot_capabilities",
    ]));
    expect(names).not.toContain("discord_apply_plan");
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("separates the mutation tool and marks it destructive", async () => {
    const { client } = await connect({ allowApply: true });
    const apply = (await client.listTools()).tools.find((t) => t.name === "discord_apply_plan")!;
    expect(apply.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(Object.keys((apply.inputSchema as { properties: object }).properties)).toEqual(["planId"]);
  });

  it("inspects, validates and plans without mutating Discord", async () => {
    const { api, call } = await connect();
    const inspect = await call("discord_inspect_guild", { guildId: GUILD_ID });
    expect(inspect.data.guild.name).toBe("Test Guild");
    const v = await call("discord_validate_config", { configYaml: CONFIG });
    expect(v.data.valid).toBe(true);
    const p = await call("discord_plan_changes", { configYaml: CONFIG });
    expect(p.data.planId).toMatch(/^plan_/);
    expect(p.data.text).toContain("Create role: Moderator");
    expect(p.data.nextStep).toMatch(/read-only/);
    expect(api.mutationCalls()).toEqual([]);
  });

  it("requires out-of-band approval when the client cannot confirm", async () => {
    const { call, store, api } = await connect({ allowApply: true });
    const { data } = await call("discord_plan_changes", { configYaml: CONFIG });
    const denied = await call("discord_apply_plan", { planId: data.planId });
    expect(denied.isError).toBe(true);
    expect(denied.data.code).toBe("APPROVAL_REQUIRED");
    expect(denied.data.hint).toContain(`approve ${data.planId}`);
    expect(api.mutationCalls()).toEqual([]);

    store.setPlanStatus(data.planId, "approved", "cli:test");
    const ok = await call("discord_apply_plan", { planId: data.planId });
    expect(ok.data.status).toBe("success");
    expect(store.getPlan(data.planId)!.status).toBe("applied");
    // a plan cannot be replayed
    expect((await call("discord_apply_plan", { planId: data.planId })).data.code).toBe("PLAN_NOT_PENDING");
  });

  it("asks the user through elicitation and respects a decline", async () => {
    const accepted = await connect({ allowApply: true, elicit: "accept" });
    const p1 = await accepted.call("discord_plan_changes", { configYaml: CONFIG });
    expect((await accepted.call("discord_apply_plan", { planId: p1.data.planId })).data.status).toBe("success");

    const declined = await connect({ allowApply: true, elicit: "decline" });
    const p2 = await declined.call("discord_plan_changes", { configYaml: CONFIG });
    const r = await declined.call("discord_apply_plan", { planId: p2.data.planId });
    expect(r.data.code).toBe("NOT_APPROVED");
    expect(declined.api.mutationCalls()).toEqual([]);
  });

  it("never accepts elicitation for high-risk plans", async () => {
    const { call, api } = await connect({ allowApply: true, elicit: "accept" });
    const p = await call("discord_plan_changes", { configYaml: RISKY });
    expect(p.data.nextStep).toMatch(/approved by the user from a terminal/);
    const r = await call("discord_apply_plan", { planId: p.data.planId });
    expect(r.data.code).toBe("APPROVAL_REQUIRED");
    expect(api.mutationCalls()).toEqual([]);
  });

  it("applies a plan at most once even under concurrent calls", async () => {
    const { call, store, api } = await connect({ allowApply: true });
    const { data } = await call("discord_plan_changes", { configYaml: CONFIG });
    store.setPlanStatus(data.planId, "approved", "cli");
    const results = await Promise.all([call("discord_apply_plan", { planId: data.planId }), call("discord_apply_plan", { planId: data.planId })]);
    expect(results.filter((r) => r.data.status === "success")).toHaveLength(1);
    expect(results.filter((r) => r.data.code === "PLAN_NOT_PENDING")).toHaveLength(1);
    expect(api.rawGuild(GUILD_ID).roles.filter((r) => r.name === "Moderator")).toHaveLength(1);
  });

  it("consumes a plan when apply fails for any reason", async () => {
    const { call, store, api } = await connect({ allowApply: true });
    const { data } = await call("discord_plan_changes", { configYaml: CONFIG });
    store.setPlanStatus(data.planId, "approved", "cli");
    api.failNext("getCurrentUser", () => new Error("network down"));
    expect((await call("discord_apply_plan", { planId: data.planId })).isError).toBe(true);
    expect(store.getPlan(data.planId)!.status).toBe("failed");
  });

  it("rejects expired plans", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const { call, store } = await connect({ allowApply: true, now: () => now, planTtlMs: 60_000 });
    const { data } = await call("discord_plan_changes", { configYaml: CONFIG });
    store.setPlanStatus(data.planId, "approved", "cli");
    now = new Date("2026-01-01T00:02:00Z");
    expect((await call("discord_apply_plan", { planId: data.planId })).data.code).toBe("PLAN_EXPIRED");
  });

  it("rejects plans when Discord changed after planning", async () => {
    const { call, store, api } = await connect({ allowApply: true });
    const { data } = await call("discord_plan_changes", { configYaml: CONFIG });
    store.setPlanStatus(data.planId, "approved", "cli");
    await api.createChannel(GUILD_ID, { name: "surprise", type: 0 });
    const r = await call("discord_apply_plan", { planId: data.planId });
    expect(r.data.code).toBe("STATE_CHANGED");
  });

  it("enforces the allowed-guild list", async () => {
    const { call } = await connect({ allowedGuilds: ["999999999999999999"] });
    const r = await call("discord_inspect_guild", { guildId: GUILD_ID });
    expect(r.data.code).toBe("GUILD_NOT_ALLOWED");
    expect((await call("discord_list_guilds")).data.guilds).toEqual([]);
  });

  it("restricts config paths to the sandbox root", async () => {
    const root = mkdtempSync(join(tmpdir(), "dctl-mcp-"));
    writeFileSync(join(root, "ok.yaml"), CONFIG);
    const { call } = await connect({ sandboxRoot: root });
    expect((await call("discord_validate_config", { configPath: "ok.yaml" })).data.valid).toBe(true);
    const r = await call("discord_validate_config", { configPath: "../../../etc/hosts" });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatch(/outside the allowed directory/);
  });

  it("never exposes the bot token", async () => {
    const token = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB";
    registerSecret(token);
    const { call, api } = await connect();
    api.failNext("getGuild", () => new Error(`boom Authorization: Bot ${token}`));
    const r = await call("discord_inspect_guild", { guildId: GUILD_ID });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain(token);
  });
});
