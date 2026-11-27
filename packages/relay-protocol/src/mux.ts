const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const RELAY_MUX_PROTOCOL = "opencraft-relay.v2";
export const RELAY_MUX_PATH = "/__opencraft_relay/v2/mux";
export const RELAY_BLOBS_PATH_PREFIX = "/__opencraft_relay/v2/blobs/";
/** Auto-responded at the Cloudflare edge via `setWebSocketAutoResponse` without waking a hibernated DO. */
export const RELAY_MUX_PING = "__oc_ping__";
export const RELAY_MUX_PONG = "__oc_pong__";

export const MUX_HEADER_BYTES = 9;
export const MAX_MUX_PAYLOAD = 65_536;
export const MAX_MUX_STREAMS = 512;
export const DEFAULT_MUX_WINDOW = 262_144;
export const MAX_MUX_WINDOW = 0x7fff_ffff;
export const DEFAULT_MUX_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MUX_BATCH_MS = 50;

export const MUX_FLAG_FIN = 0x01;
export const MUX_FLAG_TRANSIENT_DELTA = 0x02;

export const MuxFrameType = Object.freeze({
  OPEN_WS: 0x01,
  OPEN_HTTP: 0x02,
  HTTP_RESPONSE: 0x03,
  DATA_TEXT: 0x04,
  DATA_BINARY: 0x05,
  WINDOW_UPDATE: 0x06,
  CLOSE: 0x07,
  ROUTE_ADVERTISE: 0x08,
  AUDIENCE_STATE: 0x09,
  DATA_BATCH: 0x0a,
} as const);

export type MuxFrameTypeCode = (typeof MuxFrameType)[keyof typeof MuxFrameType];

export interface MuxAccessScope {
  readonly role: "owner" | "collaborator";
  readonly threadIds?: readonly string[];
  readonly allowExecution: boolean;
  readonly grantEpoch: number;
}

export interface MuxOpenWsInit {
  readonly path: string;
  readonly subprotocol?: string;
  readonly actorId: string;
  readonly grantId?: string;
  readonly deviceThumbprint?: string;
  readonly scope: MuxAccessScope;
}

export interface MuxOpenHttpInit {
  readonly method: string;
  readonly path: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly actorId: string;
  readonly grantId?: string;
  readonly scope: MuxAccessScope;
}

export interface MuxHttpResponseInit {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
}

export type DirectRouteKind = "lan" | "tailscale" | "tunnel";

export interface DirectRouteCandidate {
  readonly kind: DirectRouteKind;
  readonly origin: string;
  readonly priority: number;
}

export type MuxFrame =
  | { readonly type: typeof MuxFrameType.OPEN_WS; readonly streamId: number; readonly init: MuxOpenWsInit }
  | {
      readonly type: typeof MuxFrameType.OPEN_HTTP;
      readonly streamId: number;
      readonly fin: boolean;
      readonly init: MuxOpenHttpInit;
    }
  | {
      readonly type: typeof MuxFrameType.HTTP_RESPONSE;
      readonly streamId: number;
      readonly fin: boolean;
      readonly init: MuxHttpResponseInit;
    }
  | {
      readonly type: typeof MuxFrameType.DATA_TEXT;
      readonly streamId: number;
      readonly fin: boolean;
      readonly transientDelta: boolean;
      readonly text: string;
    }
  | {
      readonly type: typeof MuxFrameType.DATA_BINARY;
      readonly streamId: number;
      readonly fin: boolean;
      readonly data: Uint8Array;
    }
  | {
      readonly type: typeof MuxFrameType.DATA_BATCH;
      readonly streamId: number;
      readonly transientDelta: boolean;
      readonly messages: readonly string[];
    }
  | { readonly type: typeof MuxFrameType.WINDOW_UPDATE; readonly streamId: number; readonly increment: number }
  | {
      readonly type: typeof MuxFrameType.CLOSE;
      readonly streamId: number;
      readonly code: number;
      readonly reason: string;
    }
  | { readonly type: typeof MuxFrameType.ROUTE_ADVERTISE; readonly candidates: readonly DirectRouteCandidate[] }
  | { readonly type: typeof MuxFrameType.AUDIENCE_STATE; readonly activeWatchers: number };

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SECRET_43_RE = /^[A-Za-z0-9_-]{43}$/u;
const SHORT_PAIR_CODE_RE = /^[A-Za-z0-9_-]{16,96}$/u;

export function isValidRelayMachineId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_RE.test(value);
}

/**
 * Deterministic UUIDv4-shaped identifier derived from the first 128 bits of a
 * 64-hex SHA-256 public-key thumbprint so sovereign device keys map 1:1 to valid
 * `actor_<uuid>` identities without any central registration table.
 */
