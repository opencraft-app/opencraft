import type { DuplexTransport } from "@opencraft/appserver-client/transport";
import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import {
  isValidRelayMachineId,
  parsePairingUrl,
  resolveRelayOriginFromWebEntry,
  solveHashcashPow,
  type DirectRouteCandidate,
} from "@opencraft/relay-protocol";
import type {
  HostConnectionJson,
  HostConnectionProfile,
  HostConnectionProfileStore,
  HostConnectionProvider,
} from "@opencraft/workbench-runtime";
import { connectWebSocketAppHost } from "./websocket-app-host";
import {
  dismissCloudRelayPairingState,
  getCloudRelayPairingState,
  setCloudRelayPairingState,
  subscribeCloudRelayPairingState,
  type CloudRelayPairingBannerState,
} from "./cloud-relay-banner-state";

export {
  dismissCloudRelayPairingState,
  getCloudRelayPairingState,
  subscribeCloudRelayPairingState,
  type CloudRelayPairingBannerState,
};

export const CLOUD_RELAY_PROVIDER_ID = "opencraft.cloud-relay" as const;

const DEVICE_KEY_DB_NAME = "opencraft-cloud-relay-keys-v1";
const DEVICE_KEY_STORE = "keys";
const DEVICE_KEY_ID = "primary-ed25519";
export const CLOUD_RELAY_SESSIONS_STORAGE_KEY = "opencraft.cloud-relay.sessions.v1";
export const CLOUD_RELAY_HUB_SESSION_STORAGE_KEY = "opencraft.cloud-relay.hub-session.v1";
const SESSIONS_STORAGE_KEY = CLOUD_RELAY_SESSIONS_STORAGE_KEY;

export interface StoredPersonalHubSession {
  readonly relayOrigin: string;
  readonly actorId: string;
  readonly token: string;
  readonly displayName: string;
  readonly signedInAt: number;
}

export interface PersonalHubOverview {
  readonly actorId: string;
  readonly profile: { readonly displayName?: string };
  readonly passkeys: ReadonlyArray<{ readonly credentialId: string; readonly label: string }>;
  readonly machines: ReadonlyArray<{
    readonly machineId: string;
    readonly displayName: string;
    readonly online: boolean;
    readonly activeWatchers: number;
    readonly directRoutesCount: number;
  }>;
  readonly threadIndex: ReadonlyArray<{
    readonly machineId: string;
    readonly threadId: string;
    readonly title: string;
    readonly status: "idle" | "running" | "waiting" | "failed";
    readonly updatedAt: number;
  }>;
}

export interface ParsedClaimTicketPreview {
  readonly rawTicket: string;
  readonly relayOrigin: string;
  readonly machineId: string;
  readonly displayName: string;
}

export interface StoredCloudRelaySession {
  readonly sessionKey: string;
  readonly relayOrigin: string;
  readonly machineId: string;
  readonly token: string;
  readonly actorId: string;
  readonly displayName: string;
  readonly allowExecution: boolean;
  readonly grantId?: string;
  readonly pairedAt: number;
}

export interface CloudRelayProviderConfig {
  readonly sessionKey: string;
  readonly relayOrigin: string;
  readonly machineId: string;
  readonly targetHostId: "local" | "local-codex";
  readonly grantId?: string;
  readonly allowExecution?: boolean;
}

interface DeviceKeyMaterial {
  readonly publicKeyB64: string;
  readonly privateKey: CryptoKey;
}

let cachedDeviceKeyPromise: Promise<DeviceKeyMaterial> | null = null;
const setPairingBannerState = setCloudRelayPairingState;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function base64UrlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const padded = b64url.replace(/-/gu, "+").replace(/_/gu, "/") + "===".slice((b64url.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function utf8ToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function openDeviceKeyDb(): Promise<IDBDatabase> {
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DEVICE_KEY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DEVICE_KEY_STORE)) {
        db.createObjectStore(DEVICE_KEY_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open device key IndexedDB"));
  });
}

