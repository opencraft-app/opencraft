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
  type EnvironmentLaunchContextV2,
  type EnvironmentTerminalAdmission,
  type EnvironmentTurnAdmission,
} from "./environment-delivery.js";
import { environmentLaunchLocator } from "./environment-launch-receiver.js";
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
  /** The pending lease of a Codex input, staged before native submission
   * (`turnId: null`); `null` when that pending input has no Human owner. The
   * Project comes from the Thread's binding, as for every Turn. */
  codexTurn?(locator: { hostId: "local-codex"; threadId: string; inputId: string }): EnvironmentTurnAdmission | null;
}
/** What `launch` returns: no Human admission, or the admission it sealed for. */
export type EnvironmentLaunchReply =
  | { readonly context: null }
  | { readonly context: EnvironmentLaunchContextV2; readonly capsule: string };
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
  readonly #issuer = new EnvironmentLaunchIssuer();
  readonly #environment: AccountEnvironment;
  #closed = false;
  /** X25519 public key that execution owners pin through trusted composition. */
  readonly issuer = this.#issuer.key;
  constructor(
    private readonly vault: Pick<EmployeeGitVaultStore, "readDocument" | "writeDocument">,
    /** Durable admission of an active Turn (`null` when it has no Human owner). */
    private readonly admission: (
      input: GitExecutionLocator,
    ) => Omit<GitExecutionHandoff, "authority" | "capability"> | null,
    /** Durable creation and terminal records. A kind without a reader is refused. */
    private readonly records: EnvironmentLaunchRecordReaders = {},
  ) {
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
    if (claim.kind === "turn" && claim.hostId === "local-codex") {
      // A Codex input is staged while its lease is still pending: no native
      // Turn exists yet. Only that pending lease admits it.
      const reader = this.records.codexTurn;
      if (!reader || claim.turnId !== null) return unavailable();
      const { threadId, inputId } = claim;
      read = () => {
        const admitted = reader({ hostId: "local-codex", threadId, inputId });
        return admitted
          ? { admission: admitted, project: environmentThreadProject(this.vault, "local-codex", threadId) }
          : null;
      };
    } else if (claim.kind === "turn") {
      // Turns come from the execution lease, Project from the Thread binding.
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

  /** Reads this owner's own durable record for `locator` and seals for exactly
   * that admission. The caller names a record, never an account or a Project;
   * `{context: null}` means the record exists without a Human owner (a Turn
   * only). A creation or terminal record that is not admissible is refused. */
  launch(target: EnvironmentLaunchTarget, raw: unknown): EnvironmentLaunchReply {
    try {
      if (this.#closed) return unavailable();
      const locator = environmentLaunchLocator(raw);
      let admission: EnvironmentLaunchAdmission | null;
      if (locator.kind === "turn" && locator.hostId === "local-codex") {
        if (!this.records.codexTurn) return unavailable();
        admission = this.records.codexTurn({
          hostId: "local-codex",
          threadId: locator.threadId,
          inputId: locator.inputId,
        });
      } else if (locator.kind === "turn") {
        const admitted = this.admission({ hostId: locator.hostId, threadId: locator.threadId, inputId: locator.inputId });
        admission = admitted ? turnAdmission(admitted) : null;
      } else if (locator.kind === "creation") {
        const reader = this.records.creation;
        if (!reader) return unavailable();
        admission = reader({ hostId: locator.hostId, operationId: locator.operationId })?.admission ?? unavailable();
      } else {
        const reader = this.records.terminal;
        if (!reader) return unavailable();
        admission =
          reader({ hostId: locator.hostId, resource: locator.resource, operation: locator.operation })?.admission ??
          unavailable();
      }
      if (admission === null) return { context: null };
      const context: EnvironmentLaunchContextV2 = { version: 2, admission: environmentLaunchAdmission(admission) };
      return { context, capsule: this.#sealV2(target, context) };
    } catch {
      return unavailable();
    }
  }

  close() {
    this.#closed = true;
    this.#issuer.close();
  }
}
