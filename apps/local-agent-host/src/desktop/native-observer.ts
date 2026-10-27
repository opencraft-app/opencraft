import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { connect, type Socket } from "node:net";

const unavailable = () => new Error("Desktop is unavailable");
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export interface NativeObserver {
  inspect(signal: AbortSignal): Promise<string>;
  open(incarnation: string, signal: AbortSignal): Promise<Socket>;
}

/** Fixed verified loopback endpoint. No enterprise service, user shell or arbitrary TCP target.
 * The private key stays on the Host. No credential reaches the renderer. */
export function createNativeObserver(): NativeObserver {
  const openVerified = async (signal: AbortSignal, expected?: string) => {
    signal.throwIfAborted();
    const directory = "/run/opencraft-desktop-observer";
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o077)) throw unavailable();
    const file = await open(`${directory}/key`, constants.O_RDONLY | constants.O_NOFOLLOW);
    let key: Buffer;
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o077) || metadata.size !== 32) throw unavailable();
      key = await file.readFile();
      if (key.length !== 32) throw unavailable();
    } finally { await file.close(); }
    const nonce = randomBytes(32).toString("hex");
    let socket: Socket | undefined;
    try {
      signal.throwIfAborted();
      const result = await new Promise<{ socket: Socket; incarnation: string }>((resolve, reject) => {
        const stream = connect({ host: "127.0.0.1", port: 5902 });
        socket = stream;
        let header = Buffer.alloc(0), done = false;
        const timeout = setTimeout(() => finish(), 5_000);
        const cleanup = () => {
          clearTimeout(timeout); signal.removeEventListener("abort", abort);
          stream.off("data", data); stream.off("error", error); stream.off("close", error);
        };
        const finish = (incarnation?: string, remaining?: Buffer) => {
          if (done) return; done = true; cleanup();
          if (!incarnation || signal.aborted) { stream.destroy(); reject(unavailable()); return; }
          stream.pause();
          if (remaining?.length) stream.unshift(remaining);
          // Keep a harmless error listener during the consumer handoff window.
          stream.on("error", () => {});
          resolve({ socket: stream, incarnation });
        };
        const abort = () => finish(), error = () => finish();
        const data = (chunk: Buffer) => {
          // Only buffer the bounded proof, not media coalesced in the same read.
          const end = chunk.indexOf(10);
          const proofChunk = end < 0 ? chunk : chunk.subarray(0, end);
          if (header.length + proofChunk.length > 512) { finish(); return; }
          header = Buffer.concat([header, proofChunk]);
          if (end < 0) return;
          try {
            const proof = JSON.parse(header.toString("utf8"));
            const fields = ["protocol", "version", "readOnly", "incarnation", "nonce", "mac"];
            if (!proof || Object.keys(proof).length !== fields.length || fields.some(field => !(field in proof))
              || proof.protocol !== "opencraft-desktop-observer" || proof.version !== 1 || proof.readOnly !== true
              || proof.nonce !== nonce || !hex(proof.incarnation) || !hex(proof.mac)
              || (expected !== undefined && proof.incarnation !== expected)) throw unavailable();
            const mac = createHmac("sha256", key).update(`opencraft-desktop-observer/v1\0${nonce}\0${proof.incarnation}`).digest();
            if (!timingSafeEqual(mac, Buffer.from(proof.mac, "hex"))) throw unavailable();
            finish(proof.incarnation, chunk.subarray(end + 1));
          } catch { finish(); }
        };
        stream.on("error", error); stream.on("close", error); stream.on("data", data);
        stream.once("connect", () => stream.write(`${JSON.stringify({ nonce })}\n`));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      return result;
    } catch { socket?.destroy(); throw unavailable(); }
    finally { key.fill(0); }
  };
  return {
    async inspect(signal) { const result = await openVerified(signal); result.socket.destroy(); return result.incarnation; },
    async open(incarnation, signal) {
      if (!hex(incarnation)) throw unavailable();
      return (await openVerified(signal, incarnation)).socket;
    },
  };
}

export async function localDesktopMachineIdentity(): Promise<string> {
  const machine = (await readFile("/etc/machine-id", "utf8")).trim();
  if (!/^[a-f0-9]{32}$/.test(machine)) throw unavailable();
  return `local-machine:${createHash("sha256").update(machine).digest("hex")}`;
}
