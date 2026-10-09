import { describe, it, expect, vi } from "vitest";
import { setup, desiredFrom, apply, plan, GUILD_ID } from "./helpers.js";
import { executePlan } from "../src/engine/executor.js";
import { withRetry } from "../src/engine/retry.js";
import { DiscordApiError } from "../src/util/errors.js";
import { DiscordctlService } from "../src/service.js";
import { fetchSnapshot } from "../src/provider/normalize.js";

const base = `version: 1\nguild: { id: "\${DISCORD_GUILD_ID}" }\n`;
const CONFIG = base + `
roles: [{ key: a, name: Alpha }, { key: b, name: Beta }]
categories:
  - key: cat
    name: Cat
    permissions: { a: { view: allow } }
    channels: [{ key: one, name: one }, { key: two, name: two }]
`;
const rateLimited = (ms: number) => () => new DiscordApiError({ status: 429, message: "rate limited", retryAfterMs: ms });
const serverError = () => new DiscordApiError({ status: 502, message: "bad gateway" });

describe("retry policy", () => {
  it("honors retry_after and stops after maxAttempts", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw rateLimited(1234)(); }, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 5000 }, { sleep: async (ms) => void sleeps.push(ms) }),
    ).rejects.toThrow(/rate limited/);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1234, 1234]);
  });

  it("uses bounded exponential backoff for 5xx", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const r = await withRetry(async () => { if (++n < 4) throw serverError(); return "ok"; }, { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 250 }, { sleep: async (ms) => void sleeps.push(ms), random: () => 1 });
    expect(r).toEqual({ value: "ok", attempts: 4 });
    expect(sleeps).toEqual([100, 200, 250]);
  });

  it("never retries client errors", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new DiscordApiError({ status: 403, discordCode: 50013, message: "Missing Permissions" }); })).rejects.toThrow();
    expect(n).toBe(1);
  });
});

