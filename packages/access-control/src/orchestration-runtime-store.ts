import { Worker } from "node:worker_threads";
import { communicationExtensionModule } from "./communication-extension.js";
import {
  OrchestrationRuntimeClient,
  coreOrchestrationTransport,
  orchestrationRuntimeFailure,
  type OrchestrationRuntimeOwner,
  type OrchestrationRuntimeTransport,
} from "./orchestration-runtime-client.js";
import type { OrchestrationRuntimeMethod } from "./orchestration-runtime-contract.js";

export type { OrchestrationRuntimeOwner, OrchestrationRuntimeStorage } from "./orchestration-runtime-client.js";

/** File-backed adapter. The shared client also works with an existing owner. */
export class OrchestrationRuntimeWorker extends OrchestrationRuntimeClient {
  constructor(source: string | OrchestrationRuntimeOwner) {
    super(typeof source === "string" ? nodeOrchestrationTransport(source) : coreOrchestrationTransport(source));
  }
}

function nodeOrchestrationTransport(path: string): OrchestrationRuntimeTransport {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const worker = new Worker(new URL("./orchestration-runtime-worker.mjs", import.meta.url), {
    workerData: { path, extensionModule: communicationExtensionModule() }, execArgv: [],
  });
  let failure: Error | undefined;
  let stopping = false;
  let nextId = 0;
  const ready = new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => {
      failure ??= error;
      reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    worker.on("error", failed);
    worker.on("exit", code => {
      if (!stopping || code !== 0 || pending.size) failed(new Error("Orchestration storage worker exited"));
    });
    worker.on("message", packet => {
      if (packet.type === "ready") { resolve(); return; }
      const request = pending.get(packet.id);
      if (!request) return;
      pending.delete(packet.id);
      if (packet.error) request.reject(orchestrationRuntimeFailure(packet.error));
      else request.resolve(packet.result);
    });
  });
  void ready.catch(() => {});
  const post = (method: OrchestrationRuntimeMethod | "close", payload: unknown) => {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, method, payload }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  };
  return {
    capacity: 128,
    ready,
    request: post,
    async close() {
      stopping = true;
      try { await ready; await post("close", {}); }
      finally { await worker.terminate(); }
    },
  };
}
