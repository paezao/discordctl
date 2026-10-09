import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { listTemplates } from "../src/templates.js";
import { setup, desiredFrom, apply, plan } from "./helpers.js";
import { auditPermissions, modelFromDesired } from "../src/permissions/audit.js";

const sources = [...listTemplates().map((t) => ({ name: t.name, path: t.path })), { name: "blastorama", path: "examples/blastorama/discord.yaml" }];

describe("templates and examples", () => {
  it("ships the five required templates", () => {
    expect(listTemplates().map((t) => t.name).sort()).toEqual(["creator-community", "gaming-community", "open-source-project", "saas-community", "small-private-team"]);
  });

  for (const { name, path } of sources) {
    describe(name, () => {
      const desired = () => desiredFrom(readFileSync(path, "utf8"));

      it("validates and passes the permission audit", () => {
        const findings = auditPermissions(modelFromDesired(desired()));
        expect(findings.filter((f) => f.severity === "critical" || f.severity === "high")).toEqual([]);
      });

      it("has staff-only areas hidden from ordinary members", () => {
        expect(desired().categories.some((c) => c.private)).toBe(true);
      });

      for (const community of [false, true]) {
        it(`applies idempotently (${community ? "Community" : "non-Community"} guild)`, async () => {
          const { api, store } = setup(community ? ["COMMUNITY"] : []);
          const d = desired();
          const { report } = await apply(api, store, d);
          expect(report.status).toBe("success");
          expect((await plan(api, store, d)).plan.ops).toEqual([]);
        });
      }
    });
  }

  it("Blastorama uses the emoji╺╸name convention for every channel", () => {
    const d = desiredFrom(readFileSync("examples/blastorama/discord.yaml", "utf8"));
    const required = ["rules", "announcements", "dev-updates", "general", "clips-and-screenshots", "looking-for-game", "game-discussion",
      "party-1", "party-2", "suggestions", "bug-reports", "playtest-feedback", "staff-chat", "mod-logs"];
    expect(d.channels.map((c) => c.key)).toEqual(expect.arrayContaining(required));
    for (const c of d.channels) expect(c.name).toMatch(/^\p{Extended_Pictographic}️?╺╸[a-z0-9-]+$/u);
    expect(d.roles.map((r) => r.name)).toEqual(["Admin", "Developer", "Moderator", "Playtester", "Event Ping", "Update Ping"]);
    expect(d.roles.find((r) => r.key === "developer")!.permissions! & (1n << 3n)).toBe(0n); // no Administrator
  });
});