export function deterministicUuidFromHex(hex64: string): string {
  if (!/^[a-f0-9]{64}$/iu.test(hex64)) throw new Error("Expected 64-char hex digest");
  const h = hex64.toLowerCase();
  const vNibble = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${vNibble}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function countLeadingZeroBits(bytes: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    const b = bytes[i]!;
    if (b === 0) {
      total += 8;
      continue;
    }
    total += Math.clz32(b) - 24;
    break;
  }
  return total;
}

export async function verifyHashcashPow(challenge: string, nonce: string, requiredBits: number): Promise<boolean> {
  if (!Number.isInteger(requiredBits) || requiredBits < 0 || requiredBits > 30) return false;
  if (!challenge || typeof nonce !== "string" || !/^[A-Za-z0-9_-]{1,32}$/u.test(nonce)) return false;
  if (requiredBits === 0) return true;
  const input = encoder.encode(`${challenge}:${nonce}`);
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return countLeadingZeroBits(digest) >= requiredBits;
}

/**
 * Solves a stateless Hashcash SHA-256 leading-zero puzzle using WebCrypto.
 * At `bits = 14..16` (~16k..65k hashes), takes ~15-60ms on a normal client while
 * making unauthenticated botnet/script floods prohibitively expensive.
 */
export async function solveHashcashPow(
  challenge: string,
  requiredBits: number,
  maxIterations = 2_000_000,
): Promise<string> {
  if (requiredBits <= 0) return "0";
  const prefix = `${challenge}:`;
  for (let i = 0; i < maxIterations; i += 1) {
    const nonce = i.toString(36);
    const input = encoder.encode(prefix + nonce);
    const copy = new Uint8Array(input.byteLength);
    copy.set(input);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
    if (countLeadingZeroBits(digest) >= requiredBits) {
      return nonce;
    }
  }
  throw new Error("Hashcash proof-of-work exceeded iteration budget");
}

/**
 * Self-addressing machine credential (`ocm_<machineId>_<43-char-secret>`):
 * allows stateless Edge Workers to route in O(1) directly to `idFromName(machineId)`
 * without scanning a global database or registry.
 */
export function formatMachineCredential(machineId: string, secret: string): string {
  if (!isValidRelayMachineId(machineId)) throw new Error("Invalid relay machine ID");
  if (!SECRET_43_RE.test(secret)) throw new Error("Invalid relay machine secret");
  return `ocm_${machineId}_${secret}`;
}

export function parseMachineCredential(value: unknown): { readonly machineId: string; readonly secret: string } | null {
  if (typeof value !== "string" || !value.startsWith("ocm_") || value.length !== 4 + 36 + 1 + 43) return null;
  const machineId = value.slice(4, 40);
  if (value[40] !== "_") return null;
  const secret = value.slice(41);
  if (!isValidRelayMachineId(machineId) || !SECRET_43_RE.test(secret)) return null;
  return { machineId, secret };
}

export const OFFICIAL_CLOUD_RELAY_ORIGIN = "https://relay.opencraft.app";
export const OFFICIAL_WEB_APP_ORIGIN = "https://my.opencraft.app";

export interface PairingLinkPayload {
  readonly relayOrigin: string;
  readonly machineId: string;
  readonly code: string;
  readonly approvalRequired?: boolean;
  readonly webOrigin?: string;
}

function validateRelayOrigin(raw: string): string {
  const url = new URL(raw);
  if (
    url.origin !== raw ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname.endsWith(".test"))
      ))
  ) {
    throw new Error("Invalid relay origin");
  }
  return url.origin;
}

export function resolveRelayWebAppOrigin(relayOriginRaw: string, explicitWebOrigin?: string): string {
  const relayOrigin = validateRelayOrigin(relayOriginRaw);
  if (explicitWebOrigin?.trim()) return validateRelayOrigin(explicitWebOrigin.trim());
  if (relayOrigin === OFFICIAL_CLOUD_RELAY_ORIGIN) return OFFICIAL_WEB_APP_ORIGIN;
  return relayOrigin;
}

export function resolveRelayOriginFromWebEntry(webOriginRaw: string, explicitRelayParam?: string | null): string {
  if (explicitRelayParam?.trim()) return validateRelayOrigin(explicitRelayParam.trim());
  const webOrigin = validateRelayOrigin(webOriginRaw);
  if (webOrigin === OFFICIAL_WEB_APP_ORIGIN) return OFFICIAL_CLOUD_RELAY_ORIGIN;
  return webOrigin;
}

