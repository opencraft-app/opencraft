import { join } from "node:path";
import { parseHumanAuthConfiguration } from "@opencraft/access-control/human-auth-configuration";
import { readPrivateJson } from "@opencraft/identity-core/node";
import { loadRelayConnection } from "@opencraft/plugin-relay-connect/server";
import { nodeHubStatePort } from "@opencraft/hub-network/state-port-node";
import { readDaemonMachineIdentity } from "@opencraft/opencraft-daemon/machine-identity";

/**
 * Node adapter of the installation root input port (`./root-inputs.ts`). Each
 * member reads exactly what the Node root read before, in the same format:
 * the private relay connection file, the private Human login configuration
 * file, the Hub's `hub-network-controller.json` and `hub-network.json` (the
 * latter through its Worker-owned writer lock), and `<dataDirectory>/machine-id`.
 * Nothing is read until the root calls a member.
 */
export function nodeRootInputs({
  dataDirectory,
  machineName,
  humanAuthConfig,
  relayConnectFile,
  relayAssertionOptions,
}) {
  return {
    relayConnection: async () =>
      relayConnectFile ? loadRelayConnection(relayConnectFile, relayAssertionOptions) : null,
    // Owner-only regular file, read without following links (`readPrivateJson`), then validated.
    humanAuthConfiguration: async () =>
      humanAuthConfig ? parseHumanAuthConfiguration(await readPrivateJson(humanAuthConfig)) : null,
    hubState: nodeHubStatePort({
      controllerFile: join(dataDirectory, "hub-network-controller.json"),
      stateFile: join(dataDirectory, "hub-network.json"),
    }),
    machineIdentity: () => readDaemonMachineIdentity(dataDirectory, machineName),
  };
}
