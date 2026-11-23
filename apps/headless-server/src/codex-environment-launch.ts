import type { EnvironmentLaunchTarget } from "@opencraft/execution-environment/environment-delivery";
import type { EnvironmentLaunchReply } from "@opencraft/execution-environment/environment-launch-owner";
import type { EnvironmentLaunchLocator } from "@opencraft/execution-environment/environment-launch-receiver";
import type { CodexEnvironmentLaunchPort } from "@opencraft/opencraft-daemon/codex-engine-adapter";
import type { EnvironmentCreationRecord } from "@opencraft/plugin-assets/server";
import type { EnvironmentCreationRequest } from "@opencraft/plugin-assets/server/storage";
import type { EnvironmentCreationReservationMethods } from "@opencraft/storage-node/server-owner";

/** The core vault owner's record-sealing port (the assets Worker). */
interface VaultOwnerLaunch {
  launch?(target: EnvironmentLaunchTarget, locator: EnvironmentLaunchLocator): Promise<EnvironmentLaunchReply>;
  admitCreation?(request: EnvironmentCreationRequest): Promise<EnvironmentCreationRecord>;
}
type Promised<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never };

/** Codex delivery for the core vault owner: the adapter relays capsules sealed
 * for core's own durable records, and creation reservations are written by the
 * Server owner after the vault owner admitted the Actor epoch and the Project.
 * Nothing here reads values. Absent for a downstream issuer port (it seals Turns
 * only) or without a Codex Core, whose process is the receiver. */
export function coreCodexEnvironmentLaunch(
  port: VaultOwnerLaunch | undefined,
  server: { call: Promised<EnvironmentCreationReservationMethods> } | undefined,
  coreEndpoint: string | undefined,
  instance: string,
): CodexEnvironmentLaunchPort | undefined {
  if (!port?.launch || !port.admitCreation || !server || !coreEndpoint) return undefined;
  const { launch, admitCreation } = port;
  return Object.freeze({
    instance,
    launch: (target: EnvironmentLaunchTarget, locator: EnvironmentLaunchLocator) => launch(target, locator),
    async reserveCreation(request) {
      const record = await admitCreation({ hostId: "local-codex", ...request });
      if (record.operationId !== request.operationId || record.hostId !== "local-codex")
        throw Error("environment_launch_unavailable");
      await server.call.reserveEnvironmentCreation(record);
    },
    async settleCreation(operationId, outcome) {
      await server.call.settleEnvironmentCreation("local-codex", operationId, outcome);
    },
  } satisfies CodexEnvironmentLaunchPort);
}
