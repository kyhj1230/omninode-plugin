// Whether the target CLI is signed in, checked before a question is started.
// Both CLIs answer locally: `claude auth status` and `codex login status`
// exit non-zero when nobody is signed in, without making a model request.
// Without this, a signed-out CLI only surfaces later as a bare
// CLI_EXECUTION_FAILED from the runner, after the live view already opened.
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

import { EXECUTABLE_BY_TARGET } from "./cli-spec.mjs";
import { BridgeError, bridgeProviderLabel } from "./constants.mjs";

const execFile = promisify(nodeExecFile);

const LOGIN_STATUS_ARGV = {
  codex: ["login", "status"],
  claude_code: ["auth", "status"],
};
const LOGIN_COMMAND_BY_TARGET = { codex: "codex login", claude_code: "claude auth login" };

// "signed_in" | "signed_out" | "unknown". Only a definite non-zero exit from
// the status command counts as signed out: a missing binary, a timeout, or an
// unrecognised command is "unknown" and must not block a question that would
// otherwise work.
export async function cliLoginStatus(target, { execFileImpl = execFile } = {}) {
  const executable = EXECUTABLE_BY_TARGET[target];
  const argv = LOGIN_STATUS_ARGV[target];
  if (!executable || !argv) return "unknown";
  try {
    await execFileImpl(executable, argv, { timeout: 8_000 });
    return "signed_in";
  } catch (error) {
    if (error && typeof error.code === "number" && !error.killed) return "signed_out";
    return "unknown";
  }
}

export function loginRequiredError(target) {
  const label = bridgeProviderLabel(target);
  return new BridgeError(
    "CLI_LOGIN_REQUIRED",
    `${label} CLI is not signed in, so no answer was produced. Do not ask permission: start the official sign-in now by running \`${LOGIN_COMMAND_BY_TARGET[target]}\` (the owner finishes it in the browser it opens), then retry this call.`,
  );
}

export async function requireCliLogin(target, deps = {}) {
  if ((await cliLoginStatus(target, deps)) !== "signed_out") return;
  throw loginRequiredError(target);
}

// Text a CLI prints (its own error result or stderr) when its sign-in is the
// problem: an expired or unrefreshable OAuth session, no login at all, or a
// rejected credential. Read locally to classify a failure, never forwarded.
const AUTH_FAILURE_PATTERN = /authenticat|oauth|not (?:logged|signed) in|log ?in|sign ?in|unauthori[sz]ed|\b401\b|session (?:has )?expired|token (?:has )?(?:expired|invalid|revoked)|invalid (?:api key|credential|token)|credentials?\b.*(?:expired|invalid|missing)/iu;
export const looksLikeAuthFailure = (text) => AUTH_FAILURE_PATTERN.test(String(text ?? ""));
