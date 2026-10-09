import { describe, it, expect } from "vitest";
import { ALL_PERMISSIONS, P, bitsFromNames, namesFromBits, resolvePermissionName } from "../src/permissions/flags.js";
import { computeChannelPermissions, type SimRole } from "../src/permissions/effective.js";

describe("permission bitfields", () => {
  it("handles bits above 2^53 exactly with BigInt", () => {
    expect(P.SendPolls).toBe(1n << 49n);
    expect(P.SendPolls > BigInt(Number.MAX_SAFE_INTEGER) / 1024n).toBe(true);
    const bits = bitsFromNames(["SendPolls", "UseExternalApps", "ViewChannel"]);
    expect(namesFromBits(bits)).toEqual(["ViewChannel", "SendPolls", "UseExternalApps"]);
  });

  it("resolves aliases in any casing", () => {
    expect(resolvePermissionName("view")).toBe("ViewChannel");
    expect(resolvePermissionName("send_messages")).toBe("SendMessages");
    expect(resolvePermissionName("manage-roles")).toBe("ManageRoles");
    expect(resolvePermissionName("ManageEmojisAndStickers")).toBe("ManageGuildExpressions");
    expect(resolvePermissionName("nope")).toBeUndefined();
  });

  it("renders unknown bits instead of dropping them", () => {
    expect(namesFromBits(1n << 62n)).toEqual(["Bit(62)"]);
  });

  it("round-trips every permission", () => {
    expect(bitsFromNames(namesFromBits(ALL_PERMISSIONS))).toBe(ALL_PERMISSIONS);
  });
});

describe("effective permissions", () => {
  const everyone: SimRole = { id: "g", name: "@everyone", permissions: P.ViewChannel | P.SendMessages | P.EmbedLinks };
  const roles = new Map<string, SimRole>([
    ["mod", { id: "mod", name: "Mod", permissions: P.ManageMessages }],
    ["admin", { id: "admin", name: "Admin", permissions: P.Administrator }],
    ["muted", { id: "muted", name: "Muted", permissions: 0n }],
  ]);
  const calc = (roleIds: string[], overwrites: Parameters<typeof computeChannelPermissions>[0]["overwrites"], extra: { id?: string; isOwner?: boolean } = {}) =>
    computeChannelPermissions({ member: { roleIds, ...extra }, everyone, roles, overwrites });

  it("applies @everyone overwrite before role overwrites", () => {
    const ow = [{ id: "g", type: "role" as const, allow: 0n, deny: P.ViewChannel }, { id: "mod", type: "role" as const, allow: P.ViewChannel, deny: 0n }];
    expect(calc([], ow) & P.ViewChannel).toBe(0n);
    expect(calc(["mod"], ow) & P.ViewChannel).toBe(P.ViewChannel);
  });

  it("role allow wins over another role's deny", () => {
    const ow = [{ id: "muted", type: "role" as const, allow: 0n, deny: P.SendMessages }, { id: "mod", type: "role" as const, allow: P.SendMessages, deny: 0n }];
    expect(calc(["muted"], ow) & P.SendMessages).toBe(0n);
    expect(calc(["muted", "mod"], ow) & P.SendMessages).toBe(P.SendMessages);
  });

  it("member overwrites apply last", () => {
    const ow = [{ id: "mod", type: "role" as const, allow: P.SendMessages, deny: 0n }, { id: "u1", type: "member" as const, allow: 0n, deny: P.SendMessages }];
    expect(calc(["mod"], ow, { id: "u1" }) & P.SendMessages).toBe(0n);
  });

  it("Administrator and ownership bypass overwrites", () => {
    const ow = [{ id: "g", type: "role" as const, allow: 0n, deny: P.ViewChannel }];
    expect(calc(["admin"], ow)).toBe(ALL_PERMISSIONS);
    expect(calc([], ow, { isOwner: true })).toBe(ALL_PERMISSIONS);
  });

  it("applies implicit rules: no view means nothing, no send drops embeds", () => {
    expect(calc([], [{ id: "g", type: "role", allow: 0n, deny: P.ViewChannel }])).toBe(0n);
    expect(calc([], [{ id: "g", type: "role", allow: 0n, deny: P.SendMessages }]) & P.EmbedLinks).toBe(0n);
  });
});
