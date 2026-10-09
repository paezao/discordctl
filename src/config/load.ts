import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LineCounter, parseDocument, isMap, isSeq, type Node as YamlNode, type Document } from "yaml";
import type { ZodError } from "zod";
import { ConfigSchema, PresetLibrarySchema, type Config, type PresetConfig } from "./schema.js";
import { type Diagnostic, formatPath } from "../core/diagnostics.js";
import { ConfigError } from "../util/errors.js";

export interface LoadOptions {
  /** Environment used for `${VAR}` interpolation. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Base directory for relative `imports`. Defaults to the config file's directory. */
  baseDir?: string;
  /** If set, `imports` may not resolve outside this directory (used by the MCP server). */
  sandboxRoot?: string;
  /** Source label for diagnostics. */
  source?: string;
}

export interface LoadedConfig {
  config: Config;
  /** Presets after merging imported libraries (local definitions win). */
  presets: Record<string, PresetConfig>;
  source: string;
  diagnostics: Diagnostic[];
}

export const BUILTIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");

export function loadConfigFile(path: string, options: LoadOptions = {}): LoadedConfig {
  const abs = resolve(path);
  if (options.sandboxRoot) assertInside(abs, options.sandboxRoot);
  if (!existsSync(abs)) throw new ConfigError(`Config file not found: ${path}`);
  const text = readFileSync(abs, "utf8");
  return loadConfigText(text, { ...options, baseDir: options.baseDir ?? dirname(abs), source: options.source ?? path });
}

/**
 * Parse, interpolate and validate configuration text. Throws ConfigError only for
 * unrecoverable problems (YAML syntax, schema violations); semantic issues are returned
 * as diagnostics by `resolveConfig`.
 */
export function loadConfigText(text: string, options: LoadOptions = {}): LoadedConfig {
  const source = options.source ?? "<inline>";
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: true, uniqueKeys: true });
  if (doc.errors.length > 0) {
    const e = doc.errors[0]!;
    const line = e.linePos?.[0]?.line;
    throw new ConfigError(`${source}${line ? `:${line}` : ""}: YAML syntax error: ${e.message.split("\n")[0]}`);
  }
  const env = options.env ?? process.env;
  const raw = interpolate(doc.toJS({ maxAliasCount: 100 }), env, []);

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(formatZodError(parsed.error, doc, lineCounter, source), {
      hint: "See docs/configuration.md or run `discordctl schema` for the full schema.",
    });
  }
  const config = parsed.data;
  const diagnostics: Diagnostic[] = [];
  const presets = { ...loadImports(config.imports, options, diagnostics), ...config.presets };
  return { config, presets, source, diagnostics };
}

function loadImports(imports: string[], options: LoadOptions, diagnostics: Diagnostic[]): Record<string, PresetConfig> {
  const merged: Record<string, PresetConfig> = {};
  for (const spec of imports) {
    let file: string;
    if (spec.startsWith("builtin:")) {
      const name = spec.slice("builtin:".length);
      // Builtin names are plain identifiers; anything else could escape the presets directory.
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new ConfigError(`Invalid builtin import "${spec}"`, { hint: "Builtin libraries are named like builtin:common." });
      file = join(BUILTIN_DIR, "presets", `${name}.yaml`);
    } else {
      const base = options.baseDir ?? process.cwd();
      file = isAbsolute(spec) ? spec : resolve(base, spec);
      if (options.sandboxRoot) assertInside(file, options.sandboxRoot);
    }
    if (!existsSync(file)) throw new ConfigError(`Import not found: ${spec}`);
    const doc = parseDocument(readFileSync(file, "utf8"));
    if (doc.errors.length > 0) throw new ConfigError(`Import ${spec}: YAML syntax error: ${doc.errors[0]!.message}`);
    const parsed = PresetLibrarySchema.safeParse(interpolate(doc.toJS(), options.env ?? process.env, []));
    if (!parsed.success) {
      throw new ConfigError(`Import ${spec} is not a valid preset library:\n${parsed.error.issues.map((i) => `  - ${formatPath(i.path)}: ${i.message}`).join("\n")}`);
    }
    for (const [name, preset] of Object.entries(parsed.data.presets)) {
      if (merged[name]) {
        diagnostics.push({ severity: "info", code: "PRESET_SHADOWED", message: `Preset "${name}" from ${spec} overrides an earlier import` });
      }
      merged[name] = preset;
    }
  }
  return merged;
}

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Replace `${VAR}` / `${VAR:-default}` in every string scalar. `$${` escapes a literal `${`. */
export function interpolate(value: unknown, env: Record<string, string | undefined>, path: (string | number)[]): unknown {
  if (typeof value === "string") {
    return value
      .replace(VAR_PATTERN, (match, name: string, fallback: string | undefined, offset: number, whole: string) => {
        if (offset > 0 && whole[offset - 1] === "$") return match;
        const v = env[name];
        if (v !== undefined && v !== "") return v;
        if (fallback !== undefined) return fallback;
        throw new ConfigError(`Environment variable ${name} is not set (referenced at ${formatPath(path) || "<root>"})`, {
          hint: `Export ${name} or add it to your .env file, or use \${${name}:-default}.`,
        });
      })
      .replace(/\$\$\{/g, "${");
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, env, [...path, i]));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, env, [...path, k]);
    return out;
  }
  return value;
}

function formatZodError(error: ZodError, doc: Document, lc: LineCounter, source: string): string {
  const lines = error.issues.slice(0, 20).map((issue) => {
    // For unknown keys, point at the misspelled key itself rather than its parent object.
    const keyPath = issue.code === "unrecognized_keys" && issue.keys.length > 0 ? [...issue.path, issue.keys[0]!] : issue.path;
    const line = lineFor(doc, lc, keyPath as (string | number)[]);
    const loc = line ? `${source}:${line}` : source;
    const p = formatPath(issue.path as PropertyKey[]);
    return `  - ${loc} ${p ? `at ${p}: ` : ""}${issue.message}`;
  });
  const more = error.issues.length > 20 ? `\n  ... and ${error.issues.length - 20} more` : "";
  return `Invalid configuration (${error.issues.length} problem${error.issues.length === 1 ? "" : "s"}):\n${lines.join("\n")}${more}`;
}

function lineFor(doc: Document, lc: LineCounter, path: (string | number)[]): number | undefined {
  // Walk as deep as the path exists to point at the closest node.
  for (let depth = path.length; depth >= 0; depth--) {
    const node = doc.getIn(path.slice(0, depth), true) as YamlNode | undefined;
    if (node && typeof node === "object" && "range" in node && node.range) {
      return lc.linePos(node.range[0]).line;
    }
    if (depth === 0 && (isMap(doc.contents) || isSeq(doc.contents)) && doc.contents.range) {
      return lc.linePos(doc.contents.range[0]).line;
    }
  }
  return undefined;
}

function assertInside(file: string, root: string): void {
  const rel = relative(resolve(root), resolve(file));
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ConfigError(`Refusing to read ${file}: outside the allowed directory ${root}`);
  }
}
