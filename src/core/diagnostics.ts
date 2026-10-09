export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  /** Config path (e.g. `categories[2].channels[0].permissions`) or resource reference. */
  path?: string;
  line?: number;
  hint?: string;
}

export function hasErrors(diags: Diagnostic[]): boolean {
  return diags.some((d) => d.severity === "error");
}

export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const p of path) {
    if (typeof p === "number") out += `[${p}]`;
    else out += out.length === 0 ? String(p) : `.${String(p)}`;
  }
  return out;
}
