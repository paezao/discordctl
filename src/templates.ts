import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { BUILTIN_DIR } from "./config/load.js";

export interface TemplateInfo {
  name: string;
  title: string;
  description: string;
  path: string;
}

/** Built-in templates are plain YAML files in templates/*.yaml (presets live in templates/presets/). */
export function listTemplates(dir = BUILTIN_DIR): TemplateInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => {
      const path = join(dir, f);
      const doc = parse(readFileSync(path, "utf8")) as { metadata?: { name?: string; description?: string } } | null;
      return { name: f.replace(/\.yaml$/, ""), title: doc?.metadata?.name ?? f, description: doc?.metadata?.description ?? "", path };
    });
}

export function readTemplate(name: string, dir = BUILTIN_DIR): string {
  const t = listTemplates(dir).find((x) => x.name === name);
  if (!t) throw new Error(`Unknown template "${name}". Available: ${listTemplates(dir).map((x) => x.name).join(", ")}`);
  return readFileSync(t.path, "utf8");
}
