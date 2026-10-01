// begin_bridge_turn_v9's target_cli_status is documented as "a caller-host
// attestation from a local check in the same environment that would run the
// target CLI" — not a value the caller may just assert. This performs that
// check locally rather than always claiming "available".
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

import { EXECUTABLE_BY_TARGET } from "./cli-spec.mjs";

const execFile = promisify(nodeExecFile);

export async function checkTargetCliStatus(target, { execFileImpl = execFile } = {}) {
  const executable = EXECUTABLE_BY_TARGET[target];
  if (!executable) return "installation_required";
  try {
    await execFileImpl("/usr/bin/which", [executable], { timeout: 5_000 });
  } catch {
    return "installation_required";
  }
  // Confirming an authenticated session (vs. merely installed) would mean
  // running the CLI's own status command, which is itself a provider call.
  // A CLI actually missing its login surfaces as a normal CLI_EXECUTION_FAILED
  // from cli-runner.mjs instead, same as any other failed turn.
  return "available";
}
