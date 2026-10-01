import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

import { BridgeError, KEYCHAIN_SERVICE } from "./constants.mjs";

const execFile = promisify(nodeExecFile);

const KEYCHAIN_ITEM_MISSING = 44;

function normalize(value) {
  if (!value || typeof value !== "object") return null;
  const { clientId, accessToken, refreshToken, expiresAt } = value;
  if (typeof clientId !== "string" || !clientId) return null;
  if (typeof refreshToken !== "string" || !refreshToken) return null;
  return {
    clientId,
    accessToken: typeof accessToken === "string" ? accessToken : "",
    refreshToken,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
  };
}

/**
 * Holds only this plugin's own Omninode OAuth grant. It never reads, derives,
 * or stores a provider CLI credential — those stay with the official CLIs.
 */
export class KeychainTokenStore {
  constructor({
    account = process.env.OMNINODE_BRIDGE_KEYCHAIN_ACCOUNT || process.env.USER || "omninode",
    service = KEYCHAIN_SERVICE,
    execFileImpl = execFile,
  } = {}) {
    this.account = account;
    this.service = service;
    this.execFileImpl = execFileImpl;
  }

  async read() {
    try {
      const { stdout } = await this.execFileImpl("/usr/bin/security", [
        "find-generic-password", "-a", this.account, "-s", this.service, "-w",
      ], { maxBuffer: 64 * 1024 });
      return normalize(JSON.parse(String(stdout)));
    } catch (error) {
      if (error?.code === KEYCHAIN_ITEM_MISSING) return null;
      throw new BridgeError("BRIDGE_KEYCHAIN_UNAVAILABLE", "The Omninode Bridge login could not be read from Keychain.");
    }
  }

  async write(value) {
    const normalized = normalize(value);
    if (!normalized) throw new BridgeError("BRIDGE_TOKEN_INVALID", "The Omninode Bridge login is invalid.");
    try {
      await this.execFileImpl("/usr/bin/security", [
        "add-generic-password", "-a", this.account, "-s", this.service, "-w", JSON.stringify(normalized), "-U",
      ], { maxBuffer: 64 * 1024 });
    } catch {
      throw new BridgeError("BRIDGE_KEYCHAIN_UNAVAILABLE", "The Omninode Bridge login could not be saved in Keychain.");
    }
  }

  async clear() {
    try {
      await this.execFileImpl("/usr/bin/security", [
        "delete-generic-password", "-a", this.account, "-s", this.service,
      ], { maxBuffer: 16 * 1024 });
    } catch {
      // Already absent is the desired end state.
    }
  }
}

export class MemoryTokenStore {
  constructor(value = null) {
    this.value = normalize(value);
  }

  async read() { return this.value; }
  async write(value) { this.value = normalize(value); }
  async clear() { this.value = null; }
}
