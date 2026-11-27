import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AppHostServer, AppHostServerPort } from "@opencraft/app-host-server";
import type { RuntimeMachineIdentity } from "@opencraft/appserver-protocol";
import {
  connectRelayMux,
  type MuxSocketLike,
  type RelayMuxClientConnection,
  type RelayMuxWsStream,
} from "@opencraft/plugin-relay-connect/mux";
import {
  discoverDirectRoutes,
  type DirectRouteDiscoveryOptions,
} from "@opencraft/plugin-relay-connect/route-discovery";
import {
  formatMachineClaimUrl,
  formatPairingUrl,
  formatShareUrl,
  isValidRelayMachineId,
  parseMachineCredential,
  solveHashcashPow,
  type DirectRouteCandidate,
  type MuxAccessScope,
} from "@opencraft/relay-protocol";

const ENROLLMENT_FILE_NAME = "relay-enrollment.json";
export const DEFAULT_CLOUD_RELAY_ORIGIN = "https://relay.opencraft.app";

export interface PersistedRelayEnrollment {
  readonly schemaVersion: 1;
  readonly relayOrigin: string;
  readonly actorId: string;
  readonly machineId: string;
  readonly credential: string;
  readonly sessionToken: string;
  readonly enrolledAt: number;
  readonly displayName?: string;
  readonly approvalRequired?: boolean;
  readonly hubClaimed?: boolean;
  /** Present when enrolled in zero-signup sovereign Ed25519 mode (`cnf`-bound JWT). */
  readonly ownerPublicKey?: string;
  readonly ownerPrivateKeyPkcs8?: string;
}

export interface DaemonRelayPairingInvite {
  readonly machineId: string;
  readonly relayOrigin: string;
  readonly code: string;
  readonly pairingUrl: string;
  readonly httpsPairingUrl: string;
  readonly expiresAt: number;
  readonly approvalRequired: boolean;
}

export interface DaemonRelayShareResult {
  readonly grantId: string;
  readonly shareToken: string;
  readonly shareUrl: string;
  readonly machineId: string;
  readonly expiresAt: number;
  readonly allowExecution: boolean;
}

export interface DaemonRelayPendingApproval {
  readonly shortCode: string;
  readonly thumbprint: string;
  readonly label: string;
  readonly expiresAt: number;
}

export interface DaemonRelayActiveShareSummary {
  readonly grantId: string;
  readonly machineId: string;
  readonly allowExecution: boolean;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly shareUrl?: string;
}

export interface DaemonRelayStatus {
  readonly enrolled: boolean;
  readonly connected: boolean;
  readonly activeWatchers: number;
  readonly relayOrigin: string | null;
  readonly actorId: string | null;
  readonly machineId: string | null;
  readonly machineName: string;
  readonly approvalRequired: boolean;
  readonly hubClaimed?: boolean;
  readonly advertisedRoutes: readonly DirectRouteCandidate[];
  readonly latestInvite?: DaemonRelayPairingInvite | null;
  readonly pendingApprovals?: readonly DaemonRelayPendingApproval[];
  readonly activeShares?: readonly DaemonRelayActiveShareSummary[];
  readonly planTier?: "free" | "pro" | "team";
  readonly machineLimit?: number;
}

export interface DaemonRelayEnrollmentServiceOptions {
  readonly dataDirectory: string;
  readonly appHost: Pick<AppHostServer, "accept">;
  readonly machineIdentity: RuntimeMachineIdentity;
  readonly allowLoopbackInsecure?: boolean;
  readonly batchWindowMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly createMuxSocket?: (url: string, subprotocol: string, headers: Record<string, string>) => MuxSocketLike;
  readonly routeDiscoveryOptions?: DirectRouteDiscoveryOptions;
}

class RelayStreamAppHostPort implements AppHostServerPort {
  readonly #listeners = new Set<(message: unknown) => void>();

  constructor(private readonly stream: RelayMuxWsStream) {}

  postMessage(message: Parameters<AppHostServerPort["postMessage"]>[0]): void {
    this.stream.sendText(JSON.stringify(message));
  }

