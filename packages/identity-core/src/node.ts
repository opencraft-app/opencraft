import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { parsePrincipal, type Principal } from "./index.js";
export const ASSERTION_HEADER = "x-opencraft-relay-assertion";
export type IdentityRequest = Pick<IncomingMessage, "headers"> & Partial<Pick<IncomingMessage, "rawHeaders" | "method" | "url">>;
export interface IdentityProvider {
  authenticate(request: IdentityRequest): Principal | null;
  trustedOrigin?(request: IdentityRequest): string | null;
  /** Revalidate server-owned browser sessions when a connection outlives its request. */
  isCurrent?(principal: Principal): boolean;
}
export async function readPrivateJson(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new Error("Private configuration requires an absolute path");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1_048_576 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("Private configuration must be an owner-only regular file");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}
export interface AssertionScope { readonly issuer: string; readonly instanceId: string; readonly origin: string; }
function validScope(scope: AssertionScope) {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(scope.issuer) || !/^[A-Za-z0-9._-]{1,128}$/u.test(scope.instanceId)) throw new Error("Invalid relay scope");
  const url = new URL(scope.origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== scope.origin || url.username || url.password) throw new Error("Invalid relay origin");
}
export class AssertionSigner {
  readonly #key: KeyObject;
  constructor(readonly scope: AssertionScope, privateKey: string) {
    validScope(scope); this.#key = createPrivateKey(privateKey);
    if (this.#key.asymmetricKeyType !== "ed25519") throw new Error("Relay assertions require Ed25519");
  }
  issue(principal: Principal, method: string, path: string, now = Date.now()): string {
    const identity = parsePrincipal(principal);
    if (identity.expiresAt <= now) throw new Error("Identity expired");
    const payload = Buffer.from(JSON.stringify({ v: 1, ...this.scope, principal: identity, method, path,
      issuedAt: now, expiresAt: Math.min(now + 30_000, identity.expiresAt), nonce: randomUUID() })).toString("base64url");
    return payload + "." + sign(null, Buffer.from(payload), this.#key).toString("base64url");
  }
}
export interface AssertionProviderOptions {
  /** Compiled product compatibility only; never supplied by request headers or relay JSON. */
  readonly additionalAdmissionProbePaths?: readonly string[];
}
/** Request-local cache allows multiple authorization checks; wire assertions are single-use. */
export class AssertionProvider implements IdentityProvider {
  readonly #key: KeyObject;
  readonly #seen = new Map<string, number>();
  readonly #cache = new WeakMap<object, Principal | null>();
  readonly #admissionProbePaths: ReadonlySet<string>;
  #nextPrune = 0;
  constructor(readonly scope: AssertionScope, publicKey: string, readonly now = Date.now, options: AssertionProviderOptions = {}) {
    validScope(scope); this.#key = createPublicKey(publicKey);
    if (this.#key.asymmetricKeyType !== "ed25519") throw new Error("Relay assertions require Ed25519");
    const paths = options.additionalAdmissionProbePaths === undefined ? [] : options.additionalAdmissionProbePaths;
    if (!Array.isArray(paths) || paths.length > 16 || paths.some(path => typeof path !== 'string'
      || path.length > 256 || !/^\/[A-Za-z0-9/_-]+$/u.test(path) || path.startsWith('//')
      || new URL(path, 'http://opencraft.invalid').pathname !== path)) throw new Error('Invalid assertion admission probe paths');
    this.#admissionProbePaths = new Set(['/__opencraft_access/admission', ...paths]);
  }
  authenticate(request: IdentityRequest): Principal | null {
    if (this.#cache.has(request)) return this.#cache.get(request)!;
    let identity: Principal | null = null;
    try {
      const token = request.headers[ASSERTION_HEADER];
      if (typeof token !== "string" || token.length > 16_384) throw new Error("Missing assertion");
      if (request.rawHeaders && request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders![i]!.toLowerCase() === ASSERTION_HEADER).length !== 1) throw new Error("Duplicate assertion");
      const parts = token.split('.');
      if (parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_-]+$/u.test(p)) || !verify(null, Buffer.from(parts[0]!), this.#key, Buffer.from(parts[1]!, "base64url"))) throw new Error("Invalid assertion");
      const p = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
      // The managed static entry probes document admission without fetching application data.
      const probe = request.method === 'GET' && this.#admissionProbePaths.has(request.url ?? '');
      const method = probe ? request.headers['x-opencraft-relay-probe-method'] ?? request.method : request.method;
      const path = probe ? request.headers['x-opencraft-relay-probe-path'] ?? request.url : request.url;
      const now = this.now();
      if (now >= this.#nextPrune) {
        for (const [nonce, expiry] of this.#seen) if (expiry <= now) this.#seen.delete(nonce);
        this.#nextPrune = now + 1000;
      }
      if (request.headers.host !== new URL(this.scope.origin).host || (request.headers.origin !== undefined && request.headers.origin !== this.scope.origin)
        || p.v !== 1 || p.issuer !== this.scope.issuer || p.instanceId !== this.scope.instanceId || p.origin !== this.scope.origin
        || p.method !== method || p.path !== path || typeof p.nonce !== "string" || p.nonce.length > 128
        || !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt) || p.issuedAt > now + 1000
        || p.expiresAt <= now || p.expiresAt - p.issuedAt > 30_000 || p.issuedAt < now - 30_000
        || this.#seen.has(p.nonce) || this.#seen.size >= 100_000) throw new Error("Assertion scope or freshness mismatch");
      identity = parsePrincipal(p.principal);
      if (identity.expiresAt <= now || p.expiresAt > identity.expiresAt) throw new Error("Expired identity");
      this.#seen.set(p.nonce, p.expiresAt);
    } catch { identity = null; }
    this.#cache.set(request, identity); return identity;
  }
  trustedOrigin(request: IdentityRequest): string | null { return this.authenticate(request) ? this.scope.origin : null; }
}