export function formatShareUrl(relayOriginRaw: string, shareToken: string, explicitWebOrigin?: string): string {
  const relayOrigin = validateRelayOrigin(relayOriginRaw);
  const webOrigin = resolveRelayWebAppOrigin(relayOrigin, explicitWebOrigin);
  const url = new URL(`/s/${encodeURIComponent(shareToken)}`, webOrigin);
  if (
    webOrigin !== relayOrigin &&
    !(webOrigin === OFFICIAL_WEB_APP_ORIGIN && relayOrigin === OFFICIAL_CLOUD_RELAY_ORIGIN)
  ) {
    url.searchParams.set("relay", relayOrigin);
  }
  return url.toString();
}

export function formatMachineClaimUrl(relayOriginRaw: string, ticketB64: string, explicitWebOrigin?: string): string {
  const relayOrigin = validateRelayOrigin(relayOriginRaw);
  const webOrigin = resolveRelayWebAppOrigin(relayOrigin, explicitWebOrigin);
  const url = new URL("/claim", webOrigin);
  if (
    webOrigin !== relayOrigin &&
    !(webOrigin === OFFICIAL_WEB_APP_ORIGIN && relayOrigin === OFFICIAL_CLOUD_RELAY_ORIGIN)
  ) {
    url.searchParams.set("relay", relayOrigin);
  }
  return `${url.href}#ticket=${encodeURIComponent(ticketB64)}`;
}

/**
 * Keeps the one-time pairing secret inside `#code=...` so HTTP access logs,
 * proxies and Referer headers never observe it.
 */
export function formatPairingUrl(input: PairingLinkPayload, scheme: "opencraft" | "https" = "opencraft"): string {
  const relayOrigin = validateRelayOrigin(input.relayOrigin);
  if (!isValidRelayMachineId(input.machineId)) throw new Error("Invalid pairing machine ID");
  if (!SHORT_PAIR_CODE_RE.test(input.code)) throw new Error("Invalid pairing code");
  const fragment = `#code=${encodeURIComponent(input.code)}`;
  if (scheme === "https") {
    const webOrigin = resolveRelayWebAppOrigin(relayOrigin, input.webOrigin);
    const url = new URL("/pair", webOrigin);
    url.searchParams.set("m", input.machineId);
    if (
      webOrigin !== relayOrigin &&
      !(webOrigin === OFFICIAL_WEB_APP_ORIGIN && relayOrigin === OFFICIAL_CLOUD_RELAY_ORIGIN)
    ) {
      url.searchParams.set("relay", relayOrigin);
    }
    if (input.approvalRequired) url.searchParams.set("approval", "1");
    return `${url.href}${fragment}`;
  }
  const params = new URLSearchParams({ relay: relayOrigin, m: input.machineId });
  if (input.approvalRequired) params.set("approval", "1");
  return `opencraft://pair?${params.toString()}${fragment}`;
}

export function parsePairingUrl(raw: string): PairingLinkPayload | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw.trim());
    const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    const code = hashParams.get("code") ?? "";
    if (!SHORT_PAIR_CODE_RE.test(code)) return null;
    if (url.protocol === "opencraft:") {
      if (url.hostname !== "pair" && url.pathname !== "//pair" && url.pathname !== "/pair") return null;
      const relay = url.searchParams.get("relay") ?? "";
      const machineId = url.searchParams.get("m") ?? "";
      if (!isValidRelayMachineId(machineId)) return null;
      return {
        relayOrigin: validateRelayOrigin(relay),
        machineId,
        code,
        ...(url.searchParams.get("approval") === "1" ? { approvalRequired: true } : {}),
      };
    }
    if ((url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/pair") {
      const machineId = url.searchParams.get("m") ?? "";
      if (!isValidRelayMachineId(machineId)) return null;
      const relayOrigin = resolveRelayOriginFromWebEntry(url.origin, url.searchParams.get("relay"));
      return {
        relayOrigin,
        machineId,
        code,
        ...(url.searchParams.get("approval") === "1" ? { approvalRequired: true } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function isPrivateOrTailnetIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^(?:0|[1-9]\d{0,2})$/u.test(p))) return false;
  const nums = parts.map(Number);
  if (nums.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = nums as [number, number, number, number];
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  // Tailscale CGNAT range 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function validateDirectRouteCandidate(value: unknown): DirectRouteCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid direct route candidate");
  const candidate = value as Record<string, unknown>;
  const kind = candidate.kind;
  if (kind !== "lan" && kind !== "tailscale" && kind !== "tunnel") throw new Error("Invalid direct route kind");
  if (typeof candidate.origin !== "string" || candidate.origin.length > 512)
    throw new Error("Invalid direct route origin");
  const priority = candidate.priority;
  if (typeof priority !== "number" || !Number.isSafeInteger(priority) || priority < 0 || priority > 1000) {
    throw new Error("Invalid direct route priority");
  }
  const url = new URL(candidate.origin);
  if (url.origin !== candidate.origin || url.username || url.password) throw new Error("Invalid direct route URL");
  const host = url.hostname.toLowerCase();
  if (kind === "tailscale") {
    const validTsHttps = url.protocol === "https:" && (host.endsWith(".ts.net") || isPrivateOrTailnetIpv4(host));
    const validTsHttp = url.protocol === "http:" && isPrivateOrTailnetIpv4(host);
    if (!validTsHttps && !validTsHttp) throw new Error("Tailscale route requires *.ts.net HTTPS or CGNAT address");
  } else if (kind === "lan") {
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      (!isPrivateOrTailnetIpv4(host) && !host.endsWith(".local"))
    ) {
      throw new Error("LAN route requires a private network address");
    }
  } else if (url.protocol !== "https:") {
    throw new Error("Tunnel route requires HTTPS");
  }
  return Object.freeze({ kind, origin: url.origin, priority });
}

function writeHeader(type: MuxFrameTypeCode, streamId: number, meta: number, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffff_ffff) {
    throw new RangeError("Invalid mux streamId");
  }
  if (!Number.isInteger(meta) || meta < 0 || meta > 0xffff_ffff) {
    throw new RangeError("Invalid mux frame metadata");
  }
  if (payload.byteLength > MAX_MUX_PAYLOAD) {
    throw new RangeError(`Mux frame payload exceeds ${MAX_MUX_PAYLOAD} bytes`);
  }
  const out = new Uint8Array(MUX_HEADER_BYTES + payload.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, type);
  view.setUint32(1, streamId, false);
  view.setUint32(5, meta, false);
  out.set(payload, MUX_HEADER_BYTES);
  return out;
}

