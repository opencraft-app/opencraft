import { randomUUID, timingSafeEqual } from "node:crypto";
import type { TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import type { ActorSshKeyInput, StoredActorSshKey } from "@opencraft/storage-node/server-actor-ssh-keys";
import { parsePersonalPublicKey, sshPublicKeyFingerprint } from "@opencraft/ssh-http-ingress/keys";

/**
 * Personal SSH keys of Human Actors (docs/architecture/identity/personal-ssh-keys.md).
 *
 * The Server owner Worker commits every change; this network-thread owner keeps
 * the only hot-path state, an in-memory projection of active keys, and never
 * opens SQLite. SSH authentication resolves the offered key's fingerprint
 * against the projection and rechecks the Actor's current state on every call.
 */

/** Async ports of the Server owner Worker (`actorSshKeyMethods`). */
export interface ActorSshKeyStorage {
  actorSshKeysSnapshot(): Promise<StoredActorSshKey[]>;
  addActorSshKey(input: ActorSshKeyInput): Promise<StoredActorSshKey>;
  removeActorSshKey(actorId: string, keyId: string, operator: string): Promise<{ id: string; fingerprint: string }>;
  revokeActorSshKeys(actorId: string, operator: string, reason: string): Promise<string[]>;
}

/** Synchronous reads of existing Actor and membership projections. */
export interface ActorSshKeyAuthority {
  actor(actorId: string): { readonly kind: string; readonly enabled: boolean; readonly generation: number } | null;
  /** Current instance admission; true for every enabled Human when the installation has no membership. */
  admits(actorId: string): boolean;
  /** An explicit, durable membership revocation (not a transient admission refusal). */
  revoked(actorId: string): boolean;
  bindings(actorId: string): readonly { readonly provider: string; readonly subject: string }[];
  administrator(actorId: string): boolean;
  /** Subscribes to committed Actor and membership changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** A key as people and administrators see it. Never the key body. */
export interface ActorSshKeyView {
  readonly id: string;
  readonly name: string;
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly createdAt: number;
  /** Who added it: the person, an administrator, an operator or an import. */
  readonly addedBy: "self" | "administrator" | "operator" | "import";
}

export class ActorSshKeyRefusal extends Error {
  constructor(
    readonly code:
      | "invalid_ssh_key"
      | "invalid_key_name"
      | "key_exists"
      | "key_in_use"
      | "key_limit"
      | "unknown_key"
      | "actor_unavailable"
      | "ssh_keys_unavailable",
  ) {
    super(code);
    this.name = "ActorSshKeyRefusal";
  }
}

const STORED_CODES = new Set(["invalid_ssh_key", "key_exists", "key_in_use", "key_limit", "unknown_key"]);
/** An SSH login carries authority for at most this long; the connection is then closed. */
export const SSH_AUTHORIZATION_TTL_MS = 86_400_000;

/** `operator` strings recorded in the audit. */
export const sshKeyOperator = {
  self: (actorId: string) => "actor:" + actorId,
  administrator: (actorId: string) => "administrator:" + actorId,
  local: "local-operator",
  system: "system",
  import: (label: string) => "import:" + label,
};

function addedBy(row: StoredActorSshKey): ActorSshKeyView["addedBy"] {
  if (row.createdBy === sshKeyOperator.self(row.actorId)) return "self";
  if (row.createdBy.startsWith("administrator:")) return "administrator";
  if (row.createdBy.startsWith("import:")) return "import";
  return "operator";
}

export function validKeyName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && name.length <= 128 && !/[\x00-\x1f\x7f]/u.test(name) ? name : null;
}

export class ActorSshKeys {
  readonly #storage: ActorSshKeyStorage;
  readonly #authority: ActorSshKeyAuthority;
  readonly #now: () => number;
  readonly #byFingerprint = new Map<string, StoredActorSshKey>();
  readonly #byActor = new Map<string, Map<string, StoredActorSshKey>>();
  /** Actors whose keys this owner is revoking; the projection already dropped them. */
  readonly #revoking = new Set<string>();
  readonly #unsubscribe: () => void;
  #failure: Error | null = null;
  #closed = false;

  private constructor(
    storage: ActorSshKeyStorage,
    authority: ActorSshKeyAuthority,
    rows: StoredActorSshKey[],
    now: () => number,
  ) {
    this.#storage = storage;
    this.#authority = authority;
    this.#now = now;
    for (const row of rows) this.#install(row);
    this.#unsubscribe = authority.subscribe(() => this.reconcile());
  }

  /** Loads the active keys once, then revokes those whose Actor was disabled or revoked meanwhile. */
  static async open(
    storage: ActorSshKeyStorage,
    authority: ActorSshKeyAuthority,
    { now = Date.now }: { now?: () => number } = {},
  ): Promise<ActorSshKeys> {
    const keys = new ActorSshKeys(storage, authority, await storage.actorSshKeysSnapshot(), now);
    keys.reconcile();
    return keys;
  }

  get available(): boolean {
    return !this.#failure && !this.#closed;
  }

  /**
   * The owner Worker was lost or a commit failed: the projection may no longer be
   * a prefix of storage, so every key is refused until the process restarts.
   */
  fail(error: Error): void {
    this.#failure ??= error;
    this.#byFingerprint.clear();
    this.#byActor.clear();
  }

  #install(row: StoredActorSshKey): void {
    this.#byFingerprint.set(row.fingerprint, row);
    let keys = this.#byActor.get(row.actorId);
    if (!keys) this.#byActor.set(row.actorId, (keys = new Map()));
    keys.set(row.id, row);
  }

  #drop(row: StoredActorSshKey): void {
    if (this.#byFingerprint.get(row.fingerprint) === row) this.#byFingerprint.delete(row.fingerprint);
    const keys = this.#byActor.get(row.actorId);
    keys?.delete(row.id);
    if (keys?.size === 0) this.#byActor.delete(row.actorId);
  }

  #assertAvailable(): void {
    if (!this.available) throw new ActorSshKeyRefusal("ssh_keys_unavailable");
  }

  /** The Actor may hold and use keys now: an enabled, admitted Human. */
  #currentHuman(actorId: string) {
    const actor = this.#authority.actor(actorId);
    return actor?.kind === "human" && actor.enabled && this.#authority.admits(actorId) ? actor : null;
  }

  #usable(row: StoredActorSshKey): boolean {
    if (!this.available || this.#byActor.get(row.actorId)?.get(row.id) !== row) return false;
    return this.#currentHuman(row.actorId)?.generation === row.actorGeneration;
  }

  /** Active keys of one Actor. */
  list(actorId: string): ActorSshKeyView[] {
    this.#assertAvailable();
    return [...(this.#byActor.get(actorId)?.values() ?? [])]
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((row) => ({
        id: row.id,
        name: row.name,
        algorithm: row.algorithm,
        fingerprint: row.fingerprint,
        createdAt: row.createdAt,
        addedBy: addedBy(row),
      }));
  }

  /**
   * Registers a public key for a current Human. A fingerprint active for any Actor
   * is refused. The owner audits both commits and refusals.
   */
  async add(
    actorId: string,
    input: { name?: unknown; publicKey: unknown },
    operator: string,
    options: { action?: "add" | "import"; createdAt?: number } = {},
  ): Promise<ActorSshKeyView> {
    this.#assertAvailable();
    const parsed = parsePersonalPublicKey(input.publicKey);
    if (!parsed) throw new ActorSshKeyRefusal("invalid_ssh_key");
    const name =
      input.name === undefined || input.name === ""
        ? validKeyName(parsed.comment ?? parsed.algorithm)
        : validKeyName(input.name);
    if (!name) throw new ActorSshKeyRefusal("invalid_key_name");
    const actor = this.#currentHuman(actorId);
    if (!actor) throw new ActorSshKeyRefusal("actor_unavailable");
    let row: StoredActorSshKey;
    try {
      // The owner rechecks duplicates under its writer lock; the projection is not the authority.
      row = await this.#storage.addActorSshKey({
        id: randomUUID(),
        actorId,
        actorGeneration: actor.generation,
        name,
        algorithm: parsed.algorithm,
        publicKey: parsed.publicKey,
        fingerprint: parsed.fingerprint,
        operator,
        ...(options.action ? { action: options.action } : {}),
        ...(options.createdAt !== undefined ? { createdAt: options.createdAt } : {}),
      });
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (typeof code === "string" && STORED_CODES.has(code))
        throw new ActorSshKeyRefusal(code as ActorSshKeyRefusal["code"]);
      this.fail(error instanceof Error ? error : new Error("SSH key storage failed"));
      throw new ActorSshKeyRefusal("ssh_keys_unavailable");
    }
    if (!this.available) throw new ActorSshKeyRefusal("ssh_keys_unavailable");
    this.#install(row);
    // The Actor may have been disabled or revoked while the write was queued: the
    // committed key never becomes usable and is revoked after it, in owner order.
    this.reconcile();
    if (!this.#usable(row) || this.#revoking.has(actorId)) {
      this.#drop(row);
      await this.#storage
        .revokeActorSshKeys(actorId, sshKeyOperator.system, "actor-unavailable")
        .catch((error: unknown) => {
          this.fail(error instanceof Error ? error : new Error("SSH key revocation failed"));
        });
      throw new ActorSshKeyRefusal("actor_unavailable");
    }
    return this.list(actorId).find((key) => key.id === row.id)!;
  }

  /** Revokes one key of the Actor. It stops authenticating, and live SSH sessions end, before the commit. */
  async remove(actorId: string, keyId: string, operator: string): Promise<void> {
    this.#assertAvailable();
    const row = this.#byActor.get(actorId)?.get(keyId);
    if (!row) throw new ActorSshKeyRefusal("unknown_key");
    this.#drop(row);
    try {
      await this.#storage.removeActorSshKey(actorId, keyId, operator);
    } catch (error) {
      if ((error as { code?: unknown })?.code === "unknown_key") throw new ActorSshKeyRefusal("unknown_key");
      this.fail(error instanceof Error ? error : new Error("SSH key storage failed"));
      throw new ActorSshKeyRefusal("ssh_keys_unavailable");
    }
  }

  /**
   * Durably revokes the keys of Actors that were disabled (or whose generation
   * changed) or whose membership was explicitly revoked. Runs at open and after
   * every committed Actor or membership change. A transient admission refusal
   * only refuses logins; it does not revoke.
   */
  reconcile(): void {
    if (!this.available) return;
    for (const [actorId, keys] of [...this.#byActor]) {
      if (this.#revoking.has(actorId)) continue;
      const actor = this.#authority.actor(actorId);
      const reason =
        !actor || actor.kind !== "human"
          ? "actor-missing"
          : !actor.enabled
            ? "actor-disabled"
            : [...keys.values()].some((row) => row.actorGeneration !== actor.generation)
              ? "actor-generation"
              : this.#authority.revoked(actorId)
                ? "membership-revoked"
                : null;
      if (!reason) continue;
      for (const row of [...keys.values()]) this.#drop(row);
      this.#revoking.add(actorId);
      void this.#storage
        .revokeActorSshKeys(actorId, sshKeyOperator.system, reason)
        .catch((error: unknown) => this.fail(error instanceof Error ? error : new Error("SSH key revocation failed")))
        .finally(() => this.#revoking.delete(actorId));
    }
  }

  /**
   * `sshAccess.publicKeys`: the registered key matching the offered blob, if it
   * may sign in now. The SSH user name is not significant; the key identifies the Actor.
   */
  publicKeys(_username: string, offered?: Uint8Array): string[] {
    if (!offered || !this.available) return [];
    const row = this.#byFingerprint.get(sshPublicKeyFingerprint(offered));
    return row && this.#usable(row) ? [row.publicKey] : [];
  }

  /** `sshAccess.authorize`: trusted per-connection authority for a verified signature. */
  authorize(
    _username: string,
    offered: Uint8Array,
  ): { submissionContext: TransportSubmissionContext; isCurrent(): boolean } | null {
    if (!(offered instanceof Uint8Array) || !this.available) return null;
    const row = this.#byFingerprint.get(sshPublicKeyFingerprint(offered));
    if (!row || !this.#usable(row)) return null;
    const expected = Buffer.from(row.publicKey.split(" ")[1] ?? "", "base64");
    if (expected.length !== offered.length || !timingSafeEqual(expected, offered)) return null;
    const actorId = row.actorId;
    const expiresAt = this.#now() + SSH_AUTHORIZATION_TTL_MS;
    const isCurrent = () => this.#now() < expiresAt && this.#usable(row);
    const bindings = this.#authority.bindings(actorId);
    return {
      isCurrent,
      submissionContext: {
        sender: null,
        // A person with one verified identity executes under it, as their Web login would.
        ...(bindings.length === 1
          ? { executionPrincipal: { provider: bindings[0]!.provider, subject: bindings[0]!.subject } }
          : {}),
        actorContext: { actorId, generation: row.actorGeneration, credentialId: null, expiresAt },
        validUntil: expiresAt,
        resourceOwner: {
          id: actorId,
          assertCurrent: () => {
            if (!isCurrent()) throw new Error("SSH key authority revoked");
          },
        },
        tokenUsageAuthority: () =>
          isCurrent() ? { actorId, administrator: this.#authority.administrator(actorId) } : null,
      },
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    this.#byFingerprint.clear();
    this.#byActor.clear();
  }
}

/**
 * The authority of a Headless installation: Actor state from the Actor projection
 * and, when the installation has membership, instance admission from its projection.
 */
export function installationSshKeyAuthority({
  actors,
  access,
}: {
  actors: {
    get(actorId: string): { kind: string; enabled: boolean; generation: number } | null;
    bindings(actorId: string): { provider: string; subject: string }[];
    onAuthorityChanged(listener: () => void): () => void;
  };
  access?: {
    admitsActor(actorId: string): boolean;
    store: {
      actorMembership(actorId: string): { role: string; enabled: boolean } | null;
      membership(binding: { provider: string; subject: string }): { role: string; enabled: boolean } | null;
      onAuthorityChanged(listener: () => void): () => void;
    };
  } | null;
}): ActorSshKeyAuthority {
  const administrator = (actorId: string) => {
    const member = access?.store.actorMembership(actorId);
    return !!access && member?.role === "admin" && member.enabled && access.admitsActor(actorId);
  };
  return {
    actor: (actorId) => actors.get(actorId),
    admits: (actorId) => !access || access.admitsActor(actorId),
    revoked: (actorId) =>
      !!access &&
      (access.store.actorMembership(actorId)?.enabled === false ||
        actors.bindings(actorId).some((binding) => access.store.membership(binding)?.enabled === false)),
    bindings: (actorId) => actors.bindings(actorId),
    administrator,
    subscribe: (listener) => {
      const releases = [
        actors.onAuthorityChanged(listener),
        ...(access ? [access.store.onAuthorityChanged(listener)] : []),
      ];
      return () => {
        for (const release of releases) release();
      };
    },
  };
}

type SshAccess = {
  publicKeys(username: string, offered?: Uint8Array): string[];
  authorize(
    username: string,
    offered: Uint8Array,
  ): { submissionContext: TransportSubmissionContext; isCurrent(): boolean } | null;
};

/**
 * The SSH ingress resolver: an identity composition's own `sshAccess` first, then
 * personal keys. Either may be absent; with neither, scoped SSH logins stay off.
 */
export function composeSshAccess(
  identity: SshAccess | null | undefined,
  personal: SshAccess | null | undefined,
): SshAccess | null {
  if (!identity) return personal ?? null;
  if (!personal) return identity;
  return {
    publicKeys: (username, offered) => [
      ...identity.publicKeys(username, offered),
      ...personal.publicKeys(username, offered),
    ],
    authorize: (username, offered) => identity.authorize(username, offered) ?? personal.authorize(username, offered),
  };
}
