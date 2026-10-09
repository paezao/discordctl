/** Helpers for display names, keys and Discord's channel-name normalization. */

/** Text-like channels: Discord lowercases names and converts whitespace to dashes. */
export function normalizeTextChannelName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-").replace(/-{2,}/g, "-");
}

/** Comparison key used when matching names (case-insensitive, whitespace-collapsed). */
export function nameMatchKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, "-");
}

/** Build a stable logical key from a display name: strips emoji/decoration, kebab-case. */
export function slugify(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii.length > 0 ? ascii : "resource";
}

/** Make `base` unique within `taken` by appending -2, -3, ... */
export function uniqueKey(base: string, taken: Set<string>): string {
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}-${n++}`;
  taken.add(key);
  return key;
}

export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseDuration(value: number | string): number {
  if (typeof value === "number") return value;
  const m = /^(\d+)\s*(s|m|h)?$/.exec(value.trim());
  if (!m) throw new Error(`Invalid duration "${value}" (use seconds, or e.g. "30s", "5m", "1h")`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  return unit === "h" ? n * 3600 : unit === "m" ? n * 60 : n;
}
