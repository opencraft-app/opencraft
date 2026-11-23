import type { EnvironmentLaunchContext } from "@opencraft/execution-environment/environment-delivery";
import type { GitGrantScope } from "@opencraft/execution-environment/personal-git-protocol";
import type { GitExecutionLocator } from "@opencraft/execution-environment/git-execution";

const unavailable = () => Error("environment_launch_unavailable");
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;

/** The Actor/lease handoff for ENV delivery when the identity composition owns
 * the vault and its durable admission read. The composition supplies only that
 * read (`{scope, native}`, no Git authority or capability); core applies the
 * same live checks as its own Git handoff: the Actor is current and admitted,
 * the lease is active for the live native process, and both still hold after
 * every await. A record that does not belong to the locator is refused. */
export function createEnvironmentAdmissionHandoff(options: {
  /** Durable admission of the exact Turn, or `null` for an unowned Turn. */
  admission(locator: GitExecutionLocator): Promise<EnvironmentLaunchContext | null>;
  authorize(scope: GitGrantScope): boolean | Promise<boolean>;
  inspect(handoff: EnvironmentLaunchContext): Promise<boolean>;
  closed(): boolean;
}): (locator: GitExecutionLocator) => Promise<EnvironmentLaunchContext | null> {
  const live = async (handoff: EnvironmentLaunchContext) =>
    !options.closed() &&
    (await options.authorize(handoff.scope)) &&
    !options.closed() &&
    (await options.inspect(handoff)) &&
    !options.closed() &&
    (await options.authorize(handoff.scope)) &&
    !options.closed();
  return async (locator) => {
    if (options.closed()) throw unavailable();
    let handoff: EnvironmentLaunchContext | null;
    try {
      handoff = await options.admission(locator);
    } catch {
      throw unavailable();
    }
    if (options.closed()) throw unavailable();
    if (handoff === null) return null;
    const scope = handoff?.scope,
      native = handoff?.native;
    if (
      !scope ||
      !native ||
      !text(scope.account) ||
      !scope.account.startsWith("actor:human://") ||
      scope.hostId !== locator.hostId ||
      scope.threadId !== locator.threadId ||
      scope.projectId !== null ||
      !text(scope.inputId) ||
      (locator.inputId !== undefined && scope.inputId !== locator.inputId) ||
      !text(native.turnId) ||
      !text(native.incarnation) ||
      (locator.turnId !== undefined && native.turnId !== locator.turnId)
    )
      throw unavailable();
    const frozen: EnvironmentLaunchContext = Object.freeze({
      scope: Object.freeze({ ...scope }),
      native: Object.freeze({ turnId: native.turnId, incarnation: native.incarnation }),
    });
    let current = false;
    try {
      current = await live(frozen);
    } catch {
      // An unreadable check is not a pass.
    }
    if (!current) throw unavailable();
    return frozen;
  };
}
