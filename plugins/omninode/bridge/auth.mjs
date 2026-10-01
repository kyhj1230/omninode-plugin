import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import {
  BridgeError,
  CLIENT_NAME,
  LOGIN_CALLBACK_PORT,
  LOGIN_TIMEOUT_MS,
  REFRESH_MARGIN_MS,
} from "./constants.mjs";
import { openInBrowser } from "./open-url.mjs";

const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://127.0.0.1:${LOGIN_CALLBACK_PORT}${CALLBACK_PATH}`;

const base64url = (buffer) => buffer.toString("base64url");

function page(title, detail) {
  return `<!doctype html><html lang="en"><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
    + `<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#111;color:#f5f5f5;margin:0;padding:48px">`
    + `<main style="max-width:560px;margin:auto"><h1>${title}</h1><p>${detail}</p></main></body></html>`;
}

export class BridgeAuth {
  #refreshing = null;

  constructor({
    baseUrl,
    store,
    resource = null,
    fetchImpl = fetch,
    openBrowserImpl = openInBrowser,
    now = () => Date.now(),
  }) {
    if (!baseUrl) throw new BridgeError("BRIDGE_CONFIGURATION_MISSING", "A Bridge base URL is required.");
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    this.store = store;
    this.resource = resource || `${this.baseUrl}/mcp`;
    this.fetchImpl = fetchImpl;
    this.openBrowserImpl = openBrowserImpl;
    this.now = now;
    this.metadata = null;
  }

