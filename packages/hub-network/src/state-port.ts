// Hub state port (runtime-neutral; gateway-split §4.1.1 "根输入端口").
//
// The persistent state behind a deployment's Hub controller is two things:
//  - an operator-installed remote controller configuration (read only; when
//    present, this deployment has no Hub node of its own);
//  - the Hub node's own state document (its Ed25519 identity, accepted
//    identity authority, published origin, peers, invitations and audit),
//    with exactly one writer.
// The Node adapter (`./state-port-node`) keeps both in their data directory
// files; `./state-port-document` keeps them in any StateDocumentStore whose
// owner is the single writer. The Hub node, its links and its HTTP handler
// consume only this port.
import type { State } from "./store.js";

/** The operator's remote controller: a same-machine Hub reached over loopback with a bearer credential. */
export interface HubControllerConfiguration {
  readonly endpoint: string;
  readonly credential: string;
}

export function parseHubControllerConfiguration(input: unknown): HubControllerConfiguration {
  const config = input as { schemaVersion: number; endpoint: string; credential: string } | null;
  if (
    !config ||
    config.schemaVersion !== 1 ||
    Object.keys(config).some((k) => !["schemaVersion", "endpoint", "credential"].includes(k)) ||
    typeof config.credential !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(config.credential)
  )
    throw new Error("Invalid Hub controller configuration");
  const endpoint = new URL(config.endpoint);
  if (endpoint.origin !== config.endpoint || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1")
    throw new Error("Hub controller requires loopback");
  return { endpoint: config.endpoint, credential: config.credential };
}

/** The single writer of one Hub node's state, opened with the committed state. */
export interface HubNodeStateOwner {
  /** The committed state at open; a first open has created and committed a new Hub identity. */
  readonly state: State;
  /** Durably replaces the committed state; refuses a state of another Hub identity. */
  save(state: State): Promise<void>;
  /** Releases the writer after every started save finished. */
  close(): Promise<void>;
}

export interface HubStatePort {
  /** The remote controller configuration, or null when this deployment owns its Hub node. */
  readController(): Promise<HubControllerConfiguration | null>;
  /** Opens the Hub node's state writer; called only when there is no remote controller. */
  openNode(): Promise<HubNodeStateOwner>;
}
