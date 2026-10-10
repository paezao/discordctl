import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";

const G1 = "111111111111111111";
const G2 = "222222222222222222";

describe("state store", () => {
  it("persists mappings on disk", () => {
    const path = join(mkdtempSync(join(tmpdir(), "dctl-")), "state.db");
    const a = new StateStore(path);
    a.bind(G1, "role", "mod", "1001", "Moderator");
    a.close();
    const b = new StateStore(path);
    expect(b.getMapping(G1, "role", "mod")?.discordId).toBe("1001");
    b.close();
  });

  it("isolates guilds", () => {
    const s = StateStore.memory();
    s.bind(G1, "role", "mod", "1001", "Moderator");
    s.bind(G2, "role", "mod", "2001", "Moderator");
    expect(s.getMappings(G1).map((m) => m.discordId)).toEqual(["1001"]);
    s.clearGuild(G1);
    expect(s.getMappings(G2)).toHaveLength(1);
  });

  it("keeps one key per Discord id", () => {
    const s = StateStore.memory();
    s.bind(G1, "channel", "old", "5", "x");
    s.bind(G1, "channel", "new", "5", "x");
    expect(s.getMappings(G1).map((m) => m.key)).toEqual(["new"]);
  });

  it("backs up and restores, refusing cross-guild data", () => {
    const s = StateStore.memory();
    s.bind(G1, "role", "a", "1", "A");
    const backup = s.exportGuild(G1);
    const t = StateStore.memory();
    expect(t.importGuild(backup)).toBe(1);
    expect(() => t.importGuild({ guildId: G2, resources: backup.resources })).toThrow(/belongs to guild/);
  });

  it("produces identical exports after a restore and unchanged re-binds", () => {
    const s = StateStore.memory();
    s.bind(G1, "role", "a", "1", "A");
    const backup = JSON.stringify(s.exportGuild(G1));
    const t = StateStore.memory();
    t.importGuild(JSON.parse(backup), true);
    t.bind(G1, "role", "a", "1", "A"); // e.g. the post-apply refresh
    expect(JSON.stringify(t.exportGuild(G1))).toBe(backup);
  });

  it("enforces locks and lets the holder re-acquire", () => {
    const s = StateStore.memory();
    s.acquireLock(G1, "a");
    s.acquireLock(G1, "a");
    expect(() => s.acquireLock(G1, "b")).toThrow(/locked/);
    s.releaseLock(G1, "a");
    s.acquireLock(G1, "b");
  });
});
