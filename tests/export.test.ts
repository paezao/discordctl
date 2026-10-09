import { describe, it, expect } from "vitest";
import { setup, desiredFrom, apply, plan, GUILD_ID } from "./helpers.js";
import { fetchSnapshot } from "../src/provider/normalize.js";
import { exportConfig } from "../src/export/exporter.js";
import { StateStore } from "../src/state/store.js";
import { P } from "../src/permissions/flags.js";

const CONFIG = `version: 1
guild: { id: "\${DISCORD_GUILD_ID}" }
roles:
  - { key: mod, name: Moderator, color: "#123456", hoist: true, permissions: [KickMembers] }
  - { key: vip, name: VIP }
categories:
  - key: info
    name: Info
    permissions: { everyone: { send: deny } }
    channels:
      - key: news
        name: news
        permissions: { mod: { send: allow }, everyone: { AddReactions: deny } }
      - { key: plain, name: plain }
  - key: lab
    name: Lab
    channels:
      - { key: ideas, name: ideas, type: forum, requireTag: true, defaultReaction: "👍", tags: [{ name: Bug, emoji: "🐛" }, { name: Done, moderated: true }] }
      - { key: talk, name: Talk, type: voice, userLimit: 4, bitrate: 32000 }
channels:
  - { key: lobby, name: lobby, slowmode: 5 }
`;

describe("export", () => {
  it("round-trips: exporting a guild and planning against it yields no changes", async () => {
    const { api, store } = setup();
    await apply(api, store, desiredFrom(CONFIG));
    // manual tweak in Discord that config does not know about
    await api.createRole(GUILD_ID, { name: "Handmade", permissions: P.ViewChannel.toString() });

    const snapshot = await fetchSnapshot(api, GUILD_ID);
    const { yaml, bindings } = exportConfig(snapshot);
    expect(yaml).toContain("Handmade");

    // A fresh state (e.g. a new machine): adoption by name, no Discord changes.
    const fresh = StateStore.memory();
    const { plan: p } = await plan(api, fresh, desiredFrom(yaml));
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(p.ops.every((o) => o.action === "import")).toBe(true);
    expect(p.ops).toHaveLength(bindings.length);

    for (const b of bindings) fresh.bind(GUILD_ID, b.kind, b.key, b.id, b.name);
    expect((await plan(api, fresh, desiredFrom(yaml))).plan.ops).toEqual([]);
  });

  it("pins ids for duplicate names so re-import is unambiguous", async () => {
    const { api } = setup();
    await api.createRole(GUILD_ID, { name: "Twin" });
    await api.createRole(GUILD_ID, { name: "Twin" });
    const { yaml } = exportConfig(await fetchSnapshot(api, GUILD_ID));
    expect(yaml.match(/id: "\d+"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("reuses existing state keys", async () => {
    const { api, store } = setup();
    await apply(api, store, desiredFrom(CONFIG));
    const { yaml } = exportConfig(await fetchSnapshot(api, GUILD_ID), { mappings: store.getMappings(GUILD_ID) });
    expect(yaml).toContain("key: mod");
    expect(yaml).toContain("key: ideas");
  });
});
