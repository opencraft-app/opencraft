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
import type { EnvironmentAccountResolver, EnvironmentAccountSelection } from "./environment-account.js";
import { environmentProjectId, environmentThreadProject } from "./environment-metadata.js";
import type { EnvironmentActorEpoch, GitExecutionHandoff, GitExecutionLocator } from "./git-execution.js";

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
  /** A terminal claim checked against core's own stores. The reservation lives
   * in the terminal owner's journal, which this owner cannot read (another
   * process, possibly another container); the reader returns the admission as
   * core's stores hold it (Actor epoch) with the Project of the Thread binding.
   * The reservation fields are authenticated into the capsule and checked by
   * the terminal owner against its journal. */
  terminal?(claim: EnvironmentTerminalAdmission): EnvironmentRecordAdmission<EnvironmentTerminalAdmission> | null;
}
/** Terminal records from the current Actor epoch and the Thread's Project
 * binding. A threadless terminal gets no Project: the request never selects one. */
export function environmentTerminalRecords(
  vault: Pick<EmployeeGitVaultStore, "readDocument">,
  actor: (account: string) => EnvironmentActorEpoch | null,
): NonNullable<EnvironmentLaunchRecordReaders["terminal"]> {
  return (claim) => {
    const epoch = actor(claim.account);
    if (!epoch || epoch.account !== claim.account) return null;
    return {
      admission: environmentLaunchAdmission({
        ...claim,
        actorGeneration: epoch.actorGeneration,
        membershipRevision: epoch.membershipRevision,
      }) as EnvironmentTerminalAdmission,
      project: claim.threadId === null ? null : environmentThreadProject(vault, claim.hostId, claim.threadId),
    };
  };
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
    /** Trusted composition only. Without it values come from the canonical
     * `actor:<id>` partition; with it, from the partition the installation maps
     * the verified owner to, rechecked with the admission. */
    private readonly options: { accounts?: EnvironmentAccountResolver } = {},
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
      const account = this.#account(context.scope.account, context.scope.actorGeneration);
      const checked = () => {
        current();
        if (account.selection && !account.selection.current()) unavailable();
      };
      return this.#issuer.seal(
        target,
        context,
        () =>
          this.#environment.launchEnvironment(
            account.partition,
            { projectId: project === null ? null : environmentProjectId(hostId, project) },
            {},
          ),
        checked,
      );
    } catch {
      return unavailable();
    }
  }

  /** The vault partition of the admitted owner: canonical unless the
   * installation maps it, and then only as long as the mapping still holds. */
  #account(
    account: string,
    actorGeneration: number | undefined,
  ): { partition: string; selection?: EnvironmentAccountSelection } {
    const accounts = this.options.accounts;
    if (!accounts) return { partition: account };
    const selection = accounts.forActor(account, actorGeneration ?? Number.NaN);
    return { partition: selection.partition, selection };
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
      read = () => reader(claim);
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
    const account = this.#account(claim.account, claim.actorGeneration);
    const checked = () => {
      current();
      if (account.selection && !account.selection.current()) unavailable();
    };
    return this.#issuer.seal(
      target,
      { version: 2, admission: claim },
      () =>
        this.#environment.launchEnvironment(
          account.partition,
          { projectId: project === null ? null : environmentProjectId(claim.hostId, project) },
          {},
        ),
      checked,
    );
  }

  close() {
    this.#closed = true;
    this.#issuer.close();
  }
}