function packTextBatch(messages: readonly string[]): Uint8Array {
  if (messages.length === 0 || messages.length > 1024) throw new RangeError("Invalid mux text batch count");
  const encoded = messages.map((msg) => encoder.encode(msg));
  let total = 0;
  for (const item of encoded) {
    if (item.byteLength > 0xffff) throw new RangeError("Mux batched item exceeds 65535 bytes");
    total += 2 + item.byteLength;
  }
  if (total > MAX_MUX_PAYLOAD) throw new RangeError("Mux text batch exceeds max payload");
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const item of encoded) {
    view.setUint16(offset, item.byteLength, false);
    offset += 2;
    out.set(item, offset);
    offset += item.byteLength;
  }
  return out;
}

function unpackTextBatch(payload: Uint8Array): readonly string[] {
  if (payload.byteLength < 2) throw new Error("Empty mux text batch");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const messages: string[] = [];
  let offset = 0;
  while (offset < payload.byteLength) {
    if (offset + 2 > payload.byteLength) throw new Error("Truncated mux batch header");
    const len = view.getUint16(offset, false);
    offset += 2;
    if (offset + len > payload.byteLength) throw new Error("Truncated mux batch item");
    messages.push(decoder.decode(payload.subarray(offset, offset + len)));
    offset += len;
  }
  return messages;
}

function validateScope(raw: unknown): MuxAccessScope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid mux access scope");
  const s = raw as Record<string, unknown>;
  if ((s.role !== "owner" && s.role !== "collaborator") || typeof s.allowExecution !== "boolean") {
    throw new Error("Invalid mux scope role");
  }
  if (typeof s.grantEpoch !== "number" || !Number.isSafeInteger(s.grantEpoch) || s.grantEpoch < 0) {
    throw new Error("Invalid mux grant epoch");
  }
  if (
    s.threadIds !== undefined &&
    (!Array.isArray(s.threadIds) ||
      s.threadIds.length > 128 ||
      s.threadIds.some((t) => typeof t !== "string" || !t || t.length > 256))
  ) {
    throw new Error("Invalid mux scope threadIds");
  }
  return {
    role: s.role,
    allowExecution: s.allowExecution,
    grantEpoch: s.grantEpoch,
    ...(s.threadIds ? { threadIds: [...(s.threadIds as string[])] } : {}),
  };
}

function validateHeaderPairs(raw: unknown): readonly (readonly [string, string])[] {
  if (!Array.isArray(raw) || raw.length > 128) throw new Error("Invalid mux headers");
  return raw.map((pair) => {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string" ||
      !pair[0] ||
      pair[0].length > 256 ||
      pair[1].length > 8192 ||
      /[\r\n\0]/u.test(pair[0]) ||
      /[\r\n\0]/u.test(pair[1])
    ) {
      throw new Error("Invalid mux header entry");
    }
    return [pair[0].toLowerCase(), pair[1]] as const;
  });
}