  subscribe(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  receive(message: unknown): void {
    for (const listener of this.#listeners) listener(message);
  }

  start(): void {}

  close(): void {
    this.#listeners.clear();
  }
}

function isMutatingExecutionRequest(
  message: unknown,
):
  | { readonly kind: "app-host"; readonly requestId: string; readonly method: string }
  | { readonly kind: "jsonrpc"; readonly id: unknown; readonly method: string }
  | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const record = message as {
    type?: unknown;
    requestId?: unknown;
    frame?: unknown;
    id?: unknown;
    method?: unknown;
    payload?: unknown;
  };
  const mutatingRe =
    /^(?:turn\/start|turn\/interrupt|thread\/start|thread\/fork|thread\/archive|command\/exec|exec\/|workspace\/write|approval\/respond)/u;
  if (record.type === "host/send" && typeof record.requestId === "string" && typeof record.frame === "string") {
    try {
      const inner = JSON.parse(record.frame) as { method?: unknown };
      if (typeof inner.method === "string" && mutatingRe.test(inner.method)) {
        return { kind: "app-host", requestId: record.requestId, method: inner.method };
      }
    } catch {
      return null;
    }
    return null;
  }
  const candidate =
    record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? (record.payload as { id?: unknown; method?: unknown })
      : record;
  if (typeof candidate.method !== "string") return null;
  return mutatingRe.test(candidate.method)
    ? { kind: "jsonrpc", id: candidate.id ?? null, method: candidate.method }
    : null;
}

function inferWorkstationLocationHint(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    if (tz.startsWith("Asia/")) return "apac";
    if (tz.startsWith("Australia/") || tz.startsWith("Pacific/")) return "oc";
    if (tz.startsWith("Europe/")) return "weur";
    if (tz.startsWith("America/")) return "wnam";
    if (tz.startsWith("Africa/")) return "afr";
  } catch {}
  return undefined;
}

function validatePersistedEnrollment(raw: unknown): PersistedRelayEnrollment {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid persisted relay enrollment");
  }
  const r = raw as Record<string, unknown>;
  if (
    r.schemaVersion !== 1 ||
    typeof r.relayOrigin !== "string" ||
    typeof r.actorId !== "string" ||
    !r.actorId ||
    !isValidRelayMachineId(r.machineId) ||
    typeof r.credential !== "string" ||
    parseMachineCredential(r.credential)?.machineId !== r.machineId ||
    typeof r.sessionToken !== "string" ||
    !r.sessionToken ||
    typeof r.enrolledAt !== "number"
  ) {
    throw new Error("Invalid persisted relay enrollment fields");
  }
  return {
    schemaVersion: 1,
    relayOrigin: new URL(r.relayOrigin).origin,
    actorId: r.actorId,
    machineId: r.machineId,
    credential: r.credential,
    sessionToken: r.sessionToken,
    enrolledAt: r.enrolledAt,
    ...(typeof r.displayName === "string" && r.displayName.trim() ? { displayName: r.displayName.trim() } : {}),
    ...(typeof r.approvalRequired === "boolean" ? { approvalRequired: r.approvalRequired } : {}),
    ...(typeof r.hubClaimed === "boolean" ? { hubClaimed: r.hubClaimed } : {}),
    ...(typeof r.ownerPublicKey === "string" ? { ownerPublicKey: r.ownerPublicKey } : {}),
    ...(typeof r["ownerPrivateKeyPkcs8"] === "string" ? { ownerPrivateKeyPkcs8: r["ownerPrivateKeyPkcs8"] } : {}),
  };
}

async function generateEd25519OwnerKeyMaterial(): Promise<{
  readonly publicKey: string;
  readonly privateKeyPkcs8: string;
}> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return {
    publicKey: Buffer.from(rawPub).toString("base64url"),
    privateKeyPkcs8: Buffer.from(pkcs8).toString("base64url"),
  };
}

async function signOwnerDpopHeader(
  publicKeyB64: string,
  privateKeyPkcs8B64: string,
  method: string,
  url: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(privateKeyPkcs8B64, "base64url"),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const timestamp = Date.now();
  const nonce = randomBytes(18).toString("base64url");
  const signingInput = new TextEncoder().encode(
    `opencraft-dpop.v1\n${method.toUpperCase()}\n${url}\n${timestamp}\n${nonce}`,
  );
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, signingInput));
  const envelope = JSON.stringify({
    publicKey: publicKeyB64,
    method: method.toUpperCase(),
    url,
    timestamp,
    nonce,
    signature: Buffer.from(sig).toString("base64url"),
  });
  return Buffer.from(envelope, "utf8").toString("base64url");
}

/**
 * Built-in upward Cloud Relay connector for the OpenCraft Desktop Daemon.
 * Enrolls the workstation's `machineIdentity` without any external `curl | bash`
 * agent installation, bridges `mux.v2` streams directly into `AppHostServer`,
 * enforces read-only collaborator scopes, and advertises LAN/Tailscale routes.
 */
export class DaemonRelayEnrollmentService {
  readonly #enrollmentPath: string;
  readonly #fetch: typeof fetch;
  #state: PersistedRelayEnrollment | null = null;
  #pendingAuth: { relayOrigin: string; actorId: string; token: string } | null = null;
  #mux: RelayMuxClientConnection | null = null;
  #advertisedRoutes: readonly DirectRouteCandidate[] = [];
  #latestInvite: DaemonRelayPairingInvite | null = null;
  readonly #knownShareUrls = new Map<string, string>();
  #closed = false;

