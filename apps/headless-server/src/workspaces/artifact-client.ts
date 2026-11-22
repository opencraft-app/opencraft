import { Readable } from "node:stream";
import { artifactFileBody, type Artifact } from "@opencraft/local-agent-host/artifacts";
import type { WorkspaceActorAdmission } from "./actor-authority.js";
import type { WorkspaceArtifactPort } from "./artifact-transports.js";
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
/** Main owns only the authorized local source stream/returned bytes. Provider
 * processes, credentials, lease and chunk acknowledgements remain in Worker. */
export class WorkspaceArtifactClient {
  constructor(private readonly port: WorkspaceArtifactPort) {}
  private async close(token: string): Promise<void> {
    for (;;) {
      const state = await this.port.workspaceArtifactClose(token);
      if (state === "closed") return;
      if (state === "failed") throw Error("Workspace artifact cleanup unconfirmed");
      await pause();
    }
  }
  async read(
    access: WorkspaceActorAdmission,
    threadId: string,
    path: string,
    authorize: () => void,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    authorize();
    const token = await this.port.workspaceArtifactDownload(access, threadId, path);
    let closing: Promise<void> | undefined;
    const abort = () => Atomics.store(access.requestPermit, 0, 0);
    signal?.addEventListener("abort", abort, { once: true });
    let body: Readable | undefined;
    const dispose = () =>
      (closing ??= (async () => {
        abort();
        signal?.removeEventListener("abort", abort);
        body?.destroy();
        await this.close(token);
      })());
    const check = () => {
      signal?.throwIfAborted();
      authorize();
    };
    try {
      check();
      const port = this.port;
      body = Readable.from(
        (async function* () {
          let sequence = 0,
            completed = false;
          try {
            for (;;) {
              check();
              const chunk = await port.workspaceArtifactRead(token, sequence);
              check();
              if (chunk.state === "failed") throw Error("Workspace output unavailable");
              if (chunk.state === "pending") {
                await pause();
                continue;
              }
              if (chunk.state === "done") {
                completed = true;
                break;
              }
              if (
                chunk.sequence !== sequence ||
                !(chunk.data instanceof Uint8Array) ||
                !chunk.data.byteLength ||
                chunk.data.byteLength > 65536
              )
                throw Error("Invalid workspace output credit");
              sequence++;
              yield Buffer.from(chunk.data);
            }
          } finally {
            await dispose();
            if (completed) check();
          }
        })(),
      );
      return { body, dispose };
    } catch (cause) {
      await dispose();
      throw cause;
    }
  }
  async upload(
    access: WorkspaceActorAdmission,
    threadId: string,
    artifact: Artifact,
    authorize: () => void,
    signal?: AbortSignal,
  ): Promise<Artifact> {
    signal?.throwIfAborted();
    authorize();
    const { path: _path, ...metadata } = artifact;
    const token = await this.port.workspaceArtifactUpload(access, threadId, metadata);
    const abort = () => Atomics.store(access.requestPermit, 0, 0);
    signal?.addEventListener("abort", abort, { once: true });
    const check = () => {
      signal?.throwIfAborted();
      authorize();
    };
    try {
      let sequence = 0;
      for await (const value of artifactFileBody(artifact.path)) {
        if (!(value instanceof Uint8Array)) throw Error("Invalid attachment bytes");
        for (let start = 0; start < value.byteLength; start += 65536) {
          const chunk = value.subarray(start, Math.min(start + 65536, value.byteLength));
          for (;;) {
            check();
            const accepted = await this.port.workspaceArtifactWrite(token, sequence, chunk);
            check();
            if (accepted) break;
            await pause();
          }
          sequence++;
        }
      }
      for (;;) {
        check();
        const result = await this.port.workspaceArtifactFinish(token);
        check();
        if (result.state === "failed") throw Error("Workspace attachment unavailable");
        if (result.state === "complete") return result.artifact;
        await pause();
      }
    } finally {
      abort();
      signal?.removeEventListener("abort", abort);
      await this.close(token);
    }
  }
}
