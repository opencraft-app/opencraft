import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SshServerDescriptor, SshManagementAccessMode } from "@opencraft/app-host-protocol";
import { SshConnectionStore, SshManagementError, hostKeyFingerprint, parseSshConnectionInput, readPrivateSshFile } from "./ssh-connection-store.js";

const COOKIE = "opencraft_ssh_session";
const API = "/__opencraft_ssh";
type Session = { expiresAt: number; origin: string };
type Challenge = { session: string; hostname: string; port: number; key: string; fingerprint: string; expiresAt: number };

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new SshManagementError("invalid");
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length; if (length > 24 * 1024) throw new SshManagementError("invalid"); chunks.push(Buffer.from(chunk));
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new SshManagementError("invalid"); }
}
function digest(value: string): Buffer { return createHash("sha256").update(value).digest(); }

export async function scanSshHostKey(hostname: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn("ssh-keyscan", ["-T", "5", "-t", "ed25519", "-p", String(port), hostname], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = []; let bytes = 0;
    const timer = setTimeout(() => { process.kill(); reject(new SshManagementError("unavailable", 502)); }, 7000);
    process.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024) { process.kill(); reject(new SshManagementError("unavailable", 502)); }
      else chunks.push(chunk);
    });
    process.on("error", () => { clearTimeout(timer); reject(new SshManagementError("unavailable", 502)); });
    process.on("close", () => {
      clearTimeout(timer);
      const lines = Buffer.concat(chunks).toString().trim().split("\n").filter(l => l.includes(" ssh-ed25519 "));
      const keys = new Set(lines.map(line => line.trim().split(/\s+/u).slice(1).join(" ")));
      if (keys.size !== 1) { reject(new SshManagementError("trust", 409)); return; }
      const host = port === 22 ? hostname : `[${hostname}]:${port}`;
      const key = `${host} ${[...keys][0]}`;
      try { hostKeyFingerprint(key); resolve(key); } catch { reject(new SshManagementError("trust", 409)); }
    });
  });
}

