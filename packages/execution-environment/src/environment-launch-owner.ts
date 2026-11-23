import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { AccountEnvironment } from "./account-environment.js";
import type { EmployeeGitVaultStore } from "./employee-git-vault-store.js";
import {
  EnvironmentLaunchIssuer,
  canonicalEnvironmentLaunchAdmission,
  environmentLaunchAdmission,
  environmentLaunchContextV2,
  isEnvironmentLaunchContextV2,
  type AnyEnvironmentLaunchContext,
  type EnvironmentCreationAdmission,
  type EnvironmentLaunchAdmission,
  type EnvironmentLaunchContext,
  type EnvironmentLaunchTarget,
  type EnvironmentTerminalAdmission,
} from "./environment-delivery.js";
import { environmentProjectId, environmentThreadProject } from "./environment-metadata.js";
import type { GitExecutionHandoff, GitExecutionLocator } from "./git-execution.js";

const unavailable = (): never => {
  throw Error("environment_launch_unavailable");
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const canonical = (c: EnvironmentLaunchContext) =>
  JSON.stringify([
    c.scope.account,
    c.scope.hostId,
    c.scope.threadId,
    c.scope.inputId,
    c.scope.executionId,
    c.scope.leaseGeneration,
    c.scope.actorGeneration,
    c.scope.membershipRevision,
    c.scope.projectId,
    c.native.turnId,
    c.native.incarnation,
  ]);

/** A durable creation or terminal admission as the vault owner reads it from
 * core's own record, with the Host-local Project that record binds (`null` for
 * none). The record, never the request or relayed context, selects the Project. */
export interface EnvironmentRecordAdmission<A extends EnvironmentLaunchAdmission> {
  readonly admission: A;
  readonly project: string | null;
}
export interface EnvironmentLaunchRecordReaders {
  /** Pending creation reservation by Host and creation operation. */
  creation?(locator: {
    hostId: EnvironmentCreationAdmission["hostId"];
    operationId: string;
  }): EnvironmentRecordAdmission<EnvironmentCreationAdmission> | null;
  /** Unlaunched terminal reservation by Host, resource and operation. */
  terminal?(locator: {
    hostId: EnvironmentTerminalAdmission["hostId"];
    resource: string;
    operation: string;
  }): EnvironmentRecordAdmission<EnvironmentTerminalAdmission> | null;
}
/** v2 Turn admission from a handoff-shaped durable admission. */
const turnAdmission = (a: Omit<GitExecutionHandoff, "authority" | "capability">) =>
  environmentLaunchAdmission({
    kind: "turn",
    account: a.scope.account,
    actorGeneration: a.scope.actorGeneration,
    membershipRevision: a.scope.membershipRevision,
    hostId: a.scope.hostId,
    threadId: a.scope.threadId,
    inputId: a.scope.inputId,
    executionId: a.scope.executionId,
    leaseGeneration: a.scope.leaseGeneration,
    turnId: a.native.turnId,
    incarnation: a.native.incarnation,
  });

/** Core issuer inside the sole vault owner (a Worker). It seals the values of an
 * admitted Turn for one execution process; nothing it returns contains values.
 * The caller's context is only a claim: it must equal the durable admission the
 * owner reads itself, and the Project comes from the Thread's own binding. */
export class EnvironmentLaunchOwner {
  readonly #issuer: EnvironmentLaunchIssuer;
  readonly #environment: AccountEnvironment;
  #closed = false;
  /** X25519 public key that execution owners pin through trusted composition. */
  readonly issuer: string;
  constructor(
    private readonly vault: Pick<EmployeeGitVaultStore, "readDocument" | "writeDocument">,
    /** Durable admission of an active Turn (`null` when it has no Human owner). */
    private readonly admission: (
      input: GitExecutionLocator,
    ) => Omit<GitExecutionHandoff, "authority" | "capability"> | null,
    /** Durable creation and terminal records. A kind without a reader is refused. */
    private readonly records: EnvironmentLaunchRecordReaders = {},
    /** The issuer key sealed in this vault (`sealedEnvironmentIssuerKey`).
     * Without it the key lives for this owner only. */
    privateKey?: KeyObject,
  ) {
    this.#issuer = new EnvironmentLaunchIssuer(Date.now, privateKey);
    this.issuer = this.#issuer.key;
    this.#environment = new AccountEnvironment(vault);
  }

  seal(target: EnvironmentLaunchTarget, context: AnyEnvironmentLaunchContext): string {
    try {
      if (isEnvironmentLaunchContextV2(context)) return this.#sealV2(target, context);
      if (this.#closed || !record(context) || !record(context.scope) || !record(context.native)) return unavailable();
      const { hostId, threadId, inputId, projectId } = context.scope;
      // Codex launches before a Turn exists; it is not served by this issuer yet.
      // A handoff never names a Project: selecting one is a wrong-project attempt.
      if (hostId !== "opencraft-server" || projectId !== null || typeof threadId !== "string") return unavailable();
      const locator: GitExecutionLocator = { hostId, threadId, inputId };
      const project = environmentThreadProject(this.vault, hostId, threadId);
      const current = () => {
        const admitted = this.admission(locator);
        if (
          this.#closed ||
          !admitted ||
          admitted.scope.projectId !== null ||
          canonical(admitted) !== canonical(context) ||
          environmentThreadProject(this.vault, hostId, threadId) !== project
        )
          unavailable();
      };
      current();
      return this.#issuer.seal(
        target,
        context,
        () =>
          this.#environment.launchEnvironment(
            context.scope.account,
            { projectId: project === null ? null : environmentProjectId(hostId, project) },
            {},
          ),
        current,
      );
    } catch {
      return unavailable();
    }
  }

  /** One admission check per kind; each compares the claim with the durable
   * record this owner reads itself, rereads it around the value read, and takes
   * the Project only from durable metadata. */
  #sealV2(target: EnvironmentLaunchTarget, raw: unknown): string {
    if (this.#closed) return unavailable();
    const claim = environmentLaunchContextV2(raw).admission,
      expected = canonicalEnvironmentLaunchAdmission(claim);
    let read: () => { admission: EnvironmentLaunchAdmission; project: string | null } | null;
    if (claim.kind === "turn") {
      // Turns come from the execution lease, Project from the Thread binding.
      // Codex Turns are not served by this issuer yet.
      if (claim.hostId !== "opencraft-server") return unavailable();
      const { hostId, threadId, inputId } = claim;
      read = () => {
        const admitted = this.admission({ hostId, threadId, inputId });
        if (!admitted || admitted.scope.projectId !== null) return null;
        return { admission: turnAdmission(admitted), project: environmentThreadProject(this.vault, hostId, threadId) };
      };
    } else if (claim.kind === "creation") {
      const reader = this.records.creation;
      if (!reader) return unavailable();
      const locator = { hostId: claim.hostId, operationId: claim.operationId };
      read = () => reader(locator);
    } else {
      const reader = this.records.terminal;
      if (!reader) return unavailable();
      const locator = { hostId: claim.hostId, resource: claim.resource, operation: claim.operation };
      read = () => reader(locator);
    }
    const first = read();
    if (!first || (first.project !== null && (typeof first.project !== "string" || !first.project)))
      return unavailable();
    const project = first.project;
    const current = () => {
      const now = read();
      if (
        this.#closed ||
        !now ||
        now.project !== project ||
        canonicalEnvironmentLaunchAdmission(now.admission) !== expected
      )
        unavailable();
    };
    current();
    return this.#issuer.seal(
      target,
      { version: 2, admission: claim },
      () =>
        this.#environment.launchEnvironment(
          claim.account,
          { projectId: project === null ? null : environmentProjectId(claim.hostId, project) },
          {},
        ),
      current,
    );
  }

  close() {
    this.#closed = true;
    this.#issuer.close();
  }
}

