import { AccountEnvironment } from "./account-environment.js";
import type { EmployeeGitVaultStore } from "./employee-git-vault-store.js";
import {
  EnvironmentLaunchIssuer,
  type EnvironmentLaunchContext,
  type EnvironmentLaunchTarget,
} from "./environment-delivery.js";
import { environmentProjectId, environmentThreadProject } from "./execution-environment.js";
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
  ) {
    this.#environment = new AccountEnvironment(vault);
  }

  seal(target: EnvironmentLaunchTarget, context: EnvironmentLaunchContext): string {
    try {
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

  close() {
    this.#closed = true;
    this.#issuer.close();
  }
}
