// Root input port of the installation (runtime-neutral; gateway-split §4.1.1
// "根输入端口"). Everything the installation reads at startup that a Node root
// used to read from its data directory or configuration files comes through
// this port as an already-parsed value, or (for the Hub) as a state port:
// the Node adapter (`./root-inputs-node.mjs`) reads the same files in the same
// formats; `documentRootInputs` keeps the persistent parts in one
// StateDocumentStore owned by a single writer and receives configuration as
// values. The root calls each member at its original moment in startup.
import type { RuntimeMachineIdentity } from "@opencraft/appserver-protocol";
import type { StateDocumentStore } from "@opencraft/document-storage/state";
import {
  parseHumanAuthConfiguration,
  type HumanAuthConfiguration,
} from "@opencraft/access-control/human-auth-configuration";
import type { IdentityProvider } from "@opencraft/identity-core/node";
import type { HubStatePort } from "@opencraft/hub-network/state-port";
import { documentHubStatePort } from "@opencraft/hub-network/state-port-document";
import { readDocumentMachineIdentity } from "@opencraft/local-agent-host/machine-identity-document";

/** A configured outbound relay connection: its provider verifies relayed people; the options dial out. */
export interface RelayConnection {
  readonly provider: IdentityProvider;
  readonly options: {
    readonly relay: string;
    readonly credential: string;
    readonly targetPort: number | undefined;
    readonly allowLoopbackInsecure: boolean;
    readonly ca: string | undefined;
  };
}

export interface InstallationRootInputs {
  /** The outbound relay connection, or null. Dialing out is Node-only (§4.2); other roots answer null. */
  relayConnection(): Promise<RelayConnection | null>;
  /** The Human login configuration, validated; null when the deployment has no Human login. */
  humanAuthConfiguration(): Promise<HumanAuthConfiguration | null>;
  /** The Hub controller's persistent state: a remote controller, or the node's state and its writer. */
  readonly hubState: HubStatePort;
  /** The deployment's machine identity; its ID is created on the first read and never changes. */
  machineIdentity(): Promise<RuntimeMachineIdentity>;
}

export interface DocumentRootInputsOptions {
  /** The single writer's documents: the Hub node state and the machine ID live here. */
  readonly documents: StateDocumentStore;
  /** The Human login configuration as the operator installed it (unparsed), or absent. */
  readonly humanAuthConfiguration?: unknown;
  /** A remote Hub controller configuration as the operator installed it (unparsed), or absent. */
  readonly hubController?: unknown;
  readonly machine: {
    readonly name?: string;
    readonly defaultName: string;
    readonly platform: RuntimeMachineIdentity["platform"];
  };
}

/** Root inputs for an owner whose persistent state is a StateDocumentStore; nothing here touches a file system. */
export function documentRootInputs(options: DocumentRootInputsOptions): InstallationRootInputs {
  return {
    relayConnection: async () => null,
    humanAuthConfiguration: async () =>
      options.humanAuthConfiguration === undefined ? null : parseHumanAuthConfiguration(options.humanAuthConfiguration),
    hubState: documentHubStatePort(options.documents, { controller: options.hubController }),
    machineIdentity: () =>
      readDocumentMachineIdentity(options.documents, {
        ...(options.machine.name === undefined ? {} : { machineName: options.machine.name }),
        defaultName: options.machine.defaultName,
        platform: options.machine.platform,
      }),
  };
}
