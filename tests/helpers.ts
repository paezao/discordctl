import { FakeDiscord } from "../src/provider/fake.js";
import { fetchSnapshot } from "../src/provider/normalize.js";
import { loadConfigText } from "../src/config/load.js";
import { resolveConfig } from "../src/config/resolve.js";
import { createPlan, type PlanOptions } from "../src/plan/planner.js";
import { executePlan } from "../src/engine/executor.js";
import { StateStore } from "../src/state/store.js";
import type { DesiredState } from "../src/core/model.js";
import { hasErrors } from "../src/core/diagnostics.js";

export const GUILD_ID = "111111111111111111";

export function setup(features: string[] = []) {
  const api = new FakeDiscord();
  api.addGuild({ id: GUILD_ID, name: "Test Guild", features });
  const store = StateStore.memory();
  return { api, store };
}

export function desiredFrom(yaml: string, env: Record<string, string> = {}): DesiredState {
  const loaded = loadConfigText(yaml, { env: { DISCORD_GUILD_ID: GUILD_ID, ...env } });
  const { desired, diagnostics } = resolveConfig(loaded);
  if (hasErrors(diagnostics)) throw new Error("config errors: " + JSON.stringify(diagnostics.filter((d) => d.severity === "error"), null, 2));
  return desired;
}

export async function plan(api: FakeDiscord, store: StateStore, desired: DesiredState, options: PlanOptions = {}) {
  const snapshot = await fetchSnapshot(api, desired.guildId, { onboarding: Boolean(desired.onboarding) });
  return { plan: createPlan(desired, snapshot, store.getMappings(desired.guildId), options), snapshot };
}

export async function apply(api: FakeDiscord, store: StateStore, desired: DesiredState, options: PlanOptions = {}) {
  const { plan: p, snapshot } = await plan(api, store, desired, options);
  const errors = p.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error("plan errors: " + JSON.stringify(errors, null, 2));
  const report = await executePlan(p, { api, snapshot, store, sleep: async () => {} });
  return { plan: p, report };
}
