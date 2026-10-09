import { redact } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * Minimal structured logger writing to stderr (stdout is reserved for command output
 * and for the MCP stdio transport). All output is redacted.
 */
export function createLogger(level: LogLevel = "info", sink: (line: string) => void = (l) => process.stderr.write(l + "\n")): Logger {
  const emit = (lvl: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const suffix = data && Object.keys(data).length > 0 ? " " + safeJson(data) : "";
    sink(redact(`[${lvl}] ${msg}${suffix}`));
  };
  return {
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
  };
}

export const silentLogger: Logger = createLogger("silent");

function safeJson(data: unknown): string {
  try {
    return JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return "[unserializable]";
  }
}
