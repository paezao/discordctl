/**
 * Optional end-to-end test against a REAL Discord test server. Disabled by default.
 *
 * It creates resources prefixed "dctl-it-" in the guild, verifies idempotency, then removes
 * them. Use a throwaway server you own:
 *
 *   DISCORDCTL_IT=1 DISCORDCTL_IT_TOKEN=... DISCORDCTL_IT_GUILD=... DISCORDCTL_IT_ALLOW_MUTATION=1 pnpm test:integration
 */
import { describe, it, expect } from "vitest";
import { RestDiscordApi } from "../../src/provider/rest.js";
import { StateStore } from "../../src/state/store.js";
import { DiscordctlService } from "../../src/service.js";

const token = process.env.DISCORDCTL_IT_TOKEN;
const guild = process.env.DISCORDCTL_IT_GUILD;
const enabled = Boolean(process.env.DISCORDCTL_IT && token && guild && process.env.DISCORDCTL_IT_ALLOW_MUTATION === "1");

const CONFIG = (g: string) => `version: 1
guild: { id: "${g}" }
options: { manageRoleOrder: false }
roles:
  - { key: it-role, name: dctl-it-role, color: "#123456", permissions: [] }
categories:
  - key: it-cat
    name: dctl-it-category
    private: true
    visibleTo: [it-role]
    channels:
      - { key: it-text, name: dctl-it-text, topic: integration test }
      - { key: it-voice, name: dctl-it-voice, type: voice, userLimit: 3 }
`;

describe.skipIf(!enabled)("real Discord integration", () => {
  it("applies, converges and cleans up", { timeout: 120_000 }, async () => {
    const store = StateStore.memory();
    const service = new DiscordctlService({ api: new RestDiscordApi({ token: token! }), store });
    const source = { text: CONFIG(guild!) };

    const { plan, desired } = await service.plan(source);
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const { report, remaining } = await service.apply(plan, { desired });
    expect(report.status).toBe("success");
    expect(remaining?.ops ?? []).toEqual([]);

    // Remove everything again (only resources this test created are tracked in state).
    const cleanup = await service.plan({ text: `version: 1\nguild: { id: "${guild}" }\n` }, { allowDelete: true });
    expect(cleanup.plan.ops.every((o) => o.action === "delete")).toBe(true);
    const done = await service.apply(cleanup.plan);
    expect(done.report.status).toBe("success");
  });
});
