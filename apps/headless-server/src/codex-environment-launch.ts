import type { EnvironmentLaunchTarget } from "@opencraft/execution-environment/environment-delivery";
import type { EnvironmentLaunchReply } from "@opencraft/execution-environment/environment-launch-owner";
import type { EnvironmentLaunchLocator } from "@opencraft/execution-environment/environment-launch-receiver";
import type {
  GitExecutionHandoff,
  GitExecutionLocator,
  GitExecutionReservation,
} from "@opencraft/execution-environment/git-execution";
import {
  createHumanGitExecution,
  type HumanGitExecutionPort,
} from "@opencraft/execution-environment/human-git-execution";
import type { GitGrantScope } from "@opencraft/execution-environment/personal-git-protocol";
import type { CodexEnvironmentLaunchPort } from "@opencraft/opencraft-daemon/codex-engine-adapter";
import type { EnvironmentCreationRecord } from "@opencraft/plugin-assets/server";
import type { EnvironmentCreationRequest } from "@opencraft/plugin-assets/server/storage";
import type { EnvironmentCreationReservationMethods } from "@opencraft/storage-node/server-owner";

/** A vault owner's record-sealing port: the core assets Worker, or an identity
 * composition that owns its vault (`identity.environmentLaunch`). */
interface VaultOwnerLaunch {
  launch?(target: EnvironmentLaunchTarget, locator: EnvironmentLaunchLocator): Promise<EnvironmentLaunchReply>;
  admitCreation?(request: EnvironmentCreationRequest): Promise<EnvironmentCreationRecord>;
}
type Promised<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never };

/** Codex delivery from a vault owner: the adapter relays capsules sealed for
 * core's own durable records, and creation reservations are written by the
 * Server owner after the vault owner admitted the Actor epoch and the Project.
 * Nothing here reads values. Absent for a port without the record readers
 * (`launch`, `admitCreation`), or without a Codex Core, whose process is the
 * receiver. `current` is core's live Actor check, applied before and after the
 * vault owner answers. */
export function coreCodexEnvironmentLaunch(
  port: VaultOwnerLaunch | undefined,
  server: { call: Promised<EnvironmentCreationReservationMethods> } | undefined,
  coreEndpoint: string | undefined,
  instance: string,
  current?: (actor: { actorId: string; actorGeneration: number }) => boolean,
): CodexEnvironmentLaunchPort | undefined {
  if (!port?.launch || !port.admitCreation || !server || !coreEndpoint) return undefined;
  const { launch, admitCreation } = port;
  const live = (actor: { actorId: string; actorGeneration: number }) => {
    if (current && !current(actor)) throw Error("environment_launch_unavailable");
  };
  return Object.freeze({
    instance,
    launch: (target: EnvironmentLaunchTarget, locator: EnvironmentLaunchLocator) => launch(target, locator),
    async reserveCreation(request) {
      live(request);
      const record = await admitCreation({ hostId: "local-codex", ...request });
      // The vault owner admits exactly this request; it never substitutes another.
      if (
        !record ||
        record.operationId !== request.operationId ||
        record.hostId !== "local-codex" ||
        record.actorId !== request.actorId ||
        record.actorGeneration !== request.actorGeneration ||
        record.source !== request.source ||
        record.incarnation !== request.incarnation
      )
        throw Error("environment_launch_unavailable");
      live(request);
      await server.call.reserveEnvironmentCreation(record);
    },
    async settleCreation(operationId, outcome) {
      await server.call.settleEnvironmentCreation("local-codex", operationId, outcome);
    },
  } satisfies CodexEnvironmentLaunchPort);
}

/** A personal Git execution owner: the vault owner's grant handoffs with the
 * same shape as the core assets Worker members (`gitHosts`, `gitAuthority`,
 * `executionGitGrant`, `executionGitReservation`). Only sealed grants cross;
 * no credential or vault key does. */
export interface PersonalGitExecutionOwner {
  readonly hosts: readonly string[];
  readonly authority: string;
  grant(locator: GitExecutionLocator): Promise<GitExecutionHandoff | null>;
  reservation(locator: GitExecutionLocator): Promise<GitExecutionReservation | null>;
}

/** The Codex adapter's Git execution owner from a vault owner's grant handoffs.
 * The adapter attests its own native process (`inspect`); core checks the Actor
 * around every await (`authorize`), and the shared execution owner rechecks the
 * grant before each command. */
export function codexExecutionGit(
  owner: PersonalGitExecutionOwner,
  options: {
    directory: string;
    runtimeDirectory: string;
    workerFile: string;
    authorize(scope: GitGrantScope): boolean | Promise<boolean>;
  },
): (native: {
  inspect(value: GitExecutionHandoff): Promise<boolean>;
  inspectReservation(value: GitExecutionReservation): Promise<boolean>;
}) => Pick<HumanGitExecutionPort, "reserve" | "prepare" | "close"> {
  return (native) =>
    createHumanGitExecution({
      directory: options.directory,
      runtimeDirectory: options.runtimeDirectory,
      workerFile: options.workerFile,
      hosts: owner.hosts,
      authority: owner.authority,
      grant: (locator) => owner.grant(locator),
      inspect: native.inspect,
      reservation: { grant: (locator) => owner.reservation(locator), inspect: native.inspectReservation },
      authorize: options.authorize,
    });
}
