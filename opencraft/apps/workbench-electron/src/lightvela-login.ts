import { createHash, randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type LoginRegion = "cn" | "intl";
export interface DesktopLoginSession { region: LoginRegion; token: string }
export const NATIVE_CALLBACK = "opencraft://auth/lightvela";
export const NATIVE_CLIENT = "opencraft-native-v1";
const API_BASES = { cn: "https://api.lightvela.com", intl: "https://api.lightvela.ai" };
const opaque = /^[A-Za-z0-9_-]{43}$/;
const random = () => randomBytes(32).toString("base64url");

export function parseLoginCallback(raw: string): { state: string; code: string | null; error: boolean } | null {
  if (raw.length > 2048 || !raw.startsWith(`${NATIVE_CALLBACK}?`)) return null;
  try {
    const url = new URL(raw);
    if (url.hash || url.origin !== "null" || url.protocol !== "opencraft:" || url.host !== "auth"
      || url.pathname !== "/lightvela" || url.username || url.password) return null;
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length || keys.some(k => !["state", "code", "error"].includes(k))) return null;
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code");
    const error = url.searchParams.has("error");
    if (!opaque.test(state) || (error ? code !== null : !opaque.test(code ?? ""))) return null;
    return { state, code, error };
  } catch { return null; }
}

function socketPath(state: string): string {
  const id = createHash("sha256").update(state).digest("hex").slice(0, 32);
  return process.platform === "win32" ? `\\\\.\\pipe\\opencraft-auth-${id}` : join(tmpdir(), `oc-auth-${id}.sock`);
}

/** Route a callback received by another profile to its live transaction owner. */
export async function forwardLoginCallback(raw: string): Promise<boolean> {
  const callback = parseLoginCallback(raw);
  if (!callback) return false;
  return new Promise(resolve => {
    const socket = createConnection(socketPath(callback.state));
    socket.setTimeout(2000);
    socket.once("connect", () => socket.end(`${raw}\n`));
    socket.once("data", data => { resolve(data.toString() === "accepted"); socket.destroy(); });
    socket.once("error", () => { resolve(false); socket.destroy(); });
    socket.once("timeout", () => { resolve(false); socket.destroy(); });
    socket.once("close", () => resolve(false));
  });
}

interface LoginPorts {
  openExternal(url: string): Promise<void>;
  saveSession(session: DesktopLoginSession, signal: AbortSignal): void | Promise<void>;
  onSuccess(): void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}
interface Transaction {
  region: LoginRegion;
  state: string;
  verifier: string;
  abort: AbortController;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
  processing: boolean;
  promise: Promise<DesktopLoginSession | null>;
  resolve(value: DesktopLoginSession | null): void;
  reject(error: Error): void;
}

/** PKCE, exchange and cancellation stay in Main, never in a remote browser. */
export class DesktopLightVelaLogin {
  private pending: Transaction | null = null;
  constructor(private readonly ports: LoginPorts) {}

  start(region: LoginRegion): Promise<DesktopLoginSession | null> {
    if (region !== "cn" && region !== "intl") return Promise.reject(new Error("Invalid login region"));
    if (this.pending) return this.pending.region === region ? this.pending.promise : Promise.reject(new Error("Cancel the current login before switching regions"));
    let resolve!: Transaction["resolve"];
    let reject!: Transaction["reject"];
    const promise = new Promise<DesktopLoginSession | null>((yes, no) => { resolve = yes; reject = no; });
    const state = random();
    const server = createServer(socket => {
      let body = "";
      socket.setTimeout(2000, () => socket.destroy());
      socket.on("error", () => {});
      socket.on("data", data => {
        body += data.toString();
        if (body.length > 2048) { socket.destroy(); return; }
        if (!body.includes("\n")) return;
        const accepted = this.receive(body.trim());
        socket.end(accepted ? "accepted" : "rejected");
      });
    });
    const tx: Transaction = {
      region, state, verifier: random(), abort: new AbortController(), server, processing: false,
      promise, resolve, reject,
      timer: setTimeout(() => this.finish(tx, new Error("Login timed out. Please try again.")), this.ports.timeoutMs ?? 10 * 60_000),
    };
    this.pending = tx;
    const path = socketPath(state);
    server.on("error", () => this.finish(tx, new Error("Could not prepare the desktop login callback")));
    server.listen(path, () => {
      if (this.pending !== tx) { server.close(); return; }
      try {
        if (process.platform !== "win32") chmodSync(path, 0o600);
        const url = new URL("/oauth2/authorize", API_BASES[region]);
        url.search = new URLSearchParams({
          client_id: NATIVE_CLIENT, response_type: "code", scope: "openid profile", nonce: random(),
          redirect_uri: NATIVE_CALLBACK, state,
          code_challenge: createHash("sha256").update(tx.verifier).digest("base64url"), code_challenge_method: "S256",
        }).toString();
        void this.ports.openExternal(url.toString()).catch(() => this.finish(tx, new Error("Could not open your system browser. Please try again.")));
      } catch { this.finish(tx, new Error("Could not prepare the desktop login callback")); }
    });
    return promise;
  }

  receive(raw: string): boolean {
    const callback = parseLoginCallback(raw);
    const tx = this.pending;
    if (!callback || !tx || callback.state !== tx.state || tx.processing) return false;
    if (callback.error) { this.finish(tx, new Error("LightVela login was not completed. Please try again.")); return true; }
    tx.processing = true;
    void (async () => {
      try {
        const response = await (this.ports.fetchImpl ?? fetch)(`${API_BASES[tx.region]}/auth/session/exchange`, {
          method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", redirect: "error",
          body: JSON.stringify({ client_id: NATIVE_CLIENT, code: callback.code, code_verifier: tx.verifier, redirect_uri: NATIVE_CALLBACK }),
          signal: AbortSignal.any([tx.abort.signal, AbortSignal.timeout(15000)]),
        });
        if (!response.ok) throw new Error("Login exchange failed or expired. Please sign in again.");
        const body = await response.json() as { session_token?: unknown };
        if (typeof body.session_token !== "string" || !body.session_token.trim()) throw new Error("Login returned no session. Please try again.");
        if (this.pending !== tx) return;
        const session = { region: tx.region, token: body.session_token };
        await this.ports.saveSession(session, tx.abort.signal);
        if (this.pending !== tx) return;
        this.finish(tx, null, session);
        this.ports.onSuccess();
      } catch (error) {
        this.finish(tx, error instanceof Error && error.message.startsWith("Login ") ? error : new Error("Could not complete login. Please try again."));
      }
    })();
    return true;
  }

  cancel(): void { if (this.pending) this.finish(this.pending, null); }

  private finish(tx: Transaction, error: Error | null, session: DesktopLoginSession | null = null): void {
    if (this.pending !== tx) return;
    this.pending = null;
    clearTimeout(tx.timer);
    tx.abort.abort();
    tx.server.close();
    tx.verifier = "";
    if (error) tx.reject(error); else tx.resolve(session);
  }
}
