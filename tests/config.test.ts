import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFile, loadConfigText } from "../src/config/load.js";
import { resolveConfig } from "../src/config/resolve.js";
import { P } from "../src/permissions/flags.js";
import { GUILD_ID } from "./helpers.js";

const env = { DISCORD_GUILD_ID: GUILD_ID };
const resolveYaml = (yaml: string, opts: { guildId?: string } = {}) => resolveConfig(loadConfigText(yaml, { env }), opts);
const errors = (yaml: string) => resolveYaml(yaml).diagnostics.filter((d) => d.severity === "error");
const base = `version: 1\nguild: { id: "\${DISCORD_GUILD_ID}" }\n`;

describe("YAML parsing and interpolation", () => {
  it("interpolates environment variables with defaults", () => {
    const loaded = loadConfigText(`version: 1\nguild: { id: "\${GID:-${GUILD_ID}}" }\nroles: [{ key: a, name: "\${ROLE_NAME}" }]`, { env: { ROLE_NAME: "Alpha" } });
    expect(loaded.config.guild.id).toBe(GUILD_ID);
    expect(loaded.config.roles[0]!.name).toBe("Alpha");
  });

  it("fails clearly on a missing variable", () => {
    expect(() => loadConfigText(`version: 1\nguild: { id: "\${NOPE}" }`, { env: {} })).toThrow(/NOPE is not set/);
  });

  it("supports $${ escapes", () => {
    const loaded = loadConfigText(base + `roles: [{ key: a, name: "cost $\${5}" }]`, { env });
    expect(loaded.config.roles[0]!.name).toBe("cost ${5}");
  });

  it("reports YAML syntax errors with a line number", () => {
    expect(() => loadConfigText("version: 1\nguild: [unclosed\n", { env })).toThrow(/:\d+: YAML syntax error/);
  });

  it("rejects unknown keys (typos) with the line number", () => {
    expect(() => loadConfigText(base + "roles:\n  - key: a\n    name: A\n    permisions: []\n", { env, source: "x.yaml" })).toThrow(/x\.yaml:6.*permisions/s);
  });

  it("rejects an unsupported version", () => {
    expect(() => loadConfigText(`version: 2\nguild: { id: "${GUILD_ID}" }`, { env })).toThrow(/version/);
  });

  it("refuses imports outside the sandbox", () => {
    const dir = mkdtempSync(join(tmpdir(), "dctl-"));
    writeFileSync(join(dir, "c.yaml"), base + 'imports: ["../../etc/passwd"]\n');
    expect(() => loadConfigFile(join(dir, "c.yaml"), { env, sandboxRoot: dir })).toThrow(/outside the allowed directory/);
  });

  it("loads the builtin preset library", () => {
    const loaded = loadConfigText(base + 'imports: ["builtin:common"]\n', { env });
    expect(Object.keys(loaded.presets)).toContain("read-only");
  });
});

describe("validation", () => {
  it("accepts a minimal config", () => {
    expect(errors(base)).toEqual([]);
  });

  it("detects duplicate keys and reserved names", () => {
    const e = errors(base + "roles:\n  - { key: a, name: A }\n  - { key: a, name: B }\n  - { key: c, name: '@everyone' }\n");
    expect(e.map((d) => d.code)).toEqual(expect.arrayContaining(["DUPLICATE_KEY", "RESERVED_NAME"]));
  });

  it("detects unknown permissions and role references", () => {
    const e = errors(base + "roles: [{ key: a, name: A, permissions: [FlyAround] }]\ncategories:\n  - key: c\n    name: C\n    permissions: { ghost: { view: deny } }\n");
    expect(e.map((d) => d.code)).toEqual(expect.arrayContaining(["UNKNOWN_PERMISSION", "UNKNOWN_ROLE"]));
  });

  it("rejects guild-only permissions in overwrites", () => {
    const e = errors(base + "categories:\n  - key: c\n    name: C\n    permissions: { everyone: { Administrator: allow } }\n");
    expect(e[0]?.code).toBe("GUILD_ONLY_PERMISSION");
  });

  it("rejects fields that do not apply to a channel type", () => {
    const e = errors(base + "channels:\n  - { key: v, name: V, type: voice, topic: hi }\n  - { key: t, name: t, tags: [{ name: x }] }\n");
    expect(e.filter((d) => d.code === "FIELD_NOT_SUPPORTED")).toHaveLength(2);
  });

  it("enforces Discord limits", () => {
    const e = errors(base + "channels:\n  - { key: t, name: t, slowmode: 7h }\n  - { key: v, name: v, type: voice, userLimit: 150 }\n");
    expect(e.map((d) => d.code)).toEqual(["SLOWMODE_TOO_HIGH", "USER_LIMIT"]);
  });

  it("validates fallback types", () => {
    expect(errors(base + "channels: [{ key: a, name: a, type: forum, fallbackType: voice }]")[0]?.code).toBe("INVALID_FALLBACK");
    expect(errors(base + "channels: [{ key: a, name: a, type: announcement, fallbackType: text }]")).toEqual([]);
  });

  it("refuses a --guild that contradicts the config", () => {
    const r = resolveYaml(base, { guildId: "222222222222222222" });
    expect(r.diagnostics.some((d) => d.code === "GUILD_MISMATCH")).toBe(true);
  });

  it("validates references in onboarding and guild settings", () => {
    const e = errors(`version: 1\nguild: { id: "${GUILD_ID}", systemChannel: nope }\nonboarding: { defaultChannels: [missing] }\n`);
    expect(e.filter((d) => d.code === "UNKNOWN_CHANNEL")).toHaveLength(2);
    expect(e.some((d) => d.code === "UNKNOWN_CHANNEL")).toBe(true);
  });
});

