// Remembers the last model the server actually assigned per target, so a new
// turn can start the CLI immediately instead of waiting on a network round
// trip just to learn which model to pass. Not a secret — plain JSON on disk,
// not Keychain.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BRIDGE_PROVIDERS } from "./constants.mjs";

function normalize(value) {
  const out = {};
  if (value && typeof value === "object") {
    for (const target of BRIDGE_PROVIDERS) {
      if (typeof value[target] === "string" && value[target].trim()) out[target] = value[target];
    }
  }
  return out;
}

export class FileModelCache {
  constructor({
    path = join(homedir(), ".omninode-bridge-local", "model-cache.json"),
  } = {}) {
    this.path = path;
  }

  async get(target) {
    return this.#read()[target] ?? null;
  }

  /** Called with the server's authoritative choice after a turn's begin call resolves. */
  async reconcile(target, turn) {
    const model = turn?.model;
    if (typeof model !== "string" || !model.trim()) return;
    const state = this.#read();
    if (state[target] === model) return;
    state[target] = model;
    this.#write(state);
  }

  #read() {
    try {
      return normalize(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      return {};
    }
  }

  #write(state) {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeFileSync(this.path, JSON.stringify(state), "utf8");
    } catch {
      // Losing the cache just means the next turn waits for the server's
      // model once more; never worth failing a turn over.
    }
  }
}

export class MemoryModelCache {
  constructor(initial = {}) {
    this.state = normalize(initial);
  }

  async get(target) { return this.state[target] ?? null; }
  async reconcile(target, turn) {
    const model = turn?.model;
    if (typeof model === "string" && model.trim()) this.state[target] = model;
  }
}
