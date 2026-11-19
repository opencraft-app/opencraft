import type { SandboxEnvironment, SandboxProcess } from "@opencraft/sandbox";

/** Temporary compatibility bridge. Replace with versioned template runtime delivery.
 * One preparer belongs to one authorized compute lease, never a workspace cache. */
export const executionRuntimeArtifact = Object.freeze({
  version: "0.162.1",
  cacheArchive: "/shared/.opencraft/runtime-cache/codex-0.162.1-linux-x64.tgz",
  url: "https://registry.npmjs.org/@openai/codex/-/codex-0.162.1-linux-x64.tgz",
  sha512: "cjK2mdHIfEepZ1lQ1MX3aTQC+8ncIsvnacl/6vI2dIIcfP8/MrhTQ2+qRlkXFNDzJSj1d36quIszP+3/4CUJWQ==",
});
export interface PreparedExecutionRuntime { executable: string; version: string; source: "template" | "temporary" | "shared-cache"; }
export const executionRuntimeBootstrapScript = String.raw`
import os,sys,json,platform,signal,subprocess,tempfile,urllib.request,hashlib,base64,tarfile,pathlib,shutil,stat
stage='platform'
def report(kind,value,tb):
 print(json.dumps({'error':'runtime_preparation_failed','stage':stage,'category':kind.__name__}),flush=True)
sys.excepthook=report
def deadline(signum,frame):raise TimeoutError()
signal.signal(signal.SIGALRM,deadline)
signal.alarm(120)
pin=json.loads(sys.argv[1])
def version(p):
 try:
  r=subprocess.run([p,'--version'],capture_output=True,timeout=5,env={'PATH':'/usr/bin:/bin'})
  return r.returncode==0 and r.stdout.decode().strip()=='codex-cli '+pin['version']
 except (OSError,subprocess.TimeoutExpired): return False
if platform.system()!='Linux' or platform.machine() not in ('x86_64','amd64'): raise RuntimeError('unsupported_runtime_platform')
stage='template'
p='/opt/opencraft-codex/package/vendor/x86_64-unknown-linux-musl/bin/codex'
if version(p):
 print(json.dumps({'executable':p,'version':pin['version'],'source':'template'}));sys.exit(0)
root=pathlib.Path(tempfile.mkdtemp(prefix='opencraft-runtime-',dir='/tmp'))
try:
 stage='cache'
 archive=root/'runtime.tgz';h=hashlib.sha512();total=0;source='temporary'
 try:
  fd=os.open(pin['cacheArchive'],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 except FileNotFoundError:fd=None
 if fd is not None:
  with os.fdopen(fd,'rb') as r,open(archive,'xb') as w:
   info=os.fstat(r.fileno())
   if not stat.S_ISREG(info.st_mode) or info.st_size>256*1024*1024:raise RuntimeError('invalid_cache_archive')
   while True:
    b=r.read(1024*1024)
    if not b:break
    total+=len(b)
    if total>256*1024*1024:raise RuntimeError('archive_too_large')
    h.update(b);w.write(b)
  source='shared-cache'
 else:
  stage='download'
  with urllib.request.urlopen(pin['url'],timeout=30) as r,open(archive,'xb') as w:
   if r.geturl()!=pin['url']: raise RuntimeError('unexpected_redirect')
   while True:
    b=r.read(1024*1024)
    if not b: break
    total+=len(b)
    if total>256*1024*1024: raise RuntimeError('archive_too_large')
    h.update(b);w.write(b)
 stage='integrity'
 if base64.b64encode(h.digest()).decode()!=pin['sha512']: raise RuntimeError('integrity_mismatch')
 stage='extract'
 with tarfile.open(archive,'r:gz') as t:
  entries=t.getmembers()
  if len(entries)>10000 or sum(m.size for m in entries)>768*1024*1024: raise RuntimeError('archive_too_large')
  for m in entries:
   if m.name.startswith('/') or '..' in pathlib.PurePosixPath(m.name).parts or not (m.isfile() or m.isdir()) or m.mode & 0o7000: raise RuntimeError('unsafe_archive')
  t.extractall(root)
 archive.unlink()
 p=str(root/'package/vendor/x86_64-unknown-linux-musl/bin/codex')
 stage='version'
 if not version(p): raise RuntimeError('runtime_version_mismatch')
 print(json.dumps({'executable':p,'version':pin['version'],'source':source}))
except BaseException:
 shutil.rmtree(root,ignore_errors=True);raise
`;
export function createExecutionRuntimePreparer(options: {
  sandbox: Pick<SandboxEnvironment, "spawn">;
  authorize(): Promise<void>;
  /** Owner must retire the lease if cleanup cannot be confirmed. */
  onCleanupUnconfirmed(): void;
}) {
  let preparation: Promise<PreparedExecutionRuntime> | undefined;
  const prepare = async (): Promise<PreparedExecutionRuntime> => {
    let child: SandboxProcess | undefined, expired = false, timer: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = []; let size = 0;
    const cleanup = async () => { if (child) try { await child.terminate(); } catch { options.onCleanupUnconfirmed(); throw Error("runtime_cleanup_unconfirmed"); } };
    const work = async (): Promise<PreparedExecutionRuntime> => {
      await options.authorize();
      if (expired) throw Error("runtime_preparation_timeout");
      child = await options.sandbox.spawn({ command: ["/usr/bin/python3", "-c", executionRuntimeBootstrapScript, JSON.stringify(executionRuntimeArtifact)], cwd: "/tmp", env: { PATH: "/usr/bin:/bin" } }, output => {
        if (output.stream === "stdout") { size += output.data.length; if (size <= 8192) chunks.push(Buffer.from(output.data)); }
      });
      if (expired) { await cleanup(); throw Error("runtime_preparation_timeout"); }
      if (child.kind === "process") await child.closeStdin();
      const exit = await child.exited;
      if (expired || size > 8192) throw Error("runtime_preparation_failed");
      if (exit.code !== 0) {
        // Only bounded, allow-listed diagnostic fields; never remote stderr/URLs.
        let detail = "";
        try {
          const failure = JSON.parse(Buffer.concat(chunks).toString());
          if (["platform", "template", "cache", "download", "integrity", "extract", "version"].includes(failure.stage)
            && ["RuntimeError", "TimeoutError", "URLError", "HTTPError", "OSError", "PermissionError", "ReadError"].includes(failure.category))
            detail = ":" + failure.stage + ":" + failure.category;
        } catch {}
        throw Error("runtime_preparation_failed" + detail);
      }
      await options.authorize();
      const value = JSON.parse(Buffer.concat(chunks).toString()) as PreparedExecutionRuntime;
      const template = value.source === "template" && value.executable === "/opt/opencraft-codex/package/vendor/x86_64-unknown-linux-musl/bin/codex";
      const temporary = (value.source === "temporary" || value.source === "shared-cache") && /^\/tmp\/opencraft-runtime-[a-zA-Z0-9_-]+\/package\/vendor\/x86_64-unknown-linux-musl\/bin\/codex$/.test(value.executable);
      if ((!template && !temporary) || value.version !== executionRuntimeArtifact.version) throw Error("runtime_invalid_receipt");
      return { executable: value.executable, version: value.version, source: value.source };
    };
    try {
      return await Promise.race([work().catch(async error => { await cleanup(); throw error; }), new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; void cleanup().catch(() => {}); reject(Error("runtime_preparation_timeout")); }, 130000); })]);
    } finally { clearTimeout(timer); }
  };
  return { async prepare(): Promise<PreparedExecutionRuntime> {
    await options.authorize();
    // Cache failures too: no silent retries after an uncertain installation.
    return preparation ??= prepare();
  } };
}