async function loadOrCreateBrowserDeviceKey(): Promise<DeviceKeyMaterial> {
  if (cachedDeviceKeyPromise) return cachedDeviceKeyPromise;
  cachedDeviceKeyPromise = (async () => {
    try {
      const db = await openDeviceKeyDb();
      try {
        const existing = await new Promise<{ publicKeyB64: string; privateKey: CryptoKey } | undefined>(
          (resolve, reject) => {
            const tx = db.transaction(DEVICE_KEY_STORE, "readonly");
            const req = tx.objectStore(DEVICE_KEY_STORE).get(DEVICE_KEY_ID);
            req.onsuccess = () => resolve(req.result as { publicKeyB64: string; privateKey: CryptoKey } | undefined);
            req.onerror = () => reject(req.error);
          },
        );
        if (existing?.publicKeyB64 && existing?.privateKey) {
          return existing;
        }
        const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
        const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
        const record: DeviceKeyMaterial = {
          publicKeyB64: bytesToBase64Url(rawPub),
          privateKey: pair.privateKey,
        };
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(DEVICE_KEY_STORE, "readwrite");
          tx.objectStore(DEVICE_KEY_STORE).put(record, DEVICE_KEY_ID);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        return record;
      } finally {
        db.close();
      }
    } catch {
      const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
      const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
      return { publicKeyB64: bytesToBase64Url(rawPub), privateKey: pair.privateKey };
    }
  })();
  return cachedDeviceKeyPromise;
}

async function signBrowserDpop(method: string, url: string): Promise<string> {
  const key = await loadOrCreateBrowserDeviceKey();
  const timestamp = Date.now();
  const nonce = randomBase64Url(18);
  const input = new TextEncoder().encode(`opencraft-dpop.v1\n${method.toUpperCase()}\n${url}\n${timestamp}\n${nonce}`);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, input));
  return utf8ToBase64Url(
    JSON.stringify({
      publicKey: key.publicKeyB64,
      method: method.toUpperCase(),
      url,
      timestamp,
      nonce,
      signature: bytesToBase64Url(signature),
    }),
  );
}

function readStoredSessions(): Record<string, StoredCloudRelaySession> {
  try {
    const raw = window.localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, StoredCloudRelaySession>;
  } catch {
    return {};
  }
}

function saveStoredSession(session: StoredCloudRelaySession): void {
  const current = readStoredSessions();
  current[session.sessionKey] = session;
  try {
    window.localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Ephemeral session still works in memory when storage is restricted.
  }
  inMemorySessions.set(session.sessionKey, session);
}

const inMemorySessions = new Map<string, StoredCloudRelaySession>();

function getStoredSession(sessionKey: string): StoredCloudRelaySession | null {
  return inMemorySessions.get(sessionKey) ?? readStoredSessions()[sessionKey] ?? null;
}

export function listStoredCloudRelaySessions(): readonly StoredCloudRelaySession[] {
  const merged = new Map<string, StoredCloudRelaySession>();
  for (const [k, v] of Object.entries(readStoredSessions())) {
    if (v && typeof v.machineId === "string") merged.set(k, v);
  }
  for (const [k, v] of inMemorySessions.entries()) {
    merged.set(k, v);
  }
  return [...merged.values()].sort((a, b) => (b.pairedAt ?? 0) - (a.pairedAt ?? 0));
}

export async function disconnectAllCloudRelaySessions(store: HostConnectionProfileStore): Promise<void> {
  clearPersonalHubSession();
  inMemorySessions.clear();
  try {
    window.localStorage.removeItem(SESSIONS_STORAGE_KEY);
    window.sessionStorage.removeItem("opencraft.hub-entered-session");
  } catch {
    // Restricted storage
  }
  const relayProfiles = store
    .getSnapshot()
    .profiles.filter((p) => p.providerId === CLOUD_RELAY_PROVIDER_ID);
  for (const p of relayProfiles) {
    await store.remove(p.hostId).catch(() => undefined);
  }
}

export function isPasskeyUserCancelledOrNotFound(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "NotAllowedError" || name === "AbortError") return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /cancelled|canceled|not allowed|timed out/iu.test(msg);
}

function inferBrowserDeviceLabel(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/iPhone/iu.test(ua)) return "iPhone Browser";
  if (/iPad/iu.test(ua)) return "iPad Browser";
  if (/Android/iu.test(ua)) return "Android Browser";
  if (/Macintosh/iu.test(ua)) return "Mac Browser";
  if (/Windows/iu.test(ua)) return "Windows Browser";
  return "Web Workbench";
}