  /** A valid access token, refreshing or prompting for login as needed. */
  async accessToken({ interactive = true } = {}) {
    const stored = await this.store.read();
    if (!stored) {
      if (!interactive) throw new BridgeError("BRIDGE_LOGIN_REQUIRED", "Connect Omninode Bridge on this Mac first.");
      return (await this.login()).accessToken;
    }
    if (stored.accessToken && stored.expiresAt - REFRESH_MARGIN_MS > this.now()) return stored.accessToken;
    return (await this.#refresh(stored)).accessToken;
  }

  async login() {
    const metadata = await this.#discover();
    const stored = await this.store.read();
    const clientId = stored?.clientId || await this.#register(metadata);

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(24));

    const waiting = this.#awaitCallback(state);
    try {
      const authorize = new URL(metadata.authorization_endpoint);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("client_id", clientId);
      authorize.searchParams.set("redirect_uri", REDIRECT_URI);
      authorize.searchParams.set("code_challenge", challenge);
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("resource", this.resource);
      authorize.searchParams.set("state", state);
      // The server rejects any authorize request that omits bridge:read —
      // begin/stream/record also need bridge:write, so request both up front
      // rather than forcing a second consent later.
      authorize.searchParams.set("scope", "bridge:read bridge:write");

      await this.openBrowserImpl(authorize.toString());
      const code = await waiting.code;

      const token = await this.#post(metadata.token_endpoint, {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
        resource: this.resource,
      });
      return await this.#persist(clientId, token);
    } finally {
      waiting.close();
    }
  }

  async logout() {
    await this.store.clear();
  }

  async #refresh(stored) {
    // Serialized on purpose: this server rotates refresh tokens and treats a
    // reused one as theft, revoking the whole grant. Two concurrent refreshes
    // would do exactly that to ourselves.
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = (async () => {
      const metadata = await this.#discover();
      let token;
      try {
        token = await this.#post(metadata.token_endpoint, {
          grant_type: "refresh_token",
          refresh_token: stored.refreshToken,
          client_id: stored.clientId,
          resource: this.resource,
        });
      } catch (error) {
        // The request may have been consumed before it failed. Retrying the
        // same token is what triggers grant revocation, so drop the grant and
        // make the owner log in again instead of guessing.
        await this.store.clear();
        throw error instanceof BridgeError
          ? error
          : new BridgeError("BRIDGE_LOGIN_REQUIRED", "The Omninode Bridge login expired. Connect it again.");
      }
      return this.#persist(stored.clientId, token);
    })().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #persist(clientId, token) {
    const accessToken = token?.access_token;
    const refreshToken = token?.refresh_token;
    if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
      throw new BridgeError("BRIDGE_TOKEN_INVALID", "Omninode returned an incomplete login response.");
    }
    const lifetime = Number.isFinite(token.expires_in) ? token.expires_in * 1000 : 15 * 60 * 1000;
    const value = { clientId, accessToken, refreshToken, expiresAt: this.now() + lifetime };
    await this.store.write(value);
    return value;
  }

  async #discover() {
    if (this.metadata) return this.metadata;
    const url = `${this.baseUrl}/.well-known/oauth-authorization-server`;
    let response;
    try {
      response = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    } catch {
      throw new BridgeError("BRIDGE_API_UNAVAILABLE", "Omninode Bridge could not be reached.");
    }
    if (!response.ok) throw new BridgeError("BRIDGE_API_UNAVAILABLE", "Omninode Bridge did not publish its login endpoints.");
    const metadata = await response.json();
    if (typeof metadata?.authorization_endpoint !== "string" || typeof metadata?.token_endpoint !== "string") {
      throw new BridgeError("BRIDGE_API_UNAVAILABLE", "Omninode Bridge published incomplete login endpoints.");
    }
    this.metadata = metadata;
    return metadata;
  }

  async #register(metadata) {
    const endpoint = metadata.registration_endpoint || `${this.baseUrl}/oauth/register`;
    const client = await this.#post(endpoint, {
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    const clientId = client?.client_id;
    if (typeof clientId !== "string" || !clientId) {
      throw new BridgeError("BRIDGE_REGISTRATION_FAILED", "Omninode Bridge could not register this Mac.");
    }
    return clientId;
  }

  async #post(url, body) {
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new BridgeError("BRIDGE_API_UNAVAILABLE", "Omninode Bridge could not be reached.");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.error) {
      throw new BridgeError("BRIDGE_LOGIN_FAILED", "Omninode Bridge could not complete the login.");
    }
    return payload;
  }

  /**
   * Runs a single-use loopback listener for the redirect. Bound to 127.0.0.1
   * so nothing off this machine can reach it, and closed the moment the code
   * arrives or the window lapses.
   */
  #awaitCallback(expectedState) {
    let settle;
    let timer;
    const server = createServer((request, response) => {
      const url = new URL(request.url, REDIRECT_URI);
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const ok = !error && code && state === expectedState;
      response.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(ok
        ? page("Connected", "You can return to your terminal now.")
        : page("Connection failed", "Nothing was saved. Start the connection again from your terminal."));
      settle?.(ok
        ? { code }
        : { error: new BridgeError("BRIDGE_LOGIN_FAILED", "The Omninode Bridge login was denied or did not match.") });
    });

    const code = new Promise((resolve, reject) => {
      settle = (result) => (result.error ? reject(result.error) : resolve(result.code));
      server.on("error", () => reject(new BridgeError(
        "BRIDGE_LOGIN_PORT_BUSY",
        `Port ${LOGIN_CALLBACK_PORT} is in use, so the Omninode Bridge login page could not start.`,
      )));
      server.listen(LOGIN_CALLBACK_PORT, "127.0.0.1");
      timer = setTimeout(
        () => reject(new BridgeError("BRIDGE_LOGIN_TIMEOUT", "The Omninode Bridge login was not completed in time.")),
        LOGIN_TIMEOUT_MS,
      );
    });

    // The redirect can land before `login` reaches its `await`, so keep a
    // handler attached from the start; without it that window surfaces as an
    // unhandled rejection instead of a login error.
    code.catch(() => {});

    return {
      code,
      close() {
        clearTimeout(timer);
        // close() alone leaves keep-alive sockets holding the fixed port, which
        // would make the next login report the port as busy.
        server.closeAllConnections?.();
        server.close();
      },
    };
  }
}