export function encodeMuxFrame(frame: MuxFrame): Uint8Array {
  switch (frame.type) {
    case MuxFrameType.OPEN_WS:
      if (frame.streamId <= 0) throw new RangeError("OPEN_WS requires streamId > 0");
      return writeHeader(frame.type, frame.streamId, 0, encoder.encode(JSON.stringify(frame.init)));
    case MuxFrameType.OPEN_HTTP:
      if (frame.streamId <= 0) throw new RangeError("OPEN_HTTP requires streamId > 0");
      return writeHeader(
        frame.type,
        frame.streamId,
        frame.fin ? MUX_FLAG_FIN : 0,
        encoder.encode(JSON.stringify(frame.init)),
      );
    case MuxFrameType.HTTP_RESPONSE:
      if (frame.streamId <= 0) throw new RangeError("HTTP_RESPONSE requires streamId > 0");
      return writeHeader(
        frame.type,
        frame.streamId,
        frame.fin ? MUX_FLAG_FIN : 0,
        encoder.encode(JSON.stringify(frame.init)),
      );
    case MuxFrameType.DATA_TEXT: {
      if (frame.streamId <= 0) throw new RangeError("DATA_TEXT requires streamId > 0");
      const flags = (frame.fin ? MUX_FLAG_FIN : 0) | (frame.transientDelta ? MUX_FLAG_TRANSIENT_DELTA : 0);
      return writeHeader(frame.type, frame.streamId, flags, encoder.encode(frame.text));
    }
    case MuxFrameType.DATA_BINARY:
      if (frame.streamId <= 0) throw new RangeError("DATA_BINARY requires streamId > 0");
      return writeHeader(frame.type, frame.streamId, frame.fin ? MUX_FLAG_FIN : 0, frame.data);
    case MuxFrameType.DATA_BATCH:
      if (frame.streamId <= 0) throw new RangeError("DATA_BATCH requires streamId > 0");
      return writeHeader(
        frame.type,
        frame.streamId,
        frame.transientDelta ? MUX_FLAG_TRANSIENT_DELTA : 0,
        packTextBatch(frame.messages),
      );
    case MuxFrameType.WINDOW_UPDATE:
      if (frame.streamId <= 0 || frame.increment <= 0 || frame.increment > MAX_MUX_WINDOW) {
        throw new RangeError("Invalid WINDOW_UPDATE");
      }
      return writeHeader(frame.type, frame.streamId, frame.increment, new Uint8Array(0));
    case MuxFrameType.CLOSE: {
      if (frame.streamId <= 0) throw new RangeError("CLOSE requires streamId > 0");
      const reasonBytes = frame.reason ? encoder.encode(frame.reason) : new Uint8Array(0);
      if (reasonBytes.byteLength > 123) throw new RangeError("CLOSE reason exceeds 123 bytes");
      return writeHeader(frame.type, frame.streamId, frame.code, reasonBytes);
    }
    case MuxFrameType.ROUTE_ADVERTISE:
      return writeHeader(
        frame.type,
        0,
        0,
        encoder.encode(JSON.stringify({ candidates: frame.candidates.map(validateDirectRouteCandidate) })),
      );
    case MuxFrameType.AUDIENCE_STATE:
      if (frame.activeWatchers < 0 || frame.activeWatchers > 65_535) throw new RangeError("Invalid activeWatchers");
      return writeHeader(frame.type, 0, frame.activeWatchers, new Uint8Array(0));
  }
}

