import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import { acquireProcessWriter } from "@opencraft/sqlite-node";
import { HubNetwork } from "./node.js";
import type { HubNetworkOptions } from "./open.js";
import { hubId, MemoryHubStore, type State } from "./store.js";
import { documentHubStore, type HubStateDocument } from "./document-hub-store.js";

// Node owner of one Hub state file. It runs in the Hub state Worker, in
// offline admin tools and in tests; network processes use openHubNetwork(),
// which keeps it (and the synchronous writer fence) off their event loop.

/**
 * One deployment-owned, private Hub state file (`hub-network.json` by
 * default); never browser preferences or relay replicas. The process-writer
 * fence `<path>.lock` makes this the only writer; the document itself goes
 * through a StateDocumentStore over the file's directory.
 */
export class HubStateFile {
  #pending = 0;
  #drained: (() => void) | undefined;
  #closing: Promise<void> | undefined;
  readonly #hubState: HubStateDocument;
  readonly #release: () => void;
  private constructor(readonly state: State, readonly id: string, hubState: HubStateDocument, release: () => void) {
    this.#hubState = hubState;
    this.#release = release;
  }

  static async open(path: string): Promise<HubStateFile> {
    if (!isAbsolute(path)) throw new Error("Hub state requires an absolute path");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const release = acquireProcessWriter(`${path}.lock`);
    try {
      // `<path>.lock` is the process-writer fence (shared with earlier releases),
      // so the document lock sits beside it.
      const documents = fileStateDocumentStore(dirname(path), {
        lockfilePath: (file) => `${file}.state-lock`,
        // The document holds the node's private key.
        private: { maxBytes: 1_048_576 },
      });
      const hubState = documentHubStore(documents, basename(path));
      const state = await hubState.open();
      return new HubStateFile(state, hubId(state.publicKey), hubState, release);
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Writes a state committed by the Hub after validating it keeps this identity. */
  async save(state: unknown): Promise<void> {
    if (this.#closing) throw new Error("Hub store is closed");
    if (hubId((state as State).publicKey) !== this.id) throw new Error("Hub state belongs to another Hub identity");
    this.#pending++;
    try {
      await this.#hubState.save(state);
    } finally {
      if (--this.#pending === 0) this.#drained?.();
    }
  }

  /** Releases the writer fence after every started write finished. */
  close(): Promise<void> {
    return (this.#closing ??= (async () => {
      if (this.#pending) await new Promise<void>((resolve) => (this.#drained = resolve));
      this.#release();
    })());
  }
}

class LocalHubStore extends MemoryHubStore {
  constructor(state: State, readonly file: HubStateFile) {
    super(state);
  }
  override close() {
    super.close();
    // Releases the writer fence once writes already started have finished.
    void this.file.close();
  }
}

/**
 * A durable-mode Hub over a state file in this thread, for offline tools and
 * tests; closing the Hub releases the file. Network processes use
 * openHubNetwork(), which keeps the file in a Worker.
 */
export async function openLocalHubNetwork(path: string, options: HubNetworkOptions = {}): Promise<HubNetwork> {
  const file = await HubStateFile.open(path);
  let node: HubNetwork | undefined;
  try {
    node = new HubNetwork(new LocalHubStore(file.state, file), { ...options, persist: (state) => file.save(state) });
    // Configuring the identity authority at open is itself a change to persist.
    if (node.store.state.revision !== file.state.revision) await file.save(structuredClone(node.store.state));
    return node;
  } catch (error) {
    node?.close();
    await file.close();
    throw error;
  }
}