describe("normalization and permission merging", () => {
  const yaml = base + `
imports: ["builtin:common"]
roles:
  - { key: mod, name: Mod, permissions: [ManageMessages] }
  - { key: member, name: Member }
categories:
  - key: info
    name: Info
    preset: read-only
    channels:
      - key: news
        name: News Feed
        permissions:
          mod: { send: allow }
          everyone: { AddReactions: inherit }
      - key: own
        name: own
        inheritPermissions: false
        permissions: { member: { view: allow } }
  - key: staff
    name: Staff
    private: true
    visibleTo: [mod]
    channels:
      - { key: s, name: s }
`;
  it("merges category overwrites into channels, with inherit clearing values", () => {
    const { desired, diagnostics } = resolveYaml(yaml);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const news = desired.channels.find((c) => c.key === "news")!;
    const ev = news.overwrites!.find((o) => o.target.kind === "everyone")!;
    expect(ev.deny & P.SendMessages).toBe(P.SendMessages);
    expect(ev.allow & P.AddReactions).toBe(0n);
    const mod = news.overwrites!.find((o) => o.target.kind === "role" && o.target.key === "mod")!;
    expect(mod.allow).toBe(P.SendMessages);
  });

  it("does not inherit when inheritPermissions is false", () => {
    const own = resolveYaml(yaml).desired.channels.find((c) => c.key === "own")!;
    expect(own.overwrites).toEqual([{ target: { kind: "role", key: "member" }, allow: P.ViewChannel, deny: 0n }]);
  });

  it("expands private + visibleTo and propagates privacy to children", () => {
    const { desired } = resolveYaml(yaml);
    const s = desired.channels.find((c) => c.key === "s")!;
    expect(s.private).toBe(true);
    expect(s.overwrites).toEqual(
      expect.arrayContaining([
        { target: { kind: "everyone" }, allow: 0n, deny: P.ViewChannel },
        { target: { kind: "role", key: "mod" }, allow: P.ViewChannel, deny: 0n },
      ]),
    );
  });

  it("leaves overwrites unmanaged when nothing declares permissions", () => {
    const { desired } = resolveYaml(base + "categories: [{ key: c, name: C, channels: [{ key: x, name: x }] }]");
    expect(desired.channels[0]!.overwrites).toBeUndefined();
  });

  it("notes Discord's text-channel name normalization", () => {
    const { diagnostics } = resolveYaml(base + "channels: [{ key: x, name: Big Room }]");
    expect(diagnostics.find((d) => d.code === "NAME_NORMALIZED")?.message).toMatch(/big-room/);
  });

  it("infers role tiers", () => {
    const { desired } = resolveYaml(base + "roles:\n  - { key: a, name: A, permissions: [Administrator] }\n  - { key: b, name: B, permissions: [KickMembers] }\n  - { key: c, name: C }\n");
    expect(desired.roles.map((r) => r.tier)).toEqual(["admin", "staff", "member"]);
  });
});