function parseEntryActionFromUrl(
  rawHref: string,
):
  | { readonly kind: "pair"; readonly relayOrigin: string; readonly machineId: string; readonly code: string }
  | { readonly kind: "share"; readonly relayOrigin: string; readonly shareToken: string }
  | null {
  let parsed: URL;
  try {
    parsed = new URL(rawHref);
  } catch {
    return null;
  }
  if (parsed.protocol === "opencraft:") {
    const pair = parsePairingUrl(rawHref);
    if (pair) {
      return { kind: "pair", relayOrigin: pair.relayOrigin, machineId: pair.machineId, code: pair.code };
    }
    return null;
  }
  const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
  if (pathname === "/pair") {
    const pair = parsePairingUrl(rawHref);
    if (pair) {
      return { kind: "pair", relayOrigin: pair.relayOrigin, machineId: pair.machineId, code: pair.code };
    }
  }
  const shareMatch = /^\/s\/([A-Za-z0-9_-]{38,160})$/u.exec(pathname);
  if (shareMatch) {
    try {
      const relayOrigin = resolveRelayOriginFromWebEntry(parsed.origin, parsed.searchParams.get("relay"));
      return { kind: "share", relayOrigin, shareToken: decodeURIComponent(shareMatch[1]!) };
    } catch {
      return null;
    }
  }
  return null;
}

async function probeDirectRoute(candidate: DirectRouteCandidate, timeoutMs = 300): Promise<string | null> {
  if (
    typeof window !== "undefined" &&
    window.location.protocol === "https:" &&
    !candidate.origin.startsWith("https://")
  ) {
    // Mixed-content rules block ws:// from https:// origins unless Tailscale HTTPS is used.
    return null;
  }
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const healthUrl = new URL("/health", candidate.origin).toString();
    const res = await fetch(healthUrl, { method: "GET", signal: controller.signal, mode: "cors" });
    if (!res.ok) return null;
    const wsUrl = new URL("/apphost", candidate.origin);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    return wsUrl.toString();
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function resolveFastestRelaySocketUrl(session: StoredCloudRelaySession): Promise<string> {
  // 1. Query authorized direct routes + verify session readiness (Happy Eyeballs Offload 2)
  try {
    const routesUrl = new URL(`/m/${session.machineId}/__routes`, session.relayOrigin);
    if (session.grantId) routesUrl.searchParams.set("grant", session.grantId);
    const dpop = await signBrowserDpop("GET", routesUrl.toString());
    const res = await fetch(routesUrl.toString(), {
      method: "GET",
      credentials: "include",
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-opencraft-dpop": dpop,
      },
    });
    if (res.ok) {
      const body = (await res.json()) as { directRoutes?: readonly DirectRouteCandidate[] };
      const candidates = body.directRoutes ?? [];
      if (candidates.length > 0) {
        const directResults = await Promise.all(candidates.map((c) => probeDirectRoute(c, 300)));
        const winner = directResults.find((item): item is string => item !== null);
        if (winner) return winner;
      }
    }
  } catch {
    // Fall back to Cloud Relay mux WebSocket seamlessly.
  }

  const wsBase = new URL(`/m/${session.machineId}/ws`, session.relayOrigin);
  wsBase.protocol = wsBase.protocol === "https:" ? "wss:" : "ws:";
  if (session.grantId) wsBase.searchParams.set("grant", session.grantId);
  const canonicalForDpop = wsBase.toString();
  const dpop = await signBrowserDpop("GET", canonicalForDpop);
  wsBase.searchParams.set("access_token", session.token);
  wsBase.searchParams.set("dpop", dpop);
  return wsBase.toString();
}

function validateProviderConfig(raw: HostConnectionJson): CloudRelayProviderConfig & HostConnectionJson {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Cloud Relay connection config must be an object");
  }
  const record = raw as Record<string, unknown>;
  const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey.trim() : "";
  const relayOrigin = typeof record.relayOrigin === "string" ? new URL(record.relayOrigin).origin : "";
  const machineId = typeof record.machineId === "string" ? record.machineId : "";
  const targetHostId = record.targetHostId === "local-codex" ? "local-codex" : "local";
  if (!sessionKey || !relayOrigin || !isValidRelayMachineId(machineId)) {
    throw new TypeError("Invalid Cloud Relay machine configuration");
  }
  return Object.freeze({
    sessionKey,
    relayOrigin,
    machineId,
    targetHostId,
    ...(typeof record.grantId === "string" && record.grantId ? { grantId: record.grantId } : {}),
    ...(typeof record.allowExecution === "boolean" ? { allowExecution: record.allowExecution } : {}),
  }) as CloudRelayProviderConfig & HostConnectionJson;
}

