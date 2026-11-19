import { SANDBOX_CONFIG_PATH } from '../../../assets/contract';
import type { SandboxConfigurations } from '../../../assets/sandbox-configurations';
interface SandboxConfigurationService { store: SandboxConfigurations; allowed(request: IncomingMessage): boolean; allowCustomEndpoints(request: IncomingMessage): boolean; canManagePlatform?(request: IncomingMessage): boolean }
import { IOA_ACCESS_PATH } from "./admission-contract";
import { TencentOaAccessPolicy } from "./access-policy";
import { parsePrincipal, type Principal } from '@opencraft/identity-core';
import type { IdentityProvider } from '@opencraft/identity-core/node';
import type { WorkbenchRequestIdentity } from '@opencraft/app-host-server';
import type { TransportSubmissionContext } from '@opencraft/appserver-client/transport';
export { TencentOaAccessPolicy } from "./access-policy";
// Node-only subpath; never re-export from the Renderer entry.
export { TencentOaParticipants } from "./participants-server";
import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import type { EmployeeSshCredentials } from './ssh-credentials';
import { TENCENTOA_SSH_CREDENTIALS_PATH } from './contract';
import { identityValidUntil, TENCENTOA_MODEL_DEFAULTS_PATH, TENCENTOA_CLOCK_SKEW_MS, TENCENTOA_PHOTO_PATH, TENCENTOA_READ_RECEIPTS_PATH, TENCENTOA_SESSION_PATH, type TencentOaIdentity, type TencentOaServerDiagnostic } from "./contract";

import { parseAccountModelSelection, validateModelDefaultsHost, type AccountModelDefaultsRecord } from "@opencraft/workbench-runtime";
import { GIT_CREDENTIALS_PATH } from './git-credentials-contract';
import type { EmployeeGitCredentialsService } from './git-credentials-server';
import type { AccountEnvironmentHttp, EnvironmentAccount } from '../../../../../scripts/account-environment-http';
import { TENCENTOA_ENVIRONMENT_PATH } from './contract';
interface ModelDefaultsStore {
  read(account: string, hostId: string): AccountModelDefaultsRecord;
  write(account: string, hostId: string, revision: number, selection: unknown): { updated: boolean; record: AccountModelDefaultsRecord };
}

interface ReadReceiptStore { read(account: string): string[]; merge(account: string, receipts: unknown): string[]; }

type IdentityRequest = Pick<IncomingMessage, "headers"> & Partial<Pick<IncomingMessage, "rawHeaders">>;
interface AccessSettings { handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>; }
interface TencentOaAuthenticationResult {
  readonly identity: TencentOaIdentity | null;
  readonly diagnostic: TencentOaServerDiagnostic | null;
}
const protectedHeaders = new Set(["timestamp", "signature", "x-rio-seq", "staffid", "staffname", "x-ext-data", "x-tai-identity"]);
const requiredTaiHeaders = ["timestamp", "signature", "x-rio-seq", "x-tai-identity"] as const;
const maximumIdentityBytes = 16_384;
const utf8 = new TextDecoder("utf-8", { fatal: true });
/** Diagnostics carry reason codes and header names only; never values, payloads or key material. */
function denied(reason: TencentOaServerDiagnostic["reason"], extra: Omit<TencentOaServerDiagnostic, "reason"> = {}): TencentOaAuthenticationResult {
  return { identity: null, diagnostic: Object.freeze({ reason, ...extra }) };
}

function header(request: IdentityRequest, name: string, required = true): string {
  const value = request.headers[name];
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || (required && !value) || value.length > maximumIdentityBytes) throw new Error("Invalid identity header");
  return value;
}
function base64url(value: string, size?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid identity encoding");
  const result = Buffer.from(value, "base64url");
  if (result.toString("base64url") !== value || (size !== undefined && result.length !== size)) throw new Error("Invalid identity encoding");
  return result;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid identity payload");
  return value as Record<string, unknown>;
}
function parseExpiration(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid identity expiration");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) throw new Error("Invalid identity expiration");
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1]! || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59) throw new Error("Invalid identity expiration");
  return new Date(value).toISOString();
}

