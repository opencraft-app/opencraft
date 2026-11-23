import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { validateEnvironmentName } from "./account-environment.js";
import { ExecutionEnvironmentSnapshot } from "./execution-snapshot.js";
import { validGitGrantScope } from "./personal-git-protocol.js";
import type { GitExecutionHandoff } from "./git-execution.js";

export type EnvironmentLaunchPurpose = "codex" | "pi" | "dsh" | "acp" | "terminal";
export interface EnvironmentLaunchTarget {
  readonly purpose: EnvironmentLaunchPurpose;
  /** Original authenticated execution-process attachment, NOT a browser label. */
  readonly instance: string;
  readonly key: string;
}
/** v1 context: an admitted native Turn only. Its capsules keep opening. */
export type EnvironmentLaunchContext = Pick<GitExecutionHandoff, "scope" | "native">;

/** Actor epoch a durable admission was granted under. Only Human Actors hold ENV. */
interface EnvironmentLaunchActor {
  readonly account: string;
  readonly actorGeneration: number;
  readonly membershipRevision: number;
  readonly hostId: "local-codex" | "opencraft-server";
}
/** An admitted native Turn: the execution lease and the live native incarnation. */
export interface EnvironmentTurnAdmission extends EnvironmentLaunchActor {
  readonly kind: "turn";
  readonly threadId: string;
  readonly inputId: string;
  readonly executionId: string;
  readonly leaseGeneration: number;
  readonly turnId: string;
  readonly incarnation: string;
}
/** A durable creation reservation (new or forked Thread) recorded before the
 * native creation, keyed by its creation operation. No Thread exists yet. */
export interface EnvironmentCreationAdmission extends EnvironmentLaunchActor {
  readonly kind: "creation";
  readonly operationId: string;
  /** The Thread being forked, or `null` for a new Thread. */
  readonly source: string | null;
  /** The execution owner incarnation holding the reservation. */
  readonly incarnation: string;
}
/** A durable terminal reservation recorded by the terminal owner before spawn. */
export interface EnvironmentTerminalAdmission extends EnvironmentLaunchActor {
  readonly kind: "terminal";
  readonly threadId: string | null;
  readonly resource: string;
  readonly operation: string;
  /** The terminal owner incarnation holding the reservation. */
  readonly incarnation: string;
}
export type EnvironmentLaunchAdmission =
  EnvironmentTurnAdmission | EnvironmentCreationAdmission | EnvironmentTerminalAdmission;
export type EnvironmentLaunchKind = EnvironmentLaunchAdmission["kind"];
/** v2 context. It never names a Project: the vault owner resolves it from its
 * own durable metadata for every kind. */
export interface EnvironmentLaunchContextV2 {
  readonly version: 2;
  readonly admission: EnvironmentLaunchAdmission;
}
export type AnyEnvironmentLaunchContext = EnvironmentLaunchContext | EnvironmentLaunchContextV2;

/** Which admission kinds each execution owner may launch under. A v1 capsule
 * only ever expresses a Turn for the original three purposes. */
const KINDS: Readonly<Record<EnvironmentLaunchPurpose, readonly EnvironmentLaunchKind[]>> = Object.freeze({
  dsh: ["turn"],
  pi: ["turn"],
  acp: ["creation", "turn"],
  codex: ["creation", "turn"],
  terminal: ["terminal"],
});
const V1_PURPOSES: readonly EnvironmentLaunchPurpose[] = ["codex", "pi", "dsh"];
export const environmentLaunchKinds = (purpose: EnvironmentLaunchPurpose): readonly EnvironmentLaunchKind[] =>
  KINDS[purpose] ?? [];
/** Codex launches on the local Codex Host only; DSH, Pi and ACP on the server
 * Host; a terminal may belong to either. */
const hostFits = (purpose: EnvironmentLaunchPurpose, hostId: string) =>
  purpose === "terminal" ? true : (purpose === "codex") === (hostId === "local-codex");
export const isEnvironmentLaunchContextV2 = (value: unknown): value is EnvironmentLaunchContextV2 =>
  !!value && typeof value === "object" && (value as { version?: unknown }).version === 2;
