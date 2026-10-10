import { describe, it, expect } from "vitest";
import { setup, desiredFrom, apply, plan, GUILD_ID } from "./helpers.js";
import { DiscordctlService } from "../src/service.js";
import { exportConfig } from "../src/export/exporter.js";
import { fetchSnapshot } from "../src/provider/normalize.js";
import { requiredBotPermissions } from "../src/permissions/requirements.js";
import { P } from "../src/permissions/flags.js";
import { StateStore } from "../src/state/store.js";

const channels = ["rules", "general", "lfg", "clips", "memes", "help", "offtopic"];
const base = (onboarding: string, extra = "") => `version: 1
guild: { id: "\${DISCORD_GUILD_ID}" }
roles:
  - { key: events, name: Event Ping }
  - { key: updates, name: Update Ping }
channels:
${channels.map((c) => `  - { key: ${c}, name: ${c}${c === "rules" ? ", permissions: { everyone: { send: deny } }" : ""} }`).join("\n")}
${extra}
onboarding:
${onboarding}`;

const MANAGED = `  manage: true
  defaultChannels: [rules, general, lfg, clips, memes, help, offtopic]
  prompts:
    - title: What do you want to hear about?
      options:
        - { title: Game nights, emoji: "🏆", roles: [events], channels: [lfg] }
        - { title: Patch notes, emoji: "🛠️", roles: [updates] }
`;