  constructor(private readonly options: DaemonRelayEnrollmentServiceOptions) {
    this.#enrollmentPath = join(options.dataDirectory, ENROLLMENT_FILE_NAME);
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  status(): DaemonRelayStatus {
    const validInvite =
      this.#latestInvite && this.#latestInvite.expiresAt > Date.now() + 15_000 ? this.#latestInvite : null;
    return {
      enrolled: this.#state !== null,
      connected: this.#mux?.connected() ?? false,
      activeWatchers: this.#mux?.activeWatchers() ?? 0,
      relayOrigin: this.#state?.relayOrigin ?? this.#pendingAuth?.relayOrigin ?? null,
      actorId: this.#state?.actorId ?? this.#pendingAuth?.actorId ?? null,
      machineId: this.#state?.machineId ?? null,
      machineName: this.#state?.displayName ?? this.options.machineIdentity.name,
      approvalRequired: this.#state?.approvalRequired === true,
      hubClaimed: this.#state?.hubClaimed === true,
      advertisedRoutes: this.#advertisedRoutes,
      latestInvite: validInvite,
    };
  }

  async inspectDetailedStatus(options: { readonly ensureInvite?: boolean } = {}): Promise<DaemonRelayStatus> {
    const base = this.status();
    const state = this.#state;
    if (!state) return base;

    let latestInvite = base.latestInvite ?? null;
    if (options.ensureInvite && !latestInvite) {
      try {
        latestInvite = await this.createPairingInvite({ approvalRequired: state.approvalRequired === true });
      } catch {
        // Keep status readable even when temporarily offline.
      }
    }

    let pendingApprovals: readonly DaemonRelayPendingApproval[] = [];
    let activeShares: readonly DaemonRelayActiveShareSummary[] = [];
    let planTier: "free" | "pro" | "team" | undefined;
    let machineLimit: number | undefined;

    try {
      const meUrl = `${state.relayOrigin}/__opencraft_cloud/me`;
      const inspectUrl = `${state.relayOrigin}/m/${state.machineId}/__inspect`;
      const [meRes, inspectRes] = await Promise.all([
        this.#fetch(meUrl, { method: "GET", headers: await this.#authHeaders(state, "GET", meUrl, false) }),
        this.#fetch(inspectUrl, { method: "GET", headers: await this.#authHeaders(state, "GET", inspectUrl, false) }),
      ]);
      if (meRes.ok) {
        const summary = (await meRes.json()) as {
          profile?: { planTier?: "free" | "pro" | "team"; machineLimit?: number };
          shares?: ReadonlyArray<{
            grantId: string;
            machineId: string;
            allowExecution: boolean;
            expiresAt: number;
            createdAt?: number;
            revoked?: boolean;
            revokedAt?: number | null;
          }>;
        };
        planTier = summary.profile?.planTier;
        machineLimit = summary.profile?.machineLimit;
        const now = Date.now();
        activeShares = (summary.shares ?? [])
          .filter(
            (s) =>
              s.machineId === state.machineId &&
              s.revoked !== true &&
              (s.revokedAt === undefined || s.revokedAt === null) &&
              s.expiresAt > now,
          )
          .map((s) => ({
            grantId: s.grantId,
            machineId: s.machineId,
            allowExecution: s.allowExecution,
            expiresAt: s.expiresAt,
            createdAt: s.createdAt ?? now,
            ...(this.#knownShareUrls.has(s.grantId) ? { shareUrl: this.#knownShareUrls.get(s.grantId)! } : {}),
          }));
      }
      if (inspectRes.status === 403 && state.ownerPublicKey && state.ownerPrivateKeyPkcs8) {
        // Machine ownership was claimed to a Personal Hub in the browser! Sync new ownerActorId + sessionToken seamlessly.
        const syncUrl = `${state.relayOrigin}/__opencraft_cloud/machines/sync-owner`;
        const syncRes = await this.#fetch(syncUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencraft-dpop": await signOwnerDpopHeader(
              state.ownerPublicKey,
              state.ownerPrivateKeyPkcs8,
              "POST",
              syncUrl,
            ),
          },
          body: JSON.stringify({ machineId: state.machineId }),
        });
        if (syncRes.ok) {
          const synced = (await syncRes.json()) as { actorId?: string; token?: string; hubClaimed?: boolean };
          if (synced.actorId && synced.token) {
            const updated: PersistedRelayEnrollment = {
              ...state,
              actorId: synced.actorId,
              sessionToken: synced.token,
              hubClaimed: synced.hubClaimed === true,
            };
            this.#state = updated;
            await this.#writePrivateEnrollment(updated).catch(() => undefined);
          }
        }
      } else if (inspectRes.ok) {
        const inspected = (await inspectRes.json()) as {
          ownerActorId?: string | null;
          pendingApprovals?: readonly DaemonRelayPendingApproval[];
        };
        pendingApprovals = inspected.pendingApprovals ?? [];
        if (
          inspected.ownerActorId &&
          inspected.ownerActorId !== state.actorId &&
          state.ownerPublicKey &&
          state.ownerPrivateKeyPkcs8
        ) {
          const syncUrl = `${state.relayOrigin}/__opencraft_cloud/machines/sync-owner`;
          const syncRes = await this.#fetch(syncUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-opencraft-dpop": await signOwnerDpopHeader(
                state.ownerPublicKey,
                state.ownerPrivateKeyPkcs8,
                "POST",
                syncUrl,
              ),
            },
            body: JSON.stringify({ machineId: state.machineId }),
          });
          if (syncRes.ok) {
            const synced = (await syncRes.json()) as { actorId?: string; token?: string; hubClaimed?: boolean };
            if (synced.actorId && synced.token) {
              const updated: PersistedRelayEnrollment = {
                ...state,
                actorId: synced.actorId,
                sessionToken: synced.token,
                hubClaimed: synced.hubClaimed === true,
              };
              this.#state = updated;
              await this.#writePrivateEnrollment(updated).catch(() => undefined);
            }
          }
        }
      }
    } catch {
      // Network unreachable; return local status cleanly.
    }

    return {
      ...this.status(),
      latestInvite,
      pendingApprovals,
      activeShares,
      ...(planTier ? { planTier } : {}),
      ...(machineLimit !== undefined ? { machineLimit } : {}),
    };
  }

  async loadAndResume(): Promise<DaemonRelayStatus> {
    try {
      const content = await readFile(this.#enrollmentPath, "utf8");
      const parsed = validatePersistedEnrollment(JSON.parse(content));
      this.#state = parsed;
      await this.#startMux(parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }
    return this.status();
  }

  async registerAccount(input: {
    readonly relayOrigin: string;
    readonly username: string;
    readonly password: string;
    readonly displayName?: string;
  }): Promise<{ readonly actorId: string; readonly token: string }> {
    const origin = new URL(input.relayOrigin).origin;
    const res = await this.#fetch(`${origin}/__opencraft_cloud/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: input.username,
        password: input.password,
        ...(input.displayName ? { displayName: input.displayName } : {}),
      }),
    });
    const body = (await res.json()) as { actorId?: string; token?: string; error?: string };
    if (!res.ok || !body.actorId || !body.token) {
      throw new Error(body.error ?? `Cloud registration failed (${res.status})`);
    }
    this.#pendingAuth = { relayOrigin: origin, actorId: body.actorId, token: body.token };
    return { actorId: body.actorId, token: body.token };
  }

  async loginAccount(input: {
    readonly relayOrigin: string;
    readonly username: string;
    readonly password: string;
  }): Promise<{ readonly actorId: string; readonly token: string }> {
    const origin = new URL(input.relayOrigin).origin;
    const res = await this.#fetch(`${origin}/__opencraft_cloud/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: input.username, password: input.password }),
    });
    const body = (await res.json()) as { actorId?: string; token?: string; error?: string };
    if (!res.ok || !body.actorId || !body.token) {
      throw new Error(body.error ?? `Cloud login failed (${res.status})`);
    }
    this.#pendingAuth = { relayOrigin: origin, actorId: body.actorId, token: body.token };
    return { actorId: body.actorId, token: body.token };
  }

  /**
   * Zero-signup 1-click sovereign enrollment: generates (or reuses) a local
   * Ed25519 workstation keypair, solves the stateless Hashcash PoW challenge,
   * claims the machine on the Cloud Relay with DPoP proof, and connects `mux.v2`
   * immediately without requiring any email, password, or account registration.
   */
  async enrollSovereignMachine(input: {
    readonly relayOrigin: string;
    readonly displayName?: string;
    readonly approvalRequired?: boolean;
    readonly licenseKey?: string;
  }): Promise<{
    readonly actorId: string;
    readonly machineId: string;
    readonly relayOrigin: string;
    readonly pairingInvite: DaemonRelayPairingInvite;
  }> {
    const relayOrigin = new URL(input.relayOrigin).origin;
    const keys =
      this.#state?.ownerPublicKey && this.#state?.ownerPrivateKeyPkcs8
        ? { publicKey: this.#state.ownerPublicKey, privateKeyPkcs8: this.#state.ownerPrivateKeyPkcs8 }
        : await generateEd25519OwnerKeyMaterial();

    const powRes = await this.#fetch(`${relayOrigin}/__opencraft_cloud/pow/challenge?purpose=enroll`);
    if (!powRes.ok) throw new Error(`Failed to fetch PoW challenge (${powRes.status})`);
    const powChallenge = (await powRes.json()) as { challenge: string; bits: number };
    const powNonce = await solveHashcashPow(powChallenge.challenge, powChallenge.bits);

    const enrollUrl = `${relayOrigin}/__opencraft_cloud/sovereign/enroll`;
    const dpop = await signOwnerDpopHeader(keys.publicKey, keys.privateKeyPkcs8, "POST", enrollUrl);
    const locationHint = inferWorkstationLocationHint();

    const resolvedDisplayName =
      input.displayName?.trim() || this.#state?.displayName || this.options.machineIdentity.name;
    const res = await this.#fetch(enrollUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencraft-pow": `${powChallenge.challenge}:${powNonce}`,
        "x-opencraft-dpop": dpop,
        ...(locationHint ? { "x-opencraft-location-hint": locationHint } : {}),
      },
      body: JSON.stringify({
        machineId: this.options.machineIdentity.machineId,
        displayName: resolvedDisplayName,
        approvalRequired: input.approvalRequired === true,
        ...(input.licenseKey ? { licenseKey: input.licenseKey } : {}),
      }),
    });
    const body = (await res.json()) as {
      actorId?: string;
      token?: string;
      machine?: { machineId: string; ownerActorId: string };
      credential?: string;
      pairing?: { code: string; expiresAt: number; approvalRequired: boolean };
      error?: string;
    };
    if (!res.ok || !body.actorId || !body.token || !body.machine || !body.credential || !body.pairing) {
      throw new Error(body.error ?? `Sovereign enrollment failed (${res.status})`);
    }

    const persisted: PersistedRelayEnrollment = validatePersistedEnrollment({
      schemaVersion: 1,
      relayOrigin,
      actorId: body.actorId,
      machineId: body.machine.machineId,
      credential: body.credential,
      sessionToken: body.token,
      enrolledAt: Date.now(),
      displayName: resolvedDisplayName,
      approvalRequired: body.pairing.approvalRequired,
      ownerPublicKey: keys.publicKey,
      ownerPrivateKeyPkcs8: keys.privateKeyPkcs8,
    });
    await this.#writePrivateEnrollment(persisted);
    this.#state = persisted;
    await this.#startMux(persisted);

    const pairingPayload = {
      relayOrigin,
      machineId: persisted.machineId,
      code: body.pairing.code,
      approvalRequired: body.pairing.approvalRequired,
    };
    const pairingInvite: DaemonRelayPairingInvite = {
      machineId: persisted.machineId,
      relayOrigin,
      code: body.pairing.code,
      pairingUrl: formatPairingUrl(pairingPayload, "opencraft"),
      httpsPairingUrl: formatPairingUrl(pairingPayload, "https"),
      expiresAt: body.pairing.expiresAt,
      approvalRequired: body.pairing.approvalRequired,
    };
    this.#latestInvite = pairingInvite;
    return {
      actorId: persisted.actorId,
      machineId: persisted.machineId,
      relayOrigin,
      pairingInvite,
    };
  }

  async activateLicense(licenseKey: string): Promise<{
    readonly tier: "pro" | "team";
    readonly machineLimit: number;
    readonly maxBlobBytes: number;
  }> {
    const state = this.#requireEnrolled();
    const url = `${state.relayOrigin}/__opencraft_cloud/license/activate`;
    const headers = await this.#authHeaders(state, "POST", url, true);
    const res = await this.#fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ licenseKey }),
    });
    const body = (await res.json()) as {
      tier?: "pro" | "team";
      machineLimit?: number;
      maxBlobBytes?: number;
      error?: string;
    };
    if (!res.ok || !body.tier || typeof body.machineLimit !== "number" || typeof body.maxBlobBytes !== "number") {
      throw new Error(body.error ?? `License activation failed (${res.status})`);
    }
    return { tier: body.tier, machineLimit: body.machineLimit, maxBlobBytes: body.maxBlobBytes };
  }

  async enrollMachine(
    input: {
      readonly relayOrigin?: string;
      readonly sessionToken?: string;
      readonly actorId?: string;
      readonly displayName?: string;
    } = {},
  ): Promise<{
    readonly machineId: string;
    readonly relayOrigin: string;
    readonly pairingInvite: DaemonRelayPairingInvite;
  }> {
    const relayOrigin = new URL(input.relayOrigin ?? this.#pendingAuth?.relayOrigin ?? this.#state?.relayOrigin ?? "")
      .origin;
    const sessionToken = input.sessionToken ?? this.#pendingAuth?.token ?? this.#state?.sessionToken;
    if (!sessionToken) throw new Error("Sign in to the Cloud Relay before enrolling this machine");

    const locationHint = inferWorkstationLocationHint();
    const res = await this.#fetch(`${relayOrigin}/__opencraft_cloud/machines`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sessionToken}`,
        ...(locationHint ? { "x-opencraft-location-hint": locationHint } : {}),
      },
      body: JSON.stringify({
        machineId: this.options.machineIdentity.machineId,
        displayName: input.displayName ?? this.options.machineIdentity.name,
        platform: this.options.machineIdentity.platform,
      }),
    });
    const body = (await res.json()) as {
      machine?: { machineId: string; ownerActorId: string };
      credential?: string;
      pairing?: { code: string; expiresAt: number; approvalRequired: boolean };
      error?: string;
    };
    if (!res.ok || !body.machine || !body.credential || !body.pairing) {
      throw new Error(body.error ?? `Machine enrollment failed (${res.status})`);
    }

    const persisted: PersistedRelayEnrollment = validatePersistedEnrollment({
      schemaVersion: 1,
      relayOrigin,
      actorId: body.machine.ownerActorId,
      machineId: body.machine.machineId,
      credential: body.credential,
      sessionToken,
      enrolledAt: Date.now(),
    });
    await this.#writePrivateEnrollment(persisted);
    this.#state = persisted;
    await this.#startMux(persisted);

    const pairingPayload = {
      relayOrigin,
      machineId: persisted.machineId,
      code: body.pairing.code,
      approvalRequired: body.pairing.approvalRequired,
    };
    return {
      machineId: persisted.machineId,
      relayOrigin,
      pairingInvite: {
        machineId: persisted.machineId,
        relayOrigin,
        code: body.pairing.code,
        pairingUrl: formatPairingUrl(pairingPayload, "opencraft"),
        httpsPairingUrl: formatPairingUrl(pairingPayload, "https"),
        expiresAt: body.pairing.expiresAt,
        approvalRequired: body.pairing.approvalRequired,
      },
    };
  }

  async createPairingInvite(
    options: { readonly approvalRequired?: boolean; readonly ttlMs?: number } = {},
  ): Promise<DaemonRelayPairingInvite> {
    const state = this.#requireEnrolled();
    const url = `${state.relayOrigin}/__opencraft_cloud/machines/${state.machineId}/pair-code`;
    const res = await this.#fetch(url, {
      method: "POST",
      headers: await this.#authHeaders(state, "POST", url, true),
      body: JSON.stringify(options),
    });
    const body = (await res.json()) as {
      code?: string;
      expiresAt?: number;
      approvalRequired?: boolean;
      error?: string;
    };
    if (!res.ok || !body.code || typeof body.expiresAt !== "number") {
      throw new Error(body.error ?? `Failed to issue pairing code (${res.status})`);
    }
    const payload = {
      relayOrigin: state.relayOrigin,
      machineId: state.machineId,
      code: body.code,
      approvalRequired: body.approvalRequired === true,
    };
    if (options.approvalRequired !== undefined && options.approvalRequired !== state.approvalRequired) {
      const updated = { ...state, approvalRequired: options.approvalRequired };
      this.#state = updated;
      await this.#writePrivateEnrollment(updated).catch(() => undefined);
    }
    const invite: DaemonRelayPairingInvite = {
      machineId: state.machineId,
      relayOrigin: state.relayOrigin,
      code: body.code,
      pairingUrl: formatPairingUrl(payload, "opencraft"),
      httpsPairingUrl: formatPairingUrl(payload, "https"),
      expiresAt: body.expiresAt,
      approvalRequired: body.approvalRequired === true,
    };
    this.#latestInvite = invite;
    return invite;
  }

  async approvePendingDevice(shortCode: string): Promise<{ readonly thumbprint: string }> {
    const state = this.#requireEnrolled();
    const url = `${state.relayOrigin}/__opencraft_cloud/machines/${state.machineId}/approve-device`;
    const res = await this.#fetch(url, {
      method: "POST",
      headers: await this.#authHeaders(state, "POST", url, true),
      body: JSON.stringify({ shortCode }),
    });
    const body = (await res.json()) as { thumbprint?: string; error?: string };
    if (!res.ok || !body.thumbprint) {
      throw new Error(body.error ?? `Device approval failed (${res.status})`);
    }
    return { thumbprint: body.thumbprint };
  }

  async createShare(
    options: {
      readonly allowExecution?: boolean;
      readonly threadIds?: readonly string[];
      readonly ttlMs?: number;
    } = {},
  ): Promise<DaemonRelayShareResult> {
    const state = this.#requireEnrolled();
    const url = `${state.relayOrigin}/__opencraft_cloud/shares`;
    const res = await this.#fetch(url, {
      method: "POST",
      headers: await this.#authHeaders(state, "POST", url, true),
      body: JSON.stringify({
        machineId: state.machineId,
        allowExecution: options.allowExecution === true,
        ...(options.threadIds ? { threadIds: options.threadIds } : {}),
        ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
      }),
    });
    const body = (await res.json()) as {
      grant?: { grantId: string; machineId: string; expiresAt: number; allowExecution: boolean };
      shareToken?: string;
      shareUrl?: string;
      error?: string;
    };
    if (!res.ok || !body.grant || !body.shareToken) {
      throw new Error(body.error ?? `Failed to create collaborator share (${res.status})`);
    }
    const shareUrl = body.shareUrl ?? formatShareUrl(state.relayOrigin, body.shareToken);
    this.#knownShareUrls.set(body.grant.grantId, shareUrl);
    return {
      grantId: body.grant.grantId,
      shareToken: body.shareToken,
      shareUrl,
      machineId: body.grant.machineId,
      expiresAt: body.grant.expiresAt,
      allowExecution: body.grant.allowExecution,
    };
  }

  async revokeShare(grantId: string): Promise<void> {
    const state = this.#requireEnrolled();
    const url = `${state.relayOrigin}/__opencraft_cloud/shares/${grantId}/revoke`;
    const res = await this.#fetch(url, {
      method: "POST",
      headers: await this.#authHeaders(state, "POST", url, false),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Share revocation failed (${res.status})`);
    }
    this.#knownShareUrls.delete(grantId);
  }

  async refreshDirectRoutes(overrideOptions?: DirectRouteDiscoveryOptions): Promise<readonly DirectRouteCandidate[]> {
    const discovered = await discoverDirectRoutes(overrideOptions ?? this.options.routeDiscoveryOptions);
    this.#advertisedRoutes = discovered;
    this.#mux?.advertiseRoutes(discovered);
    return discovered;
  }

  async setDeviceName(rawName: string): Promise<DaemonRelayStatus> {
    const trimmed = rawName.trim().slice(0, 128) || this.options.machineIdentity.name;
    if (this.#state) {
      const updated: PersistedRelayEnrollment = { ...this.#state, displayName: trimmed };
      this.#state = updated;
      await this.#writePrivateEnrollment(updated);
    }
    return this.status();
  }

  async createClaimUrl(): Promise<{
    readonly claimUrl: string;
    readonly machineId: string;
    readonly displayName: string;
  }> {
    if (!this.#state) {
      await this.enrollSovereignMachine({ relayOrigin: DEFAULT_CLOUD_RELAY_ORIGIN });
    }
    const state = this.#requireEnrolled();
    if (!state.ownerPublicKey || !state.ownerPrivateKeyPkcs8) {
      throw new Error("Machine is missing sovereign owner key material");
    }
    const key = await crypto.subtle.importKey(
      "pkcs8",
      Buffer.from(state.ownerPrivateKeyPkcs8, "base64url"),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const timestamp = Date.now();
    const nonce = randomBytes(18).toString("base64url");
    const displayName = state.displayName ?? this.options.machineIdentity.name;
    const signingInput = new TextEncoder().encode(
      `opencraft-machine-claim.v1\n${state.relayOrigin}\n${state.machineId}\n${timestamp}\n${nonce}`,
    );
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, signingInput));
    const ticket = {
      v: 1 as const,
      relayOrigin: state.relayOrigin,
      machineId: state.machineId,
      displayName,
      ownerPublicKey: state.ownerPublicKey,
      timestamp,
      nonce,
      signature: Buffer.from(sig).toString("base64url"),
    };
    const ticketB64 = Buffer.from(JSON.stringify(ticket), "utf8").toString("base64url");
    return {
      claimUrl: formatMachineClaimUrl(state.relayOrigin, ticketB64),
      machineId: state.machineId,
      displayName,
    };
  }

  async publishThreadIndex(
    threads: readonly {
      readonly threadId: string;
      readonly title: string;
      readonly status: "idle" | "running" | "waiting" | "failed";
      readonly updatedAt: number;
    }[],
  ): Promise<void> {
    const state = this.#state;
    if (!state) return;
    const url = `${state.relayOrigin}/__opencraft_cloud/machines/${state.machineId}/thread-index`;
    await this.#fetch(url, {
      method: "POST",
      headers: await this.#authHeaders(state, "POST", url, true),
      body: JSON.stringify({ threads: threads.slice(0, 15) }),
    }).catch(() => undefined);
  }

  async unenroll(): Promise<void> {
    const state = this.#state;
    this.#mux?.close();
    this.#mux = null;
    this.#state = null;
    this.#latestInvite = null;
    this.#knownShareUrls.clear();
    await unlink(this.#enrollmentPath).catch(() => undefined);
    if (state) {
      const url = `${state.relayOrigin}/__opencraft_cloud/machines/${state.machineId}/revoke`;
      const headers = await this.#authHeaders(state, "POST", url, false);
      await this.#fetch(url, {
        method: "POST",
        headers,
      }).catch(() => undefined);
    }
  }

  close(): void {
    this.#closed = true;
    this.#mux?.close();
    this.#mux = null;
  }

  async #authHeaders(
    state: PersistedRelayEnrollment,
    method: string,
    url: string,
    jsonBody: boolean,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${state.sessionToken}`,
      ...(jsonBody ? { "content-type": "application/json" } : {}),
    };
    if (state.ownerPublicKey && state.ownerPrivateKeyPkcs8) {
      headers["x-opencraft-dpop"] = await signOwnerDpopHeader(
        state.ownerPublicKey,
        state.ownerPrivateKeyPkcs8,
        method,
        url,
      );
    }
    return headers;
  }

  #requireEnrolled(): PersistedRelayEnrollment {
    if (!this.#state) throw new Error("Daemon is not enrolled with a Cloud Relay");
    return this.#state;
  }

  async #startMux(state: PersistedRelayEnrollment): Promise<void> {
    if (this.#closed) return;
    this.#mux?.close();
    const routes = await discoverDirectRoutes(this.options.routeDiscoveryOptions);
    this.#advertisedRoutes = routes;

    this.#mux = connectRelayMux({
      relay: state.relayOrigin,
      credential: state.credential,
      allowLoopbackInsecure: this.options.allowLoopbackInsecure === true,
      ...(this.options.batchWindowMs !== undefined ? { batchWindowMs: this.options.batchWindowMs } : {}),
      ...(this.options.createMuxSocket ? { createSocket: this.options.createMuxSocket } : {}),
      initialRoutes: routes,
      onOpenWs: (stream, init) => {
        this.#bridgeAppHostStream(stream, init.actorId, init.scope);
      },
      onOpenHttp: (_req, init) => {
        if (init.path === "/health" || init.path.startsWith("/health?")) {
          return {
            status: 200,
            headers: [["content-type", "application/json"]],
            body: JSON.stringify({
              ok: true,
              machineId: this.options.machineIdentity.machineId,
              name: this.options.machineIdentity.name,
              platform: this.options.machineIdentity.platform,
            }),
          };
        }
        return {
          status: 404,
          headers: [["content-type", "application/json"]],
          body: JSON.stringify({ error: "not_found" }),
        };
      },
    });
  }

  #bridgeAppHostStream(stream: RelayMuxWsStream, actorId: string, scope: MuxAccessScope): void {
    const port = new RelayStreamAppHostPort(stream);
    let connection: ReturnType<Pick<AppHostServer, "accept">["accept"]> | null = null;
    stream.onText((text) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        stream.close(1008, "Invalid AppHost JSON");
        return;
      }
      if (connection === null) {
        const hello = parsed as { type?: unknown; rendererId?: unknown } | null;
        const rendererId =
          hello &&
          typeof hello === "object" &&
          hello.type === "hello" &&
          typeof hello.rendererId === "string" &&
          hello.rendererId.length > 0 &&
          hello.rendererId.length <= 256
            ? hello.rendererId
            : `relay-${actorId}-${stream.streamId}`;
        connection = this.options.appHost.accept(port, rendererId);
      }
      if (scope.role === "collaborator" && !scope.allowExecution) {
        const blocked = isMutatingExecutionRequest(parsed);
        if (blocked) {
          stream.sendText(
            JSON.stringify(
              blocked.kind === "app-host"
                ? {
                    type: "response",
                    requestId: blocked.requestId,
                    ok: false,
                    error: {
                      code: "EXECUTION_DENIED",
                      message: "Execution is disabled for this collaborator share",
                      retryable: false,
                    },
                  }
                : {
                    jsonrpc: "2.0",
                    id: blocked.id,
                    error: { code: -32003, message: "Execution is disabled for this collaborator share" },
                  },
            ),
          );
          return;
        }
      }
      port.receive(parsed);
    });
    stream.onClose(() => {
      connection?.close();
      port.close();
    });
  }

  async #writePrivateEnrollment(state: PersistedRelayEnrollment): Promise<void> {
    await mkdir(this.options.dataDirectory, { recursive: true, mode: 0o700 });
    const tempPath = `${this.#enrollmentPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(tempPath, 0o600);
    await rename(tempPath, this.#enrollmentPath);
  }
}
