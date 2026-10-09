/**
 * Secret redaction. Every string that may leave the process (logs, MCP responses,
 * error reports) should pass through `redact`.
 */
const TOKEN_PATTERN = /[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/g;
const BOT_HEADER_PATTERN = /(Bot|Bearer)\s+[A-Za-z0-9._-]{20,}/g;

const knownSecrets = new Set<string>();

/** Register a secret value so it is always redacted, even if it does not match a token shape. */
export function registerSecret(secret: string | undefined): void {
  if (secret && secret.length >= 8) knownSecrets.add(secret);
}

export function redact(input: string): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join("[REDACTED]");
  }
  return out.replace(TOKEN_PATTERN, "[REDACTED_TOKEN]").replace(BOT_HEADER_PATTERN, "$1 [REDACTED]");
}

/** Deep-redact any JSON-compatible value. Keys that look like secrets are dropped entirely. */
export function redactDeep<T>(value: T): T {
  return walk(value) as T;
}

const SECRET_KEYS = /^(token|bot_?token|authorization|secret|password|client_?secret)$/i;

function walk(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? "[REDACTED]" : walk(v);
    }
    return out;
  }
  return value;
}
