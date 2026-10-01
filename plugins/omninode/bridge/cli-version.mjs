// Installed-vs-latest check for the target CLI the Bridge runs, so the asking
// side can offer an update before a question goes out. Read-only: this never
// installs or updates anything itself — the owner answers first.
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

import { EXECUTABLE_BY_TARGET } from "./cli-spec.mjs";

const execFile = promisify(nodeExecFile);

const NPM_PACKAGE_BY_TARGET = { codex: "@openai/codex", claude_code: "@anthropic-ai/claude-code" };
const UPDATE_COMMAND_BY_TARGET = {
  codex: "npm install -g @openai/codex@latest",
  claude_code: "claude update",
};

// Marks the activity line that carries the CLI version to the live view, so
// the page can show it next to Apply instead of listing it as a command.
export const CLI_VERSION_ACTIVITY_PREFIX = "omninode:cli-version ";

export function parseVersion(text) {
  return String(text ?? "").match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/u)?.[0] ?? null;
}

export function isOlderVersion(installed, latest) {
  const a = String(installed).split(/[-+]/u)[0].split(".").map(Number);
  const b = String(latest).split(/[-+]/u)[0].split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

export async function installedCliVersion(target, { execFileImpl = execFile } = {}) {
  const executable = EXECUTABLE_BY_TARGET[target];
  if (!executable) return null;
  try {
    const { stdout } = await execFileImpl(executable, ["--version"], { timeout: 5_000 });
    return parseVersion(stdout);
  } catch {
    return null;
  }
}

export async function latestCliVersion(target, { execFileImpl = execFile } = {}) {
  const pkg = NPM_PACKAGE_BY_TARGET[target];
  if (!pkg) return null;
  try {
    const { stdout } = await execFileImpl("npm", ["view", pkg, "version"], { timeout: 15_000 });
    return parseVersion(stdout);
  } catch {
    return null;
  }
}

export async function checkCliVersion(target, deps = {}) {
  const [installed, latest] = await Promise.all([
    installedCliVersion(target, deps),
    latestCliVersion(target, deps),
  ]);
  return {
    installed,
    latest,
    upToDate: installed && latest ? !isOlderVersion(installed, latest) : null,
    updateCommand: UPDATE_COMMAND_BY_TARGET[target] ?? null,
  };
}