const sharedAppHosts = new Map<
  string,
  {
    readonly appHost: ReturnType<typeof connectWebSocketAppHost>;
    latestSocketUrl: string;
  }
>();

function acquireSharedCloudRelayAppHost(config: CloudRelayProviderConfig): ReturnType<typeof connectWebSocketAppHost> {
  const existing = sharedAppHosts.get(config.sessionKey);
  if (existing) return existing.appHost;

  const state = {
    latestSocketUrl: "",
    appHost: null as unknown as ReturnType<typeof connectWebSocketAppHost>,
  };
  state.appHost = connectWebSocketAppHost(
    (attemptUrl) => {
      const target = new URL(state.latestSocketUrl);
      const attemptParsed = new URL(attemptUrl);
      const attemptParam = attemptParsed.searchParams.get("attempt");
      const clientParam = attemptParsed.searchParams.get("client");
      if (attemptParam) target.searchParams.set("attempt", attemptParam);
      if (clientParam) target.searchParams.set("client", clientParam);
      return new WebSocket(target.toString());
    },
    {
      beforeConnect: async () => {
        const session = getStoredSession(config.sessionKey);
        if (!session) {
          throw new Error("Cloud Relay session credentials are missing; re-scan the pairing QR code.");
        }
        state.latestSocketUrl = await resolveFastestRelaySocketUrl(session);
      },
    },
  );
  sharedAppHosts.set(config.sessionKey, state);
  return state.appHost;
}

export const CloudRelayHostConnectionProvider: HostConnectionProvider = {
  id: CLOUD_RELAY_PROVIDER_ID,
  label: "OpenCraft Cloud Relay",
  targets: ["web", "electron"],
  configVersion: 1,
  validate: validateProviderConfig,
  createTransport(rawConfig): DuplexTransport {
    const config = validateProviderConfig(rawConfig);
    return acquireSharedCloudRelayAppHost(config).createTransport(config.targetHostId);
  },
};

export const CloudRelayHostConnectionExtension: TrustedExtensionDefinition = {
  manifest: {
    manifestVersion: 1,
    id: "opencraft.cloud-relay-host",
    name: "OpenCraft Cloud Relay Host",
    description: "Connects browser, mobile, and desktop workbenches to remote workstations over OpenCraft Cloud Relay.",
    version: "1.0.0",
    apiVersion: 1,
    trust: "trusted",
    platforms: ["web", "electron"],
    activationEvents: ["onStartupFinished"],
  },
  activate(api) {
    api.internal.register("hostConnectionProvider", CloudRelayHostConnectionProvider);
  },
};

function buildProfilesForSession(session: StoredCloudRelaySession): readonly HostConnectionProfile[] {
  const baseHostId = session.grantId ? `relay-share:${session.grantId}` : `relay:${session.machineId}`;
  const labelSuffix = session.grantId ? (session.allowExecution ? " (Shared)" : " (View Only)") : "";
  const openCraftProfile: HostConnectionProfile = {
    hostId: baseHostId,
    displayName: `${session.displayName}${labelSuffix}`,
    providerId: CLOUD_RELAY_PROVIDER_ID,
    providerConfig: {
      sessionKey: session.sessionKey,
      relayOrigin: session.relayOrigin,
      machineId: session.machineId,
      targetHostId: "local",
      ...(session.grantId ? { grantId: session.grantId } : {}),
      allowExecution: session.allowExecution,
    },
    providerConfigVersion: 1,
    hostKind: "remote-control",
    enabled: true,
    autoConnect: true,
    includeInSidebar: true,
    credentialRef: null,
    transportEndpoint: session.relayOrigin,
    executionLocation: session.displayName,
    workspaceBrowseRoots: [],
    revision: 0,
  };
  const codexProfile: HostConnectionProfile = {
    ...openCraftProfile,
    hostId: `${baseHostId}:codex`,
    displayName: `${session.displayName} · Codex${labelSuffix}`,
    providerConfig: {
      sessionKey: session.sessionKey,
      relayOrigin: session.relayOrigin,
      machineId: session.machineId,
      targetHostId: "local-codex",
      ...(session.grantId ? { grantId: session.grantId } : {}),
      allowExecution: session.allowExecution,
    },
  };
  return [openCraftProfile, codexProfile];
}

