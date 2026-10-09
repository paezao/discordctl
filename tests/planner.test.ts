import { describe, it, expect } from "vitest";
import { ChannelType } from "discord-api-types/v10";
import { setup, desiredFrom, apply, plan, GUILD_ID } from "./helpers.js";
import { P } from "../src/permissions/flags.js";

const base = `version: 1\nguild: { id: "\${DISCORD_GUILD_ID}" }\n`;
const CONFIG = base + `
roles:
  - { key: mod, name: Moderator, permissions: [ManageMessages, KickMembers] }
  - { key: tester, name: Playtester, color: "#00ff00" }
categories:
  - key: community
    name: Community
    channels:
      - { key: general, name: general, topic: Hello }
      - { key: voice, name: Party, type: voice, userLimit: 5 }
  - key: staff
    name: Staff
    private: true
    visibleTo: [mod]
    channels:
      - { key: staff-chat, name: staff-chat }
`;

describe("plan generation", () => {
  it("creates everything on an empty guild with correct dependencies", async () => {
    const { api, store } = setup();
    const { plan: p } = await plan(api, store, desiredFrom(CONFIG));
    expect(p.summary).toMatchObject({ create: 7, update: 0, delete: 0 });
    const ids = p.ops.map((o) => o.id);
    const general = p.ops.find((o) => o.id === "channel.create:general")!;
    expect(general.dependsOn).toContain("channel.create:community");
    const staffChat = p.ops.find((o) => o.id === "channel.create:staff-chat")!;
    expect(staffChat.dependsOn).toEqual(expect.arrayContaining(["channel.create:staff", "role.create:mod"]));
    // dependencies always come earlier in the plan
    for (const op of p.ops) for (const d of op.dependsOn) expect(ids.indexOf(d)).toBeLessThan(ids.indexOf(op.id));
  });

  it("is idempotent: a second apply makes no Discord calls", async () => {
    const { api, store } = setup();
    const desired = desiredFrom(CONFIG);
    await apply(api, store, desired);
    const before = api.mutationCalls().length;
    const second = await apply(api, store, desired);
    expect(second.plan.ops).toEqual([]);
    expect(second.report.status).toBe("noop");
    expect(api.mutationCalls().length).toBe(before);
  });

  it("applies permission overwrites that hide private channels", async () => {
    const { api, store } = setup();
    await apply(api, store, desiredFrom(CONFIG));
    const g = api.rawGuild(GUILD_ID);
    const staff = g.channels.find((c) => c.name === "Staff")!;
    const ow = staff.permission_overwrites as Array<{ id: string; deny: string; allow: string }>;
    expect(BigInt(ow.find((o) => o.id === GUILD_ID)!.deny) & P.ViewChannel).toBe(P.ViewChannel);
    const modId = g.roles.find((r) => r.name === "Moderator")!.id;
    expect(BigInt(ow.find((o) => o.id === modId)!.allow)).toBe(P.ViewChannel);
  });

  it("renames instead of recreating when the display name changes", async () => {
    const { api, store } = setup();
    await apply(api, store, desiredFrom(CONFIG));
    const modId = store.getMapping(GUILD_ID, "role", "mod")!.discordId;
    const renamed = desiredFrom(CONFIG.replace("name: Moderator", "name: Mods").replace("name: general,", "name: lobby,"));
    const { plan: p, report } = await apply(api, store, renamed);
    expect(p.ops.map((o) => `${o.action}:${o.id}`)).toEqual(["update:role.update:mod", "update:channel.update:general"]);
    expect(report.status).toBe("success");
    expect(store.getMapping(GUILD_ID, "role", "mod")!.discordId).toBe(modId);
    expect(api.rawGuild(GUILD_ID).roles.filter((r) => r.name === "Mods")).toHaveLength(1);
  });

  it("detects and reverts drift from an external rename", async () => {
    const { api, store } = setup();
    const desired = desiredFrom(CONFIG);
    await apply(api, store, desired);
    api.externalRenameRole(GUILD_ID, store.getMapping(GUILD_ID, "role", "tester")!.discordId, "Hacked");
    const { plan: p } = await plan(api, store, desired);
    expect(p.ops).toHaveLength(1);
    expect(p.ops[0]!.changes[0]).toMatchObject({ field: "name", before: "Hacked", after: "Playtester" });
  });

  it("recreates a resource deleted outside discordctl and warns", async () => {
    const { api, store } = setup();
    const desired = desiredFrom(CONFIG);
    await apply(api, store, desired);
    const oldId = store.getMapping(GUILD_ID, "channel", "general")!.discordId;
    api.externalDeleteChannel(GUILD_ID, oldId);
    const { plan: p, report } = await apply(api, store, desired);
    expect(p.diagnostics.some((d) => d.code === "DELETED_EXTERNALLY")).toBe(true);
    expect(p.ops.map((o) => o.id)).toContain("channel.create:general");
    expect(report.status).toBe("success");
    expect(store.getMapping(GUILD_ID, "channel", "general")!.discordId).not.toBe(oldId);
  });

  it("adopts existing resources by name instead of duplicating them", async () => {
    const { api, store } = setup();
    const existing = await api.createRole(GUILD_ID, { name: "Moderator", permissions: (P.ManageMessages | P.KickMembers).toString() });
    const { plan: p } = await plan(api, store, desiredFrom(CONFIG));
    const op = p.ops.find((o) => o.key === "mod")!;
    expect(op.action).toBe("import");
    expect(op.discordId).toBe(existing.id);
    await apply(api, store, desiredFrom(CONFIG));
    expect(api.rawGuild(GUILD_ID).roles.filter((r) => r.name === "Moderator")).toHaveLength(1);
  });

  it("refuses ambiguous name matches and suggests pinning an id", async () => {
    const { api, store } = setup();
    await api.createRole(GUILD_ID, { name: "Moderator" });
    await api.createRole(GUILD_ID, { name: "Moderator" });
    const { plan: p } = await plan(api, store, desiredFrom(CONFIG));
    const e = p.diagnostics.find((d) => d.code === "AMBIGUOUS_MATCH")!;
    expect(e.severity).toBe("error");
    expect(e.hint).toMatch(/id:/);
  });

  it("respects pinned ids", async () => {
    const { api, store } = setup();
    const a = await api.createRole(GUILD_ID, { name: "Moderator" });
    await api.createRole(GUILD_ID, { name: "Moderator" });
    const { plan: p } = await plan(api, store, desiredFrom(CONFIG.replace("key: mod, name: Moderator,", `key: mod, name: Moderator, id: "${a.id}",`)));
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(p.ops.find((o) => o.key === "mod")!.discordId).toBe(a.id);
  });

  it("reorders roles and channels to match the configuration", async () => {
    const { api, store } = setup();
    await apply(api, store, desiredFrom(CONFIG));
    const swapped = CONFIG.replace(
      "  - { key: mod, name: Moderator, permissions: [ManageMessages, KickMembers] }\n  - { key: tester, name: Playtester, color: \"#00ff00\" }",
      "  - { key: tester, name: Playtester, color: \"#00ff00\" }\n  - { key: mod, name: Moderator, permissions: [ManageMessages, KickMembers] }",
    );
    const { plan: p } = await apply(api, store, desiredFrom(swapped));
    expect(p.ops.map((o) => o.id)).toEqual(["roles.reorder"]);
    const roles = api.rawGuild(GUILD_ID).roles;
    const pos = (n: string) => roles.find((r) => r.name === n)!.position as number;
    expect(pos("Playtester")).toBeGreaterThan(pos("Moderator"));
    expect((await plan(api, store, desiredFrom(swapped))).plan.ops).toEqual([]);
  });

  it("moves a channel to another category", async () => {
    const { api, store } = setup();
    await apply(api, store, desiredFrom(CONFIG));
    const moved = CONFIG.replace("      - { key: general, name: general, topic: Hello }\n", "").replace("      - { key: staff-chat, name: staff-chat }", "      - { key: staff-chat, name: staff-chat }\n      - { key: general, name: general, topic: Hello }");
    const { plan: p, report } = await apply(api, store, desiredFrom(moved));
    const op = p.ops.find((o) => o.key === "general")!;
    expect(op.action).toBe("move");
    expect(report.status).toBe("success");
    expect((await plan(api, store, desiredFrom(moved))).plan.ops).toEqual([]);
  });

  it("preserves unmanaged overwrites by default and removes them when authoritative", async () => {
    const { api, store } = setup();
    await apply(api, store, desiredFrom(CONFIG));
    const id = store.getMapping(GUILD_ID, "channel", "staff-chat")!.discordId;
    const ch = api.rawGuild(GUILD_ID).channels.find((c) => c.id === id)!;
    const foreign = { id: "333333333333333333", type: 1, allow: P.ViewChannel.toString(), deny: "0" };
    (ch.permission_overwrites as unknown[]).push(foreign);
    expect((await plan(api, store, desiredFrom(CONFIG))).plan.ops).toEqual([]);
    const strict = desiredFrom(CONFIG.replace("      - { key: staff-chat, name: staff-chat }", "      - { key: staff-chat, name: staff-chat, overwritePolicy: authoritative }"));
    const { plan: p } = await plan(api, store, strict);
    expect(p.ops[0]!.risk).toBe("medium");
    expect(p.ops[0]!.riskReasons.join()).toMatch(/unmanaged/);
  });

  it("preserves forum tag ids and does not drop unmanaged tags", async () => {
    const { api, store } = setup();
    const yaml = base + "channels:\n  - key: f\n    name: forum\n    type: forum\n    requireTag: true\n    tags: [{ name: Bug }, { name: Idea }]\n";
    await apply(api, store, desiredFrom(yaml));
    expect((await plan(api, store, desiredFrom(yaml))).plan.ops).toEqual([]);
    const ch = api.rawGuild(GUILD_ID).channels.find((c) => c.type === ChannelType.GuildForum)!;
    expect(ch.flags).toBe(16);
    const bugId = (ch.available_tags as Array<{ id: string; name: string }>).find((t) => t.name === "Bug")!.id;
    await apply(api, store, desiredFrom(yaml.replace("{ name: Idea }", "{ name: Idea, moderated: true }")));
    const tags = api.rawGuild(GUILD_ID).channels.find((c) => c.type === ChannelType.GuildForum)!.available_tags as Array<{ id: string; name: string }>;
    expect(tags.find((t) => t.name === "Bug")!.id).toBe(bugId);
  });

  it("turns on requireTag for an existing forum while adding its first tags", async () => {
    const { api, store } = setup();
    await apply(api, store, desiredFrom(base + "channels:\n  - { key: f, name: ideas, type: forum }\n"));
    const withTags = desiredFrom(base + "channels:\n  - { key: f, name: ideas, type: forum, requireTag: true, tags: [{ name: Idea }, { name: Done, moderated: true }] }\n");
    const { report } = await apply(api, store, withTags);
    expect(report.status).toBe("success");
    expect(api.rawGuild(GUILD_ID).channels[0]!.flags).toBe(16);
    expect((await plan(api, store, withTags)).plan.ops).toEqual([]);
  });

  it("does not see a diff in multi-line topics that Discord trims", async () => {
    const { api, store } = setup();
    const yaml = base + "channels:\n  - key: f\n    name: forum\n    type: forum\n    guidelines: |\n      Line one.\n      Line two.\n";
    await apply(api, store, desiredFrom(yaml));
    expect((await plan(api, store, desiredFrom(yaml))).plan.ops).toEqual([]);
  });

  it("never converts incompatible channel types", async () => {
    const { api, store } = setup();
    await apply(api, store, desiredFrom(base + "channels: [{ key: x, name: lounge }]"));
    const { plan: p } = await plan(api, store, desiredFrom(base + "channels: [{ key: x, name: lounge, type: voice }]"));
    expect(p.diagnostics.find((d) => d.code === "TYPE_CHANGE_UNSUPPORTED")?.severity).toBe("error");
    expect(p.ops.some((o) => o.action === "delete")).toBe(false);
  });

  it("requires Community for announcement channels unless a fallback is set", async () => {
    const { api, store } = setup();
    const { plan: p } = await plan(api, store, desiredFrom(base + "channels: [{ key: a, name: news, type: announcement }]"));
    expect(p.diagnostics.find((d) => d.code === "REQUIRES_COMMUNITY")?.severity).toBe("error");
    const { plan: q } = await plan(api, store, desiredFrom(base + "channels: [{ key: a, name: news, type: announcement, fallbackType: text }]"));
    expect(q.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});

describe("destructive safeguards", () => {
  it("never deletes without explicit authorization", async () => {
    const { api, store } = setup();
    await apply(api, store, desiredFrom(CONFIG));
    const smaller = desiredFrom(CONFIG.replace("      - { key: voice, name: Party, type: voice, userLimit: 5 }\n", ""));
    const { plan: p } = await plan(api, store, smaller);
    expect(p.ops).toEqual([]);
    expect(p.diagnostics.find((d) => d.code === "ORPHANED")).toBeDefined();
    const { plan: d } = await plan(api, store, smaller, { allowDelete: true });
    expect(d.ops.map((o) => o.id)).toEqual(["channel.delete:voice"]);
    expect(d.ops[0]!.destructive).toBe(true);
    expect(d.ops[0]!.risk).toBe("high");
  });

  it("treats a renamed config key as a rebinding, never a deletion", async () => {
    const { api, store } = setup();
    await apply(api, store, desiredFrom(CONFIG));
    const id = store.getMapping(GUILD_ID, "channel", "general")!.discordId;
    const rekeyed = desiredFrom(CONFIG.replace("key: general,", "key: chat,"));
    const { plan: p, report } = await apply(api, store, rekeyed, { allowDelete: true });
    expect(p.ops.some((o) => o.action === "delete")).toBe(false);
    expect(p.diagnostics.some((d) => d.code === "KEY_RENAMED")).toBe(true);
    expect(report.status).toBe("success");
    expect(store.getMapping(GUILD_ID, "channel", "chat")!.discordId).toBe(id);
    expect(api.rawGuild(GUILD_ID).channels.some((c) => c.id === id)).toBe(true);
  });

  it("decides which overwrites are managed independently of channel order", async () => {
    const { api, store } = setup();
    const member = "444444444444444444";
    const yaml = (order: "ab" | "ba") => {
      const a = "  - { key: a, name: a, permissions: { everyone: { view: allow } } }";
      const b = `  - { key: b, name: b, permissions: { "member:${member}": { send: deny } } }`;
      return base + "channels:\n" + (order === "ab" ? [a, b] : [b, a]).join("\n") + "\n";
    };
    await apply(api, store, desiredFrom(yaml("ab")));
    const chA = api.rawGuild(GUILD_ID).channels.find((c) => c.name === "a")!;
    (chA.permission_overwrites as unknown[]).push({ id: member, type: 1, allow: "0", deny: P.SendMessages.toString() });
    // The member is a target managed by the config (declared on b), so it is removed from a in either order.
    const first = (await plan(api, store, desiredFrom(yaml("ab")))).plan.ops.map((o) => o.id);
    const second = (await plan(api, store, desiredFrom(yaml("ba")))).plan.ops.filter((o) => o.id.startsWith("channel.update")).map((o) => o.id);
    expect(first).toContain("channel.update:a");
    expect(second).toEqual(["channel.update:a"]);
  });

  it("never deletes resources that discordctl did not create or import", async () => {
    const { api, store } = setup();
    await api.createChannel(GUILD_ID, { name: "handmade", type: 0 });
    const { plan: p } = await plan(api, store, desiredFrom(base), { allowDelete: true });
    expect(p.ops).toEqual([]);
  });

  it("marks removing the last administrative role as critical", async () => {
    const { api, store } = setup();
    const yaml = base + "roles: [{ key: boss, name: Boss, permissions: [Administrator] }]";
    api.rawGuild(GUILD_ID).roles[1]!.permissions = P.Administrator.toString(); // bot must hold what it grants
    await apply(api, store, desiredFrom(yaml));
    const { plan: p } = await plan(api, store, desiredFrom(base + "roles: [{ key: boss, name: Boss, permissions: [ViewAuditLog] }]"));
    expect(p.ops[0]!.risk).toBe("critical");
    expect(p.diagnostics.some((d) => d.code === "LAST_ADMIN_PATH")).toBe(true);
  });

  it("rates granting private-channel access to raw members/role IDs as high risk", async () => {
    const { api, store } = setup();
    const yaml = (target: string) => base + `categories:\n  - key: s\n    name: Staff\n    private: true\n    channels:\n      - key: c\n        name: secret\n        permissions: { "${target}": { view: allow } }\n`;
    const member = (await plan(api, store, desiredFrom(yaml("member:555555555555555555")))).plan;
    expect(member.ops.find((o) => o.key === "c")!.risk).toBe("high");
    expect(member.ops.find((o) => o.key === "c")!.riskReasons.join()).toMatch(/private/);
  });

  it("rates elevated permissions granted through member overwrites as high risk", async () => {
    const { api, store } = setup();
    const p = (await plan(api, store, desiredFrom(base + 'channels: [{ key: c, name: c, permissions: { "member:555555555555555555": { ManageRoles: allow } } }]'))).plan;
    expect(p.ops[0]!.risk).toBe("high");
  });

  it("rejects overwrites for role IDs that are not in the guild", async () => {
    const { api, store } = setup();
    const p = (await plan(api, store, desiredFrom(base + 'channels: [{ key: c, name: c, permissions: { "roleId:777777777777777777": { view: allow } } }]'))).plan;
    expect(p.diagnostics.find((d) => d.code === "UNKNOWN_ROLE_ID")?.severity).toBe("error");
  });

  it("rates permission escalation by risk", async () => {
    const { api, store } = setup();
    const { plan: p } = await plan(api, store, desiredFrom(base + "everyone: { permissions: [ViewChannel, ManageRoles] }"));
    expect(p.ops[0]!.risk).toBe("critical");
    expect(p.maxRisk).toBe("critical");
  });

  it("blocks plans the bot cannot apply", async () => {
    const { api, store } = setup();
    api.rawGuild(GUILD_ID).roles[1]!.permissions = (P.ManageRoles | P.ManageChannels | P.ViewChannel).toString();
    const { plan: p } = await plan(api, store, desiredFrom(base + "roles: [{ key: m, name: M, permissions: [BanMembers] }]"));
    expect(p.diagnostics.find((d) => d.code === "BOT_CANNOT_GRANT")?.severity).toBe("error");
  });

  it("refuses to manage roles above the bot", async () => {
    const { api, store } = setup();
    const r = await api.createRole(GUILD_ID, { name: "Owner Role" });
    api.rawGuild(GUILD_ID).roles.find((x) => x.id === r.id)!.position = 50;
    const { plan: p } = await plan(api, store, desiredFrom(base + "roles: [{ key: o, name: Owner Role, color: '#ffffff' }]"));
    expect(p.diagnostics.find((d) => d.code === "ROLE_ABOVE_BOT")?.severity).toBe("error");
  });

  it("refuses to target integration-managed roles", async () => {
    const { api, store } = setup();
    const botRole = api.rawGuild(GUILD_ID).roles[1]!;
    const { plan: p } = await plan(api, store, desiredFrom(base + `roles: [{ key: b, name: x, id: "${botRole.id}" }]`));
    expect(p.diagnostics.find((d) => d.code === "UNMANAGEABLE_ROLE")?.severity).toBe("error");
  });
});