describe("execution", () => {
  it("recovers from rate limits during apply", async () => {
    const { api, store } = setup();
    api.failNext("createRole", rateLimited(500), 2);
    const sleep = vi.fn(async () => {});
    const desired = desiredFrom(CONFIG);
    const { plan: p, snapshot } = await plan(api, store, desired);
    const report = await executePlan(p, { api, snapshot, store, sleep });
    expect(report.status).toBe("success");
    expect(sleep).toHaveBeenCalledWith(500);
    expect(report.results[0]!.attempts).toBe(3);
  });

  it("does not duplicate a create that succeeded despite an ambiguous error", async () => {
    const { api, store } = setup();
    const original = api.createRole.bind(api);
    let first = true;
    api.createRole = async (...args) => {
      const r = await original(...args);
      if (first) { first = false; throw serverError(); } // Discord created it but the response was lost
      return r;
    };
    const { report } = await apply(api, store, desiredFrom(CONFIG));
    expect(report.status).toBe("success");
    expect(api.rawGuild(GUILD_ID).roles.filter((r) => r.name === "Alpha")).toHaveLength(1);
  });

  it("reports partial failure, skips dependents and converges on re-run", async () => {
    const { api, store } = setup();
    api.failNext("createChannel", () => new DiscordApiError({ status: 400, discordCode: 50035, message: "Invalid Form Body" }), 1, (args) => (args[1] as { name: string }).name === "Cat");
    const desired = desiredFrom(CONFIG);
    const { plan: p, snapshot } = await plan(api, store, desired);
    const report = await executePlan(p, { api, snapshot, store, sleep: async () => {} });
    expect(report.status).toBe("partial");
    expect(report.results.find((r) => r.opId === "channel.create:cat")!.status).toBe("failed");
    expect(report.results.find((r) => r.opId === "channel.create:one")!.status).toBe("skipped");
    // completed roles are already in state
    expect(store.getMapping(GUILD_ID, "role", "a")).toBeDefined();

    const retry = await apply(api, store, desired);
    expect(retry.plan.ops.some((o) => o.id.startsWith("role.create"))).toBe(false);
    expect(retry.report.status).toBe("success");
    expect(api.rawGuild(GUILD_ID).roles.filter((r) => r.name === "Alpha")).toHaveLength(1);
    expect((await plan(api, store, desired)).plan.ops).toEqual([]);
  });

  it("continues with independent operations when asked", async () => {
    const { api, store } = setup();
    api.failNext("createRole", () => new DiscordApiError({ status: 400, message: "nope" }), 1);
    const { plan: p, snapshot } = await plan(api, store, desiredFrom(base + "roles: [{ key: a, name: A }]\nchannels: [{ key: c, name: c }]"));
    const report = await executePlan(p, { api, snapshot, store, continueOnError: true });
    expect(report.results.map((r) => r.status)).toEqual(["failed", "applied"]);
  });

  it("is not stale when Discord merely returns collections in a different order", async () => {
    const { api, store } = setup(["COMMUNITY", "NEWS", "GUILD_ONBOARDING"]);
    const service = new DiscordctlService({ api, store });
    const cfg = CONFIG.replace("${DISCORD_GUILD_ID}", GUILD_ID);
    await service.apply((await service.plan({ text: cfg })).plan);
    const next = cfg.replace("{ key: two, name: two }", "{ key: two, name: two }, { key: three, name: three }");
    const { plan: p, desired } = await service.plan({ text: next });
    const { report, remaining } = await service.apply(p, { desired });
    expect(report.status).toBe("success");
    expect(remaining!.ops).toEqual([]);
  });

  it("refuses to apply a plan when the guild changed after planning", async () => {
    const { api, store } = setup();
    const service = new DiscordctlService({ api, store });
    const { plan: p } = await service.plan({ text: CONFIG.replace("${DISCORD_GUILD_ID}", GUILD_ID) });
    await api.createRole(GUILD_ID, { name: "sneaky" });
    await expect(service.apply(p)).rejects.toThrow(/changed since this plan/);
    expect(api.rawGuild(GUILD_ID).roles.some((r) => r.name === "Alpha")).toBe(false);
  });

  it("refuses plans with errors or unauthorized deletions", async () => {
    const { api, store } = setup();
    const { plan: p, snapshot } = await plan(api, store, desiredFrom(CONFIG));
    await expect(executePlan({ ...p, diagnostics: [{ severity: "error", code: "X", message: "x" }] }, { api, snapshot })).rejects.toThrow(/errors/);
    const del = { ...p, ops: [{ ...p.ops[0]!, destructive: true }], allowDelete: false };
    await expect(executePlan(del, { api, snapshot })).rejects.toThrow(/deletions/);
  });

  it("refuses to touch resources from another guild", async () => {
    const { api, store } = setup();
    const other = api.addGuild({ id: "222222222222222222", name: "Other" });
    const foreign = await api.createChannel("222222222222222222", { name: "theirs", type: 0 });
    const { plan: p, snapshot } = await plan(api, store, desiredFrom(CONFIG));
    const evil = { ...p, ops: [{ ...p.ops[0]!, payload: { type: "channel.delete" as const, channelId: foreign.id } }] };
    const report = await executePlan(evil, { api, snapshot, store });
    expect(report.results[0]!.error?.message).toMatch(/does not belong/);
    expect(other.channels).toHaveLength(1);
  });

  it("serializes applies per guild with a lock", async () => {
    const { api, store } = setup();
    store.acquireLock(GUILD_ID, "someone-else");
    const { plan: p } = await plan(api, store, desiredFrom(CONFIG));
    const snapshot = await fetchSnapshot(api, GUILD_ID);
    await expect(executePlan(p, { api, snapshot, store })).rejects.toThrow(/locked/);
  });

  it("writes an audit log", async () => {
    const { api, store } = setup();
    await apply(api, store, desiredFrom(CONFIG));
    const log = store.auditLog(GUILD_ID);
    expect(log[0]!.action).toBe("apply");
    expect(log.some((e) => e.action === "role.create:a" && e.status === "applied")).toBe(true);
  });
});