export function decodeMuxFrame(input: ArrayBuffer | Uint8Array): MuxFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < MUX_HEADER_BYTES) throw new Error("Truncated mux frame");
  const payloadLength = bytes.byteLength - MUX_HEADER_BYTES;
  if (payloadLength > MAX_MUX_PAYLOAD) throw new Error("Mux frame exceeds max payload");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0);
  const streamId = view.getUint32(1, false);
  const meta = view.getUint32(5, false);
  const payload = bytes.subarray(MUX_HEADER_BYTES);

  switch (type) {
    case MuxFrameType.OPEN_WS: {
      if (streamId === 0 || meta !== 0) throw new Error("Invalid OPEN_WS header");
      const parsed = JSON.parse(decoder.decode(payload)) as Record<string, unknown>;
      if (
        typeof parsed.path !== "string" ||
        !parsed.path.startsWith("/") ||
        typeof parsed.actorId !== "string" ||
        !parsed.actorId
      ) {
        throw new Error("Invalid OPEN_WS payload");
      }
      return {
        type,
        streamId,
        init: {
          path: parsed.path,
          actorId: parsed.actorId,
          scope: validateScope(parsed.scope),
          ...(typeof parsed.subprotocol === "string" ? { subprotocol: parsed.subprotocol } : {}),
          ...(typeof parsed.grantId === "string" ? { grantId: parsed.grantId } : {}),
          ...(typeof parsed.deviceThumbprint === "string" ? { deviceThumbprint: parsed.deviceThumbprint } : {}),
        },
      };
    }
    case MuxFrameType.OPEN_HTTP: {
      if (streamId === 0) throw new Error("Invalid OPEN_HTTP streamId");
      const parsed = JSON.parse(decoder.decode(payload)) as Record<string, unknown>;
      if (
        typeof parsed.method !== "string" ||
        !/^[A-Z]{3,10}$/u.test(parsed.method) ||
        typeof parsed.path !== "string" ||
        !parsed.path.startsWith("/") ||
        typeof parsed.actorId !== "string" ||
        !parsed.actorId
      ) {
        throw new Error("Invalid OPEN_HTTP payload");
      }
      return {
        type,
        streamId,
        fin: (meta & MUX_FLAG_FIN) !== 0,
        init: {
          method: parsed.method,
          path: parsed.path,
          headers: validateHeaderPairs(parsed.headers),
          actorId: parsed.actorId,
          scope: validateScope(parsed.scope),
          ...(typeof parsed.grantId === "string" ? { grantId: parsed.grantId } : {}),
        },
      };
    }
    case MuxFrameType.HTTP_RESPONSE: {
      if (streamId === 0) throw new Error("Invalid HTTP_RESPONSE streamId");
      const parsed = JSON.parse(decoder.decode(payload)) as Record<string, unknown>;
      if (
        typeof parsed.status !== "number" ||
        !Number.isInteger(parsed.status) ||
        parsed.status < 100 ||
        parsed.status > 599
      ) {
        throw new Error("Invalid HTTP_RESPONSE status");
      }
      return {
        type,
        streamId,
        fin: (meta & MUX_FLAG_FIN) !== 0,
        init: { status: parsed.status, headers: validateHeaderPairs(parsed.headers) },
      };
    }
    case MuxFrameType.DATA_TEXT:
      if (streamId === 0) throw new Error("Invalid DATA_TEXT streamId");
      return {
        type,
        streamId,
        fin: (meta & MUX_FLAG_FIN) !== 0,
        transientDelta: (meta & MUX_FLAG_TRANSIENT_DELTA) !== 0,
        text: decoder.decode(payload),
      };
    case MuxFrameType.DATA_BINARY:
      if (streamId === 0) throw new Error("Invalid DATA_BINARY streamId");
      return {
        type,
        streamId,
        fin: (meta & MUX_FLAG_FIN) !== 0,
        data: payload.slice(),
      };
    case MuxFrameType.DATA_BATCH:
      if (streamId === 0) throw new Error("Invalid DATA_BATCH streamId");
      return {
        type,
        streamId,
        transientDelta: (meta & MUX_FLAG_TRANSIENT_DELTA) !== 0,
        messages: unpackTextBatch(payload),
      };
    case MuxFrameType.WINDOW_UPDATE:
      if (streamId === 0 || meta === 0 || meta > MAX_MUX_WINDOW || payload.byteLength !== 0) {
        throw new Error("Invalid WINDOW_UPDATE frame");
      }
      return { type, streamId, increment: meta };
    case MuxFrameType.CLOSE:
      if (streamId === 0 || payload.byteLength > 123) throw new Error("Invalid CLOSE frame");
      return { type, streamId, code: meta, reason: payload.byteLength ? decoder.decode(payload) : "" };
    case MuxFrameType.ROUTE_ADVERTISE: {
      if (streamId !== 0 || meta !== 0) throw new Error("Invalid ROUTE_ADVERTISE header");
      const parsed = JSON.parse(decoder.decode(payload)) as { candidates?: unknown };
      if (!Array.isArray(parsed.candidates) || parsed.candidates.length > 16) {
        throw new Error("Invalid ROUTE_ADVERTISE candidates");
      }
      return { type, candidates: parsed.candidates.map(validateDirectRouteCandidate) };
    }
    case MuxFrameType.AUDIENCE_STATE:
      if (streamId !== 0 || meta > 65_535 || payload.byteLength !== 0) throw new Error("Invalid AUDIENCE_STATE frame");
      return { type, activeWatchers: meta };
    default:
      throw new Error(`Unsupported mux frame type: ${type}`);
  }
}

/**
 * Per-stream credit-based flow controller. Bounds queued outbound bytes so a
 * stalled consumer stalls only its own stream rather than exhausting memory or
 * blocking sibling multiplexed streams on the shared WebSocket.
 */
export class MuxStreamFlowControl {
  #sendWindow: number;
  readonly #initialReceiveWindow: number;
  #unackedReceiveBytes = 0;
  #bufferedBytes = 0;
  readonly #maxBufferedBytes: number;
  readonly #queue: { binary: boolean; bytes: Uint8Array; fin: boolean; transientDelta: boolean }[] = [];