/** Installation-owner control plane. Not a browser-owned credential/config cache. */
export class SshManagement {
  readonly store: SshConnectionStore;
  readonly accessMode: SshManagementAccessMode;
  private readonly accessHash: Buffer | null;
  private readonly sessions = new Map<string, Session>();
  private readonly challenges = new Map<string, Challenge>();
  private readonly revocations = new Set<() => void>();
  private failedAttempts: number[] = [];
  private activeScans = 0;
  constructor(readonly options: {
    directory: string;
    publicOrigin?: string;
    /** Explicit operator opt-in: no installation-wide origin pin; sessions still bind their unlock origin. */
    publicAccess?: boolean;
    accessFile?: string;
    /** Shared installation access by default; operators may require an additional key. */
    accessMode?: SshManagementAccessMode;
    sessionTtlMs?: number;
    scanHostKey?: (hostname: string, port: number) => Promise<string>;
    resetConnection: (serverId: string) => Promise<void>;
    connectConnection: (serverId: string, assertAdmission: () => void) => Promise<void>;
    connectionState?: (serverId: string) => string;
    legacyServers?: readonly SshServerDescriptor[];
  }) {
    if (options.publicAccess && options.publicOrigin) throw new Error("Choose either SSH public access or a fixed origin");
    this.accessMode = options.accessMode ?? (options.accessFile ? "access-key" : "shared");
    if (this.accessMode !== "shared" && this.accessMode !== "access-key") throw new Error("Invalid SSH management access mode");
    if (this.accessMode === "shared" && options.accessFile) throw new Error("SSH access file requires access-key mode");
    if (options.publicOrigin) {
      const url = new URL(options.publicOrigin);
      if (url.protocol !== "https:" || url.origin !== options.publicOrigin) throw new Error("SSH public access requires a fixed HTTPS origin");
    }
    this.store = new SshConnectionStore(options.directory);
    this.accessHash = null;
    if (this.accessMode === "shared") return;
    const accessPath = options.accessFile ?? join(options.directory, "access.key");
    if (!options.accessFile) {
      try { writeFileSync(accessPath, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") { this.store.close(); throw error; } }
    }
    try {
      const access = readPrivateSshFile(accessPath, 4096).toString().trim();
      if (access.length < 32) throw new Error("SSH access key must contain at least 32 characters");
      this.accessHash = digest(access);
    } catch (error) { this.store.close(); throw error; }
  }
  sameOrigin(request: IncomingMessage, requireOrigin: boolean): boolean {
    if (request.headers["sec-fetch-site"] === "cross-site") return false;
    if (this.options.publicAccess) {
      if (request.headers.origin === undefined) return !requireOrigin;
      try {
        const url = new URL(request.headers.origin);
        return ["http:", "https:"].includes(url.protocol) && url.origin === request.headers.origin;
      } catch { return false; }
    }
    const expected = this.options.publicOrigin ?? `http://${request.headers.host}`;
    if (!this.options.publicOrigin) {
      try { if (!["localhost", "127.0.0.1"].includes(new URL(expected).hostname)) return false; } catch { return false; }
    }
    return request.headers.origin === expected || (!requireOrigin && request.headers.origin === undefined);
  }
  private requestOrigin(request: IncomingMessage): string | null {
    if (request.headers.origin !== undefined) return request.headers.origin;
    try {
      const url = new URL(request.headers.referer ?? "");
      return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
    } catch { return null; }
  }
  private cookieName(origin: string): string {
    // Secure cookies cannot be overwritten by HTTP. Separate protocol jars
    // preserve both origin-bound grants when visitors switch entry schemes.
    return `${COOKIE}_${origin.startsWith("https:") ? "https" : "http"}`;
  }
  private findSession(request: IncomingMessage): { id: string; token: string; session: Session } | null {
    const cookies = (request.headers.cookie ?? "").split(";").map(v => v.trim());
    const origin = this.requestOrigin(request);
    const names = origin ? [this.cookieName(origin), COOKIE] : [`${COOKIE}_https`, `${COOKIE}_http`, COOKIE];
    for (const name of names) {
      const token = cookies.find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);
      if (!token) continue;
      if (!/^[a-zA-Z0-9_-]{43}$/u.test(token)) return null;
      const id = digest(token).toString("hex"), session = this.sessions.get(id);
      if (!session || session.expiresAt <= Date.now()) { this.sessions.delete(id); return null; }
      if (origin !== null && origin !== session.origin) return null;
      return { id, token, session };
    }
    return null;
  }
  session(request: IncomingMessage): string | null { return this.findSession(request)?.id ?? null; }
  authorized(request: IncomingMessage): boolean { return this.sameOrigin(request, false) && this.session(request) !== null; }
  catalog(request: IncomingMessage): readonly SshServerDescriptor[] {
    if (!this.authorized(request)) return [];
    return this.store.list().filter(row => row.enabled).map(({ serverId, displayName, workspaceBrowseRoots }) => ({ serverId, displayName, workspaceBrowseRoots }));
  }
  onRevocation(listener: () => void) { this.revocations.add(listener); return () => this.revocations.delete(listener); }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = new URL(request.url ?? "/", "http://invalid").pathname;
    if (path !== API && !path.startsWith(`${API}/`)) return false;
    try {
      if (!this.sameOrigin(request, request.method !== "GET")) throw new SshManagementError("locked", 403);
      if (path === `${API}/session` && request.method === "GET") {
        const grant = this.findSession(request);
        // A same-origin GET may omit both Origin and Referer. Report which
        // grant was selected so the browser cannot mistake HTTP for HTTPS.
        json(response, 200, { available: true, authenticated: grant !== null, accessMode: this.accessMode,
          ...(grant ? { authenticatedOrigin: grant.session.origin } : {}) });
        return true;
      }
      if (path === `${API}/session` && request.method === "POST") {
        const data = await body(request);
        if (this.accessMode === "access-key") {
          this.failedAttempts = this.failedAttempts.filter(t => t > Date.now() - 60_000);
          if (this.failedAttempts.length >= 10) { json(response, 429, { error: "locked" }); return true; }
          if (typeof data.accessKey !== "string" || data.accessKey.length > 4096 || !this.accessHash || !timingSafeEqual(digest(data.accessKey), this.accessHash)) {
            this.failedAttempts.push(Date.now()); throw new SshManagementError("locked", 401);
          }
        }
        for (const [id, entry] of this.sessions) if (entry.expiresAt <= Date.now()) this.sessions.delete(id);
        const existing = this.accessMode === "shared" ? this.findSession(request) : null;
        if (!existing && this.sessions.size >= 64) throw new SshManagementError("unavailable", 503);
        const token = existing?.token ?? randomBytes(32).toString("base64url"), ttl = this.options.sessionTtlMs ?? 8 * 60 * 60_000;
        const origin = request.headers.origin!; // Required and validated by sameOrigin above.
        this.sessions.set(digest(token).toString("hex"), { expiresAt: Date.now() + ttl, origin });
        response.setHeader("set-cookie", `${this.cookieName(origin)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttl / 1000)}${origin.startsWith("https:") ? "; Secure" : ""}`);
        json(response, 200, { authenticated: true }); return true;
      }
      const session = this.session(request);
      if (session === null) throw new SshManagementError("locked", 401);
      if (path === `${API}/session` && request.method === "DELETE") {
        const secure = this.sessions.get(session)!.origin.startsWith("https:");
        this.sessions.delete(session);
        for (const [id, challenge] of this.challenges) if (challenge.session === session) this.challenges.delete(id);
        for (const listener of this.revocations) listener();
        response.setHeader("set-cookie", [`${this.cookieName(secure ? "https:" : "http:")}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`, `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`]);
        json(response, 200, { authenticated: false }); return true;
      }
      if (path === `${API}/connections` && request.method === "GET") {
        json(response, 200, this.store.list().map(row => ({ ...row, state: row.enabled ? this.options.connectionState?.(row.serverId) ?? "idle" : "disabled" }))); return true;
      }
      if (path === `${API}/legacy-connections` && request.method === "GET") {
        json(response, 200, this.options.legacyServers ?? []); return true;
      }
      if (path === `${API}/trust` && request.method === "POST") {
        const data = await body(request);
        const input = parseSshConnectionInput({ displayName: "probe", username: "probe", enabled: false, workspaceBrowseRoots: [], hostname: data.hostname, port: data.port });
        for (const [id, challenge] of this.challenges) if (challenge.expiresAt <= Date.now()) this.challenges.delete(id);
        if (this.challenges.size >= 32 || this.activeScans >= 4) throw new SshManagementError("unavailable", 503);
        this.activeScans++;
        let key: string;
        try { key = await (this.options.scanHostKey ?? scanSshHostKey)(input.hostname, input.port); }
        finally { this.activeScans--; }
        if (this.session(request) !== session) throw new SshManagementError("locked", 401);
        if (this.challenges.size >= 32) throw new SshManagementError("unavailable", 503);
        const fingerprint = hostKeyFingerprint(key), id = randomBytes(24).toString("base64url");
        this.challenges.set(id, { session, hostname: input.hostname, port: input.port, key, fingerprint, expiresAt: Date.now() + 120_000 });
        json(response, 200, { challengeId: id, fingerprint }); return true;
      }
      const match = path.match(/^\/__opencraft_ssh\/connections(?:\/(ssh:[a-zA-Z0-9._-]{1,80})(?:\/(connect|reconnect))?)?$/u);
      if (!match) throw new SshManagementError("missing", 404);
      const id = match[1] ?? null;
      const data = await body(request);
      // A slow body may outlive logout/expiry. Authorization is rechecked at
      // the synchronous persistence admission boundary, not only at routing.
      if (this.session(request) !== session) throw new SshManagementError("locked", 401);
      if (match[2] && request.method === "POST" && id) {
        const current = this.store.get(id);
        if (data.revision !== current.revision) throw new SshManagementError("conflict", 409);
        if (!current.enabled) throw new SshManagementError("unavailable", 409);
        if (match[2] === "reconnect") await this.options.resetConnection(id);
        // The reset/physical-close barrier must finish before admitting a
        // successor. Logout or a concurrent config write can revoke admission.
        const assertAdmission = () => {
          if (this.session(request) !== session) throw new SshManagementError("locked", 401);
          if (this.store.get(id).revision !== current.revision) throw new SshManagementError("conflict", 409);
        };
        assertAdmission();
        await this.options.connectConnection(id, assertAdmission);
        json(response, 200, { ok: true }); return true;
      }
      if (request.method === "DELETE" && id) {
        this.store.remove(id, Number(data.revision));
        await this.options.resetConnection(id); json(response, 200, { ok: true }); return true;
      }
      if ((request.method !== "POST" || id !== null) && (request.method !== "PUT" || id === null)) throw new SshManagementError("invalid", 405);
      const input = parseSshConnectionInput(data.input);
      let hostKey: string | undefined;
      if (data.challengeId !== undefined || id === null) {
        const challenge = typeof data.challengeId === "string" ? this.challenges.get(data.challengeId) : undefined;
        if (!challenge || challenge.session !== session || challenge.expiresAt <= Date.now() || challenge.hostname !== input.hostname || challenge.port !== input.port || data.fingerprint !== challenge.fingerprint) throw new SshManagementError("trust", 409);
        hostKey = challenge.key;
      }
      const row = this.store.save(id, Number(data.revision), input, hostKey);
      if (typeof data.challengeId === "string") this.challenges.delete(data.challengeId);
      if (id) await this.options.resetConnection(id);
      json(response, 200, row); return true;
    } catch (error) {
      // Never send raw spawn/crypto/SQLite error or submitted data to browser/logs.
      const safe = error instanceof SshManagementError ? error : new SshManagementError("unavailable", 503);
      json(response, safe.status, { error: safe.code }); return true;
    }
  }
  close() { this.sessions.clear(); this.challenges.clear(); this.revocations.clear(); this.accessHash?.fill(0); this.store.close(); }
}
