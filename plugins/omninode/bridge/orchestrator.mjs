// Turn orchestration for the local Bridge.
//
// The connector version of this flow cost one AI inference round per step
// (check -> begin -> spawn -> stream -> record). Here every step is plain
// code, and the Room is treated strictly as an observer: no network call is
// ever awaited on the path the user is waiting on for the *answer*.
//
// Split into begin()/finish() rather than one run() so the caller can open a
// live view the moment the Room exists (a ~0.4s round trip) instead of only
// after the full answer (seconds) — mirroring how the old live-view plugin
// returned its conversation handle immediately, before Codex finished.
import { BridgeError } from "./constants.mjs";
import { checkTargetCliStatus } from "./cli-availability.mjs";
import { CLI_VERSION_ACTIVITY_PREFIX } from "./cli-version.mjs";
import { modelActivityLine } from "./cli-models.mjs";

const MIRROR_COALESCE_MS = 1000;
// Bounds how long begin() waits on the Room round trip before returning
// anyway. A dead or slow Bridge server must never hold up the CLI answer —
// the CLI keeps running regardless; this only affects whether localViewUrl
// is ready in time for the caller to open a live view immediately.
// The real deployment is a serverless function; a cold start alone has been
// measured near 3s, so 3s left almost no margin before silently dropping the
// live view. 6s keeps a healthy warm call (~0.4-0.5s) just as fast while
// giving a cold one room to actually finish instead of racing it.
const BEGIN_TIMEOUT_MS = 6000;
// Extra time granted to the same in-flight Room call before the live view is
// declared unavailable.
const RETRY_WAIT_MS = 4000;

// Plain-language reason shown to the owner when no live view link exists.
function liveViewUnavailableReason(t, failure) {
  if (t?.providerSetup) return "Omninode says the target CLI needs setup first, so no live view was created.";
  const code = failure?.code;
  if (code === "BRIDGE_LOGIN_REQUIRED" || code === "BRIDGE_TOKEN_INVALID") {
    return "Sign in to Omninode (a login window may be open in your browser), then ask again to get a live view.";
  }
  if (failure) return "Omninode could not be reached, so there is no live view this time.";
  return "Omninode was too slow to respond, so there is no live view this time.";
}

function liveViewUnavailableError(t, failure) {
  // The server's own limit gets its own actionable message.
  if (failure?.message === "ROOM_LIMIT") {
    return new BridgeError(
      "BRIDGE_ROOM_LIMIT",
      "Omninode Bridge has reached its room limit, so no live view could be created and nothing was started. Ask the owner to delete old rooms in the Bridge sidebar (https://omninode-web.vercel.app/bridge), then ask again.",
    );
  }
  return new BridgeError(
    "BRIDGE_LIVE_VIEW_UNAVAILABLE",
    `${liveViewUnavailableReason(t, failure)} Nothing was started — tell the owner why and stop; do not answer without the live view.`,
  );
}

// What the Room shows for a failed turn: the bare code, except for a sign-in
// problem, which says what to do instead of just naming the error.
function failureText(error) {
  if (error?.code === "CLI_LOGIN_REQUIRED") return "CLI_LOGIN_REQUIRED · The CLI is not signed in. Sign in, then ask again.";
  return String(error?.code || "BRIDGE_TARGET_UNAVAILABLE");
}

function detach(promise) {
  // Mirror writes are best-effort. A failed observer write must never
  // surface as a Bridge failure, and must never reject an unhandled promise.
  return promise.catch(() => null);
}