/** The key belongs to the installation; identities belong to individual requests. */
export class TencentOaServerPlugin implements WorkbenchRequestIdentity {
  readonly #key: Buffer | null;
  readonly #identityResolver?: (request: IdentityRequest) => Principal | null;
  readonly #accessPolicy?: TencentOaAccessPolicy;
  readonly #accessSettings?: AccessSettings;
  readonly #readReceipts?: ReadReceiptStore;
  readonly #modelDefaults?: ModelDefaultsStore;
  readonly #sandboxConfigurations?: SandboxConfigurationService;
  readonly #gitCredentials?: EmployeeGitCredentialsService;
  readonly #environment?: { http: AccountEnvironmentHttp; projects: EnvironmentAccount["projects"]; isAllowed(request: IncomingMessage): boolean };
  readonly #sshCredentials?: Pick<EmployeeSshCredentials, 'read' | 'generate'>;
  readonly #now: () => number;
  readonly #fetcher: typeof fetch;
  readonly #photoOrigin: string;
  #closed = false;
  constructor(token: Uint8Array | null, options: { readonly sandboxConfigurations?: SandboxConfigurationService; readonly gitCredentials?: EmployeeGitCredentialsService; readonly environment?: { http: AccountEnvironmentHttp; projects: EnvironmentAccount["projects"]; isAllowed(request: IncomingMessage): boolean }; readonly sshCredentials?: Pick<EmployeeSshCredentials, 'read' | 'generate'>; readonly identityResolver?: (request: IdentityRequest) => Principal | null; readonly now?: () => number; readonly fetcher?: typeof fetch; readonly photoOrigin?: string; readonly modelDefaults?: ModelDefaultsStore; readonly readReceipts?: ReadReceiptStore; readonly accessPolicy?: TencentOaAccessPolicy; readonly accessSettings?: AccessSettings } = {}) {
    if (token === null ? !options.identityResolver : token.byteLength !== 32) throw new Error("Tencent OA requires a 32-byte application token or a verified identity resolver");
    try { if (token) utf8.decode(token); } catch { throw new Error("Tencent OA requires a UTF-8 application token"); }
    this.#identityResolver = options.identityResolver;
    this.#accessPolicy = options.accessPolicy;
    this.#accessSettings = options.accessSettings;
    this.#readReceipts = options.readReceipts;
    this.#modelDefaults = options.modelDefaults;
    this.#gitCredentials = options.gitCredentials;
    this.#sandboxConfigurations = options.sandboxConfigurations;
    this.#environment = options.environment;
    this.#sshCredentials = options.sshCredentials;
    this.#key = token ? Buffer.from(token) : null; this.#now = options.now ?? Date.now;
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    const origin = new URL(options.photoOrigin ?? process.env.OPENCRAFT_TENCENTOA_PHOTO_ORIGIN ?? "http://api-idc.sgw.woa.com");
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Invalid Tencent OA photo origin");
    this.#photoOrigin = origin.origin;
  }
  static async fromTokenFile(path: string, options: { readonly sandboxConfigurations?: SandboxConfigurationService; readonly gitCredentials?: EmployeeGitCredentialsService; readonly environment?: { http: AccountEnvironmentHttp; projects: EnvironmentAccount["projects"]; isAllowed(request: IncomingMessage): boolean }; readonly sshCredentials?: Pick<EmployeeSshCredentials, 'read' | 'generate'>; readonly identityResolver?: (request: IdentityRequest) => Principal | null; readonly modelDefaults?: ModelDefaultsStore; readonly readReceipts?: ReadReceiptStore; readonly accessPolicy?: TencentOaAccessPolicy; readonly accessSettings?: AccessSettings } = {}): Promise<TencentOaServerPlugin> {
    if (!isAbsolute(path)) throw new Error("Tencent OA requires an absolute private token-file path");
    let handle;
    let bytes: Buffer | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 256 || (info.mode & 0o077) !== 0
        || (process.getuid && info.uid !== process.getuid())) throw new Error();
      bytes = await handle.readFile();
      const token = bytes.subarray(0, bytes.length - (bytes.at(-1) === 10 ? (bytes.at(-2) === 13 ? 2 : 1) : 0));
      return new TencentOaServerPlugin(token, options);
    } catch { throw new Error("Tencent OA private token configuration is unavailable or invalid"); }
    finally { bytes?.fill(0); await handle?.close(); }
  }
  /** Null on invalid input; no partial identity or crypto errors escape this boundary. */
  authenticate(request: IdentityRequest): TencentOaIdentity | null {
    return this.authenticateWithDiagnostic(request).identity;
  }
  /** Sanitized failure reason for the same fail-closed check; never exposes credentials or payloads. */
  authenticateWithDiagnostic(request: IdentityRequest): TencentOaAuthenticationResult {
    if (this.#closed) return denied("closed");
    if (this.#identityResolver) {
      const p = this.#identityResolver(request);
      if (p?.provider !== 'tencentoa' || !p.attributes?.loginName || !/^[1-9][0-9]*$/u.test(p.subject) || p.expiresAt <= this.#now()) return denied("resolver_unauthenticated");
      return { identity: { loginName: p.attributes.loginName, staffId: p.subject, expiresAt: new Date(p.expiresAt - TENCENTOA_CLOCK_SKEW_MS).toISOString() }, diagnostic: null };
    }
    return this.authenticateNativeWithDiagnostic(request);
  }
  identityProvider(): IdentityProvider {
    return { authenticate: request => {
      const employee = this.authenticateNative(request);
      return employee ? parsePrincipal({ provider: 'tencentoa', subject: employee.staffId, displayName: employee.loginName,
        aliases: ['login:' + employee.loginName.toLowerCase()], attributes: { loginName: employee.loginName }, expiresAt: Date.parse(employee.expiresAt) + TENCENTOA_CLOCK_SKEW_MS }) : null;
    } };
  }
  authenticateNative(request: IdentityRequest): TencentOaIdentity | null {
    return this.authenticateNativeWithDiagnostic(request).identity;
  }
  private authenticateNativeWithDiagnostic(request: IdentityRequest): TencentOaAuthenticationResult {
    if (this.#closed) return denied("closed");
    const key = this.#key;
    if (!key) return denied("missing_key");
    let plaintext: Buffer | undefined;
    try {
      const seen = new Set<string>();
      for (let index = 0; index < (request.rawHeaders?.length ?? 0); index += 2) {
        const name = request.rawHeaders![index]!.toLowerCase();
        if (!protectedHeaders.has(name)) continue;
        if (seen.has(name)) return denied("duplicate_header");
        seen.add(name);
      }
      const presentHeaders = Object.keys(request.headers).filter(name => {
        const value = request.headers[name];
        return protectedHeaders.has(name.toLowerCase()) && typeof value === "string" && value.length > 0 && value.length <= maximumIdentityBytes;
      }).sort();
      const missingHeaders = requiredTaiHeaders.filter(name => !presentHeaders.includes(name));
      if (missingHeaders.length) return denied("missing_tai_headers", { missingHeaders, presentHeaders });
      const now = this.#now(), timestamp = header(request, "timestamp"), signature = header(request, "signature");
      if (!/^\d{1,12}$/u.test(timestamp) || !/^[A-F0-9]{64}$/u.test(signature)) return denied("invalid_timestamp_or_signature_format");
      const skewMs = Math.abs(Number(timestamp) * 1000 - now);
      if (skewMs > TENCENTOA_CLOCK_SKEW_MS) return denied("clock_skew", { skewMs });
      const sequence = header(request, "x-rio-seq");
      const message = timestamp + key.toString("utf8") + [sequence,
        header(request, "staffid", false), header(request, "staffname", false), header(request, "x-ext-data", false)].join(",") + timestamp;
      const expected = createHash("sha256").update(message, "utf8").digest("hex").toUpperCase();
      if (!timingSafeEqual(Buffer.from(expected, "ascii"), Buffer.from(signature, "ascii"))) return denied("signature_mismatch");
      const parts = header(request, "x-tai-identity").split(".");
      if (parts.length !== 5 || parts[1] !== "") return denied("invalid_jwe_format");
      const protectedPart = parts[0]!;
      let algorithm: Record<string, unknown>;
      try { algorithm = record(JSON.parse(utf8.decode(base64url(protectedPart)))); }
      catch { return denied("invalid_jwe_format"); }
      if (algorithm.alg !== "dir" || algorithm.enc !== "A256GCM" || algorithm.crit !== undefined || algorithm.zip !== undefined) return denied("unsupported_jwe_header");
      let iv: Buffer, ciphertext: Buffer, authTag: Buffer;
      try { iv = base64url(parts[2]!, 12); ciphertext = base64url(parts[3]!); authTag = base64url(parts[4]!, 16); }
      catch { return denied("invalid_jwe_format"); }
      let decrypted: Buffer;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.from(protectedPart, "ascii")); decipher.setAuthTag(authTag);
        decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        plaintext = decrypted;
      } catch { return denied("decrypt_failed"); }
      let payload: Record<string, unknown>;
      try { payload = record(JSON.parse(utf8.decode(decrypted))); }
      catch { return denied("invalid_payload"); }
      const fields = new Map<string, unknown>();
      for (const [fieldName, value] of Object.entries(payload)) {
        const name = fieldName.toLowerCase();
        if (!["loginname", "staffid", "expiration"].includes(name)) continue;
        if (fields.has(name)) return denied("invalid_payload");
        fields.set(name, value);
      }
      let expiresAt: string;
      try { expiresAt = parseExpiration(fields.get("expiration")); }
      catch { return denied("invalid_payload"); }
      const loginName = fields.get("loginname"), staffId = fields.get("staffid");
      if (typeof loginName !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(loginName)
        || typeof staffId !== "number" || !Number.isSafeInteger(staffId) || staffId <= 0) return denied("invalid_payload");
      if (Date.parse(expiresAt) < now - TENCENTOA_CLOCK_SKEW_MS) return denied("identity_expired");
      // When legacy cleartext fields also exist, do not accept contradictory identities.
      let legacyId: string, legacyName: string;
      try { legacyId = header(request, "staffid", false); legacyName = header(request, "staffname", false); }
      catch { return denied("legacy_header_mismatch"); }
      if ((legacyId && legacyId !== String(staffId)) || (legacyName && legacyName !== loginName)) return denied("legacy_header_mismatch");
      return { identity: Object.freeze({ loginName, staffId: String(staffId), expiresAt }), diagnostic: null };
    } catch { return denied("invalid_payload"); }
    finally { plaintext?.fill(0); }
  }
  /** Disabled only by absence of installation policy; an empty policy denies everyone. */
  get admissionRequired(): boolean { return this.#accessPolicy !== undefined; }
  admissionStatus(request: IdentityRequest): 204 | 401 | 403 {
    if (this.#closed) return 401;
    if (!this.#accessPolicy) return 204;
    const identity = this.authenticate(request);
    return !identity ? 401 : this.#accessPolicy.allows(identity.loginName) ? 204 : 403;
  }
  connectionContext(request: IdentityRequest): TransportSubmissionContext | null {
    if (this.#closed) return null;
    const identity = this.authenticate(request);
    if (!identity) return this.admissionRequired ? null : { sender: null };
    return { sender: { kind: "employee", loginName: identity.loginName },
      executionPrincipal: { provider: "tencentoa", subject: identity.staffId, loginName: identity.loginName },
      validUntil: identityValidUntil(identity) };
  }
  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const url = new URL(request.url ?? "/", "http://opencraft.invalid");
    // Older direct clients retain their path; managed Web routes the generic
    // enterprise identity namespace to this optional downstream service.
    if (url.pathname.startsWith("/__opencraft_tencentoa/")) {
      url.pathname = url.pathname.replace("/__opencraft_tencentoa/", "/__opencraft_enterprise_identity/");
    }
    if (!url.pathname.startsWith("/__opencraft_enterprise_identity/")) return false;
    if (url.pathname === IOA_ACCESS_PATH && this.#accessSettings) {
      void this.#accessSettings.handle(request, response).catch(() => {
        if (!response.headersSent) { response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end('{"error":"policy_unavailable"}'); }
        else response.destroy();
      });
      return true;
    }
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("x-content-type-options", "nosniff");
    const reply = (status: number, value: unknown): true => { response.statusCode = status; response.end(JSON.stringify(value)); return true; };
    // Compatibility for older managed static workers. Core admission runs first.
    if (url.pathname === "/__opencraft_enterprise_identity/admission") {
      if (request.method !== "GET") return reply(405, { error: "method_not_allowed" });
      response.statusCode = 204; response.end(); return true;
    }
    const modelDefaults = url.pathname === TENCENTOA_MODEL_DEFAULTS_PATH;
    const readReceipts = url.pathname === TENCENTOA_READ_RECEIPTS_PATH;
    const gitCredentials = url.pathname === GIT_CREDENTIALS_PATH;
    const sandboxConfigurations = url.pathname === SANDBOX_CONFIG_PATH;
    const environment = url.pathname === TENCENTOA_ENVIRONMENT_PATH;
    const sshCredentials = url.pathname === TENCENTOA_SSH_CREDENTIALS_PATH;
    const photo = url.pathname.startsWith(TENCENTOA_PHOTO_PATH)
      ? /^(48|100|150|500)\/([A-Za-z0-9._-]{1,128})\.png$/.exec(url.pathname.slice(TENCENTOA_PHOTO_PATH.length)) : null;
    if ((url.pathname !== TENCENTOA_SESSION_PATH && !photo && !readReceipts && !modelDefaults && !gitCredentials && !sshCredentials && !environment && !sandboxConfigurations) || (!modelDefaults && !environment && url.search)) return reply(404, { error: "missing" });
    if (request.method !== "GET" && !((readReceipts || modelDefaults || gitCredentials || sshCredentials || environment || sandboxConfigurations) && request.method === "POST")) { response.setHeader("allow", "GET, POST"); return reply(405, { error: "method_not_allowed" }); }
    if (request.headers["sec-fetch-site"] === "cross-site") return reply(403, { error: "forbidden" });
    if (request.headers.origin !== undefined) {
      try {
        const origin = new URL(header(request, "origin"));
        if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== request.headers.origin || origin.host !== request.headers.host) throw new Error();
      } catch { return reply(403, { error: "forbidden" }); }
    }
    const session = url.pathname === TENCENTOA_SESSION_PATH;
    const authentication = session
      ? this.authenticateWithDiagnostic(request)
      : { identity: this.authenticate(request), diagnostic: null };
    const identity = authentication.identity;
    if (sandboxConfigurations) {
      if (!identity) return reply(401, { error: 'unauthenticated' });
      const service = this.#sandboxConfigurations;
      if (!service) return reply(503, { error: 'unavailable' });
      void service.store.handle(request, response, { scope: `tencentoa:${identity.staffId}`,
        current: () => this.authenticate(request)?.staffId === identity.staffId && service.allowed(request),
        allowCustomEndpoints: () => service.allowCustomEndpoints(request),
        canManagePlatform: () => service.canManagePlatform?.(request) ?? false,
      }).catch(() => { if (!response.writableEnded) reply(503, { error: 'unavailable' }); });
      return true;
    }
    if (environment) {
      if (!identity) return reply(401, { error: 'unauthenticated' });
      if (!this.#environment) return reply(503, { error: 'unavailable' });
      const current = () => this.authenticate(request)?.staffId === identity.staffId
        && this.admissionStatus(request) === 204 && this.#environment!.isAllowed(request);
      void this.#environment.http.handle(request, response, { account: `tencentoa:${identity.staffId}`,
        current, projects: this.#environment.projects }).catch(() => { if (!response.writableEnded) reply(503, { error: 'unavailable' }); });
      return true;
    }
    if (gitCredentials) {
      if (!identity) return reply(401, { error: 'unauthenticated' });
      if (!this.#gitCredentials) return reply(503, { error: 'unavailable' });
      void this.#gitCredentials.handle(request, response, identity, () => this.authenticate(request)?.staffId === identity.staffId)
        .catch(() => { if (!response.writableEnded) reply(503, { error: 'unavailable' }); });
      return true;
    }
    const employeePrincipal = () => parsePrincipal({ provider: 'tencentoa', subject: identity!.staffId,
      displayName: identity!.loginName, attributes: { loginName: identity!.loginName }, expiresAt: identityValidUntil(identity!) });
    if (sshCredentials) {
      if (!identity) return reply(401, { error: 'unauthenticated' });
      const scope = `tencentoa:${identity.staffId}`;
      if (request.headers['x-opencraft-account-scope'] !== scope) return reply(409, { error: 'account_changed' });
      if (!this.#sshCredentials) return reply(404, { error: 'missing' });
      response.setHeader('pragma', 'no-cache');
      response.setHeader('referrer-policy', 'no-referrer');
      try {
        if (request.method === 'POST') {
          const expected = request.headers['x-opencraft-ssh-key-fingerprint'];
          if (typeof expected !== 'string' || (expected !== 'none' && !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(expected))) return reply(400, { error: 'invalid_request' });
          return reply(200, { scope, credential: this.#sshCredentials.generate(employeePrincipal(), expected === 'none' ? null : expected) });
        }
        return reply(200, { scope, credential: this.#sshCredentials.read(employeePrincipal()) });
      } catch (error) {
        if (error instanceof Error && error.message === 'credential_conflict') return reply(409, { error: 'credential_conflict' });
        return reply(503, { error: 'credential_unavailable' });
      }
    }
    if (modelDefaults) {
      if (!identity) return reply(401, { error: "unauthenticated" });
      const scope = `tencentoa:${identity.staffId}`;
      if (request.headers["x-opencraft-account-scope"] !== scope) return reply(409, { error: "account_changed" });
      const hostId = url.searchParams.get("hostId");
      try {
        validateModelDefaultsHost(hostId);
        if ([...url.searchParams.keys()].some(key => key !== "hostId") || url.searchParams.getAll("hostId").length !== 1) throw new Error();
      } catch { return reply(400, { error: "invalid_host" }); }
      if (!this.#modelDefaults) return reply(503, { error: "unavailable" });
      if (request.method === "GET") {
        try { return reply(200, { scope, hostId, record: this.#modelDefaults.read(scope, hostId) }); }
        catch { return reply(503, { error: "unavailable" }); }
      }
      if (request.headers["content-type"] !== "application/json") return reply(415, { error: "json_required" });
      void (async () => {
        try {
          let bytes = 0; const chunks: Buffer[] = [];
          for await (const chunk of request) {
            bytes += Buffer.byteLength(chunk);
            if (bytes > 16_384) { reply(413, { error: "too_large" }); return; }
            chunks.push(Buffer.from(chunk));
          }
          const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!input || typeof input !== "object" || Array.isArray(input)
            || Object.keys(input).length !== 2 || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error();
          const selection = parseAccountModelSelection(input.selection);
          if (this.authenticate(request)?.staffId !== identity.staffId) { reply(401, { error: "unauthenticated" }); return; }
          try {
            const result = this.#modelDefaults!.write(scope, hostId, input.revision, selection);
            reply(result.updated ? 200 : 409, { scope, hostId, record: result.record });
          } catch { reply(503, { error: "unavailable" }); }
        } catch { if (!response.writableEnded) reply(400, { error: "invalid_model_defaults" }); }
      })();
      return true;
    }
    if (readReceipts) {
      if (!identity) return reply(401, { error: "unauthenticated" });
      const scope = `tencentoa:${identity.staffId}`;
      if (request.headers["x-opencraft-read-scope"] !== scope) return reply(409, { error: "account_changed" });
      if (!this.#readReceipts) return reply(503, { error: "unavailable" });
      if (request.method === "GET") {
        try { return reply(200, { scope, receipts: this.#readReceipts.read(scope) }); }
        catch { return reply(503, { error: "unavailable" }); }
      }
      if (request.headers["content-type"] !== "application/json") return reply(415, { error: "json_required" });
      void (async () => {
        try {
          let bytes = 0; const chunks: Buffer[] = [];
          for await (const chunk of request) {
            bytes += Buffer.byteLength(chunk);
            if (bytes > 1024 * 1024) { reply(413, { error: "too_large" }); return; }
            chunks.push(Buffer.from(chunk));
          }
          const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !Array.isArray(input.receipts)) throw new TypeError();
          // Storage outages are distinct from malformed client input.
          const { parseThreadReadReceipts } = await import("@opencraft/workbench-runtime");
          const receipts = parseThreadReadReceipts(input.receipts);
          if (this.authenticate(request)?.staffId !== identity.staffId) { reply(401, { error: "unauthenticated" }); return; }
          try { reply(200, { scope, receipts: this.#readReceipts!.merge(scope, receipts) }); }
          catch { reply(503, { error: "unavailable" }); }
        } catch { if (!response.writableEnded) reply(400, { error: "invalid_receipts" }); }
      })();
      return true;
    }
    if (photo) {
      if (!identity) return reply(401, { error: "unauthenticated" });
      void this.servePhoto(response, photo[1]!, photo[2]!);
      return true;
    }
    if (!identity) return reply(401, { available: true, identity: null, diagnostic: authentication.diagnostic });
    return reply(200, { available: true, identity });
  }
  private async servePhoto(response: ServerResponse, size: string, loginName: string): Promise<void> {
    try {
      const upstream = await this.#fetcher(`${this.#photoOrigin}/ebus/rhrc/photo/${size}/${encodeURIComponent(loginName)}.png`, {
        headers: { "content-type": "application/json", accept: "image/png,image/jpeg,image/webp,image/gif" },
        redirect: "error", signal: AbortSignal.timeout(4_000),
      });
      const contentType = upstream.headers.get("content-type") ?? "";
      if (!upstream.ok || !/^image\/(png|jpeg|webp|gif)(?:;|$)/i.test(contentType) || !upstream.body) throw new Error();
      const reader = upstream.body.getReader(), chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          length += part.value.byteLength;
          if (length > 1_048_576) { await reader.cancel(); throw new Error(); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      if (!length || this.#closed || response.destroyed) throw new Error();
      response.setHeader("content-type", contentType);
      response.statusCode = 200; response.end(Buffer.concat(chunks));
    } catch {
      if (response.destroyed) return;
      response.statusCode = 502; response.end(JSON.stringify({ error: "photo_unavailable" }));
    }
  }
  close(): void { this.#closed = true; this.#key?.fill(0); }
}
