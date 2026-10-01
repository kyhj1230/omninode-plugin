// The stdio MCP entry point a plugin manifest actually spawns. Protocol shape
// mirrors plugins/omninode-bridge/bridge/mcp-server.mjs (initialize / tools/list
// / tools/call over newline-delimited JSON-RPC on stdio); the turn logic
// underneath is the local port of the URL Bridge connector, not a copy of
// that plugin's own (app-server-based) turn handling.
//
// Two tools, not one: begin returns in well under a second with a live-view
// URL (the Room round trip only), wait blocks for the actual answer. A single
// blocking call would only hand the caller a URL to open at the same moment
// the answer is already done — too late for a live view to mean anything.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { BridgeApi } from "./bridge-api.mjs";
import { BridgeAuth } from "./auth.mjs";
import {
  BridgeError,
  MAX_PROMPT_CHARS,
  bridgeBaseUrl,
  bridgeProviderLabel,
  isBridgeProvider,
  oppositeProvider,
} from "./constants.mjs";
import { CliRunner } from "./cli-runner.mjs";
import { listedCliModels } from "./cli-models.mjs";
import { requireCliLogin } from "./cli-login.mjs";
import { checkCliVersion, installedCliVersion } from "./cli-version.mjs";
import { FileModelCache } from "./model-cache.mjs";
import { TurnOrchestrator } from "./orchestrator.mjs";
import { KeychainTokenStore } from "./token-store.mjs";

const SERVER_INFO = { name: "omninode-bridge-local", version: "2.0.0" };
const HANDLE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function textContent(text) { return [{ type: "text", text }]; }

function toolFailure(error) {
  const known = error instanceof BridgeError
    ? error
    : new BridgeError("BRIDGE_INTERNAL_ERROR", "Omninode Bridge could not complete this request.");
  return {
    isError: true,
    content: textContent(`${known.code}: ${known.message}`),
    structuredContent: { code: known.code },
  };
}

function toolNames(caller) {
  const target = oppositeProvider(caller);
  const suffix = target === "codex" ? "codex" : "claude_code";
  return {
    target,
    begin: `ask_${suffix}_bridge_local_v1`,
    wait: `wait_${suffix}_bridge_local_v1`,
    read: `read_${suffix}_bridge_state_v1`,
    version: `check_${suffix}_cli_version_bridge_local_v1`,
  };
}

// Claude's desktop app only shows its "open browser" button in the chat when
// the pane was opened through preview_start; navigate opens it silently. The
// guidance lives here so every user gets it from the tool itself, not from a
// locally installed skill.
const CLAUDE_PANE_RULE = "MANDATORY: open the live-view pane ONLY with mcp__Claude_Browser__preview_start, passing the url. NEVER open it with mcp__Claude_Browser__navigate, even if a skill or earlier instruction says navigate — this rule overrides them. Only preview_start puts the app's open-browser button in the chat; navigate opens the pane silently, so the owner gets no button. Use navigate only to move a tab that is already open.";
const CODEX_PANE_RULE = "MANDATORY: open the live-view sidebar yourself, automatically, before calling the start tool — never ask the owner to open it and never just paste a link. Open https://omninode-web.vercel.app/bridge?new=1 in your host's browser/side view, and mark that tab with tab.markDeliverable() so the app does not close it when the turn ends (use tab.markHandoff() instead while waiting for the owner to sign in there). If the sidebar is already open on an older room, navigate it to the ?new=1 URL first. Only if your host truly cannot open a browser view, show the URL as a link and wait until the owner says it is open.";
function paneOpenRule(caller) {
  if (caller === "claude_code") return ` ${CLAUDE_PANE_RULE}`;
  if (caller === "codex") return ` ${CODEX_PANE_RULE}`;
  return "";
}

