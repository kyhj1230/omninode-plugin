// Ported verbatim from the URL Bridge's host-execution.mjs (visibleParser /
// isCliSessionId). Parses each CLI's newline-delimited JSON into an
// append-only answer snapshot, forwarding only visible assistant text as the
// answer — plus, separately, a short activity summary of the allowlisted
// Bash commands each CLI actually runs (never their raw stdout). Never
// thinking, stderr, usage, or login data.
export const isCliSessionId = (value) =>
  typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);

const MAX_ANSWER_BYTES = 262_144;
// Matches the old plugin's codex-bridge-relay.mjs describeItem() truncation,
// verified against real codex-cli --json output.
const MAX_COMMAND_CHARS = 200;
// Matches the DB's bridge_v2_append_activity octet_length cap.
const MAX_ACTIVITY_CHARS = 500;

const truncate = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// Same summary shape as the old plugin's describeItem(): "$ <command>" while
// running, "exit <code>" once it finishes. Only command_execution is covered
// here — Codex's other item types (agent_message, error) are already handled
// as the answer/failure path, not activity.
function describeCommandExecution(item, started) {
  const command = typeof item.command === "string" ? truncate(item.command, MAX_COMMAND_CHARS) : "";
  if (started) return command ? `$ ${command}` : "Running a command…";
  const exitCode = Number.isInteger(item.exit_code) ? item.exit_code : null;
  return exitCode === null ? "Command finished." : `exit ${exitCode}`;
}

// Same shape as describeCommandExecution, for claude_code's Bash tool — the
// only tool this Bridge ever enables for that target (see cli-spec.mjs's
// CLAUDE_CODE_ALLOWED_BASH). tool_result carries no exit code, only
// is_error, so "exit 1" here is a stand-in, not a real process exit status —
// chosen to match the Room UI's existing /^exit [1-9]/ failure-line pattern
// rather than adding a second format for it to recognize.
function describeClaudeBashCommand(input) {
  const command = typeof input?.command === "string" ? truncate(input.command, MAX_COMMAND_CHARS) : "";
  return command ? `$ ${command}` : "Running a command…";
}
function describeClaudeBashResult(isError) {
  return isError ? "exit 1" : "exit 0";
}

export function visibleParser(target, emit) {
  let answer = "";
  // With Bash enabled, claude_code can legitimately send more than one
  // top-level message per turn: a preamble ("먼저 ls를 실행하겠습니다") before a
  // tool call, then the real final response after the tool result comes
  // back. Both stream into `answer` (still one continuous, append-only live
  // view — a reader watching it happen sees the preamble, then the answer).
  // But the CLI's own authoritative `result` field is only ever the LAST
  // message's text, not the preamble too — so the finish()-time consistency
  // check has to compare `result` against just that last message, tracked
  // here separately and reset at each message_start.
  let lastMessageText = "";
  let final = null;
  let ok = false;
  let failed = false;
  let cliId = null;
  let errorText = "";
  const items = new Map();

  const bounded = (s) => {
    if (typeof s !== "string" || new TextEncoder().encode(s).length > MAX_ANSWER_BYTES) {
      throw new Error("CLI_ANSWER_INVALID");
    }
    return s;
  };

  const snapshot = (s) => {
    bounded(s);
    if (!s.startsWith(answer)) throw new Error("CLI_STREAM_NOT_APPEND_ONLY");
    if (s !== answer) {
      answer = s;
      emit({ kind: "snapshot", answer });
    }
  };

  return {
    line(line) {
      if (!line.trim()) return;
      const m = JSON.parse(line);
      if (target === "claude_code") {
        if (m.type === "system" && m.subtype === "init") cliId = m.session_id;
        const e = m.type === "stream_event" ? m.event : null;
        if (e?.type === "message_start") lastMessageText = "";
        if (e?.type === "content_block_start" && e.content_block?.type === "text") {
          const addition = e.content_block.text || "";
          lastMessageText += addition;
          snapshot(answer + addition);
        }
        if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
          lastMessageText += e.delta.text;
          snapshot(answer + e.delta.text);
        }
        if (m.type === "result") {
          ok = m.subtype === "success" && !m.is_error;
          failed ||= !ok;
          if (!ok && typeof m.result === "string") errorText = m.result.slice(0, 1000);
          if (ok) final = bounded(m.result);
        }
        // The CLI also emits fully-assembled (non-delta) "assistant"/"user"
        // messages alongside the raw stream_event deltas above — simpler to
        // read a tool_use's already-complete input/result here than to
        // reassemble input_json_delta chunks by hand.
        if (m.type === "assistant") {
          for (const block of m.message?.content ?? []) {
            if (block?.type === "tool_use" && block.name === "Bash") {
              emit({ kind: "activity", text: truncate(describeClaudeBashCommand(block.input), MAX_ACTIVITY_CHARS) });
            }
          }
        }
        if (m.type === "user") {
          for (const block of m.message?.content ?? []) {
            if (block?.type === "tool_result") {
              emit({ kind: "activity", text: describeClaudeBashResult(block.is_error === true) });
            }
          }
        }
      } else {
        if (m.type === "thread.started") cliId = m.thread_id;
        if (["item.started", "item.updated", "item.completed"].includes(m.type)
          && m.item?.type === "agent_message" && typeof m.item.id === "string") {
          items.set(m.item.id, bounded(m.item.text));
          snapshot([...items.values()].join("\n\n"));
        }
        if (m.type === "item.started" && m.item?.type === "command_execution") {
          emit({ kind: "activity", text: truncate(describeCommandExecution(m.item, true), MAX_ACTIVITY_CHARS) });
        }
        if (m.type === "item.completed" && m.item?.type === "command_execution") {
          emit({ kind: "activity", text: truncate(describeCommandExecution(m.item, false), MAX_ACTIVITY_CHARS) });
        }
        if (m.type === "turn.completed") { ok = true; final = answer; }
        if (m.type === "turn.failed" || m.type === "error") {
          failed = true;
          const message = m.error?.message ?? m.message;
          if (typeof message === "string") errorText = message.slice(0, 1000);
        }
      }
    },
    // The CLI's own failure text, for local classification only.
    errorText() { return errorText; },
    finish() {
      const cliSessionId = isCliSessionId(cliId) ? cliId : null;
      // codex has no preamble/final split (final is always set to the same
      // `answer` it's checked against); claude_code's authoritative result
      // only ever covers its last message, not any preamble before a tool call.
      const expected = target === "claude_code" ? lastMessageText : answer;
      if (failed || !ok || !final || !final.startsWith(expected) || !cliSessionId) {
        throw new Error("CLI_RESULT_FAILED");
      }
      return { answer: final, cliSessionId };
    },
  };
}
