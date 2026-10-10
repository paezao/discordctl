import pc from "picocolors";
import type { Plan, PlanOp } from "./types.js";
import type { Diagnostic } from "../core/diagnostics.js";
import type { ExecutionReport } from "../engine/executor.js";
import type { Finding } from "../permissions/audit.js";
import type { ManualStep } from "../core/model.js";

export interface Colors {
  green: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
  cyan: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
  magenta: (s: string) => string;
}

const id = (s: string) => s;
export const NO_COLOR: Colors = { green: id, yellow: id, red: id, cyan: id, dim: id, bold: id, magenta: id };
export function colors(enabled: boolean): Colors {
  if (!enabled) return NO_COLOR;
  const c = pc.createColors(true);
  return { green: c.green, yellow: c.yellow, red: c.red, cyan: c.cyan, dim: c.dim, bold: c.bold, magenta: c.magenta };
}

const SYMBOL: Record<PlanOp["action"], string> = { create: "+", update: "~", move: "↕", delete: "-", import: "=" };
const VERB: Record<PlanOp["action"], string> = { create: "Create", update: "Update", move: "Move", delete: "Delete", import: "Import" };
const RESOURCE_LABEL: Record<PlanOp["resource"], string> = {
  guild: "server settings", everyone: "role", role: "role", "role-order": "", category: "category", channel: "channel", "channel-order": "", onboarding: "",
};

export function renderPlan(plan: Plan, c: Colors = NO_COLOR, options: { detailed?: boolean; manualSteps?: "titles" | "full" } = {}): string {
  const detailed = options.detailed ?? true;
  const lines: string[] = [c.bold(`Plan for ${plan.guildName} (${plan.guildId})`), ""];
  if (plan.ops.length === 0) {
    lines.push(c.green("No changes. Discord matches the configuration."));
  }
  for (const op of plan.ops) {
    const color = op.action === "create" ? c.green : op.action === "delete" ? c.red : op.action === "import" ? c.cyan : c.yellow;
    const what =
      op.resource === "role-order" ? "Reorder role hierarchy"
      : op.resource === "channel-order" ? `Reorder ${op.name}`
      : op.resource === "onboarding" ? "Update server onboarding"
      : `${VERB[op.action]} ${RESOURCE_LABEL[op.resource]}: ${op.name}`;
    const risk = op.risk === "low" ? "" : " " + (op.risk === "critical" || op.risk === "high" ? c.red : c.yellow)(`[${op.risk} risk]`);
    const note = op.note && !["category", "voice channel", "stage channel"].includes(op.note) ? c.dim(` (${op.note})`) : "";
    lines.push(`${color(SYMBOL[op.action])} ${what}${risk}${note}`);
    if (detailed) {
      for (const ch of op.changes) {
        if (ch.before === null && ch.after !== null) lines.push(`    ${c.dim(ch.field + ":")} ${ch.after}`);
        else if (ch.after === null) lines.push(`    ${c.dim(ch.field + ":")} ${c.red(String(ch.before))} ${c.dim("→ (removed)")}`);
        else lines.push(`    ${c.dim(ch.field + ":")} ${ch.before} ${c.dim("→")} ${ch.after}`);
      }
      for (const r of op.riskReasons) lines.push(`    ${c.red("!")} ${r}`);
    }
  }
  const s = plan.summary;
  lines.push("");
  lines.push(
    c.bold(`Plan: ${s.create} to create, ${s.update} to update, ${s.move} to move, ${s.delete} to delete`) + (s.import ? c.dim(`, ${s.import} to import into state`) : "") + ".",
  );
  const diag = renderDiagnostics(plan.diagnostics.filter((d) => d.severity !== "info"), c);
  if (diag) lines.push("", diag);
  if (plan.manualSteps.length && options.manualSteps === "full") {
    lines.push("", renderManualSteps(plan.manualSteps, c));
  } else if (plan.manualSteps.length) {
    lines.push("", c.bold("Manual steps (not automated):") + c.dim(" step-by-step instructions are shown after apply, or with `plan`"));
    for (const st of plan.manualSteps) lines.push(`  ${c.magenta("•")} ${st.title}`);
  }
  return lines.join("\n");
}

export function renderDiagnostics(diags: Diagnostic[], c: Colors = NO_COLOR): string {
  return diags
    .map((d) => {
      const tag = d.severity === "error" ? c.red("error") : d.severity === "warning" ? c.yellow("warning") : c.cyan("info");
      const where = d.path ? c.dim(` [${d.path}${d.line ? `:${d.line}` : ""}]`) : "";
      return `${tag}: ${d.message}${where}${d.hint ? `\n    ${c.dim("hint:")} ${d.hint}` : ""}`;
    })
    .join("\n");
}

export function renderFindings(findings: Finding[], c: Colors = NO_COLOR): string {
  if (findings.length === 0) return c.green("No permission issues found.");
  return findings
    .map((f) => {
      const color = f.severity === "critical" || f.severity === "high" ? c.red : f.severity === "medium" ? c.yellow : c.dim;
      return `${color(f.severity.toUpperCase().padEnd(8))} ${f.message}${f.hint ? `\n         ${c.dim("hint:")} ${f.hint}` : ""}`;
    })
    .join("\n");
}

export function renderManualSteps(steps: ManualStep[], c: Colors = NO_COLOR): string {
  const out = [c.bold(`Manual steps (${steps.length}) — Discord's API can't do these, so do them in the Discord app:`)];
  steps.forEach((s, i) => {
    out.push("", c.bold(`${i + 1}. ${s.title}`), `   ${c.dim(s.reason)}`);
    s.steps.forEach((step, j) => {
      const [first, ...rest] = step.split("\n");
      out.push(`   ${c.magenta(`${String.fromCharCode(97 + j)})`)} ${first}`);
      for (const line of rest) out.push(`      ${line}`);
    });
    if (s.snippet) {
      // Raw lines with no prefix or indent, so the block can be selected and pasted as-is.
      out.push("", c.dim("----- copy from the next line -----"), s.snippet, c.dim("----- end of text to copy -----"));
    }
  });
  return out.join("\n");
}

export function renderReport(report: ExecutionReport, c: Colors = NO_COLOR): string {
  const lines: string[] = [];
  for (const r of report.results) {
    if (r.status === "applied") continue;
    const tag = r.status === "failed" ? c.red("failed ") : c.yellow("skipped");
    lines.push(`${tag} ${r.opId}: ${r.error?.message ?? ""}${r.error?.hint ? c.dim(` (${r.error.hint})`) : ""}`);
  }
  const color = report.status === "success" || report.status === "noop" ? c.green : report.status === "partial" ? c.yellow : c.red;
  lines.push(color(`Apply ${report.status}: ${report.applied} applied, ${report.failed} failed, ${report.skipped} skipped.`));
  if (report.status === "partial" || report.status === "failed") {
    lines.push(c.dim("Completed operations were recorded in state. Fix the error and run plan/apply again to finish; nothing will be duplicated."));
  }
  return lines.join("\n");
}