  constructor(
    readonly streamId: number,
    private readonly emit: (frame: MuxFrame) => void,
    options: { initialWindow?: number; maxBufferedBytes?: number } = {},
  ) {
    this.#sendWindow = options.initialWindow ?? DEFAULT_MUX_WINDOW;
    this.#initialReceiveWindow = options.initialWindow ?? DEFAULT_MUX_WINDOW;
    this.#maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MUX_MAX_BUFFERED_BYTES;
  }

  get sendWindow(): number {
    return this.#sendWindow;
  }

  get bufferedBytes(): number {
    return this.#bufferedBytes;
  }

  sendText(text: string, options: { fin?: boolean; transientDelta?: boolean } = {}): void {
    const bytes = encoder.encode(text);
    // Keep WebSocket text message boundaries intact when within MAX_MUX_PAYLOAD;
    // split larger HTTP/stream text payloads into bounded slices.
    if (bytes.byteLength <= MAX_MUX_PAYLOAD) {
      this.#enqueue({
        binary: false,
        bytes,
        fin: options.fin === true,
        transientDelta: options.transientDelta === true,
      });
      this.#drain();
      return;
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      const end = Math.min(offset + MAX_MUX_PAYLOAD, bytes.byteLength);
      this.#enqueue({
        binary: false,
        bytes: bytes.subarray(offset, end),
        fin: options.fin === true && end === bytes.byteLength,
        transientDelta: options.transientDelta === true,
      });
      offset = end;
    }
    this.#drain();
  }

  sendBinary(data: Uint8Array, options: { fin?: boolean } = {}): void {
    if (data.byteLength === 0) {
      if (options.fin) {
        this.#enqueue({ binary: true, bytes: new Uint8Array(0), fin: true, transientDelta: false });
        this.#drain();
      }
      return;
    }
    let offset = 0;
    while (offset < data.byteLength) {
      const end = Math.min(offset + MAX_MUX_PAYLOAD, data.byteLength);
      this.#enqueue({
        binary: true,
        bytes: data.slice(offset, end),
        fin: options.fin === true && end === data.byteLength,
        transientDelta: false,
      });
      offset = end;
    }
    this.#drain();
  }

  onWindowUpdate(increment: number): void {
    if (!Number.isInteger(increment) || increment <= 0 || this.#sendWindow + increment > MAX_MUX_WINDOW) {
      throw new Error("Stream send window overflow");
    }
    this.#sendWindow += increment;
    this.#drain();
  }

  onInboundConsumed(byteCount: number): void {
    if (byteCount <= 0) return;
    this.#unackedReceiveBytes += byteCount;
    if (this.#unackedReceiveBytes >= this.#initialReceiveWindow >>> 1) {
      const increment = this.#unackedReceiveBytes;
      this.#unackedReceiveBytes = 0;
      this.emit({ type: MuxFrameType.WINDOW_UPDATE, streamId: this.streamId, increment });
    }
  }

  clear(): void {
    this.#queue.length = 0;
    this.#bufferedBytes = 0;
  }

  #enqueue(item: { binary: boolean; bytes: Uint8Array; fin: boolean; transientDelta: boolean }): void {
    if (this.#bufferedBytes + item.bytes.byteLength > this.#maxBufferedBytes) {
      throw new Error("Mux stream outbound buffer limit exceeded");
    }
    this.#queue.push(item);
    this.#bufferedBytes += item.bytes.byteLength;
  }

  #drain(): void {
    while (this.#queue.length > 0) {
      const head = this.#queue[0]!;
      if (head.bytes.byteLength === 0) {
        this.#queue.shift();
        this.emit(
          head.binary
            ? { type: MuxFrameType.DATA_BINARY, streamId: this.streamId, fin: head.fin, data: head.bytes }
            : {
                type: MuxFrameType.DATA_TEXT,
                streamId: this.streamId,
                fin: head.fin,
                transientDelta: head.transientDelta,
                text: "",
              },
        );
        continue;
      }
      if (this.#sendWindow === 0) return;
      if (head.binary && head.bytes.byteLength > this.#sendWindow) {
        const take = this.#sendWindow;
        const part = head.bytes.subarray(0, take);
        head.bytes = head.bytes.subarray(take);
        this.#bufferedBytes -= take;
        this.#sendWindow = 0;
        this.emit({ type: MuxFrameType.DATA_BINARY, streamId: this.streamId, fin: false, data: part });
        return;
      }
      if (!head.binary && head.bytes.byteLength > this.#sendWindow) {
        // Wait for enough window to preserve whole UTF-8 / JSON-RPC message boundaries.
        return;
      }
      this.#queue.shift();
      this.#bufferedBytes -= head.bytes.byteLength;
      this.#sendWindow -= head.bytes.byteLength;
      if (head.binary) {
        this.emit({ type: MuxFrameType.DATA_BINARY, streamId: this.streamId, fin: head.fin, data: head.bytes });
      } else {
        this.emit({
          type: MuxFrameType.DATA_TEXT,
          streamId: this.streamId,
          fin: head.fin,
          transientDelta: head.transientDelta,
          text: decoder.decode(head.bytes),
        });
      }
    }
  }
}