export async function provisionCloudRelaySessionProfiles(
  store: HostConnectionProfileStore,
  session: StoredCloudRelaySession,
): Promise<string> {
  const profiles = buildProfilesForSession(session);
  for (const profile of profiles) {
    const existing = store.getSnapshot().profiles.find((p) => p.hostId === profile.hostId);
    await store.put({
      ...profile,
      revision: existing?.revision ?? 0,
    });
  }
  return profiles[0]!.hostId;
}

async function waitUntilDeviceApproved(
  session: StoredCloudRelaySession,
  onApproved: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 2_000));
    if (getCloudRelayPairingState().phase !== "pending_approval") return;
    try {
      const routesUrl = new URL(`/m/${session.machineId}/__routes`, session.relayOrigin).toString();
      const dpop = await signBrowserDpop("GET", routesUrl);
      const res = await fetch(routesUrl, {
        method: "GET",
        credentials: "include",
        headers: {
          authorization: `Bearer ${session.token}`,
          "x-opencraft-dpop": dpop,
        },
      });
      if (res.ok) {
        await onApproved();
        setPairingBannerState({ phase: "connected", machineId: session.machineId, relayOrigin: session.relayOrigin });
        globalThis.setTimeout(() => {
          if (getCloudRelayPairingState().phase === "connected") setPairingBannerState({ phase: "idle" });
        }, 4_000);
        return;
      }
    } catch {
      // Retry until approved or expired.
    }
  }
  setPairingBannerState({
    phase: "error",
    errorMessage: "Device approval timed out. Generate a new QR code on your computer.",
  });
}

