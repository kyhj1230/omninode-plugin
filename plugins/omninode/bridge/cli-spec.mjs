// Ported from the URL Bridge's protocol.mjs (cliSpec / isSupportedModelPreference),
// verbatim in argv content, with one deliberate, owner-approved addition: a narrow
// Bash allowlist for claude_code (see CLAUDE_CODE_ALLOWED_BASH below), added after
// confirming no Anthropic policy prohibits it. Everything else here — read-only
// sandbox, stripped child environment, a fresh empty working directory — is
// unchanged from the original "configured condition."
import { BridgeError } from "./constants.mjs";

// Read/compute-only, no writes, no deletes, no network, no privilege escalation.
// This is enforced by claude CLI's own permission gate (verified live: a
// disallowed command like `rm` is not executed, not just discouraged), not an
// OS-level sandbox — Claude Code CLI has no equivalent to Codex's
// --sandbox read-only. --tools "Bash" alone already excludes every other tool
// (Write, Edit, WebFetch, ...); this list further restricts what Bash itself
// may run.
const CLAUDE_CODE_ALLOWED_BASH = [
  "Bash(ls*)", "Bash(pwd)", "Bash(echo*)", "Bash(date*)", "Bash(cat*)",
  "Bash(head*)", "Bash(tail*)", "Bash(wc*)", "Bash(python3 -c*)", "Bash(bc*)",
];

// Kept alongside cliSpec so the availability check (used for the honest
// target_cli_status attestation sent in begin_bridge_turn_v9) resolves the
// same binary name cliSpec would actually invoke.
export const EXECUTABLE_BY_TARGET = { codex: "codex", claude_code: "claude" };

export function isSupportedModelPreference(target, model, effort) {
  if (!["codex", "claude_code"].includes(target) || typeof model !== "string") return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(model)) return false;
  return effort == null || (typeof effort === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(effort));
}

export function cliSpec(target, model, effort, prompt) {
  if (model && !isSupportedModelPreference(target, model, null)) {
    throw new BridgeError("BRIDGE_TARGET_MODEL_INVALID", "That model is not recognized for this target CLI.");
  }
  if (effort && !isSupportedModelPreference(target, model, effort)) {
    throw new BridgeError("BRIDGE_TARGET_MODEL_INVALID", "That reasoning effort is not recognized for this target CLI.");
  }
  if (typeof prompt !== "string" || !prompt || prompt.includes("\0")) {
    throw new BridgeError("BRIDGE_PROMPT_INVALID", "The prompt is invalid.");
  }

  if (target === "codex") {
    const argv = [
      "exec",
      "--ignore-user-config",
      "--sandbox", "read-only",
      "--skip-git-repo-check",
      "--json",
      "-c", 'shell_environment_policy.inherit="none"',
    ];
    if (model) argv.push("--model", model);
    if (effort) argv.push("-c", `model_reasoning_effort="${effort}"`);
    argv.push("--", prompt);

    const resumeArgv = [
      "exec", "resume",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--json",
      "-c", 'sandbox_mode="read-only"',
      "-c", 'shell_environment_policy.inherit="none"',
    ];
    if (model) resumeArgv.push("--model", model);
    if (effort) resumeArgv.push("-c", `model_reasoning_effort="${effort}"`);
    resumeArgv.push("<new_cli_session_id>", "--", prompt);

    return { executable: "codex", argv, resumeArgv, shell: false, cwd: "fresh_empty_directory" };
  }

  const argv = [
    "--safe-mode", "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--tools", "Bash", "--allowedTools", ...CLAUDE_CODE_ALLOWED_BASH,
  ];
  if (model) argv.push("--model", model);
  if (effort) argv.push("--effort", effort);
  argv.push("--", prompt);

  const resumeArgv = [
    "--safe-mode", "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--tools", "Bash", "--allowedTools", ...CLAUDE_CODE_ALLOWED_BASH,
  ];
  if (model) resumeArgv.push("--model", model);
  if (effort) resumeArgv.push("--effort", effort);
  resumeArgv.push("--resume", "<new_cli_session_id>", "--", prompt);

  return { executable: "claude", argv, resumeArgv, shell: false, cwd: "fresh_empty_directory" };
}
