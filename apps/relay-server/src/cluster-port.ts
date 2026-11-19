import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { HubNetwork } from "../../../packages/hub-network/src/node.js";
import type { RelaySessionStore } from "./session-store.js";

export type RelayHub = Pick<HubNetwork, "snapshot" | "routes" | "open" | "handleUpgrade"> & {
  command(
    input: Record<string, unknown>,
    operator: string,
  ): ReturnType<HubNetwork["command"]> | Promise<ReturnType<HubNetwork["command"]>>;
};
export interface RelayClusterPort {
  readonly sessions: RelaySessionStore;
  prepare(): Promise<void>;
  open(instanceId: string, signal: AbortSignal): Promise<Duplex>;
  claimConnection(instanceId: string, retire: () => void): Promise<string>;
  releaseConnection(instanceId: string, claim: string): Promise<void>;
  retainStreams(retire: () => void): () => void;
  registerPending(id: string): Promise<void>;
  releasePending(id: string): Promise<void>;
  forwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean>;
  bind(handlers: {
    channel(instanceId: string, signal: AbortSignal, claim: string): Promise<Duplex>;
    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  }): void;
}
