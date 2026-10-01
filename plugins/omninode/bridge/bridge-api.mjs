// HTTP client for the same MCP endpoint the URL Bridge connector exposes
// (POST {baseUrl}/mcp, JSON-RPC 2.0, tools/call). Calling it directly from
// plugin code — instead of an AI reading protocol.mjs and driving each tool
// call itself — is the entire point of this port: same conditions (the
// bridge_v2_* functions this endpoint calls still enforce Room ownership,
// round limits, etc.), zero AI-inference round trips.
import { randomUUID } from "node:crypto";

import { BridgeError } from "./constants.mjs";

export class BridgeApi {
  constructor({ baseUrl, auth, caller, fetchImpl = fetch }) {
    if (!baseUrl) throw new BridgeError("BRIDGE_CONFIGURATION_MISSING", "A Bridge base URL is required.");
    this.mcpUrl = `${baseUrl.replace(/\/+$/u, "")}/mcp`;
    this.auth = auth;
    this.caller = caller;
    this.fetchImpl = fetchImpl;
    this.#nextId = 0;
  }

  #nextId;

  async beginTurn({ prompt, target, targetCliStatus, roomId = null, roomMode = null }) {
    const result = await this.#call("begin_bridge_turn_v9", {
      request_key: randomUUID(),
      caller: this.caller,
      target,
      target_cli_status: targetCliStatus,
      prompt,
      ...(roomId ? { room_id: roomId } : {}),
      ...(roomMode ? { room_mode: roomMode } : {}),
    });
    if (result?.status && result.status !== "available") {
      // installation_required / login_required: no Room was created, and
      // nothing here should retry or attempt setup on the owner's behalf.
      return { providerSetup: result.provider_setup ?? null, status: result.status };
    }
    return {
      turnId: result?.turn?.id,
      roomId: result?.room?.id,
      model: result?.turn?.model ?? null,
      effort: result?.turn?.reasoning_effort ?? null,
      roomUrl: result?.room_url ?? null,
      // The deployed Omninode Web viewer page, not localhost. Server-provided,
      // so the exact host/query stays in sync with wherever protocol.mjs's
      // roomView() actually points BRIDGE_VIEWER_ORIGIN.
      localViewUrl: result?.room_view?.hosted_url ?? null,
      roundTrips: result?.room?.round_trips ?? null,
    };
  }

  async streamTurn({ turnId, sequence, delta }) {
    return this.#call("stream_bridge_turn_v2", { turn_id: turnId, sequence, delta });
  }

  async appendActivity({ turnId, text }) {
    return this.#call("activity_bridge_turn_v1", { turn_id: turnId, text });
  }

  async recordTurn({ turnId, state, answer, cliSessionId = null }) {
    return this.#call("record_bridge_turn_v2", {
      turn_id: turnId,
      state,
      answer,
      ...(cliSessionId ? { cli_session_id: cliSessionId } : {}),
    });
  }

  async #call(name, args) {
    const token = await this.auth.accessToken();
    const id = `w${++this.#nextId}`;
    let response;
    try {
      response = await this.fetchImpl(this.mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
      });
    } catch {
      throw new BridgeError("BRIDGE_API_UNAVAILABLE", "Omninode Bridge could not be reached.");
    }
    let payload = {};
    try { payload = await response.json(); } catch { /* stable Bridge codes below */ }
    // A request-level failure (bad auth, malformed JSON-RPC) comes back as a
    // bare {error} with a non-200 status.
    if (!response.ok || payload?.error) {
      const message = typeof payload?.error === "string"
        ? payload.error
        : payload?.error?.message ?? "Omninode Bridge rejected the request.";
      throw new BridgeError("BRIDGE_API_ERROR", message);
    }
    // A tool-level failure is still HTTP 200 (this is a normal MCP tool
    // result, not a protocol error) — isError:true with only `content` text,
    // no structuredContent.
    if (payload?.result?.isError === true) {
      const message = payload.result.content?.[0]?.text || "Omninode Bridge rejected this request.";
      throw new BridgeError("BRIDGE_API_ERROR", message);
    }
    // Tool results carry their actual data as structuredContent — content[0].text
    // is the same data JSON-stringified for display, not a separate payload.
    if (payload?.result?.structuredContent !== undefined) return payload.result.structuredContent;
    const text = payload?.result?.content?.[0]?.text;
    if (typeof text === "string") {
      try { return JSON.parse(text); } catch { /* fall through */ }
    }
    throw new BridgeError("BRIDGE_API_ERROR", "Omninode Bridge returned an unexpected response shape.");
  }
}
