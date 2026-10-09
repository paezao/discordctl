import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

/**
 * Load node:sqlite while suppressing its one-time ExperimentalWarning on older Node versions,
 * so CLI output and the MCP stdio stream stay clean.
 */
export function loadSqlite(): typeof DatabaseSyncType {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/sqlite/i.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const require = createRequire(import.meta.url);
    return (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
  } finally {
    process.emitWarning = original;
  }
}
