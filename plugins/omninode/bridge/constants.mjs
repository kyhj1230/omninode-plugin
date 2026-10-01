// Deliberately distinct from the separate omninode-bridge plugin's port and
// Keychain item so both can be installed at once without clobbering each other.
export const LOGIN_CALLBACK_PORT = 47_640;
export const KEYCHAIN_SERVICE = "fyi.omninode.bridge.oauth.v2";

export const CLIENT_NAME = "Omninode Bridge (local)";
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// The access token lives 15 minutes; refresh before it lapses mid-turn.
export const REFRESH_MARGIN_MS = 60 * 1000;

export const BRIDGE_PROVIDERS = ["codex", "claude_code"];

// Matches the server's begin_bridge_turn_v9 prompt maxLength exactly
// (protocol.mjs) — checking locally against a different limit would either
// reject prompts the server would accept, or accept ones it would reject.
export const MAX_PROMPT_CHARS = 131_072;

export function isBridgeProvider(value) {
  return BRIDGE_PROVIDERS.includes(value);
}

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

export function oppositeProvider(provider) {
  if (provider === "codex") return "claude_code";
  if (provider === "claude_code") return "codex";
  throw new BridgeError("BRIDGE_CALLER_INVALID", "Bridge caller is invalid.");
}

export function bridgeProviderLabel(provider) {
  if (provider === "codex") return "Codex";
  if (provider === "claude_code") return "Claude Code";
  return "Bridge";
}

// The URL Bridge connector's own test deployment (see
// docs/feature-backup/bridge-mcp-before-local-plugin-port-20260909/README.md).
// Not a secret; overridable for local development against a different
// deployment without editing source.
export function bridgeBaseUrl(environment = process.env) {
  return (environment.OMNINODE_BRIDGE_URL?.trim()) || "https://omninode-bridge-test.vercel.app";
}