export async function redeemCloudRelayUrl(
  rawUrl: string,
  onSessionReady: (session: StoredCloudRelaySession) => Promise<void>,
): Promise<StoredCloudRelaySession | null> {
  const entry = parseEntryActionFromUrl(rawUrl);
  if (!entry) return null;

  if (
    typeof window !== "undefined" &&
    (window.location.pathname.startsWith("/pair") || window.location.pathname.startsWith("/s/"))
  ) {
    try {
      window.history.replaceState(null, "", "/");
    } catch {
      // Non-fatal in restricted history contexts.
    }
  }

  setPairingBannerState({ phase: "redeeming", relayOrigin: entry.relayOrigin });

  try {
    const deviceKey = await loadOrCreateBrowserDeviceKey();
    if (entry.kind === "pair") {
      const res = await fetch(`${entry.relayOrigin}/__opencraft_cloud/pair/redeem`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          machineId: entry.machineId,
          code: entry.code,
          devicePublicKey: deviceKey.publicKeyB64,
          deviceLabel: inferBrowserDeviceLabel(),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        actorId?: string;
        token?: string;
        displayName?: string;
        status?: string;
        shortCode?: string;
        error?: string;
      };
      if (!res.ok || !body.actorId || !body.token) {
        throw new Error(body.error ?? `Pairing failed (${res.status})`);
      }
      const resolvedName =
        typeof body.displayName === "string" && body.displayName.trim()
          ? body.displayName.trim()
          : `Mac (${entry.machineId.slice(0, 6)})`;
      const session: StoredCloudRelaySession = {
        sessionKey: `relay:${entry.machineId}`,
        relayOrigin: entry.relayOrigin,
        machineId: entry.machineId,
        token: body.token,
        actorId: body.actorId,
        displayName: resolvedName,
        allowExecution: true,
        pairedAt: Date.now(),
      };
      saveStoredSession(session);
      if (res.status === 202 || body.status === "pending_approval") {
        setPairingBannerState({
          phase: "pending_approval",
          shortCode: body.shortCode ?? "------",
          machineId: entry.machineId,
          relayOrigin: entry.relayOrigin,
        });
        void waitUntilDeviceApproved(session, () => onSessionReady(session));
        return null;
      }
      await onSessionReady(session);
      setPairingBannerState({ phase: "connected", machineId: entry.machineId, relayOrigin: entry.relayOrigin });
      globalThis.setTimeout(() => {
        if (getCloudRelayPairingState().phase === "connected") setPairingBannerState({ phase: "idle" });
      }, 3_500);
      return session;
    }

    // Collaborator guest share link (`/s/<shareToken>`) — zero signup with stateless Hashcash PoW!
    const powRes = await fetch(`${entry.relayOrigin}/__opencraft_cloud/pow/challenge?purpose=redeem`);
    if (!powRes.ok) throw new Error(`Failed to fetch PoW challenge (${powRes.status})`);
    const powChallenge = (await powRes.json()) as { challenge: string; bits: number };
    const nonce = await solveHashcashPow(powChallenge.challenge, powChallenge.bits);

    const claimRes = await fetch(`${entry.relayOrigin}/__opencraft_cloud/shares/claim-guest`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-opencraft-pow": `${powChallenge.challenge}:${nonce}`,
      },
      body: JSON.stringify({
        shareToken: entry.shareToken,
        guestPublicKey: deviceKey.publicKeyB64,
      }),
    });
    const claimed = (await claimRes.json().catch(() => ({}))) as {
      actorId?: string;
      token?: string;
      machineDisplayName?: string;
      grant?: { grantId: string; machineId: string; allowExecution: boolean; label?: string };
      error?: string;
    };
    if (!claimRes.ok || !claimed.actorId || !claimed.token || !claimed.grant) {
      throw new Error(claimed.error ?? `Share link could not be claimed (${claimRes.status})`);
    }
    const resolvedShareName =
      (typeof claimed.machineDisplayName === "string" && claimed.machineDisplayName.trim()) ||
      (typeof claimed.grant.label === "string" &&
      claimed.grant.label.trim() &&
      claimed.grant.label.trim() !== "Shared Agent"
        ? claimed.grant.label.trim()
        : `Workstation (${claimed.grant.machineId.slice(0, 6)})`);
    const session: StoredCloudRelaySession = {
      sessionKey: `relay-share:${claimed.grant.grantId}`,
      relayOrigin: entry.relayOrigin,
      machineId: claimed.grant.machineId,
      token: claimed.token,
      actorId: claimed.actorId,
      displayName: resolvedShareName,
      allowExecution: claimed.grant.allowExecution === true,
      grantId: claimed.grant.grantId,
      pairedAt: Date.now(),
    };
    saveStoredSession(session);
    await onSessionReady(session);
    setPairingBannerState({ phase: "connected", machineId: session.machineId, relayOrigin: entry.relayOrigin });
    globalThis.setTimeout(() => {
      if (getCloudRelayPairingState().phase === "connected") setPairingBannerState({ phase: "idle" });
    }, 3_500);
    return session;
  } catch (error) {
    setPairingBannerState({
      phase: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function isWebAuthnPasskeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials?.create === "function" &&
    typeof navigator.credentials?.get === "function"
  );
}

export function readStoredPersonalHubSession(): StoredPersonalHubSession | null {
  try {
    const raw = window.localStorage.getItem(CLOUD_RELAY_HUB_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredPersonalHubSession;
    if (!parsed?.relayOrigin || !parsed?.actorId || !parsed?.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredPersonalHubSession(session: StoredPersonalHubSession | null): void {
  try {
    if (!session) {
      window.localStorage.removeItem(CLOUD_RELAY_HUB_SESSION_STORAGE_KEY);
    } else {
      window.localStorage.setItem(CLOUD_RELAY_HUB_SESSION_STORAGE_KEY, JSON.stringify(session));
    }
  } catch {
    /* Restricted storage */
  }
}

export function clearPersonalHubSession(): void {
  writeStoredPersonalHubSession(null);
}

export function parseClaimTicketFromUrl(rawHref: string): ParsedClaimTicketPreview | null {
  try {
    const url = new URL(rawHref);
    const pathname = url.pathname.replace(/\/+$/u, "") || "/";
    if (pathname !== "/claim") return null;
    const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    const rawTicket = hashParams.get("ticket")?.trim() ?? "";
    if (!rawTicket) return null;
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(rawTicket))) as {
      v?: unknown;
      relayOrigin?: unknown;
      machineId?: unknown;
      displayName?: unknown;
    };
    if (
      decoded?.v !== 1 ||
      typeof decoded.relayOrigin !== "string" ||
      typeof decoded.machineId !== "string" ||
      !isValidRelayMachineId(decoded.machineId)
    ) {
      return null;
    }
    return {
      rawTicket,
      relayOrigin: new URL(decoded.relayOrigin).origin,
      machineId: decoded.machineId,
      displayName:
        typeof decoded.displayName === "string" && decoded.displayName.trim()
          ? decoded.displayName.trim()
          : "Workstation",
    };
  } catch {
    return null;
  }
}

export async function createPersonalHubWithPasskey(
  relayOrigin = "https://relay.opencraft.app",
  labelHint?: string,
): Promise<StoredPersonalHubSession> {
  if (!isWebAuthnPasskeySupported()) {
    throw new Error("Passkeys are not supported in this browser");
  }
  const optRes = await fetch(`${relayOrigin}/__opencraft_cloud/passkey/register/options`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ labelHint: labelHint || inferBrowserDeviceLabel() }),
  });
  const opts = (await optRes.json().catch(() => ({}))) as {
    rpId?: string;
    rpName?: string;
    challenge?: string;
    challengeTicket?: string;
    user?: { id: string; name: string; displayName: string };
    error?: string;
  };
  if (!optRes.ok || !opts.rpId || !opts.challenge || !opts.challengeTicket || !opts.user) {
    throw new Error(opts.error ?? `Failed to initialize Passkey (${optRes.status})`);
  }

  const userIdBytes = new TextEncoder().encode(opts.user.id);
  const userIdBuf = new Uint8Array(userIdBytes.byteLength);
  userIdBuf.set(userIdBytes);

  const created = (await navigator.credentials.create({
    publicKey: {
      rp: { id: opts.rpId, name: opts.rpName ?? "OpenCraft" },
      user: {
        id: userIdBuf,
        name: opts.user.name,
        displayName: opts.user.displayName,
      },
      challenge: base64UrlToBytes(opts.challenge),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -8 },
      ],
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "preferred",
      },
      attestation: "none",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;

  if (!created) throw new Error("Passkey creation was cancelled");
  const attResp = created.response as AuthenticatorAttestationResponse;
  const deviceKey = await loadOrCreateBrowserDeviceKey();

  const verifyRes = await fetch(`${relayOrigin}/__opencraft_cloud/passkey/register/verify`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challengeTicket: opts.challengeTicket,
      credentialId: bytesToBase64Url(new Uint8Array(created.rawId)),
      clientDataJSON: bytesToBase64Url(new Uint8Array(attResp.clientDataJSON)),
      attestationObject: bytesToBase64Url(new Uint8Array(attResp.attestationObject)),
      devicePublicKey: deviceKey.publicKeyB64,
      label: labelHint || inferBrowserDeviceLabel(),
    }),
  });
  const verified = (await verifyRes.json().catch(() => ({}))) as {
    actorId?: string;
    displayName?: string;
    token?: string;
    error?: string;
  };
  if (!verifyRes.ok || !verified.actorId || !verified.token) {
    throw new Error(verified.error ?? `Passkey verification failed (${verifyRes.status})`);
  }
  const hubSession: StoredPersonalHubSession = {
    relayOrigin,
    actorId: verified.actorId,
    token: verified.token,
    displayName: verified.displayName ?? "Personal Hub",
    signedInAt: Date.now(),
  };
  writeStoredPersonalHubSession(hubSession);
  return hubSession;
}