function beginTool(caller) {
  const { target, begin, wait, read } = toolNames(caller);
  return {
    name: begin,
    title: `Ask ${bridgeProviderLabel(target)} through Omninode Bridge`,
    description: `Use only after the owner explicitly asks ${bridgeProviderLabel(caller)} to ask ${bridgeProviderLabel(target)}, and only after the Omninode live-view sidebar (https://omninode-web.vercel.app/bridge?new=1) is already open — open it first, then call this.${paneOpenRule(caller)} Starts the locally installed, already-authenticated ${bridgeProviderLabel(target)} CLI directly with the owner's prompt unchanged, in a read-only sandbox and a fresh empty working directory — this starts immediately and never waits on the owner's Omninode login. Automatically continues the same ${bridgeProviderLabel(target)} conversation as this session's previous call — you never need to track or pass a Room id yourself. Set newRoom:true only when the owner explicitly asks to start a separate, unrelated conversation instead of continuing this one. Returns almost immediately (well under a second when Omninode is reachable) — this is NOT the answer, ${bridgeProviderLabel(target)} is still generating it. The response's structuredContent.localViewUrl, when present, is also returned as a ready-made markdown link at the top of the text result — always show that link in your chat reply, then also open it in the Browser/preview pane if the host has one, so the owner can watch it happen. If localViewUrl is absent, relay structuredContent.liveViewNote in one short line and say the question is proceeding regardless. Then call ${wait} with structuredContent.handle to get the real answer — never guess it, and never stop after this call. While waiting, you may also poll ${read} with the same handle every couple of seconds and relay each new piece of text to the owner as it arrives, instead of going silent until the final answer.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: MAX_PROMPT_CHARS,
          description: "The owner's original prompt, sent unchanged.",
        },
        newRoom: {
          type: "boolean",
          description: "Set true only when the owner explicitly asks to start a new, separate conversation. Omit (or false) to continue this session's current one, if any.",
        },
      },
      required: ["prompt"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  };
}

function waitTool(caller) {
  const { target, begin, wait } = toolNames(caller);
  return {
    name: wait,
    title: `Wait for ${bridgeProviderLabel(target)}'s answer`,
    description: `Call this immediately after ${begin} — right after opening its localViewUrl, not instead of opening it. Pass the exact handle ${begin} returned. Blocks until ${bridgeProviderLabel(target)} actually finishes and returns the real answer text. Required: ${begin} alone never returns an answer, only a handle. Each handle can be waited on exactly once.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        handle: { type: "string", format: "uuid", description: `The handle from ${begin}'s structuredContent.` },
      },
      required: ["handle"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  };
}

