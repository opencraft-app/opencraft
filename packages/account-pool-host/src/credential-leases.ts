// Short-lived model credential leases (cloudflare-deployment §2.1,
// workspace-host-split §5). The account owner is the only writer: it grants a
// lease to one engine in one workspace container incarnation, the workspace's
// owner renews it and revokes it when the incarnation changes or the workspace
// stops, and whoever forwards a model request (the Node account Core, an edge
// Worker) redeems the lease token for one provider's credential for the length
// of that request. The holder never sees a provider credential; the forwarder
// sees one only in request memory.
//
// Runtime-neutral: WebCrypto for randomness and digests, a StateDocumentStore
// for the ledger. The ledger holds only SHA-256 digests of lease tokens, never
// a token or a credential.
import type { StateDocumentStore } from "@opencraft/document-storage/state";

/** One engine in one workspace container incarnation. */
export interface CredentialLeaseHolder {
  readonly workspace: string;
  readonly engine: string;
  readonly incarnation: string;
}

/** A granted lease. `token` is returned once, here, and is never stored. */
export interface CredentialLeaseGrant {
  readonly id: string;
  readonly token: string;
  readonly holder: CredentialLeaseHolder;
  readonly expiresAt: number;
}

/** A provider the account owner can forward to, with its credential. */
export interface ProviderCredential {
  readonly providerId: string;
  readonly protocol: string;
  readonly baseUrl: string;
  readonly credential: string;
}

/** What a forwarder receives for one request; it keeps the credential in request memory only. */
export interface CredentialRedemption extends ProviderCredential {
  readonly leaseId: string;
  readonly holder: CredentialLeaseHolder;
  readonly expiresAt: number;
}

/** Resolves a configured provider's credential, or null when the account owner cannot forward to it. */
export interface ProviderCredentialSource {
  resolve(providerId: string): Promise<ProviderCredential | null>;
}

export type CredentialLeaseErrorCode =
  "invalid_lease_request" | "lease_invalid" | "lease_capacity" | "provider_unavailable";

/** A refused lease operation. `lease_invalid` covers unknown, expired and revoked leases alike. */
export class CredentialLeaseError extends Error {
  constructor(readonly code: CredentialLeaseErrorCode) {
    super(code);
    this.name = "CredentialLeaseError";
  }
}

export interface CredentialLeases {
  grant(holder: CredentialLeaseHolder, ttlMs: number): Promise<CredentialLeaseGrant>;
  /** Extends a current lease; an expired or revoked lease cannot be renewed. */
  renew(id: string, ttlMs: number): Promise<{ readonly id: string; readonly expiresAt: number }>;
  /** The provider credential for a current lease's token. */
  redeem(token: string, providerId: string): Promise<CredentialRedemption>;
  /** Whether a lease was current and is now revoked. */
  revoke(id: string): Promise<boolean>;
  /**
   * Revokes a workspace's leases (all of them, one engine's, or every
   * incarnation but `keepIncarnation`, when the container was replaced).
   * Returns how many were revoked.
   */
  revokeHolder(match: {
    readonly workspace: string;
    readonly engine?: string;
    readonly keepIncarnation?: string;
  }): Promise<number>;
}

export const CREDENTIAL_LEASE_DOCUMENT = "credential-leases.json";
export const MIN_LEASE_TTL_MS = 1_000;
export const MAX_LEASE_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_CAPACITY = 4_096;
const TOKEN_PREFIX = "oc_lease_";

interface LeaseRecord {
  tokenHash: string;
  holder: CredentialLeaseHolder;
  issuedAt: number;
  expiresAt: number;
}
interface LeaseDocument {
  schemaVersion: 1;
  leases: Record<string, LeaseRecord>;
}

const TEXT = /^[\x21-\x7e]{1,256}$/u;
const text = (value: unknown): value is string => typeof value === "string" && TEXT.test(value);

function holderOf(value: unknown): CredentialLeaseHolder {
  const holder = value as Partial<CredentialLeaseHolder> | null;
  if (
    !holder ||
    typeof holder !== "object" ||
    Object.keys(holder).some((key) => !["workspace", "engine", "incarnation"].includes(key)) ||
    !text(holder.workspace) ||
    !text(holder.engine) ||
    !text(holder.incarnation)
  )
    throw new CredentialLeaseError("invalid_lease_request");
  return { workspace: holder.workspace, engine: holder.engine, incarnation: holder.incarnation };
}

function ttlOf(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < MIN_LEASE_TTL_MS || (value as number) > MAX_LEASE_TTL_MS)
    throw new CredentialLeaseError("invalid_lease_request");
  return value as number;
}

