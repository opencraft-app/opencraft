// Node-only subpath; never re-export from the Renderer entry.
import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { TENCENTOA_CLOCK_SKEW_MS, TENCENTOA_SESSION_PATH, type TencentOaIdentity } from "./contract";

type IdentityRequest = Pick<IncomingMessage, "headers"> & Partial<Pick<IncomingMessage, "rawHeaders">>;
const protectedHeaders = new Set(["timestamp", "signature", "x-rio-seq", "staffid", "staffname", "x-ext-data", "x-tai-identity"]);
const maximumIdentityBytes = 16_384;
const utf8 = new TextDecoder("utf-8", { fatal: true });

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
export class TencentOaServerPlugin {
  readonly #key: Buffer;
  readonly #now: () => number;
  #closed = false;
  constructor(token: Uint8Array, options: { readonly now?: () => number } = {}) {
    if (token.byteLength !== 32) throw new Error("Tencent OA requires a 32-byte application token");
    try { utf8.decode(token); } catch { throw new Error("Tencent OA requires a UTF-8 application token"); }
    this.#key = Buffer.from(token); this.#now = options.now ?? Date.now;
  }
  static async fromTokenFile(path: string): Promise<TencentOaServerPlugin> {
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
      return new TencentOaServerPlugin(token);
    } catch { throw new Error("Tencent OA private token configuration is unavailable or invalid"); }
    finally { bytes?.fill(0); await handle?.close(); }
  }
  /** Null on invalid input; no partial identity or crypto errors escape this boundary. */
  authenticate(request: IdentityRequest): TencentOaIdentity | null {
    if (this.#closed) return null;
    let plaintext: Buffer | undefined;
    try {
      const seen = new Set<string>();
      for (let index = 0; index < (request.rawHeaders?.length ?? 0); index += 2) {
        const name = request.rawHeaders![index]!.toLowerCase();
        if (!protectedHeaders.has(name)) continue;
        if (seen.has(name)) throw new Error("Duplicate identity header");
        seen.add(name);
      }
      const now = this.#now(), timestamp = header(request, "timestamp"), signature = header(request, "signature");
      if (!/^\d{1,12}$/u.test(timestamp) || !/^[A-F0-9]{64}$/u.test(signature)
        || Math.abs(Number(timestamp) * 1000 - now) > TENCENTOA_CLOCK_SKEW_MS) return null;
      const sequence = header(request, "x-rio-seq");
      const message = timestamp + this.#key.toString("utf8") + [sequence,
        header(request, "staffid", false), header(request, "staffname", false), header(request, "x-ext-data", false)].join(",") + timestamp;
      const expected = createHash("sha256").update(message, "utf8").digest("hex").toUpperCase();
      if (!timingSafeEqual(Buffer.from(expected, "ascii"), Buffer.from(signature, "ascii"))) return null;
      const parts = header(request, "x-tai-identity").split(".");
      if (parts.length !== 5 || parts[1] !== "") return null;
      const protectedPart = parts[0]!;
      const algorithm = record(JSON.parse(utf8.decode(base64url(protectedPart))));
      if (algorithm.alg !== "dir" || algorithm.enc !== "A256GCM" || algorithm.crit !== undefined || algorithm.zip !== undefined) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.#key, base64url(parts[2]!, 12));
      decipher.setAAD(Buffer.from(protectedPart, "ascii")); decipher.setAuthTag(base64url(parts[4]!, 16));
      plaintext = Buffer.concat([decipher.update(base64url(parts[3]!)), decipher.final()]);
      const fields = new Map<string, unknown>();
      for (const [key, value] of Object.entries(record(JSON.parse(utf8.decode(plaintext))))) {
        const name = key.toLowerCase();
        if (!["loginname", "staffid", "expiration"].includes(name)) continue;
        if (fields.has(name)) return null;
        fields.set(name, value);
      }
      const loginName = fields.get("loginname"), staffId = fields.get("staffid"), expiresAt = parseExpiration(fields.get("expiration"));
      if (typeof loginName !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(loginName)
        || typeof staffId !== "number" || !Number.isSafeInteger(staffId) || staffId <= 0
        || Date.parse(expiresAt) < now - TENCENTOA_CLOCK_SKEW_MS) return null;
      // When legacy cleartext fields also exist, do not accept contradictory identities.
      const legacyId = header(request, "staffid", false), legacyName = header(request, "staffname", false);
      if ((legacyId && legacyId !== String(staffId)) || (legacyName && legacyName !== loginName)) return null;
      return Object.freeze({ loginName, staffId: String(staffId), expiresAt });
    } catch { return null; }
    finally { plaintext?.fill(0); }
  }
  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const url = new URL(request.url ?? "/", "http://opencraft.invalid");
    if (!url.pathname.startsWith("/__opencraft_tencentoa/")) return false;
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("x-content-type-options", "nosniff");
    const reply = (status: number, value: unknown): true => { response.statusCode = status; response.end(JSON.stringify(value)); return true; };
    if (url.pathname !== TENCENTOA_SESSION_PATH || url.search) return reply(404, { error: "missing" });
    if (request.method !== "GET") { response.setHeader("allow", "GET"); return reply(405, { error: "method_not_allowed" }); }
    if (request.headers["sec-fetch-site"] === "cross-site") return reply(403, { error: "forbidden" });
    if (request.headers.origin !== undefined) {
      try {
        const origin = new URL(header(request, "origin"));
        if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== request.headers.origin || origin.host !== request.headers.host) throw new Error();
      } catch { return reply(403, { error: "forbidden" }); }
    }
    const identity = this.authenticate(request);
    return reply(identity ? 200 : 401, { available: true, identity });
  }
  close(): void { this.#closed = true; this.#key.fill(0); }
}
