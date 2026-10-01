// The model catalog the installed target CLI itself currently lists, read
// from its own local cache (no provider call). Sent to the live view so the
// model dropdown is not limited to a catalog captured when the CLI was first
// connected — a CLI update adds models the stored catalog never saw.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// One activity line per model, so each stays far below the 500-character cap.
export const CLI_MODEL_ACTIVITY_PREFIX = "omninode:cli-model ";

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const EFFORT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u;

export async function listedCliModels(target, { path = join(homedir(), ".codex", "models_cache.json") } = {}) {
  if (target !== "codex") return [];
  try {
    const cache = JSON.parse(await readFile(path, "utf8"));
    return (Array.isArray(cache?.models) ? cache.models : [])
      .filter((entry) => entry?.visibility === "list" && MODEL_PATTERN.test(entry.slug ?? ""))
      .map((entry) => ({
        model: entry.slug,
        label: String(entry.display_name ?? entry.slug).replace(/\|/gu, "").slice(0, 60),
        efforts: (Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [])
          .map((level) => level?.effort)
          .filter((effort) => typeof effort === "string" && EFFORT_PATTERN.test(effort)),
      }));
  } catch {
    return [];
  }
}

export function modelActivityLine({ model, label, efforts }) {
  return `${CLI_MODEL_ACTIVITY_PREFIX}${model}|${label}|${efforts.join(",")}`;
}