function parse(value: unknown): LeaseDocument {
  if (value === null) return { schemaVersion: 1, leases: {} };
  const doc = value as Partial<LeaseDocument>;
  if (doc.schemaVersion !== 1 || !doc.leases || typeof doc.leases !== "object" || Array.isArray(doc.leases))
    throw new Error("Credential lease ledger is invalid");
  for (const record of Object.values(doc.leases)) {
    if (
      !record ||
      typeof record.tokenHash !== "string" ||
      !/^[0-9a-f]{64}$/u.test(record.tokenHash) ||
      !Number.isSafeInteger(record.issuedAt) ||
      !Number.isSafeInteger(record.expiresAt)
    )
      throw new Error("Credential lease ledger is invalid");
    holderOf(record.holder);
  }
  return { schemaVersion: 1, leases: { ...doc.leases } };
}

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const digest = async (token: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return TOKEN_PREFIX + btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export interface DocumentCredentialLeaseOptions {
  /** Wall-clock milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Most current leases at once; a grant beyond it is refused. */
  readonly capacity?: number;
}

/**
 * Leases in one state document. Every grant, renewal and revocation is one
 * atomic `update` that also drops expired leases, so the ledger never grows
 * past `capacity` current leases.
 */
export function documentCredentialLeases(
  documents: StateDocumentStore,
  source: ProviderCredentialSource,
  options: DocumentCredentialLeaseOptions = {},
): CredentialLeases {
  const now = options.now ?? Date.now;
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const current = (doc: LeaseDocument, at: number) =>
    Object.fromEntries(Object.entries(doc.leases).filter(([, record]) => record.expiresAt > at));
  return {
    async grant(holder, ttlMs) {
      const valid = holderOf(holder);
      const ttl = ttlOf(ttlMs);
      const token = newToken();
      const tokenHash = await digest(token);
      const id = crypto.randomUUID();
      return documents.update(CREDENTIAL_LEASE_DOCUMENT, (stored) => {
        const at = now();
        const leases = current(parse(stored), at);
        if (Object.keys(leases).length >= capacity) throw new CredentialLeaseError("lease_capacity");
        const record: LeaseRecord = { tokenHash, holder: valid, issuedAt: at, expiresAt: at + ttl };
        return {
          result: { id, token, holder: valid, expiresAt: record.expiresAt },
          next: { schemaVersion: 1, leases: { ...leases, [id]: record } },
        };
      });
    },
    async renew(id, ttlMs) {
      const ttl = ttlOf(ttlMs);
      if (typeof id !== "string") throw new CredentialLeaseError("lease_invalid");
      return documents.update(CREDENTIAL_LEASE_DOCUMENT, (stored) => {
        const at = now();
        const leases = current(parse(stored), at);
        const record = Object.hasOwn(leases, id) ? leases[id] : undefined;
        if (!record) throw new CredentialLeaseError("lease_invalid");
        const expiresAt = at + ttl;
        return {
          result: { id, expiresAt },
          next: { schemaVersion: 1, leases: { ...leases, [id]: { ...record, expiresAt } } },
        };
      });
    },
    async redeem(token, providerId) {
      if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX) || token.length > 128)
        throw new CredentialLeaseError("lease_invalid");
      if (!text(providerId)) throw new CredentialLeaseError("invalid_lease_request");
      const tokenHash = await digest(token);
      const at = now();
      const found = Object.entries(current(parse(await documents.read(CREDENTIAL_LEASE_DOCUMENT)), at)).find(
        ([, record]) => record.tokenHash === tokenHash,
      );
      if (!found) throw new CredentialLeaseError("lease_invalid");
      const [leaseId, record] = found;
      const provider = await source.resolve(providerId);
      if (!provider) throw new CredentialLeaseError("provider_unavailable");
      // A revocation or expiry while the credential was resolved wins.
      const still = parse(await documents.read(CREDENTIAL_LEASE_DOCUMENT)).leases[leaseId];
      if (!still || still.tokenHash !== tokenHash || still.expiresAt <= now())
        throw new CredentialLeaseError("lease_invalid");
      return { ...provider, leaseId, holder: record.holder, expiresAt: still.expiresAt };
    },
    async revoke(id) {
      if (typeof id !== "string") return false;
      return documents.update(CREDENTIAL_LEASE_DOCUMENT, (stored) => {
        const leases = current(parse(stored), now());
        if (!Object.hasOwn(leases, id)) return { result: false };
        delete leases[id];
        return { result: true, next: { schemaVersion: 1, leases } };
      });
    },
    async revokeHolder(match) {
      if (
        !match ||
        !text(match.workspace) ||
        (match.engine !== undefined && !text(match.engine)) ||
        (match.keepIncarnation !== undefined && !text(match.keepIncarnation))
      )
        throw new CredentialLeaseError("invalid_lease_request");
      return documents.update(CREDENTIAL_LEASE_DOCUMENT, (stored) => {
        const leases = current(parse(stored), now());
        let revoked = 0;
        for (const [id, record] of Object.entries(leases)) {
          if (record.holder.workspace !== match.workspace) continue;
          if (match.engine !== undefined && record.holder.engine !== match.engine) continue;
          if (match.keepIncarnation !== undefined && record.holder.incarnation === match.keepIncarnation) continue;
          delete leases[id];
          revoked++;
        }
        return revoked ? { result: revoked, next: { schemaVersion: 1, leases } } : { result: 0 };
      });
    },
  };
}