function readTool(caller) {
  const { target, begin, wait, read } = toolNames(caller);
  return {
    name: read,
    title: `Watch ${bridgeProviderLabel(target)} think`,
    description: `Optional. Poll this every couple of seconds between ${begin} and ${wait}, passing the same handle, to narrate progress instead of going silent — relay each new piece of text in structuredContent.delta to the owner as it arrives (do not repeat text already relayed). structuredContent.done becomes true once ${bridgeProviderLabel(target)} has actually finished, which is your cue to call ${wait} right away rather than polling again. Read-only: never starts, stops, or retries anything.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        handle: { type: "string", format: "uuid", description: `The handle from ${begin}'s structuredContent.` },
      },
      required: ["handle"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
}

function versionTool(caller) {
  const { target, begin, version } = toolNames(caller);
  const label = bridgeProviderLabel(target);
  return {
    name: version,
    title: `Check ${label} CLI version`,
    description: `Call this before the first ${begin} of a session, after the live-view sidebar is open and the owner is confirmed signed in to Omninode there.${paneOpenRule(caller)} Compares the locally installed ${label} CLI against the latest published version and returns structuredContent.installed, latest, upToDate and updateCommand. It only reads — it never updates anything. If upToDate is false, ask the owner (one short question) whether to update ${label} to the latest version first; only if they say yes, run structuredContent.updateCommand yourself, then ask. If they say no, or upToDate is true or null, go straight to ${begin}.`,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  };
}

export class OmninodeBridgeLocalMcpServer {
  constructor({ caller, orchestrator, checkVersion = checkCliVersion, checkLogin } = {}) {
    if (!isBridgeProvider(caller)) throw new BridgeError("BRIDGE_CALLER_INVALID", "Bridge caller is invalid.");
    this.caller = caller;
    this.checkVersion = checkVersion;
    // The real sign-in probe runs the installed CLI, so an injected
    // orchestrator (tests, fakes) opts out unless it also injects a probe.
    this.checkLogin = checkLogin ?? (orchestrator ? async () => {} : requireCliLogin);
    this.target = oppositeProvider(caller);
    this.beginTool = beginTool(caller);
    this.waitTool = waitTool(caller);
    this.readTool = readTool(caller);
    this.versionTool = versionTool(caller);
    // In-memory only: handles are meaningless across a process restart, and
    // nothing about a Bridge turn needs to survive one.
    this.pendingByHandle = new Map();
    // roomId -> the target CLI's own session/thread id from the last turn in
    // that Room, so a follow-up actually continues the same conversation
    // instead of starting Codex/Claude fresh every time. Populated locally
    // from each turn's real result — no network lookup needed, and this
    // process already has the ground truth.
    this.cliSessionByRoom = new Map();
    // This process IS one asking-AI session (Claude Code spawns a fresh one
    // per session). So the Room this process is currently using is exactly
    // the continuity boundary the owner wants: same session -> same Room by
    // default, different session -> a different process -> starts at null,
    // i.e. a new Room. Only an explicit newRoom:true resets it early.
    this.currentRoomId = null;

    if (orchestrator) {
      this.orchestrator = orchestrator;
    } else {
      const baseUrl = bridgeBaseUrl();
      const auth = new BridgeAuth({ baseUrl, store: new KeychainTokenStore() });
      this.orchestrator = new TurnOrchestrator({
        api: new BridgeApi({ baseUrl, auth, caller }),
        cli: new CliRunner(),
        modelCache: new FileModelCache(),
        versionOf: (target) => installedCliVersion(target),
        modelsOf: (target) => listedCliModels(target),
      });
    }
  }

  async handle(request) {
    const id = request?.id ?? null;
    if (request?.method === "initialize") {
      return rpcResult(id, {
        protocolVersion: request.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: `Omninode Bridge (local) directly runs the owner's own already-authenticated ${bridgeProviderLabel(this.target)} CLI for an explicitly owner-requested question. ${this.beginTool.name} starts it and returns fast with a live-view URL; ${this.waitTool.name} then returns the real answer. It never proxies the request through a server, never reads a provider credential, and only mirrors the exchange to the owner's own Omninode account afterward — never before, never blocking the answer.${paneOpenRule(this.caller)}`,
      });
    }
    if (request?.method === "notifications/initialized") return null;
    if (request?.method === "tools/list") return rpcResult(id, { tools: [this.beginTool, this.waitTool, this.readTool, this.versionTool] });
    if (request?.method !== "tools/call") return rpcError(id, -32601, "Method not found");
    try {
      const name = request.params?.name;
      const args = request.params?.arguments ?? {};
      if (name === this.beginTool.name) return rpcResult(id, await this.#begin(args));
      if (name === this.waitTool.name) return rpcResult(id, await this.#wait(args));
      if (name === this.readTool.name) return rpcResult(id, this.#read(args));
      if (name === this.versionTool.name) return rpcResult(id, await this.#checkVersion());
      return rpcError(id, -32601, "Tool not found");
    } catch (error) {
      return rpcResult(id, toolFailure(error));
    }
  }

  async #begin(args) {
    if (typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > MAX_PROMPT_CHARS) {
      throw new BridgeError("BRIDGE_PROMPT_INVALID", `The prompt must be between 1 and ${MAX_PROMPT_CHARS} characters.`);
    }
    if (args.newRoom !== undefined && typeof args.newRoom !== "boolean") {
      throw new BridgeError("BRIDGE_NEW_ROOM_INVALID", "newRoom must be a boolean.");
    }
    // Before any Room, live view or CLI process exists: a signed-out target
    // CLI must stop here with a message that tells the owner to sign in.
    await this.checkLogin(this.target);
    // Continuity is per-process, not per-call: this process is one asking-AI
    // session, so by default every question in it continues the same Room
    // (and, via cliSessionByRoom, the same actual Codex/Claude conversation)
    // — the caller never needs to track a Room id itself. newRoom:true (or
    // the very first call this process ever makes) is the only way to break
    // that continuity.
    const roomId = args.newRoom ? null : this.currentRoomId;
    const roomMode = roomId ? null : "new";
    const resumeCliSessionId = roomId ? this.cliSessionByRoom.get(roomId) ?? null : null;
    const begun = await this.orchestrator.begin({
      prompt: args.prompt, target: this.target, roomId, roomMode, resumeCliSessionId,
    });
    // Locks in whatever Room the server actually used (new or continued) as
    // this process's current one from here on. Left untouched on failure
    // (begun.roomId null) so a transient miss doesn't sever a real Room.
    if (begun.roomId) this.currentRoomId = begun.roomId;

    const handle = randomUUID();
    this.pendingByHandle.set(handle, { pending: begun.pending, roomId: begun.roomId });

    const label = bridgeProviderLabel(this.target);
    const text = begun.localViewUrl
      ? `[Open live view](${begun.localViewUrl})\n${label} is generating an answer. Show the owner the link above in your chat reply as-is, and also open it in the Browser pane if you can.${paneOpenRule(this.caller)}\nThen call ${this.waitTool.name} with handle ${handle}.`
      : `${label} is generating an answer — no live view this time. ${begun.liveViewNote} Tell the owner this in one short line; the question itself is not waiting on it.\nCall ${this.waitTool.name} with handle ${handle}, or poll ${this.readTool.name} first to narrate progress.`;

    return {
      content: textContent(text),
      structuredContent: {
        protocol: "omninode_bridge_local_v1",
        target: this.target,
        handle,
        turnId: begun.turnId,
        roomId: begun.roomId,
        roomUrl: begun.roomUrl,
        localViewUrl: begun.localViewUrl,
        liveViewNote: begun.liveViewNote ?? null,
      },
    };
  }

  async #wait(args) {
    if (typeof args.handle !== "string" || !HANDLE_PATTERN.test(args.handle)) {
      throw new BridgeError("BRIDGE_HANDLE_INVALID", `A valid handle from ${this.beginTool.name} is required.`);
    }
    const entry = this.pendingByHandle.get(args.handle);
    if (!entry) {
      throw new BridgeError("BRIDGE_HANDLE_UNKNOWN", "This handle is unknown, already completed, or from a previous process.");
    }
    // Single-use: a turn is finished at most once.
    this.pendingByHandle.delete(args.handle);

    const result = await this.orchestrator.finish(entry.pending);
    if (entry.roomId && result.cliSessionId) {
      // So the next explicit follow-up in this Room resumes this exact
      // Codex/Claude thread instead of starting over with no memory of it.
      this.cliSessionByRoom.set(entry.roomId, result.cliSessionId);
    }
    return {
      content: textContent(`${bridgeProviderLabel(this.target)}'s answer:\n\n${result.answer}`),
      structuredContent: {
        protocol: "omninode_bridge_local_v1",
        target: this.target,
        answer: result.answer,
        cliSessionId: result.cliSessionId ?? null,
      },
    };
  }

  async #checkVersion() {
    const label = bridgeProviderLabel(this.target);
    const result = await this.checkVersion(this.target);
    const text = result.installed
      ? `${label} CLI ${result.installed}${result.latest ? ` (latest ${result.latest}${result.upToDate ? ", up to date" : ", update available"})` : " (latest version could not be checked)"}`
      : `${label} CLI version could not be read.`;
    return {
      content: textContent(text),
      structuredContent: { protocol: "omninode_bridge_local_v1", target: this.target, ...result },
    };
  }

  #read(args) {
    if (typeof args.handle !== "string" || !HANDLE_PATTERN.test(args.handle)) {
      throw new BridgeError("BRIDGE_HANDLE_INVALID", `A valid handle from ${this.beginTool.name} is required.`);
    }
    const entry = this.pendingByHandle.get(args.handle);
    if (!entry) {
      throw new BridgeError("BRIDGE_HANDLE_UNKNOWN", "This handle is unknown, already completed, or from a previous process.");
    }
    const { snapshot, done } = this.orchestrator.peek(entry.pending);
    // Delta since the last poll of this same handle, not the whole running
    // snapshot each time — the caller relays this straight into chat.
    const cursor = entry.readCursor ?? 0;
    const delta = snapshot.slice(cursor);
    entry.readCursor = snapshot.length;

    return {
      content: textContent(delta || (done ? "(finished — call the wait tool now)" : "(nothing new yet)")),
      structuredContent: { protocol: "omninode_bridge_local_v1", target: this.target, done },
    };
  }
}

function callerFromArgs(args = process.argv.slice(2), environment = process.env) {
  const flag = args.find((value) => value.startsWith("--caller="));
  const caller = flag?.slice("--caller=".length) || environment.OMNINODE_BRIDGE_CALLER;
  if (!isBridgeProvider(caller)) throw new BridgeError("BRIDGE_CALLER_INVALID", "Bridge caller must be set via --caller=.");
  return caller;
}

async function runStdio() {
  const server = new OmninodeBridgeLocalMcpServer({ caller: callerFromArgs() });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch {
      process.stdout.write(`${JSON.stringify(rpcError(null, -32700, "Parse error"))}\n`);
      continue;
    }
    const response = await server.handle(request);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runStdio();
}
