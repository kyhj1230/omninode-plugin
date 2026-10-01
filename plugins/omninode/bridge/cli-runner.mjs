// Ported from the URL Bridge's host-execution.mjs (localCliMain), split so the
// network side (recording to the Room) is no longer this module's job — that
// belongs to bridge-api.mjs, called from the orchestrator. What is preserved
// unchanged: the spawn/parse/timeout/cleanup behavior itself, which is the
// "configured condition" the owner asked to carry over as-is.
import { spawn } from "node:child_process";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BridgeError } from "./constants.mjs";
import { cliLoginStatus, loginRequiredError, looksLikeAuthFailure } from "./cli-login.mjs";
import { cliSpec } from "./cli-spec.mjs";
import { visibleParser } from "./stream-parser.mjs";

const MAX_BUFFER_BYTES = 2_000_000;
const TURN_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 2_000;

export class CliRunner {
  constructor({ spawnImpl = spawn, loginStatusImpl = cliLoginStatus } = {}) {
    this.spawnImpl = spawnImpl;
    this.loginStatusImpl = loginStatusImpl;
  }

  /**
   * Starts one CLI turn. Returns immediately; `completed` resolves once the
   * process exits with a valid answer, or rejects. `onText` fires with the
   * running append-only snapshot as the CLI produces it.
   */
  start({ prompt, target, model = null, effort = null, resumeCliSessionId = null }) {
    const spec = cliSpec(target, model, effort, prompt);
    const argv = resumeCliSessionId
      ? spec.resumeArgv.map((v) => (v === "<new_cli_session_id>" ? resumeCliSessionId : v))
      : spec.argv;

    const listeners = new Set();
    const emitText = (text) => { for (const fn of listeners) fn(text); };
    const activityListeners = new Set();
    const emitActivity = (text) => { for (const fn of activityListeners) fn(text); };

    // Never the user's project directory: avoids project hooks/instructions
    // reaching a CLI that a different local process just asked a question of.
    const cwd = mkdtempSync(join(tmpdir(), "omninode-bridge-turn-"));
    let buffer = "";
    let bad = false;
    let killTimer = null;
    let done = false;

    const parser = visibleParser(target, (value) => {
      if (value.kind === "snapshot") emitText(value.answer);
      if (value.kind === "activity") emitActivity(value.text);
    });

    const cleanup = () => {
      // Only removes an empty directory; a CLI that created files there keeps
      // them rather than being silently deleted.
      try { rmdirSync(cwd); } catch { /* preserve any CLI-created files */ }
    };

    const completed = new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnImpl(spec.executable, argv, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        cleanup();
        done = true;
        reject(new BridgeError("CLI_UNAVAILABLE", `${spec.executable} could not be started.`));
        return;
      }

      const stop = () => {
        bad = true;
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      };

      const timer = setTimeout(stop, TURN_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (bad) return;
        try {
          buffer += chunk;
          if (Buffer.byteLength(buffer) > MAX_BUFFER_BYTES) throw new Error("CLI_EVENT_TOO_LARGE");
          let end;
          while ((end = buffer.indexOf("\n")) !== -1) {
            parser.line(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
          }
        } catch {
          stop();
        }
      });
      // Never surfaced: raw provider logs can carry account/session detail. A
      // bounded tail is kept in memory only to tell an expired sign-in apart
      // from any other failure.
      let stderrTail = "";
      child.stderr.setEncoding?.("utf8");
      child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk).slice(-8_000); });

      child.on("error", () => { bad = true; });
      child.on("close", async (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        cleanup();
        done = true;
        const failed = bad || code !== 0;
        // A failing CLI often prints its real reason (e.g. an expired OAuth
        // session) as the last line before exiting; read it before deciding.
        if (failed && buffer.trim()) { try { parser.line(buffer); } catch { /* classification only */ } }
        try {
          if (failed) throw new BridgeError("CLI_EXECUTION_FAILED", `${spec.executable} exited with an error.`);
          if (buffer.trim()) parser.line(buffer);
          const result = parser.finish();
          resolve(result);
        } catch (error) {
          const known = error instanceof BridgeError
            ? error
            : new BridgeError("CLI_RESULT_FAILED", "The CLI did not produce a usable answer.");
          // Whatever the surface error was, a sign-in problem must always be
          // reported as one, so the owner is sent to sign in instead of seeing
          // a bare execution failure.
          let signedIn = true;
          try {
            signedIn = !looksLikeAuthFailure(`${parser.errorText()}\n${stderrTail}`)
              && (await this.loginStatusImpl(target)) !== "signed_out";
          } catch { /* keep the original error */ }
          reject(signedIn ? known : loginRequiredError(target));
        }
      });
    });

    return {
      onText(fn) { listeners.add(fn); },
      onActivity(fn) { activityListeners.add(fn); },
      completed,
      get done() { return done; },
    };
  }
}
