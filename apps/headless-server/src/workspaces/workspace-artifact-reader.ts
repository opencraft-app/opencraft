import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import type { SandboxEnvironment, SandboxProcess } from "@opencraft/sandbox";
import type { GeneratedFileReader } from "@opencraft/local-agent-host/artifacts/generated-output";

export const workspaceArtifactSender = String.raw`
import os,sys,json,stat,base64,hashlib
parts=sys.argv[1].split("/")
if parts[:2]!=["","workspace"] or any(p in ["",".",".."] for p in parts[2:]):raise ValueError()
root=os.open("/workspace",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for part in parts[2:-1]:
  child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root);os.close(root);root=child
 fd=os.open(parts[-1],os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=root)
finally:os.close(root)
with os.fdopen(fd,"rb") as source:
 before=os.fstat(source.fileno())
 if not stat.S_ISREG(before.st_mode) or before.st_size>1024**3:raise ValueError()
 digest=hashlib.sha256();size=0
 for line in sys.stdin:
  if line!="next\n":raise ValueError()
  chunk=source.read(65536)
  if chunk:
   size+=len(chunk)
   if size>before.st_size:raise ValueError()
   digest.update(chunk);print(json.dumps({"data":base64.b64encode(chunk).decode()}),flush=True)
  else:
   after=os.fstat(source.fileno())
   if size!=before.st_size or (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise ValueError()
   print(json.dumps({"size":size,"sha256":digest.hexdigest()}),flush=True);break
`;

/** One credit per chunk keeps process output bounded by downstream consumption.
 * Never reads the controller filesystem or silently substitutes a local reader. */
export function workspaceArtifactReader(options: {
  sandbox: Pick<SandboxEnvironment, "spawn">;
  authorize(): Promise<void>;
  onCleanupUnconfirmed(): void;
}): GeneratedFileReader {
  return async (path, inputSignal) => {
    if (
      !path.startsWith("/workspace/") ||
      path.length > 8192 ||
      path.includes("\0") ||
      path
        .slice(11)
        .split("/")
        .some((p) => !p || p === "." || p === "..")
    )
      throw Error("Invalid workspace output path");
    const signal = AbortSignal.any([inputSignal ?? new AbortController().signal, AbortSignal.timeout(30 * 60_000)]);
    let process: SandboxProcess | undefined,
      buffer = "",
      ended = false,
      closed = false,
      stopping: Promise<void> | undefined;
    let reply: { resolve(value: Record<string, unknown>): void; reject(error: unknown): void } | undefined;
    let failure: unknown;
    const fail = (error: unknown) => {
      failure ??= error;
      reply?.reject(failure);
      reply = undefined;
    };
    const stop = () =>
      process
        ? (stopping ??= process.terminate().catch(() => {
            options.onCleanupUnconfirmed();
            throw Error("Workspace output cleanup unconfirmed");
          }))
        : Promise.resolve();
    const abort = () => {
      fail(signal.reason ?? Error("Workspace output cancelled"));
      void stop().catch(() => {});
    };
    const check = async () => {
      signal.throwIfAborted();
      if (closed) throw Error("Workspace output closed");
      if (failure) throw failure;
      await options.authorize();
      signal.throwIfAborted();
    };
    signal.addEventListener("abort", abort, { once: true });
    const dispose = async () => {
      closed = true;
      signal.removeEventListener("abort", abort);
      fail(Error("Workspace output disposed"));
      await stop();
    };
    try {
      await check();
      process = await options.sandbox.spawn(
        {
          command: ["/usr/bin/python3", "-c", workspaceArtifactSender, path],
          cwd: "/workspace",
          env: { PATH: "/usr/bin:/bin" },
        },
        (chunk) => {
          if (chunk.stream !== "stdout") return;
          buffer += Buffer.from(chunk.data).toString("utf8");
          if (buffer.length > 90000) {
            fail(Error("Workspace output exceeds chunk budget"));
            void stop().catch(() => {});
            return;
          }
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          try {
            if (!reply || newline !== buffer.length - 1) throw Error("Unexpected workspace output frame");
            const value = JSON.parse(buffer.slice(0, newline));
            buffer = "";
            const pending = reply;
            reply = undefined;
            pending.resolve(value);
          } catch (error) {
            fail(error);
            void stop().catch(() => {});
          }
        },
      );
      if (process.kind !== "process") throw Error("Workspace output requires process transport");
      const child = process;
      void child.exited.then(() => {
        ended = true;
        if (reply) fail(Error("Workspace output ended before receipt"));
      }, fail);
      await check();
      const body = Readable.from(
        (async function* () {
          const digest = createHash("sha256");
          let size = 0;
          try {
            while (true) {
              await check();
              if (ended) throw Error("Workspace output ended before receipt");
              const response = new Promise<Record<string, unknown>>((resolve, reject) => {
                reply = { resolve, reject };
              });
              // Install rejection handler before writing: process failure may race stdin.
              void response.catch(() => {});
              await child.writeStdin(Buffer.from("next\n"));
              const frame = await response;
              await check();
              if (typeof frame.data === "string") {
                const bytes = Buffer.from(frame.data, "base64");
                if (!bytes.length || bytes.length > 65536 || bytes.toString("base64") !== frame.data)
                  throw Error("Invalid workspace output bytes");
                size += bytes.length;
                if (size > 1024 ** 3) throw Error("Workspace output too large");
                digest.update(bytes);
                yield bytes;
              } else {
                if (frame.size !== size || frame.sha256 !== digest.digest("hex"))
                  throw Error("Workspace output receipt mismatch");
                await child.closeStdin();
                const exit = await child.exited;
                await check();
                if (exit.code !== 0) throw Error("Workspace output failed");
                break;
              }
            }
          } finally {
            await dispose();
          }
        })(),
      );
      return {
        body,
        dispose: async () => {
          body.destroy();
          await dispose();
        },
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  };
}