describe("onboarding", () => {
  it("is only documented as manual steps unless managed", async () => {
    const { api, store } = setup(["COMMUNITY"]);
    const d = desiredFrom(base(MANAGED.replace("manage: true", "manage: false")));
    expect(d.onboarding).toBeUndefined();
    expect(d.manualSteps.some((s) => s.title === "Server onboarding")).toBe(true);
    const { plan: p } = await plan(api, store, d);
    expect(p.ops.some((o) => o.resource === "onboarding")).toBe(false);
  });

  it("requires the Community feature", async () => {
    const { api, store } = setup();
    const { plan: p } = await plan(api, store, desiredFrom(base(MANAGED)));
    expect(p.diagnostics.find((x) => x.code === "REQUIRES_COMMUNITY" && x.path === "onboarding")?.severity).toBe("error");
  });

  it("applies questions referencing roles and channels created in the same plan, then converges", async () => {
    const { api, store } = setup(["COMMUNITY"]);
    const d = desiredFrom(base(MANAGED));
    const { plan: p, report } = await apply(api, store, d);
    const op = p.ops.find((o) => o.resource === "onboarding")!;
    expect(op.dependsOn).toEqual(expect.arrayContaining(["role.create:events", "channel.create:lfg"]));
    expect(report.status).toBe("success");
    const ob = api.rawGuild(GUILD_ID).onboarding as { prompts: Array<{ title: string; options: Array<{ role_ids: string[] }> }>; default_channel_ids: string[] };
    expect(ob.prompts[0]!.title).toBe("What do you want to hear about?");
    expect(ob.prompts[0]!.options[0]!.role_ids).toHaveLength(1);
    expect(ob.default_channel_ids).toHaveLength(7);
    expect((await plan(api, store, d)).plan.ops).toEqual([]);
  });

  it("keeps Discord's ids for existing questions and answers when editing them", async () => {
    const { api, store } = setup(["COMMUNITY"]);
    await apply(api, store, desiredFrom(base(MANAGED)));
    const before = api.rawGuild(GUILD_ID).onboarding as { prompts: Array<{ id: string; options: Array<{ id: string; title: string }> }> };
    const promptId = before.prompts[0]!.id;
    const optionId = before.prompts[0]!.options.find((o) => o.title === "Game nights")!.id;
    await apply(api, store, desiredFrom(base(MANAGED.replace("{ title: Game nights, emoji: \"🏆\"", "{ title: Game nights, description: Weekly tournaments, emoji: \"🏆\""))));
    const after = api.rawGuild(GUILD_ID).onboarding as typeof before;
    expect(after.prompts[0]!.id).toBe(promptId);
    expect(after.prompts[0]!.options.find((o) => o.title === "Game nights")!.id).toBe(optionId);
  });

  it("leaves enabled untouched when the config does not set it", async () => {
    const { api, store } = setup(["COMMUNITY"]);
    await apply(api, store, desiredFrom(base(MANAGED)));
    (api.rawGuild(GUILD_ID).onboarding as { enabled: boolean }).enabled = true; // enabled by hand in Discord
    const { plan: p } = await plan(api, store, desiredFrom(base(MANAGED)));
    expect(p.ops).toEqual([]);
  });

  it("rates turning onboarding off as high risk", async () => {
    const { api, store } = setup(["COMMUNITY"]);
    await apply(api, store, desiredFrom(base(MANAGED)));
    (api.rawGuild(GUILD_ID).onboarding as { enabled: boolean }).enabled = true;
    const { plan: p } = await plan(api, store, desiredFrom(base(MANAGED.replace("manage: true", "manage: true\n  enabled: false"))));
    const op = p.ops.find((o) => o.resource === "onboarding")!;
    expect(op.risk).toBe("high");
    expect(op.riskReasons.join("|")).toMatch(/turns onboarding off/);
  });

  it("keeps live questions missing from the config unless deletion is allowed", async () => {
    const { api, store } = setup(["COMMUNITY"]);
    await apply(api, store, desiredFrom(base(MANAGED + "    - title: Second question\n      options: [{ title: A }]\n")));
    const smaller = desiredFrom(base(MANAGED.replace("Patch notes", "Release notes")));

    const kept = await apply(api, store, smaller);
    expect(kept.plan.diagnostics.find((d) => d.code === "ORPHANED")?.message).toMatch(/Second question/);
    expect(kept.plan.ops.find((o) => o.resource === "onboarding")!.destructive).toBe(false);
    const titles = () => (api.rawGuild(GUILD_ID).onboarding as { prompts: Array<{ title: string }> }).prompts.map((p) => p.title);
    expect(titles()).toEqual(["What do you want to hear about?", "Second question"]);
    expect((await plan(api, store, smaller)).plan.ops).toEqual([]);

    const { plan: del } = await plan(api, store, smaller, { allowDelete: true });
    const op = del.ops.find((o) => o.resource === "onboarding")!;
    expect(op.destructive).toBe(true);
    expect(op.risk).toBe("high");
    expect(op.riskReasons.join()).toMatch(/removes onboarding question "Second question"/);
  });

  it("refuses to let new members self-assign administrative roles", async () => {
    const { api, store } = setup(["COMMUNITY"]);
    const yaml = base(MANAGED).replace("  - { key: events, name: Event Ping }", "  - { key: events, name: Event Ping, permissions: [ManageRoles] }");
    const { plan: p } = await plan(api, store, desiredFrom(yaml));
    expect(p.diagnostics.find((d) => d.code === "ONBOARDING_GRANTS_ADMIN")?.severity).toBe("error");
  });

  it("rates self-assignable moderation roles as critical", async () => {
    const { api, store } = setup(["COMMUNITY"]);
    const yaml = base(MANAGED).replace("  - { key: events, name: Event Ping }", "  - { key: events, name: Event Ping, tier: staff, permissions: [KickMembers] }");
    const { plan: p } = await plan(api, store, desiredFrom(yaml));
    const op = p.ops.find((o) => o.resource === "onboarding")!;
    expect(op.risk).toBe("critical");
    expect(op.riskReasons.join()).toMatch(/self-assign "Event Ping".*KickMembers/);
  });

  it("enforces Discord's default channel rules before enabling", async () => {
    expect(() => desiredFrom(base(MANAGED.replace("manage: true", "manage: true\n  enabled: true").replace("[rules, general, lfg, clips, memes, help, offtopic]", "[rules, general]")))).toThrow(/ONBOARDING_TOO_FEW_CHANNELS/);

    const { api, store } = setup(["COMMUNITY"]);
    const readOnly = base(MANAGED.replace("manage: true", "manage: true\n  enabled: true")).replace(/name: (general|lfg|clips) \}/g, "name: $1, permissions: { everyone: { send: deny } } }");
    const { plan: p } = await plan(api, store, desiredFrom(readOnly));
    expect(p.diagnostics.find((x) => x.code === "ONBOARDING_CONSTRAINTS")?.message).toMatch(/the config has 7, 3 postable/);
  });

  it("refuses a plan when onboarding changed after planning", async () => {
    const { api, store } = setup(["COMMUNITY"]);
    const service = new DiscordctlService({ api, store });
    const text = base(MANAGED).replace("${DISCORD_GUILD_ID}", GUILD_ID);
    await service.apply((await service.plan({ text })).plan);
    const { plan: p } = await service.plan({ text: text.replace("Patch notes", "Release notes") });
    (api.rawGuild(GUILD_ID).onboarding as { enabled: boolean }).enabled = true;
    await expect(service.apply(p)).rejects.toThrow(/changed since this plan/);
  });

  it("exports live onboarding so re-applying the export changes nothing", async () => {
    const { api, store } = setup(["COMMUNITY"]);
    await apply(api, store, desiredFrom(base(MANAGED)));
    const snapshot = await fetchSnapshot(api, GUILD_ID, { onboarding: true });
    const { yaml } = exportConfig(snapshot);
    expect(yaml).toContain("manage: true");
    const fresh = StateStore.memory();
    const { plan: p } = await plan(api, fresh, desiredFrom(yaml));
    expect(p.ops.filter((o) => o.action !== "import")).toEqual([]);
  });

  it("requires Manage Server for the bot", () => {
    expect(requiredBotPermissions(desiredFrom(base(MANAGED))) & P.ManageGuild).toBe(P.ManageGuild);
  });
});