function timeout(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

export class TurnOrchestrator {
  constructor({
    api, cli, modelCache, versionOf = null, modelsOf = null,
    mirrorCoalesceMs = MIRROR_COALESCE_MS,
    beginTimeoutMs = BEGIN_TIMEOUT_MS,
    retryWaitMs = RETRY_WAIT_MS,
  }) {
    this.api = api;
    this.cli = cli;
    this.modelCache = modelCache;
    // Optional (target) => installed CLI version. Shown next to Apply in the
    // live view; absent means no version line is sent.
    this.versionOf = versionOf;
    // Optional (target) => models the CLI lists right now, for the dropdown.
    this.modelsOf = modelsOf;
    this.mirrorCoalesceMs = mirrorCoalesceMs;
    this.beginTimeoutMs = beginTimeoutMs;
    this.retryWaitMs = retryWaitMs;
  }

  /**
   * Reserves the Room first — so a live view, once the caller opens it, is
   * already showing before the CLI produces a single character — then
   * starts the CLI. A dead/slow server still can't block the question
   * itself forever: the Room wait is bounded, and the CLI starts regardless
   * of whether it succeeded. The returned `pending` handle is opaque; pass
   * it to finish() to get the actual answer.
   */
  async begin({ prompt, target, roomId = null, roomMode = null, resumeCliSessionId = null }) {
    // The server would happily tell us which model to use, but waiting for
    // that answer puts a cold start (seconds, not milliseconds) in front of
    // every question. Read the last known good model locally instead and let
    // the server's actual preference land on the next turn via reconcile().
    const model = await this.modelCache.get(target);

    // begin_bridge_turn_v9 has no `model` input at all — the server assigns
    // it from stored preferences and hands it back in the response, which
    // reconcile() below picks up for next time. What it does require is an
    // honest target_cli_status, checked locally rather than just asserted.
    let failure = null;
    const startTurn = () => checkTargetCliStatus(target).then((targetCliStatus) => this.api.beginTurn({
      prompt, target, roomId, roomMode, targetCliStatus,
    })).catch((error) => {
      // Kept only to tell the owner *why* there is no live view; the CLI
      // still starts regardless, exactly as before.
      failure = error;
      return null;
    });
    // Already catches, so a rejection is never briefly unhandled.
    let turn = startTurn();
    detach(turn.then((t) => t?.turnId && this.modelCache.reconcile(target, t)));

    // Bounded wait: a healthy server answers in ~0.4s, but a dead one must
    // not block the question forever — once this settles (with or without a
    // real Room), the CLI starts either way.
    let settled = false;
    turn.then(() => { settled = true; });
    let t = await Promise.race([turn, timeout(this.beginTimeoutMs)]);

    // One second chance before giving up on the live view. If the first call
    // is still in flight (slow cold start) keep waiting on that same call —
    // a second one would create a second Room. If it already failed, no Room
    // exists yet, so a fresh single attempt is safe.
    if (!t?.turnId && !t?.providerSetup) {
      if (settled) {
        failure = null;
        turn = startTurn();
        detach(turn.then((r) => r?.turnId && this.modelCache.reconcile(target, r)));
        t = await Promise.race([turn, timeout(this.beginTimeoutMs)]);
      } else {
        t = await Promise.race([turn, timeout(this.retryWaitMs)]);
      }
    }

    // Fail closed: an answer the owner cannot watch in the live view is not
    // what they asked for, and starting the CLI anyway would spend a real
    // model turn on something they cannot see or find again. Nothing has been
    // started yet, so stopping here costs nothing.
    if (!t?.turnId) throw liveViewUnavailableError(t, failure);

    // The Room page hides a turn entirely while it's still "queued" (a
    // deliberate choice on its side, so it never shows a question with no
    // visible activity yet). Left alone, that state only ever changes at
    // finish() — meaning the question and the complete answer would appear
    // in the same instant. Flip it to "running" now, right as the CLI is
    // about to start, so the question becomes visible exactly when Codex
    // actually starts working, not only once it's already done.
    if (t?.turnId) detach(this.api.recordTurn({ turnId: t.turnId, state: "running", answer: "" }));

    if (this.versionOf) {
      detach(Promise.all([turn, this.versionOf(target)]).then(([turnResult, version]) => (
        turnResult?.turnId && version
          ? this.api.appendActivity({ turnId: turnResult.turnId, text: `${CLI_VERSION_ACTIVITY_PREFIX}${version}` })
          : null
      )));
    }

    if (this.modelsOf) {
      detach(Promise.all([turn, this.modelsOf(target)]).then(async ([turnResult, models]) => {
        if (!turnResult?.turnId) return;
        for (const entry of models) {
          await detach(this.api.appendActivity({ turnId: turnResult.turnId, text: modelActivityLine(entry) }));
        }
      }));
    }

    const run = this.cli.start({ prompt, target, model, resumeCliSessionId });
    // The CLI can fail before finish() ever runs. Suppress the
    // unhandled-rejection window without swallowing it — finish()'s own
    // await still sees the real rejection when it runs.
    run.completed.catch(() => {});

    const mirror = this.#mirrorStream(turn, run);
    // Same best-effort, never-block-the-answer posture as the text mirror:
    // a slow/dead Bridge server can lag or lose activity lines, but it can
    // never delay the CLI or the returned answer.
    const activity = this.#activityQueue(turn);
    run.onActivity((text) => activity.push(text));

    return {
      pending: { run, turn, mirror },
      turnId: t?.turnId ?? null,
      roomId: t?.roomId ?? null,
      roomUrl: t?.roomUrl ?? null,
      localViewUrl: t?.localViewUrl ?? null,
      liveViewNote: t?.localViewUrl ? null : liveViewUnavailableReason(t, failure),
    };
  }

  /** Waits for the CLI to actually finish and returns its answer. */
  async finish(pending) {
    const { run, turn, mirror } = pending;
    let result;
    try {
      result = await run.completed;
    } catch (error) {
      mirror.stop();
      detach(turn.then((t) => t?.turnId && this.api.recordTurn({
        turnId: t.turnId,
        state: "failed",
        answer: failureText(error),
      })));
      throw error;
    }

    // Triggers any last piece of text still sitting on the coalesce timer —
    // a CLI that answers in one final chunk would otherwise leave the Room
    // having shown nothing the whole time. Synchronous: this only starts
    // the send, it never waits on the network itself.
    mirror.finalize();

    // The answer is already decided; recording "complete" only affects when
    // the Room stops showing "running" — it must never be why the owner
    // waits longer for the answer they already have. This was briefly
    // awaited (bounded) to close that gap, but that meant every answer sat
    // through a real network round trip it didn't need — measured close to
    // doubling total latency on some calls. Detached: the Room will lag the
    // chat by roughly one network round trip, which is the correct trade.
    // Chaining onto `settled` (updated by finalize() above) still keeps this
    // ordered after the last delta, without this call waiting on either.
    detach(mirror.settled.then(() => turn).then((t) => t?.turnId && this.api.recordTurn({
      turnId: t.turnId,
      state: "complete",
      answer: result.answer,
      cliSessionId: result.cliSessionId,
    })));

    return { answer: result.answer, cliSessionId: result.cliSessionId };
  }

  /** Convenience wrapper for callers that just want one call, start to finish. */
  async run(args) {
    const { pending, ...begun } = await this.begin(args);
    const finished = await this.finish(pending);
    return { ...begun, ...finished };
  }

  /**
   * A non-blocking look at how far the CLI has gotten, for narrating
   * progress between begin() and finish(). Never awaits anything — reads
   * state that's already been captured locally.
   */
  peek(pending) {
    return { snapshot: pending.mirror.latest, done: pending.run.done };
  }

  /**
   * Sends each activity line (e.g. "$ grep -rn ...", "exit 0") to the Room in
   * the order it was produced, at most one write in flight — unlike the text
   * mirror there is nothing to coalesce, each line is its own entry. Every
   * send is detached: a lost or reordered activity line is acceptable, a
   * delayed answer is not.
   */
  #activityQueue(turn) {
    const queue = [];
    let sending = false;
    const pump = () => {
      if (sending || queue.length === 0) return;
      const text = queue.shift();
      sending = true;
      detach(turn.then((t) => t?.turnId && this.api.appendActivity({ turnId: t.turnId, text })))
        .finally(() => {
          sending = false;
          pump();
        });
    };
    return {
      push(text) {
        queue.push(text);
        pump();
      },
    };
  }

  #mirrorStream(turn, run) {
    // drain()'s returned object literal isn't an arrow function, so it can't
    // see `this` — capture the configured bound here instead, where `this`
    // is still the TurnOrchestrator instance.
    let latest = "";
    let sent = "";
    let sequence = 0;
    let inFlight = false;
    let stopped = false;
    // Set by finalize(): once true, a send that was already in flight
    // retries immediately on completion instead of going back on the
    // coalesce timer — finalize() itself never waits on the network, so
    // this is what actually gets the last piece out promptly.
    let finishing = false;
    let settled = Promise.resolve();
    let timer = null;

    const flush = () => {
      timer = null;
      if (stopped || inFlight || latest === sent) return;
      // stream_bridge_turn_v2 wants only the newly appended text, not the
      // full snapshot, with a sequence that increases by exactly one.
      const delta = latest.slice(sent.length);
      if (!delta) return;
      sent = latest;
      sequence += 1;
      const thisSequence = sequence;
      inFlight = true;
      settled = detach(
        turn
          .then((t) => t?.turnId && this.api.streamTurn({ turnId: t.turnId, sequence: thisSequence, delta }))
          .finally(() => {
            inFlight = false;
            if (stopped) return;
            if (latest !== sent) { if (finishing) flush(); else schedule(); }
            else if (finishing) stopped = true;
          }),
      );
    };

    const schedule = () => {
      if (stopped || timer) return;
      timer = setTimeout(flush, this.mirrorCoalesceMs);
    };

    run.onText((text) => {
      latest = text;
      schedule();
    });

    return {
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
      // For a CLI that emits its whole answer as one final chunk (common for
      // Codex), the *only* delta ever produced can still be sitting on the
      // coalesce timer when the CLI exits. stop() alone would cancel that
      // timer and the Room would never see a single word.
      //
      // finalize() triggers that last send immediately instead — but never
      // awaits its network call. finish() must not wait on this: the answer
      // is already decided, and the delta reaching the Room is exactly as
      // uncertain as any other mirror write. Ordering is preserved by
      // chaining onto `settled` afterward, not by blocking here.
      finalize() {
        if (timer) { clearTimeout(timer); timer = null; }
        finishing = true;
        if (inFlight) return; // its own .finally() will flush again or close, per `finishing`
        if (latest !== sent) flush();
        else stopped = true;
      },
      get settled() {
        return settled;
      },
      get latest() {
        return latest;
      },
    };
  }
}
