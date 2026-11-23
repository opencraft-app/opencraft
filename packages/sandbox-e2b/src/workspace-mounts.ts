import type { SandboxEnvironment, SandboxProcess } from "@opencraft/sandbox";
import { isWorkspaceRelativePath } from "@opencraft/chat-core";

const unavailable = () => Error("ordinary_workspace_mounts_unavailable");
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const volumeName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value);
type Mount = { mount: string; root: string; fs: string; source: string };
type Receipt = { mounts: Mount[]; workspace: string; library: string | null; directory: boolean };

/** A provider declaration alone is not evidence of a mounted filesystem. */
export function validateE2BMountReceipt(
  value: unknown,
  expected: { privateName: string; sharedName?: string; relativePath?: string },
) {
  if (
    !volumeName(expected.privateName) ||
    (expected.sharedName !== undefined && !volumeName(expected.sharedName)) ||
    !isWorkspaceRelativePath(expected.relativePath ?? "")
  )
    throw unavailable();
  const receipt = value as Receipt;
  if (!receipt || !Array.isArray(receipt.mounts) || receipt.mounts.length > 256 || receipt.workspace !== "/workspace")
    throw unavailable();
  const check = (path: string, name: string) => {
    const entries = receipt.mounts.filter((m) => m && m.mount === path);
    if (entries.length !== 1) throw unavailable();
    const m = entries[0]!;
    if (
      m.root !== "/" ||
      !["nfs", "nfs4"].includes(m.fs) ||
      typeof m.source !== "string" ||
      !m.source.endsWith(":/" + name) ||
      m.source.length > 1024
    )
      throw unavailable();
    if (receipt.mounts.some((m) => !m || typeof m.mount !== "string" || m.mount.startsWith(path + "/")))
      throw unavailable();
  };
  check("/workspace", expected.privateName);
  if (expected.sharedName !== undefined) {
    check("/shared", expected.sharedName);
    const selected = "/shared" + (expected.relativePath ? "/" + expected.relativePath : "");
    if (receipt.library !== selected || receipt.directory !== true) throw unavailable();
    return { cwd: "/workspace" as const, libraryPath: selected };
  }
  return { cwd: "/workspace" as const };
}

export const e2bMountProbe = String.raw`
import sys,json,os,re,signal
signal.alarm(15)
def decode(s):return re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),s)
mounts=[]
for line in open('/proc/self/mountinfo'):
 left,right=line.rstrip().split(' - ',1);a=left.split();b=right.split();point=decode(a[4])
 if point in ['/workspace','/shared'] or point.startswith(('/workspace/','/shared/')):
  mounts.append({'mount':point,'root':decode(a[3]),'fs':b[0],'source':decode(b[1])})
selected=sys.argv[1] or None
print(json.dumps({'mounts':mounts,'workspace':os.path.realpath('/workspace'),
 'library':os.path.realpath(selected) if selected else None,'directory':os.path.isdir(selected) if selected else False}))
`;

/** Call only with current owner/allocation and authorized library binding. Never
 * mounts, remounts, writes to NFS or changes volume lifecycle. Volume API tokens
 * are discarded; only exact name/ID correspondence is consumed. */
export async function verifyE2BWorkspaceMounts(input: {
  sandbox: Pick<SandboxEnvironment, "spawn">;
  workspaceId: string;
  instanceId: string;
  privateVolumeId: string;
  library?: { volumeId: string; relativePath: string };
  apiUrl: string;
  readApiKey(): Promise<string>;
  authorize(): Promise<void>;
  onCleanupUnconfirmed(): void;
  request?: typeof fetch;
}) {
  if (
    !/^ws-[a-zA-Z0-9_-]{1,160}$/.test(input.workspaceId) ||
    !input.instanceId ||
    !uuid(input.privateVolumeId) ||
    (input.library && (!uuid(input.library.volumeId) || !isWorkspaceRelativePath(input.library.relativePath)))
  )
    throw unavailable();
  const workspaceId = input.workspaceId,
    instanceId = input.instanceId,
    privateVolumeId = input.privateVolumeId;
  const library = input.library && { ...input.library };
  const endpoint = new URL(input.apiUrl);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  )
    throw unavailable();
  const read = async (path: string) => {
    await input.authorize();
    const key = await input.readApiKey();
    await input.authorize();
    const response = await (input.request ?? fetch)(endpoint.origin + path, {
      headers: { "X-API-Key": key },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw unavailable();
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 65536) throw unavailable();
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    await input.authorize();
    const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw unavailable();
    return decoded as Record<string, unknown>;
  };
  const metadata = await read("/workspaces/" + workspaceId);
  if (
    metadata?.schemaVersion !== 2 ||
    metadata.workspaceID !== workspaceId ||
    metadata.privateVolumeID !== privateVolumeId ||
    !volumeName(metadata.privateVolumeName) ||
    !Array.isArray(metadata.members) ||
    metadata.members.length !== 1 ||
    !metadata.members[0] ||
    typeof metadata.members[0] !== "object" ||
    metadata.members[0].sandboxID !== instanceId ||
    (library && metadata.sharedVolumeID !== library.volumeId)
  )
    throw unavailable();
  const privateName = metadata.privateVolumeName;
  let sharedName: string | undefined;
  if (library) {
    const volume = await read("/volumes/" + library.volumeId);
    if (volume?.volumeID !== library.volumeId || !volumeName(volume.name)) throw unavailable();
    sharedName = volume.name;
  }
  const selected = library ? "/shared" + (library.relativePath ? "/" + library.relativePath : "") : "";
  let child: SandboxProcess | undefined,
    output = "",
    bytes = 0,
    expired = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = async () => {
    if (child)
      try {
        await child.terminate();
      } catch {
        input.onCleanupUnconfirmed();
        throw unavailable();
      }
  };
  const work = async () => {
    await input.authorize();
    if (expired) throw unavailable();
    child = await input.sandbox.spawn(
      {
        command: ["/usr/bin/python3", "-c", e2bMountProbe, selected],
        cwd: "/workspace",
        env: { PATH: "/usr/bin:/bin" },
      },
      (chunk) => {
        if (chunk.stream === "stdout") {
          bytes += chunk.data.length;
          if (bytes <= 65536) output += Buffer.from(chunk.data).toString();
        }
      },
    );
    if (expired) {
      await cleanup();
      throw unavailable();
    }
    if (child.kind !== "process") throw unavailable();
    await child.closeStdin();
    const exit = await child.exited;
    if (expired || exit.code !== 0 || bytes > 65536) throw unavailable();
    await input.authorize();
    if (expired) throw unavailable();
    return validateE2BMountReceipt(JSON.parse(output), {
      privateName,
      sharedName,
      relativePath: library?.relativePath,
    });
  };
  try {
    return await Promise.race([
      work().catch(async () => {
        await cleanup();
        throw unavailable();
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          void cleanup().catch(() => {});
          reject(unavailable());
        }, 20000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