export async function signInPersonalHubWithPasskey(
  relayOrigin = "https://relay.opencraft.app",
): Promise<StoredPersonalHubSession> {
  if (!isWebAuthnPasskeySupported()) {
    throw new Error("Passkeys are not supported in this browser");
  }
  const optRes = await fetch(`${relayOrigin}/__opencraft_cloud/passkey/login/options`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const opts = (await optRes.json().catch(() => ({}))) as {
    rpId?: string;
    challenge?: string;
    challengeTicket?: string;
    error?: string;
  };
  if (!optRes.ok || !opts.rpId || !opts.challenge || !opts.challengeTicket) {
    throw new Error(opts.error ?? `Failed to start Passkey sign-in (${optRes.status})`);
  }

  const assertion = (await navigator.credentials.get({
    publicKey: {
      rpId: opts.rpId,
      challenge: base64UrlToBytes(opts.challenge),
      userVerification: "preferred",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new Error("Passkey sign-in was cancelled");
  const assertResp = assertion.response as AuthenticatorAssertionResponse;
  const deviceKey = await loadOrCreateBrowserDeviceKey();

  const verifyRes = await fetch(`${relayOrigin}/__opencraft_cloud/passkey/login/verify`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challengeTicket: opts.challengeTicket,
      credentialId: bytesToBase64Url(new Uint8Array(assertion.rawId)),
      authenticatorData: bytesToBase64Url(new Uint8Array(assertResp.authenticatorData)),
      clientDataJSON: bytesToBase64Url(new Uint8Array(assertResp.clientDataJSON)),
      signature: bytesToBase64Url(new Uint8Array(assertResp.signature)),
      devicePublicKey: deviceKey.publicKeyB64,
    }),
  });
  const verified = (await verifyRes.json().catch(() => ({}))) as {
    actorId?: string;
    displayName?: string;
    token?: string;
    error?: string;
  };
  if (!verifyRes.ok || !verified.actorId || !verified.token) {
    throw new Error(verified.error ?? `Passkey sign-in failed (${verifyRes.status})`);
  }
  const hubSession: StoredPersonalHubSession = {
    relayOrigin,
    actorId: verified.actorId,
    token: verified.token,
    displayName: verified.displayName ?? "Personal Hub",
    signedInAt: Date.now(),
  };
  writeStoredPersonalHubSession(hubSession);
  return hubSession;
}

export async function claimMachineIntoPersonalHub(
  hubSession: StoredPersonalHubSession,
  rawTicketB64: string,
): Promise<{ readonly machineId: string; readonly displayName: string }> {
  const url = `${hubSession.relayOrigin}/__opencraft_cloud/machines/claim`;
  const dpop = await signBrowserDpop("POST", url);
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${hubSession.token}`,
      "x-opencraft-dpop": dpop,
    },
    body: JSON.stringify({
      ticket: rawTicketB64,
      browserLabel: inferBrowserDeviceLabel(),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    machineId?: string;
    displayName?: string;
    error?: string;
  };
  if (!res.ok || !body.machineId) {
    throw new Error(body.error ?? `Machine claim failed (${res.status})`);
  }
  return { machineId: body.machineId, displayName: body.displayName ?? "Workstation" };
}

export async function fetchPersonalHubOverview(
  hubSession: StoredPersonalHubSession,
): Promise<PersonalHubOverview | null> {
  const url = `${hubSession.relayOrigin}/__opencraft_cloud/hub/overview`;
  const dpop = await signBrowserDpop("GET", url);
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: {
      authorization: `Bearer ${hubSession.token}`,
      "x-opencraft-dpop": dpop,
    },
  });
  if (res.status === 401 || res.status === 403) {
    clearPersonalHubSession();
    return null;
  }
  if (!res.ok) throw new Error(`Failed to load Personal Hub (${res.status})`);
  return (await res.json()) as PersonalHubOverview;
}

export async function activateHubMachineInWorkbench(
  store: HostConnectionProfileStore,
  hubSession: StoredPersonalHubSession,
  overview: PersonalHubOverview,
  preferredMachineId?: string,
): Promise<string | null> {
  const onlineMachines = overview.machines.filter((m) => m.online);
  if (onlineMachines.length === 0) return null;
  let chosenHostId: string | null = null;
  for (const machine of overview.machines) {
    const stored: StoredCloudRelaySession = {
      sessionKey: `relay:${machine.machineId}`,
      relayOrigin: hubSession.relayOrigin,
      machineId: machine.machineId,
      token: hubSession.token,
      actorId: hubSession.actorId,
      displayName: machine.displayName,
      allowExecution: true,
      pairedAt: Date.now(),
    };
    saveStoredSession(stored);
    if (machine.online) {
      const hostId = await provisionCloudRelaySessionProfiles(store, stored);
      if (!chosenHostId || machine.machineId === preferredMachineId) {
        chosenHostId = hostId;
      }
    }
  }
  return chosenHostId;
}
