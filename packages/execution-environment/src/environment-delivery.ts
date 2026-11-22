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

export type EnvironmentLaunchPurpose = "codex" | "pi" | "dsh";
export interface EnvironmentLaunchTarget {
  readonly purpose: EnvironmentLaunchPurpose;
  /** Original authenticated execution-process attachment, NOT a browser label. */
  readonly instance: string;
  readonly key: string;
}
export type EnvironmentLaunchContext = Pick<GitExecutionHandoff, "scope" | "native">;
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
    !["codex", "pi", "dsh"].includes(value.purpose) ||
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
function header(
  issuer: string,
  to: EnvironmentLaunchTarget,
  scope: EnvironmentLaunchContext,
  expires: number,
  nonce: string,
) {
  return Buffer.from(JSON.stringify(["opencraft.environment-launch.v1", issuer, to, scope, expires, nonce]));
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
  constructor(private readonly now = Date.now) {
    const pair = generateKeyPairSync("x25519");
    this.#privateKey = pair.privateKey;
    this.key = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  }
  seal(
    to: EnvironmentLaunchTarget,
    original: EnvironmentLaunchContext,
    read: () => unknown,
    assertCurrent: () => void,
    validUntil = this.now() + 60000,
  ): string {
    let key: Buffer | undefined, clear: Buffer | undefined;
    try {
      if (!this.#privateKey) return unavailable();
      const recipient = target(to),
        admitted = context(original);
      if ((recipient.purpose === "codex") !== (admitted.scope.hostId === "local-codex")) return unavailable();
      const expires = Math.min(this.now() + 60000, validUntil);
      if (!Number.isSafeInteger(expires) || expires <= this.now()) return unavailable();
      assertCurrent();
      const values = variables(read());
      assertCurrent();
      const nonce = randomBytes(12).toString("base64url");
      const aad = header(this.key, recipient, admitted, expires, nonce);
      key = sharedKey(this.#privateKey, recipient.key, nonce, aad);
      const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
      cipher.setAAD(aad);
      clear = Buffer.from(JSON.stringify(values));
      const payload = Buffer.concat([cipher.update(clear), cipher.final(), cipher.getAuthTag()]).toString("base64url");
      assertCurrent();
      return (
        "env1." +
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
  private pending = 0;
  private readonly options: {
    purpose: EnvironmentLaunchPurpose;
    instance: string;
    issuer: string;
    authorize(expected: EnvironmentLaunchContext): Promise<void>;
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
  async open(capsule: string, original: EnvironmentLaunchContext): Promise<ExecutionEnvironmentSnapshot> {
    let key: Buffer | undefined, clear: Buffer | undefined;
    if (!this.#privateKey || this.pending >= 16) return unavailable();
    this.pending++;
    try {
      if (typeof capsule !== "string" || capsule.length > 2 * 1024 ** 2 || !/^env1\.[A-Za-z0-9_-]+$/u.test(capsule))
        return unavailable();
      const bytes = Buffer.from(capsule.slice(5), "base64url");
      if (bytes.toString("base64url") !== capsule.slice(5)) return unavailable();
      const v: unknown = JSON.parse(bytes.toString());
      if (
        !record(v) ||
        Object.keys(v).some((k) => !["issuer", "target", "context", "expires", "nonce", "payload"].includes(k))
      )
        return unavailable();
      const expected = context(original),
        recipient = target(v.target as EnvironmentLaunchTarget),
        admitted = context(v.context as EnvironmentLaunchContext);
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
          this.consumed.has(v.nonce)
        )
          return unavailable();
      };
      current();
      await this.options.authorize(expected);
      current();
      const aad = header(this.options.issuer, recipient, expected, Number(v.expires), String(v.nonce));
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
      return new ExecutionEnvironmentSnapshot(expected.scope, values);
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
  }
}