/**
 * Host-to-Relay message coalescer and audience gate:
 * 1. Drops transient streaming deltas when `activeWatchers === 0` so unattended
 *    background loops never keep a Durable Object awake;
 * 2. Coalesces rapid discrete WebSocket text frames within `windowMs` (default 50ms)
 *    into a single length-prefixed `DATA_BATCH` frame while preserving exact
 *    per-message boundaries on unpack.
 */
export class MuxOutboundBatcher {
  #activeWatchers = 1;
  readonly #batches = new Map<
    number,
    { messages: string[]; bytes: number; allTransient: boolean; timer: ReturnType<typeof setTimeout> | null }
  >();

  constructor(
    private readonly sendRaw: (encoded: Uint8Array) => void,
    private readonly windowMs = DEFAULT_MUX_BATCH_MS,
  ) {}

  get activeWatchers(): number {
    return this.#activeWatchers;
  }

  setActiveWatchers(count: number): void {
    this.#activeWatchers = Math.max(0, Math.trunc(count));
    if (this.#activeWatchers === 0) {
      for (const [streamId, entry] of this.#batches) {
        if (entry.allTransient) {
          if (entry.timer !== null) clearTimeout(entry.timer);
          this.#batches.delete(streamId);
        }
      }
    }
  }

  send(frame: MuxFrame): void {
    if (frame.type === MuxFrameType.DATA_TEXT && !frame.fin) {
      if (frame.transientDelta && this.#activeWatchers === 0) return;
      // Non-transient messages (RPC requests/responses, handshakes, turn completion)
      // flush immediately with 0ms artificial latency, carrying along any queued
      // deltas on the same stream in strict FIFO order.
      if (!frame.transientDelta) {
        const itemBytes = encoder.encode(frame.text).byteLength;
        const existing = this.#batches.get(frame.streamId);
        if (existing && existing.bytes + 2 + itemBytes <= MAX_MUX_PAYLOAD && itemBytes <= 0xffff) {
          existing.messages.push(frame.text);
          existing.bytes += 2 + itemBytes;
          existing.allTransient = false;
          this.flushStream(frame.streamId);
          return;
        }
        this.flushStream(frame.streamId);
        this.sendRaw(encodeMuxFrame(frame));
        return;
      }
      if (this.windowMs <= 0) {
        this.sendRaw(encodeMuxFrame(frame));
        return;
      }
      const itemBytes = encoder.encode(frame.text).byteLength;
      if (itemBytes + 2 > MAX_MUX_PAYLOAD) {
        this.flushStream(frame.streamId);
        this.sendRaw(encodeMuxFrame(frame));
        return;
      }
      let batch = this.#batches.get(frame.streamId);
      if (batch && batch.bytes + 2 + itemBytes > MAX_MUX_PAYLOAD) {
        this.flushStream(frame.streamId);
        batch = undefined;
      }
      if (!batch) {
        const created = {
          messages: [frame.text],
          bytes: 2 + itemBytes,
          allTransient: true,
          timer: setTimeout(() => this.flushStream(frame.streamId), this.windowMs),
        };
        (created.timer as unknown as { unref?: () => void })?.unref?.();
        this.#batches.set(frame.streamId, created);
      } else {
        batch.messages.push(frame.text);
        batch.bytes += 2 + itemBytes;
      }
      return;
    }
    if ("streamId" in frame && frame.streamId > 0) this.flushStream(frame.streamId);
    this.sendRaw(encodeMuxFrame(frame));
  }

  flushStream(streamId: number): void {
    const batch = this.#batches.get(streamId);
    if (!batch) return;
    this.#batches.delete(streamId);
    if (batch.timer !== null) clearTimeout(batch.timer);
    if (batch.allTransient && this.#activeWatchers === 0) return;
    if (batch.messages.length === 1) {
      this.sendRaw(
        encodeMuxFrame({
          type: MuxFrameType.DATA_TEXT,
          streamId,
          fin: false,
          transientDelta: batch.allTransient,
          text: batch.messages[0]!,
        }),
      );
      return;
    }
    this.sendRaw(
      encodeMuxFrame({
        type: MuxFrameType.DATA_BATCH,
        streamId,
        transientDelta: batch.allTransient,
        messages: batch.messages,
      }),
    );
  }

  flushAll(): void {
    for (const streamId of [...this.#batches.keys()]) this.flushStream(streamId);
  }

  dispose(): void {
    for (const batch of this.#batches.values()) {
      if (batch.timer !== null) clearTimeout(batch.timer);
    }
    this.#batches.clear();
  }
}
