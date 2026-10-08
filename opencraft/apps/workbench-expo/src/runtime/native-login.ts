export const NATIVE_LOGIN_REDIRECT = "opencraft://auth/lightvela";
export const NATIVE_LOGIN_INTL_REDIRECT = "opencraft-intl://auth/lightvela";
export const NATIVE_LOGIN_PENDING_KEY = "vela.lightvela.native-login.v1";
const LOGIN_TTL_MS = 10 * 60_000;

interface PendingLogin { state: string; verifier: string; createdAt: number }
export interface NativeLoginPorts {
  random(): string;
  challenge(verifier: string): Promise<string>;
  now(): number;
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(expected: string): Promise<void>;
  open(url: string, redirect: string): Promise<{ type: string; url?: string }>;
  exchange(input: { code: string; code_verifier: string; redirect_uri: string }, signal: AbortSignal): Promise<string>;
}

const statePattern = /^[A-Za-z0-9_-]{43,128}$/;

export function isNativeLoginCallback(raw: string, redirect = NATIVE_LOGIN_REDIRECT): boolean {
  if (raw !== redirect && !raw.startsWith(`${redirect}?`)) return false;
  try {
    const url = new URL(raw);
    const expected = new URL(redirect);
    return (redirect === NATIVE_LOGIN_REDIRECT || redirect === NATIVE_LOGIN_INTL_REDIRECT)
      && url.protocol === expected.protocol && url.host === expected.host && url.pathname === expected.pathname
      && !url.username && !url.password;
  } catch { return false; }
}

/** Owns one login transaction; only an exact, correlated callback may exchange it. */
export function createNativeLogin(ports: NativeLoginPorts, apiBase: string | (() => string), redirect = NATIVE_LOGIN_REDIRECT) {
  if (redirect !== NATIVE_LOGIN_REDIRECT && redirect !== NATIVE_LOGIN_INTL_REDIRECT) throw new Error("Invalid native login redirect");
  let disposed = false;
  let flight: Promise<string | null> | null = null;
  let flightURL: string | null = null;
  let exchangeAbort: AbortController | null = null;
  let signInGeneration = 0;
  let signInMaterial: string | null = null;
  const ensureAlive = () => { if (disposed) throw new Error("Login was cancelled"); };
  const load = async (): Promise<(PendingLogin & { stored: string }) | null> => {
    const raw = await ports.read();
    ensureAlive();
    if (raw === null) return null;
    let value: PendingLogin;
    try { value = JSON.parse(raw); } catch { await ports.remove(raw); return null; }
    if (!value || !statePattern.test(value.state) || !statePattern.test(value.verifier)
      || !Number.isFinite(value.createdAt) || ports.now() < value.createdAt || ports.now() - value.createdAt >= LOGIN_TTL_MS) {
      await ports.remove(raw); return null;
    }
    return { ...value, stored: raw };
  };
  const consume = (raw: string): Promise<string | null> => {
    if (flight) return raw === flightURL ? flight : Promise.reject(new Error("Another login callback is being processed"));
    flightURL = raw;
    const current = (async () => {
      ensureAlive();
      if (!isNativeLoginCallback(raw, redirect)) throw new Error("Invalid login callback address");
      const url = new URL(raw);
      const pending = await load();
      if (!pending) throw new Error("Login expired. Please sign in again.");
      if (url.hash || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== pending.state) {
        throw new Error("Login callback does not match this sign-in request");
      }
      const keys = [...url.searchParams.keys()];
      if (keys.some(key => !["state", "code", "error"].includes(key)) || new Set(keys).size !== keys.length) {
        throw new Error("Invalid login callback parameters");
      }
      try {
        if (url.searchParams.has("error")) throw new Error("LightVela could not complete login. Please try again.");
        const code = url.searchParams.get("code");
        if (!code || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error("Login returned without a valid authorization code");
        const controller = new AbortController();
        exchangeAbort = controller;
        const token = await ports.exchange({ code, code_verifier: pending.verifier, redirect_uri: redirect }, controller.signal);
        ensureAlive();
        if (!token.trim()) throw new Error("Login exchange returned no session");
        return token;
      } finally {
        exchangeAbort = null;
        await ports.remove(pending.stored);
      }
    })().finally(() => { if (flight === current) { flight = null; flightURL = null; } });
    flight = current;
    return current;
  };
  return {
    consume,
    async signIn(): Promise<string | null> {
      ensureAlive();
      const generation = ++signInGeneration;
      const pending = { state: ports.random(), verifier: ports.random(), createdAt: ports.now() };
      const challenge = await ports.challenge(pending.verifier);
      ensureAlive();
      if (generation !== signInGeneration) return null;
      const stored = JSON.stringify(pending);
      await ports.write(stored);
      signInMaterial = stored;
      ensureAlive();
      if (generation !== signInGeneration) { await ports.remove(stored); return null; }
      const start = new URL("/oauth2/authorize", typeof apiBase === "string" ? apiBase : apiBase());
      start.search = new URLSearchParams({ client_id: "opencraft-native-v1", response_type: "code", scope: "openid profile", nonce: ports.random(), redirect_uri: redirect, state: pending.state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
      try {
        const result = await ports.open(start.toString(), redirect);
        ensureAlive();
        if (generation !== signInGeneration) return null;
        if (result.type !== "success" || !result.url) return null;
        const token = await consume(result.url);
        return generation === signInGeneration ? token : null;
      } catch (cause) {
        if (disposed) throw cause;
        if (generation !== signInGeneration) return null;
        throw cause;
      } finally {
        if (signInMaterial === stored) signInMaterial = null;
        await ports.remove(stored);
      }
    },
    async cancel() {
      signInGeneration++;
      exchangeAbort?.abort();
      if (signInMaterial) await ports.remove(signInMaterial);
    },
    dispose() { disposed = true; signInGeneration++; exchangeAbort?.abort(); },
  };
}