const ISSUER_ACCOUNT = "platform:environment";
const ISSUER_DOCUMENT = "document-environment-issuer";
const GENERATION = /^[A-Za-z0-9._-]{1,64}$/u;

/** The issuer's X25519 private key, sealed at rest in the vault under the
 * vault's own key and AAD. It changes only by explicit rotation: a configured
 * `generation` that differs from the stored one replaces it; no generation
 * keeps the stored key. A stored document that is not a valid key is refused
 * instead of silently rotated. Runs inside the sole vault owner. */
export function sealedEnvironmentIssuerKey(
  vault: Pick<EmployeeGitVaultStore, "readDocument" | "writeDocument">,
  generation: string | null = null,
): KeyObject {
  if (generation !== null && !GENERATION.test(generation)) return unavailable();
  const { revision, document } = vault.readDocument(ISSUER_ACCOUNT, ISSUER_DOCUMENT);
  if (document !== null) {
    if (
      !record(document) ||
      document.version !== 1 ||
      Object.keys(document).length !== 3 ||
      (document.generation !== null && (typeof document.generation !== "string" || !GENERATION.test(document.generation))) ||
      typeof document.privateKey !== "string"
    )
      return unavailable();
    if (generation === null || document.generation === generation) {
      const der = Buffer.from(document.privateKey, "base64url");
      let key: KeyObject | undefined;
      try {
        key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
      } catch {
        key = undefined;
      } finally {
        der.fill(0);
      }
      return key?.asymmetricKeyType === "x25519" ? key : unavailable();
    }
  }
  const { privateKey } = generateKeyPairSync("x25519");
  const der = privateKey.export({ type: "pkcs8", format: "der" });
  try {
    // A concurrent writer is impossible (one vault owner); a revision conflict
    // still refuses rather than overwriting.
    vault.writeDocument(ISSUER_ACCOUNT, ISSUER_DOCUMENT, revision, {
      version: 1,
      generation,
      privateKey: der.toString("base64url"),
    });
  } finally {
    der.fill(0);
  }
  return privateKey;
}

/** Publish the issuer PUBLIC key for local supervisors that pin it into
 * independent execution owners: a private (0600) file written atomically, and
 * only when its content changes, so a supervisor watching it relaunches its
 * owners only on a new key. Never carries the private key. */
export async function publishEnvironmentIssuer(path: string, issuer: string): Promise<void> {
  if (!isAbsolute(path) || !/^[A-Za-z0-9_-]{1,256}$/u.test(issuer)) return unavailable();
  const content = JSON.stringify({ schemaVersion: 1, issuer }) + "\n";
  try {
    const info = await lstat(path);
    if (info.isFile() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0 && (await readFile(path, "utf8")) === content)
      return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
