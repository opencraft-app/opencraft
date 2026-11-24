import { generateKeyPair } from "node:crypto";
import { promisify } from "node:util";
import type { StateDocumentStore } from "@opencraft/document-storage/state";
import { parseHubState, type State } from "./store.js";

/** The document key the Node owner keeps as `hub-network.json`. */
export const HUB_STATE_DOCUMENT = "hub-network.json";

export interface HubStateDocument {
  /** The committed state; a first open creates and commits a new Hub identity. */
  open(): Promise<State>;
  /** Replaces the committed state after validating it belongs to the same Hub identity. */
  save(state: unknown): Promise<void>;
}

async function initialState(): Promise<State> {
  // Explicit (empty) options: runtimes whose node:crypto requires the three-argument form accept it too.
  const pair = await promisify(generateKeyPair)("ed25519", {});
  return {
    schemaVersion: 1,
    revision: 0,
    privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    name: "OpenCraft Hub",
    endpoint: "",
    origin: "",
    accepting: false,
    forwarding: false,
    authority: null,
    peers: [],
    invitations: [],
    audit: [],
  };
}

/**
 * The Hub's private state as one StateDocumentStore entry. Single-writer
 * fencing belongs to the enclosing owner; this only reads, creates and
 * replaces the entry, which still contains the node's private key.
 */
export function documentHubStore(documents: StateDocumentStore, key = HUB_STATE_DOCUMENT): HubStateDocument {
  return {
    async open() {
      const existing = await documents.read(key);
      if (existing !== null) return parseHubState(existing);
      const fresh = await initialState();
      // Another writer may have created the identity meanwhile; never replace it.
      const state = await documents.update(key, (current) =>
        current === null ? { result: fresh, next: fresh } : { result: current },
      );
      return parseHubState(state);
    },
    async save(input) {
      const next = parseHubState(structuredClone(input));
      await documents.update(key, (current) => {
        if (current === null) throw new Error("Hub state disappeared");
        if ((current as Partial<State>).publicKey !== next.publicKey)
          throw new Error("Hub state belongs to another Hub identity");
        return { result: undefined, next };
      });
    },
  };
}
