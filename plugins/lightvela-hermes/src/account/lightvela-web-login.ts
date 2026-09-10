export const WEB_LOGIN_CLIENT_ID = "opencraft-web-v1";
export const WEB_LOGIN_CALLBACK_PATH = "/auth/lightvela/callback";
export const WEB_LOGIN_PENDING_KEY = "vela.lightvela.web-login.v1";

const LOGIN_TTL_MS = 10 * 60_000;
const valuePattern = /^[A-Za-z0-9_-]{43}$/;

interface PendingWebLogin {
  readonly state: string;
  readonly verifier: string;
  readonly createdAt: number;
  readonly returnPath: string;
  readonly region: "cn" | "intl";
}

export interface WebLoginLocation {
  readonly origin: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  assign(url: string): void;
}

interface WebLoginPorts {
  readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly location: WebLoginLocation;
  readonly history: Pick<History, "state" | "replaceState">;
  readonly fetchImpl: typeof fetch;
  readonly now?: () => number;
  readonly cryptoImpl?: Pick<Crypto, "getRandomValues" | "subtle">;
}

interface StartWebLoginOptions {
  readonly apiBase: string;
  readonly region: "cn" | "intl";
  readonly storage: Pick<Storage, "setItem">;
  readonly location: WebLoginLocation;
  readonly now?: () => number;
  readonly cryptoImpl?: Pick<Crypto, "getRandomValues" | "subtle">;
}

interface ConsumeWebLoginOptions extends WebLoginPorts {
  readonly apiBases: Readonly<Record<"cn" | "intl", string>>;
}

function base64URL(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function randomValue(cryptoImpl: Pick<Crypto, "getRandomValues">): string {
  return base64URL(cryptoImpl.getRandomValues(new Uint8Array(32)));
}

async function challenge(verifier: string, cryptoImpl: Pick<Crypto, "subtle">): Promise<string> {
  const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64URL(new Uint8Array(digest));
}

function parsePending(raw: string | null, now: number): PendingWebLogin | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingWebLogin>;
    if (
      !valuePattern.test(value.state ?? "")
      || !valuePattern.test(value.verifier ?? "")
      || !Number.isFinite(value.createdAt)
      || now < (value.createdAt ?? 0)
      || now - (value.createdAt ?? 0) >= LOGIN_TTL_MS
      || (value.region !== "cn" && value.region !== "intl")
      || typeof value.returnPath !== "string"
      || !value.returnPath.startsWith("/")
      || value.returnPath.startsWith("//")
    ) return null;
    return value as PendingWebLogin;
  } catch {
    return null;
  }
}

/** Creates one browser-owned PKCE transaction and delegates authentication to UserAuth. */
export async function startLightVelaWebLogin(options: StartWebLoginOptions): Promise<void> {
  const cryptoImpl = options.cryptoImpl ?? globalThis.crypto;
  const state = randomValue(cryptoImpl);
  const verifier = randomValue(cryptoImpl);
  const nonce = randomValue(cryptoImpl);
  const redirectURI = `${options.location.origin}${WEB_LOGIN_CALLBACK_PATH}`;
  const returnPath = `${options.location.pathname}${options.location.search}${options.location.hash}`;
  const pending: PendingWebLogin = {
    state,
    verifier,
    createdAt: (options.now ?? Date.now)(),
    returnPath,
    region: options.region,
  };
  const authorize = new URL("/oauth2/authorize", options.apiBase);
  authorize.search = new URLSearchParams({
    client_id: WEB_LOGIN_CLIENT_ID,
    response_type: "code",
    scope: "openid profile",
    nonce,
    redirect_uri: redirectURI,
    state,
    code_challenge: await challenge(verifier, cryptoImpl),
    code_challenge_method: "S256",
  }).toString();
  // Publish the transaction only when every derived field is ready. From this
  // point the stored state and the navigation target are one atomic handoff.
  options.storage.setItem(WEB_LOGIN_PENDING_KEY, JSON.stringify(pending));
  options.location.assign(authorize.toString());
}

/** Consumes only an exact callback correlated with the browser-owned transaction. */
export async function consumeLightVelaWebLoginCallback(options: ConsumeWebLoginOptions): Promise<{ token: string; region: "cn" | "intl" } | null> {
  if (options.location.pathname !== WEB_LOGIN_CALLBACK_PATH || options.location.hash) return null;
  const raw = options.storage.getItem(WEB_LOGIN_PENDING_KEY);
  const pending = parsePending(raw, (options.now ?? Date.now)());
  if (!pending) {
    if (raw !== null) options.storage.removeItem(WEB_LOGIN_PENDING_KEY);
    throw new Error("Login expired. Please sign in again.");
  }
  const query = new URLSearchParams(options.location.search);
  const keys = [...query.keys()];
  if (
    query.getAll("state").length !== 1
    || query.get("state") !== pending.state
    || keys.some(key => !["state", "code", "error"].includes(key))
    || new Set(keys).size !== keys.length
  ) throw new Error("Login callback does not match this sign-in request");
  try {
    if (query.has("error")) throw new Error("LightVela could not complete login. Please try again.");
    const code = query.get("code") ?? "";
    if (!valuePattern.test(code)) throw new Error("Login returned without a valid authorization code");
    const response = await options.fetchImpl(`${options.apiBases[pending.region]}/auth/session/exchange`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: WEB_LOGIN_CLIENT_ID,
        code,
        code_verifier: pending.verifier,
        redirect_uri: `${options.location.origin}${WEB_LOGIN_CALLBACK_PATH}`,
      }),
    });
    if (!response.ok) throw new Error("Login exchange failed. Please sign in again.");
    const body = await response.json() as { readonly session_token?: unknown };
    if (typeof body.session_token !== "string" || !body.session_token.trim()) {
      throw new Error("Login exchange returned no session");
    }
    return { token: body.session_token, region: pending.region };
  } finally {
    options.storage.removeItem(WEB_LOGIN_PENDING_KEY);
    options.history.replaceState(options.history.state, "", pending.returnPath);
  }
}
