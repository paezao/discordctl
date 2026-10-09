import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { auditPermissions, modelFromDesired, modelFromSnapshot, permissionMatrix } from "../src/permissions/audit.js";
import { desiredFrom, setup, apply } from "./helpers.js";
import { fetchSnapshot } from "../src/provider/normalize.js";

const base = `version: 1\nguild: { id: "\${DISCORD_GUILD_ID}" }\n`;
const codes = (yaml: string) => auditPermissions(modelFromDesired(desiredFrom(base + yaml))).map((f) => `${f.severity}:${f.code}`);

describe("permission audit", () => {
  it("flags Administrator on @everyone", () => {
    expect(codes("everyone: { permissions: [Administrator] }")).toContain("critical:EVERYONE_ADMIN");
  });

  it("flags elevated @everyone permissions", () => {
    expect(codes("everyone: { permissions: [ViewChannel, BanMembers] }")).toContain("high:EVERYONE_ELEVATED");
  });

  it("flags a developer (staff) role with Administrator", () => {
    expect(codes("roles: [{ key: dev, name: Developer, tier: staff, permissions: [Administrator] }]")).toContain("high:ADMIN_TO_STAFF");
  });

  it("flags Administrator on a member-tier role", () => {
    expect(codes("roles: [{ key: vip, name: VIP, tier: member, permissions: [Administrator] }]")).toContain("critical:ADMIN_TO_MEMBERS");
  });

  it("flags a private channel visible to everyone", () => {
    const yaml = `roles: [{ key: mod, name: Mod, permissions: [ManageMessages] }]
categories:
  - key: staff
    name: Staff
    private: true
    visibleTo: [mod]
    channels:
      - { key: leak, name: leak, permissions: { everyone: { view: allow } } }`;
    expect(codes(yaml)).toContain("critical:PRIVATE_EXPOSED");
  });

  it("flags moderators who cannot see moderation channels", () => {
    const yaml = `roles:
  - { key: admin, name: Admin, tier: admin, permissions: [ManageGuild, ManageRoles] }
  - { key: mod, name: Moderator, permissions: [KickMembers] }
categories:
  - { key: s, name: Staff, private: true, visibleTo: [admin], channels: [{ key: ml, name: mod-logs }] }`;
    expect(codes(yaml)).toContain("medium:MODERATOR_LOCKED_OUT");
  });

  it("flags staff locked out of a private channel", () => {
    expect(codes("roles: [{ key: mod, name: Mod, permissions: [KickMembers] }]\ncategories: [{ key: s, name: Secret, private: true }]")).toContain("high:STAFF_LOCKED_OUT");
  });

  it("flags announcement channels writable by members", () => {
    expect(codes("channels: [{ key: a, name: announcements }]")).toContain("high:ANNOUNCEMENT_WRITABLE");
  });

  it("flags conflicting role overwrites", () => {
    const yaml = `roles: [{ key: a, name: A }, { key: b, name: B }]
channels: [{ key: c, name: c, permissions: { a: { send: allow }, b: { send: deny } } }]`;
    expect(codes(yaml)).toContain("low:CONFLICTING_OVERWRITES");
  });

  it("flags an inverted hierarchy", () => {
    expect(codes("roles: [{ key: m, name: Member, tier: member }, { key: mod, name: Mod, tier: staff }]")).toContain("medium:HIERARCHY_INVERTED");
  });

  it("evaluates explicit expectations", () => {
    const yaml = "roles: [{ key: mod, name: Mod }]\nchannels: [{ key: c, name: c, expect: { noView: [everyone], send: [mod] } }]";
    expect(codes(yaml).filter((c) => c === "high:EXPECTATION_FAILED")).toHaveLength(1);
  });

  it("finds nothing serious in the Blastorama example", () => {
    const desired = desiredFrom(readFileSync("examples/blastorama/discord.yaml", "utf8"));
    const serious = auditPermissions(modelFromDesired(desired)).filter((f) => ["critical", "high", "medium"].includes(f.severity));
    expect(serious).toEqual([]);
  });

  it("audits live state after apply and builds a matrix", async () => {
    const { api, store } = setup();
    const desired = desiredFrom(base + "roles: [{ key: mod, name: Mod, permissions: [KickMembers] }]\ncategories: [{ key: s, name: Staff, private: true, visibleTo: [mod], channels: [{ key: c, name: chat }] }]");
    await apply(api, store, desired);
    const snapshot = await fetchSnapshot(api, desired.guildId);
    const live = modelFromSnapshot(snapshot);
    const matrix = permissionMatrix(live, { channels: ["chat"] });
    expect(matrix[0]!.personas["@everyone"]!.view).toBe(false);
    expect(matrix[0]!.personas["Mod"]!.view).toBe(true);
  });
});