const unavailable = (): never => {
  throw Error("environment_launch_unavailable");
};
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 1024 && !/[\x00-\x1f\x7f]/u.test(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function publicKey(value: unknown) {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(value)) return unavailable();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) return unavailable();
  const key = createPublicKey({ key: bytes, type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "x25519") return unavailable();
  return key;
}
function target(value: EnvironmentLaunchTarget): EnvironmentLaunchTarget {
  if (
    !record(value) ||
    Object.keys(value).some((k) => !["purpose", "instance", "key"].includes(k)) ||
    !Object.hasOwn(KINDS, value.purpose) ||
    !text(value.instance)
  )
    return unavailable();
  publicKey(value.key);
  return Object.freeze({ purpose: value.purpose, instance: value.instance, key: value.key });
}
function context(value: EnvironmentLaunchContext): EnvironmentLaunchContext {
  if (!record(value) || Object.keys(value).some((k) => !["scope", "native"].includes(k))) return unavailable();
  const s = value.scope,
    n = value.native;
  if (
    !record(s) ||
    Object.keys(s).some(
      (k) =>
        ![
          "account",
          "hostId",
          "threadId",
          "inputId",
          "executionId",
          "leaseGeneration",
          "actorGeneration",
          "membershipRevision",
          "projectId",
        ].includes(k),
    ) ||
    !validGitGrantScope(s) ||
    !/^actor:human:\/\/[^/]+\/[^/]+$/u.test(s.account) ||
    ![s.account, s.threadId, s.inputId, s.executionId].every(text) ||
    !(s.projectId === null || text(s.projectId)) ||
    !record(n) ||
    Object.keys(n).some((k) => !["turnId", "incarnation"].includes(k)) ||
    !text(n.turnId) ||
    !text(n.incarnation)
  )
    return unavailable();
  return Object.freeze({
    scope: Object.freeze({
      account: s.account,
      hostId: s.hostId,
      threadId: s.threadId,
      inputId: s.inputId,
      executionId: s.executionId,
      leaseGeneration: s.leaseGeneration,
      actorGeneration: s.actorGeneration,
      membershipRevision: s.membershipRevision,
      projectId: s.projectId,
    }),
    native: Object.freeze({ turnId: n.turnId, incarnation: n.incarnation }),
  });
}
const keys = (v: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(v).length === allowed.length && allowed.every((k) => Object.hasOwn(v, k));
/** Exact keys per kind, normalized in a fixed order so equal admissions encode
 * identically and a field from another kind can never be carried along. */
export function environmentLaunchAdmission(value: unknown): EnvironmentLaunchAdmission {
  if (!record(value)) return unavailable();
  const a = value;
  const actor =
    typeof a.account === "string" &&
    /^actor:human:\/\/[^/]+\/[^/]+$/u.test(a.account) &&
    text(a.account) &&
    Number.isSafeInteger(a.actorGeneration) &&
    (a.actorGeneration as number) > 0 &&
    Number.isSafeInteger(a.membershipRevision) &&
    (a.membershipRevision as number) >= 0 &&
    (a.hostId === "local-codex" || a.hostId === "opencraft-server");
  if (!actor) return unavailable();
  const base = {
    account: a.account as string,
    actorGeneration: a.actorGeneration as number,
    membershipRevision: a.membershipRevision as number,
    hostId: a.hostId as EnvironmentLaunchActor["hostId"],
  };
  const common = ["kind", "account", "actorGeneration", "membershipRevision", "hostId"];
  switch (a.kind) {
    case "turn":
      if (
        !keys(a, [...common, "threadId", "inputId", "executionId", "leaseGeneration", "turnId", "incarnation"]) ||
        ![a.threadId, a.inputId, a.executionId, a.turnId, a.incarnation].every(text) ||
        !Number.isSafeInteger(a.leaseGeneration) ||
        (a.leaseGeneration as number) <= 0
      )
        return unavailable();
      return Object.freeze({
        kind: "turn",
        ...base,
        threadId: a.threadId as string,
        inputId: a.inputId as string,
        executionId: a.executionId as string,
        leaseGeneration: a.leaseGeneration as number,
        turnId: a.turnId as string,
        incarnation: a.incarnation as string,
      });
    case "creation":
      if (
        !keys(a, [...common, "operationId", "source", "incarnation"]) ||
        ![a.operationId, a.incarnation].every(text) ||
        !(a.source === null || text(a.source))
      )
        return unavailable();
      return Object.freeze({
        kind: "creation",
        ...base,
        operationId: a.operationId as string,
        source: a.source as string | null,
        incarnation: a.incarnation as string,
      });
    case "terminal":
      if (
        !keys(a, [...common, "threadId", "resource", "operation", "incarnation"]) ||
        ![a.resource, a.operation, a.incarnation].every(text) ||
        !(a.threadId === null || text(a.threadId))
      )
        return unavailable();
      return Object.freeze({
        kind: "terminal",
        ...base,
        threadId: a.threadId as string | null,
        resource: a.resource as string,
        operation: a.operation as string,
        incarnation: a.incarnation as string,
      });
    default:
      return unavailable();
  }
}
/** Canonical encoding of a v2 admission, for owner-side equality checks. */
export const canonicalEnvironmentLaunchAdmission = (value: unknown) =>
  JSON.stringify(environmentLaunchAdmission(value));
/** Validates a v2 context: exactly `{version: 2, admission}`. */
export function environmentLaunchContextV2(value: unknown): EnvironmentLaunchContextV2 {
  if (!record(value) || !keys(value, ["version", "admission"]) || value.version !== 2) return unavailable();
  return Object.freeze({ version: 2, admission: environmentLaunchAdmission(value.admission) });
}
/** The scope a v2 snapshot reports. It never names a Project. */
function admittedScope(a: EnvironmentLaunchAdmission) {
  const base = { account: a.account, hostId: a.hostId, projectId: null };
  if (a.kind === "turn")
    return {
      ...base,
      threadId: a.threadId,
      inputId: a.inputId,
      executionId: a.executionId,
      leaseGeneration: a.leaseGeneration,
    };
  return { ...base, threadId: a.kind === "terminal" ? a.threadId : null };
}
/** Validates the context and the target together: the purpose must accept the
 * kind and the Host, and a v1 context only serves the original purposes. */
function bound(recipient: EnvironmentLaunchTarget, value: AnyEnvironmentLaunchContext) {
  if (isEnvironmentLaunchContextV2(value)) {
    const v2 = environmentLaunchContextV2(value);
    if (!KINDS[recipient.purpose].includes(v2.admission.kind) || !hostFits(recipient.purpose, v2.admission.hostId))
      return unavailable();
    return { version: 2 as const, context: v2 };
  }
  const v1 = context(value as EnvironmentLaunchContext);
  if (!V1_PURPOSES.includes(recipient.purpose) || !hostFits(recipient.purpose, v1.scope.hostId)) return unavailable();
  return { version: 1 as const, context: v1 };
}
function variables(value: unknown): Record<string, string> {
  if (!record(value) || Object.keys(value).length > 200) return unavailable();
  let size = 0;
  for (const [name, item] of Object.entries(value)) {
    validateEnvironmentName(name);
    if (typeof item !== "string" || item.includes("\0") || Buffer.byteLength(item) > 16384) return unavailable();
    size += Buffer.byteLength(item);
  }
  // Global and project documents each allow 64KiB/100 variables.
  if (size > 131072) return unavailable();
  return value as Record<string, string>;
}
/** Domain-separated associated data. The v1 encoding is unchanged byte for byte;
 * v2 has its own label, so neither version authenticates as the other. */
function header(
  version: 1 | 2,
  issuer: string,
  to: EnvironmentLaunchTarget,
  scope: AnyEnvironmentLaunchContext,
  expires: number,
  nonce: string,
) {
  return Buffer.from(JSON.stringify([`opencraft.environment-launch.v${version}`, issuer, to, scope, expires, nonce]));
}
function sharedKey(privateKey: KeyObject, peer: string, nonce: string, aad: Buffer) {
  const secret = diffieHellman({ privateKey, publicKey: publicKey(peer) });
  try {
    // Node bounds HKDF info to 1024 bytes; legitimate Native IDs can make AAD
    // larger. Hash the full domain-separated header, without truncating IDs.
    return Buffer.from(
      hkdfSync("sha256", secret, Buffer.from(nonce, "base64url"), createHash("sha256").update(aad).digest(), 32),
    );
  } finally {
    secret.fill(0);
  }
}
/** Sole vault owner -> an authenticated execution PROCESS. Main relays only an
 * opaque capsule. Pin issuer+recipient public keys through trusted composition;
 * neither key nor the expected Native context may come from a browser frame.
 * Static issuer/recipient X25519 authenticates both ends; fresh nonce derives a
 * separate AEAD key for every delivery. No vault/master key leaves its owner. */
export class EnvironmentLaunchIssuer {
  #privateKey: KeyObject | undefined;
  readonly key: string;
  /** Without `privateKey` the key lives for this object only. The core vault
   * owner passes the key it keeps sealed in its own vault. */
  constructor(
    private readonly now = Date.now,
    privateKey?: KeyObject,
  ) {
    if (privateKey && (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "x25519"))
      throw Error("environment_launch_unavailable");
    this.#privateKey = privateKey ?? generateKeyPairSync("x25519").privateKey;
    this.key = createPublicKey(this.#privateKey).export({ type: "spki", format: "der" }).toString("base64url");
  }
  seal(
    to: EnvironmentLaunchTarget,
    original: AnyEnvironmentLaunchContext,
    read: () => unknown,
    assertCurrent: () => void,
    validUntil = this.now() + 60000,
  ): string {
    let key: Buffer | undefined, clear: Buffer | undefined;
    try {
      if (!this.#privateKey) return unavailable();
      const recipient = target(to),
        { version, context: admitted } = bound(recipient, original);
      const expires = Math.min(this.now() + 60000, validUntil);
      if (!Number.isSafeInteger(expires) || expires <= this.now()) return unavailable();
      assertCurrent();
      const values = variables(read());
      assertCurrent();
      const nonce = randomBytes(12).toString("base64url");
      const aad = header(version, this.key, recipient, admitted, expires, nonce);
      key = sharedKey(this.#privateKey, recipient.key, nonce, aad);
      const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
      cipher.setAAD(aad);
      clear = Buffer.from(JSON.stringify(values));
      const payload = Buffer.concat([cipher.update(clear), cipher.final(), cipher.getAuthTag()]).toString("base64url");
      assertCurrent();
      return (
        `env${version}.` +
        Buffer.from(
          JSON.stringify({ issuer: this.key, target: recipient, context: admitted, expires, nonce, payload }),
        ).toString("base64url")
      );
    } catch {
      return unavailable();
    } finally {
      key?.fill(0);
      clear?.fill(0);
    }
  }
  close() {
    this.#privateKey = undefined;
  }
}

/** Construct INSIDE the actual execution owner, never in Gateway/Main. Expected
 * scope is supplied by its original Native turn/lease observer, not the capsule.
 * Delivery is one-shot configuration, not a retryable execution receipt. */
export class EnvironmentLaunchReceiver {
  #privateKey: KeyObject | undefined;
  readonly target: EnvironmentLaunchTarget;
  private readonly consumed = new Map<string, number>();
  /** Creation and terminal admissions launch once per receiver: the durable
   * record leaving its admissible state is the lasting fence, this set closes
   * the window before that write. Turns launch once per capsule. */
  private readonly launched = new Set<string>();
  private pending = 0;
  private readonly options: {
    purpose: EnvironmentLaunchPurpose;
    instance: string;
    issuer: string;
    authorize(expected: AnyEnvironmentLaunchContext): Promise<void>;
    now?: () => number;
  };
  constructor(options: EnvironmentLaunchReceiver["options"]) {
    this.options = Object.freeze({ ...options });
    publicKey(options.issuer);
    const pair = generateKeyPairSync("x25519");
    this.#privateKey = pair.privateKey;
    this.target = target({
      purpose: options.purpose,
      instance: options.instance,
      key: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    });
  }
  /** The version is chosen by the owner's expected context, never by the capsule:
   * a v1 context opens only `env1.` capsules and a v2 context only `env2.`. */
  async open(capsule: string, original: AnyEnvironmentLaunchContext): Promise<ExecutionEnvironmentSnapshot> {
    let key: Buffer | undefined, clear: Buffer | undefined, once: string | undefined;
    if (!this.#privateKey || this.pending >= 16) return unavailable();
    this.pending++;
    try {
      const { version, context: expected } = bound(this.target, original);
      if (
        typeof capsule !== "string" ||
        capsule.length > 2 * 1024 ** 2 ||
        !capsule.startsWith(`env${version}.`) ||
        !/^env[12]\.[A-Za-z0-9_-]+$/u.test(capsule)
      )
        return unavailable();
      const bytes = Buffer.from(capsule.slice(5), "base64url");
      if (bytes.toString("base64url") !== capsule.slice(5)) return unavailable();
      const v: unknown = JSON.parse(bytes.toString());
      if (
        !record(v) ||
        Object.keys(v).some((k) => !["issuer", "target", "context", "expires", "nonce", "payload"].includes(k))
      )
        return unavailable();
      const recipient = target(v.target as EnvironmentLaunchTarget),
        admitted =
          version === 2 ? environmentLaunchContextV2(v.context) : context(v.context as EnvironmentLaunchContext);
      if (version === 2 && (expected as EnvironmentLaunchContextV2).admission.kind !== "turn") {
        once = canonicalEnvironmentLaunchAdmission((expected as EnvironmentLaunchContextV2).admission);
        if (this.launched.has(once)) return unavailable();
      }
      const current = () => {
        const now = (this.options.now ?? Date.now)();
        if (
          !this.#privateKey ||
          v.issuer !== this.options.issuer ||
          JSON.stringify(recipient) !== JSON.stringify(this.target) ||
          JSON.stringify(admitted) !== JSON.stringify(expected) ||
          !Number.isSafeInteger(v.expires) ||
          Number(v.expires) <= now ||
          Number(v.expires) > now + 60000 ||
          typeof v.nonce !== "string" ||
          !/^[A-Za-z0-9_-]{16}$/u.test(v.nonce) ||
          this.consumed.has(v.nonce) ||
          (once !== undefined && this.launched.has(once))
        )
          return unavailable();
      };
      current();
      await this.options.authorize(expected);
      current();
      const aad = header(version, this.options.issuer, recipient, expected, Number(v.expires), String(v.nonce));
      key = sharedKey(this.#privateKey!, this.options.issuer, String(v.nonce), aad);
      if (typeof v.payload !== "string" || !/^[A-Za-z0-9_-]+$/u.test(v.payload)) return unavailable();
      const encrypted = Buffer.from(v.payload, "base64url");
      if (encrypted.length < 16 || encrypted.toString("base64url") !== v.payload) return unavailable();
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(String(v.nonce), "base64url"));
      decipher.setAAD(aad);
      decipher.setAuthTag(encrypted.subarray(-16));
      clear = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
      const values = variables(JSON.parse(clear.toString()));
      await this.options.authorize(expected);
      current();
      const now = (this.options.now ?? Date.now)();
      for (const [nonce, expires] of this.consumed) if (expires <= now) this.consumed.delete(nonce);
      if (this.consumed.size >= 4096) return unavailable();
      this.consumed.set(String(v.nonce), Number(v.expires));
      if (once !== undefined) {
        // Bounded memory: the oldest entries are long past their durable state change.
        if (this.launched.size >= 4096) this.launched.delete(this.launched.values().next().value!);
        this.launched.add(once);
      }
      return new ExecutionEnvironmentSnapshot(
        version === 2
          ? admittedScope((expected as EnvironmentLaunchContextV2).admission)
          : (expected as EnvironmentLaunchContext).scope,
        values,
      );
    } catch {
      return unavailable();
    } finally {
      key?.fill(0);
      clear?.fill(0);
      this.pending--;
    }
  }
  close() {
    this.#privateKey = undefined;
    this.consumed.clear();
    this.launched.clear();
  }
}
