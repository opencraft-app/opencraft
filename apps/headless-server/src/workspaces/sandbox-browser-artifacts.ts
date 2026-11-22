import type { SandboxEnvironment, SandboxProcess } from "@opencraft/sandbox";

import { browserRuntimeManifest, type BrowserRuntimeManifest } from "@opencraft/plugin-assets/server/browser-manifest";
export { browserRuntimeManifest, type BrowserRuntimeManifest };
/** No network/package manager fallback or writes to shared cache. Verify copied
 * bytes before extraction: mutable shared archives cannot change beneath tar. */
export const browserRuntimePreparationScript = String.raw`
import os,sys,json,stat,hashlib,tempfile,tarfile,pathlib,shutil,signal,platform
root=None
def deadline(*args): raise TimeoutError()
signal.signal(signal.SIGALRM,deadline);signal.alarm(120)
try:
 manifest=json.loads(sys.argv[1])
 if platform.system()!='Linux' or platform.machine() not in ('x86_64','amd64'): raise ValueError()
 root=pathlib.Path(tempfile.mkdtemp(prefix='opencraft-browser-runtime-',dir='/tmp'))
 expanded=0
 for index,entry in enumerate(manifest['archives']):
  local=root/('.archive-'+str(index));digest=hashlib.sha256();total=0
  fd=os.open(entry['path'],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  with os.fdopen(fd,'rb') as source,open(local,'xb') as output:
   info=os.fstat(source.fileno())
   if not stat.S_ISREG(info.st_mode) or info.st_size>256*1024*1024: raise ValueError()
   while True:
    chunk=source.read(1024*1024)
    if not chunk: break
    total+=len(chunk)
    if total>256*1024*1024: raise ValueError()
    digest.update(chunk);output.write(chunk)
  if digest.hexdigest()!=entry['sha256']: raise ValueError()
  with tarfile.open(local,'r:gz') as archive:
   entries=[]
   for member in archive:
    if len(entries)>=20000: raise ValueError()
    entries.append(member)
    parts=pathlib.PurePosixPath(member.name).parts
    if member.name.startswith('/') or '..' in parts or any(p.startswith('.archive-') for p in parts) or not(member.isfile() or member.isdir()): raise ValueError()
    # Shared-cache delivery must not install a setuid executable. Electron's
    # known helper may be present in its pinned upstream archive; extract it
    # without privilege bits. Sandboxed templates must provision that separately.
    if member.mode&0o7000:
     if parts!=('electron','chrome-sandbox') or not member.isfile() or member.mode&0o7000!=0o4000:raise ValueError()
     member.mode &= 0o777
    # Archive build-machine identities must never own the private runtime.
    member.uid=os.geteuid();member.gid=os.getegid();member.uname='';member.gname=''
    expanded+=member.size
    if expanded>1024*1024*1024: raise ValueError()
   archive.extractall(root,members=entries,numeric_owner=True)
  local.unlink()
 os.chmod(root,0o700)
 for name in ['electron/electron','owner.cjs','worker.cjs','encoder.html','encoder-preload.cjs','annotation-preload.cjs','preview-bridge.js']:
  info=os.lstat(root/name)
  if not stat.S_ISREG(info.st_mode):raise ValueError()
 if not os.access(root/'electron/electron',os.X_OK):raise ValueError()
 print(json.dumps({'directory':str(root)}),flush=True)
except BaseException:
 if root is not None:shutil.rmtree(root,ignore_errors=True)
 print(json.dumps({'error':'browser_runtime_preparation_failed'}),flush=True)
 sys.exit(1)
`;

export function createSandboxBrowserPreparer(options: {
  sandbox: Pick<SandboxEnvironment, "spawn">;
  manifest: BrowserRuntimeManifest;
  authorize(): Promise<void>;
  onCleanupUnconfirmed(): void;
}) {
  const manifest = browserRuntimeManifest(options.manifest);
  let preparing: Promise<{ directory: string }> | undefined;
  const prepare = async () => {
    let child: SandboxProcess | undefined,
      expired = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    let output = "",
      size = 0;
    const cleanup = async () => {
      if (child)
        try {
          await child.terminate();
        } catch {
          options.onCleanupUnconfirmed();
          throw Error("Browser preparation cleanup unconfirmed");
        }
    };
    const work = async () => {
      await options.authorize();
      if (expired) throw Error("Browser preparation expired");
      child = await options.sandbox.spawn(
        {
          command: ["/usr/bin/python3", "-c", browserRuntimePreparationScript, JSON.stringify(manifest)],
          cwd: "/tmp",
          env: { PATH: "/usr/bin:/bin" },
        },
        (chunk) => {
          if (chunk.stream === "stdout") {
            size += chunk.data.length;
            if (size <= 8192) output += Buffer.from(chunk.data).toString("utf8");
          }
        },
      );
      if (expired) {
        await cleanup();
        throw Error("Browser preparation expired");
      }
      if (child.kind !== "process") throw Error("Browser preparation requires process transport");
      await child.closeStdin();
      const exit = await child.exited;
      if (expired || exit.code !== 0 || size > 8192) throw Error("Browser runtime preparation failed");
      await options.authorize();
      if (expired) throw Error("Browser preparation expired");
      const value = JSON.parse(output);
      if (
        !value ||
        typeof value.directory !== "string" ||
        !/^\/tmp\/opencraft-browser-runtime-[a-zA-Z0-9_-]+$/.test(value.directory)
      )
        throw Error("Invalid browser preparation receipt");
      return { directory: value.directory as string };
    };
    try {
      return await Promise.race([
        work().catch(async (error) => {
          await cleanup();
          throw error;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            void cleanup().catch(() => {});
            reject(Error("Browser preparation timed out"));
          }, 130000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async prepare() {
      await options.authorize();
      return (preparing ??= prepare());
    },
  };
}
