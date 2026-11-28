// Structural subset of the Workers runtime consumed by the Million-Scale Cloud Relay
// assembly (`deploy/cloudflare/wrangler.cloud-relay.jsonc`). Imports no `cloudflare:*`
// module and no global Workers types so `tsc --noEmit` succeeds across workspaces.
import type { DurableObjectStorage, R2Bucket } from "@opencraft/storage-cloudflare/bindings";

export interface CloudRelayStorage extends DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  getAlarm(): Promise<number | null>;
}

export type HibernatableSocket = WebSocket & {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
};

export interface CloudRelayDOState {
  readonly storage: CloudRelayStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  waitUntil(promise: Promise<unknown>): void;
  abort(reason?: string): void;
  acceptWebSocket(socket: HibernatableSocket, tags?: readonly string[]): void;
  getWebSockets(tag?: string): HibernatableSocket[];
  setWebSocketAutoResponse(pair: unknown): void;
}

export type DurableObjectLocationHint = "wnam" | "enam" | "sam" | "weur" | "eeur" | "apac" | "oc" | "afr" | "me";

export interface CloudRelayNamespace {
  idFromName(name: string): unknown;
  get(
    id: unknown,
    options?: { readonly locationHint?: DurableObjectLocationHint },
  ): { fetch(request: Request): Promise<Response> };
}

export interface EdgeFetchBinding {
  fetch(request: Request): Promise<Response>;
}

export type HibernatableSocketRuntime = typeof globalThis & {
  WebSocketPair: new () => { 0: WebSocket; 1: HibernatableSocket };
  WebSocketRequestResponsePair: new (request: string, response: string) => unknown;
};

export interface OidcProviderConfig {
  readonly id: string;
  readonly label: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
}

export interface CloudRelayEnv {
  /** 4,096-shard `(provider, subject) -> actorId` uniqueness index. */
  readonly IDENTITY_INDEX: CloudRelayNamespace;
  /** Per-human-Actor ledger (`user:<actorId>`): machines, pairing codes, share grants, quotas. */
  readonly USER_RELAY: CloudRelayNamespace;
  /** Per-machine relay (`machine:<machineId>`): 100% hibernatable mux.v2 bridge & authority cache. */
  readonly MACHINE_RELAY: CloudRelayNamespace;
  /** Optional R2 bucket offloading large attachments/blobs off Durable Object threads. */
  readonly RELAY_BLOBS?: R2Bucket;
  /** Optional Workers Static Assets offloading the Web Workbench UI at the edge. */
  readonly ASSETS?: EdgeFetchBinding;
  /** Secret signing material (at least 32 chars) for stateless edge JWTs, shard HMACs, and R2 tickets. */
  readonly OPENCRAFT_RELAY_SIGNING_KEY: string;
  /** Canonical public origin of this hosted relay (e.g. `https://relay.opencraft.app`). */
  readonly OPENCRAFT_RELAY_ORIGIN: string;
  /** Optional dedicated Web App origin for QR/share links (e.g. `https://my.opencraft.app`). */
  readonly OPENCRAFT_WEB_APP_ORIGIN?: string;
  /** Default per-user enrolled machine cap (default `"3"`). */
  readonly OPENCRAFT_RELAY_FREE_MACHINE_LIMIT?: string;
  /** Alias for per-user enrolled machine cap. */
  readonly OPENCRAFT_MAX_MACHINES_PER_USER?: string;
  /** Optional JSON array of OIDC provider configs (`OidcProviderConfig[]`). */
  readonly OPENCRAFT_RELAY_OIDC_PROVIDERS?: string;
  /** Optional test override for HTTP stream timeout in milliseconds. */
  readonly OPENCRAFT_RELAY_HTTP_TIMEOUT_MS?: string;
  /** Optional default Durable Object location hint (e.g. `"apac"`). */
  readonly OPENCRAFT_RELAY_LOCATION_HINT?: string;
  /** Leading zero bits required for anonymous Hashcash PoW challenges (default `"14"`). */
  readonly OPENCRAFT_RELAY_POW_BITS?: string;
  /** Max anonymous sovereign machine enrollments per IP per hour (default `"12"`). */
  readonly OPENCRAFT_RELAY_IP_ENROLL_HOURLY_LIMIT?: string;
  /** Max pair/share redemptions per IP per 10 minutes (default `"30"`). */
  readonly OPENCRAFT_RELAY_IP_REDEEM_LIMIT?: string;
  /** Optional separate signing secret for commercial `ocl1_` License Keys. */
  readonly OPENCRAFT_RELAY_LICENSE_SIGNING_KEY?: string;
}

export const INTERNAL_CALLER_HEADER = "x-opencraft-relay-internal";
export const INTERNAL_CALLER_VALUE = "edge-v2";
