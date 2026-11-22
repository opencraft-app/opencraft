import { WorkspaceArtifactCleanupUnconfirmed } from "./artifact-errors.js";
import type { SandboxEnvironment, SandboxProcess } from "@opencraft/sandbox";
import { artifactFileBody, type Artifact } from "@opencraft/local-agent-host/artifacts";
import { extname } from "node:path";

/** Private working-volume copy, not the shared library or a Host path fallback. */
export const workspaceArtifactReceiver = String.raw`
import os,sys,json,hashlib,uuid,signal
size=int(sys.argv[1]);expected=sys.argv[2];name=sys.argv[3]
if size<0 or len(expected)!=64 or not name.startswith(expected):raise ValueError()
def stopped(*args):raise InterruptedError()
signal.signal(signal.SIGTERM,stopped)
root=os.open("/workspace",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
tmp=None
try:
 for part in [".opencraft","attachments"]:
  try:os.mkdir(part,0o700,dir_fd=root)
  except FileExistsError:pass
  child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root);os.close(root);root=child
 tmp=".upload-"+uuid.uuid4().hex
 fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=root)
 digest=hashlib.sha256();total=0
 with os.fdopen(fd,"wb") as target:
  while True:
   chunk=sys.stdin.buffer.read(65536)
   if not chunk:break
   total+=len(chunk)
   if total>size:raise ValueError()
   digest.update(chunk);target.write(chunk)
  target.flush();os.fsync(target.fileno())
 if total!=size or digest.hexdigest()!=expected:raise ValueError()
 os.replace(tmp,name,src_dir_fd=root,dst_dir_fd=root);tmp=None
 print(json.dumps({"path":"/workspace/.opencraft/attachments/"+name,"size":total,"sha256":expected}),flush=True)
finally:
 if tmp is not None:
  try:os.unlink(tmp,dir_fd=root)
  except FileNotFoundError:pass
 os.close(root)
`;

export async function transferWorkspaceArtifact(options: {
  sandbox: Pick<SandboxEnvironment, "spawn">;
  artifact: Artifact;
  body?: AsyncIterable<Uint8Array>;
  authorize(): Promise<void>;
  signal?: AbortSignal;
  onCleanupUnconfirmed(): void;
}): Promise<Artifact> {
  const { artifact } = options;
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 0 || !/^[a-f0-9]{64}$/.test(artifact.sha256))
    throw Error("Invalid workspace artifact");
  const suffix = extname(artifact.name).toLowerCase();
  const name = artifact.sha256 + (/^\.[a-z0-9]{1,12}$/.test(suffix) ? suffix : ".bin");
  const expectedPath = "/workspace/.opencraft/attachments/" + name;
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(30 * 60_000)]);
  let process: SandboxProcess | undefined,
    output = "",
    completed = false;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    process
      ? (stopping ??= process.terminate().catch(() => {
          options.onCleanupUnconfirmed();
          throw new WorkspaceArtifactCleanupUnconfirmed();
        }))
      : Promise.resolve();
  const abort = () => {
    void stop().catch(() => {});
  };
  const check = async () => {
    signal.throwIfAborted();
    await options.authorize();
    signal.throwIfAborted();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await check();
    process = await options.sandbox.spawn(
      {
        command: [
          "/usr/bin/python3",
          "-I",
          "-c",
          workspaceArtifactReceiver,
          String(artifact.size),
          artifact.sha256,
          name,
        ],
        cwd: "/workspace",
        env: { PATH: "/usr/bin:/bin" },
      },
      (chunk) => {
        if (chunk.stream === "stdout" && output.length <= 8192)
          output = (output + Buffer.from(chunk.data).toString("utf8")).slice(0, 8193);
        if (output.length > 8192) abort();
      },
    );
    await check();
    if (process.kind !== "process") throw Error("Workspace artifact requires process transport");
    for await (const chunk of options.body ?? artifactFileBody(artifact.path)) {
      await check();
      await process.writeStdin(chunk);
    }
    await check();
    await process.closeStdin();
    const exit = await process.exited;
    await check();
    if (exit.code !== 0 || output.length > 8192) throw Error("Workspace artifact transfer failed");
    const receipt = JSON.parse(output);
    if (receipt.path !== expectedPath || receipt.size !== artifact.size || receipt.sha256 !== artifact.sha256)
      throw Error("Workspace artifact receipt mismatch");
    completed = true;
    return { ...artifact, path: expectedPath, origin: "execution-copy" };
  } finally {
    signal.removeEventListener("abort", abort);
    if (!completed) await stop();
  }
}
