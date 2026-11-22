import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  fsyncSync,
  mkdirSync,
  constants,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { acquireProcessWriter } from "@opencraft/sqlite-node";
import type { HubService } from "./contract.js";
import { hubId, parseHubState, recordChange, storedService, type State } from "./store.js";

// Synchronous file owner. It runs in the Hub state Worker, in admin tools and
// in tests; network processes use openHubNetwork(), which keeps it off their
// event loop.
/** One deployment-owned, atomic private state; never browser preferences or relay replicas. */
export class HubStore {
  readonly state: State;
  readonly id: string;
  readonly #release: () => void;
  #closed = false;
  constructor(readonly path: string) {
    if (!isAbsolute(path)) throw new Error("Hub state requires an absolute path");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#release = acquireProcessWriter(`${path}.lock`);
    try {
      let present = false;
      try {
        lstatSync(path);
        present = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (present) {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = lstatSync(path);
          if (
            !info.isFile() ||
            info.size > 1_048_576 ||
            info.mode & 0o077 ||
            (process.getuid && info.uid !== process.getuid())
          )
            throw new Error("Hub state must be private");
          this.state = JSON.parse(readFileSync(fd, "utf8"));
        } finally {
          closeSync(fd);
        }
        this.state = parseHubState(this.state);
      } else {
        const pair = generateKeyPairSync("ed25519");
        this.state = {
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
        this.save();
      }
      this.id = hubId(this.state.publicKey);
    } catch (error) {
      this.#release();
      throw error;
    }
  }
  save() {
    if (this.#closed) throw new Error("Hub store is closed");
    const temp = this.path + "." + randomUUID() + ".tmp";
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, JSON.stringify(this.state));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.path);
  }
  record(operator: string, action: string) {
    recordChange(this.state, operator, action);
    this.save();
  }
  /** Writes a state committed by a network-thread owner after validating it. */
  replace(state: unknown) {
    const next = parseHubState(structuredClone(state));
    if (hubId(next.publicKey) !== this.id) throw new Error("Hub state belongs to another Hub identity");
    for (const key of Object.keys(this.state) as (keyof State)[]) delete this.state[key];
    Object.assign(this.state, next);
    this.save();
  }
  service(): HubService | null {
    return storedService(this.state, this.id);
  }
  close() {
    if (!this.#closed) {
      this.#closed = true;
      this.#release();
    }
  }
}
