import { createHash } from "node:crypto";
import type { SandboxEnvironment } from "@opencraft/sandbox";
import {
  encodeWorkspaceSelection,
  type ResolvedWorkspaceSelection,
} from "@opencraft/execution-environment/workspace-selection";

type GitSource = Extract<ResolvedWorkspaceSelection["source"], { kind: "git" }>;
/** Publisher-owned append-only generation layout; never a renderer-supplied path.
 * This is accidental-write isolation on the accepted trusted shared mount, not
 * tenant filesystem isolation. The publisher must never prune borrowed objects. */
export function ordinaryGitGenerationPath(source: GitSource): string {
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(source.generation)) throw Error("Invalid Git generation");
  return (
    "/shared/git/" +
    hash(source.authorizationDomain) +
    "/" +
    hash(source.repositoryId) +
    "/" +
    source.generation +
    ".git"
  );
}

// No network, credentials, arbitrary commands, reset of existing work or shared
// mutation. Runtime bootstrap provides Python/Git; provider identity and actual
// NFS mount checks remain the allocating source owner's responsibility.
const prepareScript = String.raw`
import sys,json,os,pathlib,subprocess,tempfile,shutil
v=json.load(sys.stdin);root=pathlib.Path('/workspace');base=pathlib.Path(v['base']);target=root/'project'
def fail(): raise RuntimeError('ordinary_git_copy_unavailable')
def exact(p):
 for component in [p,*p.parents]:
  if component.is_symlink(): fail()
 return p
exact(root);exact(base)
if not root.is_dir() or not base.is_dir(): fail()
if (base/'shallow').exists() or (base/'objects/info/alternates').exists(): fail()
manifest=json.loads((base/'opencraft-generation.json').read_text())
expected={'version':1,'source':v['source'],'remote':v['remote']}
generation={'version':1,'remote':v['remote'],**{key:v['source'][key] for key in ['repositoryId','authorizationDomain','generation','commit']}}
if manifest!=generation: fail()
env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/nonexistent','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_ALLOW_PROTOCOL':'file','GIT_NO_REPLACE_OBJECTS':'1'}
def git(args,cwd):
 r=subprocess.run(['git','-c','safe.directory='+str(cwd),'-c','core.hooksPath=/dev/null','-c','protocol.allow=never']+args,cwd=cwd,env=env,capture_output=True,timeout=120)
 if r.returncode: fail()
 return r.stdout.decode().strip()
if git(['rev-parse','--is-bare-repository'],base)!='true': fail()
# No promisor/partial repository is eligible for an offline immutable generation.
config=(base/'config').read_text().lower()
if 'promisor' in config or 'partialclone' in config: fail()
object_format='sha256' if len(v['source']['commit'])==64 else 'sha1'
if git(['rev-parse','--show-object-format'],base)!=object_format: fail()
if git(['cat-file','-t',v['source']['commit']],base)!='commit': fail()
def verify(copy):
 exact(copy);exact(copy/'.git')
 if not (copy/'.git').is_dir(): fail()
 if json.loads((copy/'.git/opencraft-source.json').read_text())!=expected: fail()
 if (copy/'.git/objects/info/alternates').read_text()!=str(base/'objects')+'\n': fail()
 if git(['remote','get-url','origin'],copy)!=v['remote']: fail()
 if git(['cat-file','-t',v['source']['commit']],copy)!='commit': fail()
 selected=exact(copy/v['source']['relativePath'])
 if not selected.is_dir(): fail()
 return selected
if target.exists() or target.is_symlink():
 selected=verify(target)
else:
 stage=pathlib.Path(tempfile.mkdtemp(prefix='.opencraft-git-',dir=root))
 try:
  git(['init','--object-format='+object_format,'--template=','.'],stage)
  (stage/'.git/objects/info/alternates').write_text(str(base/'objects')+'\n')
  git(['config','gc.auto','0'],stage)
  git(['config','maintenance.auto','false'],stage)
  git(['remote','add','origin',v['remote']],stage)
  git(['checkout','-b','opencraft/work',v['source']['commit']],stage)
  (stage/'.git/opencraft-source.json').write_text(json.dumps(expected))
  verify(stage)
  # Never replace an existing user directory, even after a concurrent prepare.
  # mkdir lock is on the private volume and deliberately remains on uncertain crash.
  lock=root/'.opencraft-git-publish.lock'
  lock.mkdir(mode=0o700)
  try:
   if target.exists() or target.is_symlink(): fail()
   os.rename(stage,target)
  finally: lock.rmdir()
 finally:
  if stage.exists(): shutil.rmtree(stage)
 selected=verify(target)
print(json.dumps({'cwd':str(selected)}))
`;

/** Must be called only after source authorization and mount/volume verification.
 * The durable selection already pins generation before this creates private files.
 * The same generation is required on restore; modified files/HEAD are preserved. */
export async function prepareOrdinaryGitCopy(input: {
  sandbox: Pick<SandboxEnvironment, "spawn">;
  selection: ResolvedWorkspaceSelection;
  remote: string;
  authorize(): Promise<void>;
}): Promise<{ cwd: string }> {
  const selection = encodeWorkspaceSelection(input.selection).value;
  if (selection.source.kind !== "git") throw Error("Git source required");
  const remote = new URL(input.remote);
  if (
    remote.protocol !== "https:" ||
    remote.username ||
    remote.password ||
    remote.search ||
    remote.hash ||
    remote.href !== input.remote
  )
    throw Error("Invalid canonical Git remote");
  await input.authorize();
  const output: Buffer[] = [];
  let bytes = 0,
    overflow = false;
  const child = await input.sandbox.spawn(
    {
      command: ["/usr/bin/python3", "-c", prepareScript],
      cwd: "/workspace",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    },
    (part) => {
      if (part.stream !== "stdout") return;
      bytes += part.data.byteLength;
      if (bytes > 4096) overflow = true;
      else output.push(Buffer.from(part.data));
    },
  );
  const timer = setTimeout(() => {
    void child.terminate().catch(() => {});
  }, 180000);
  try {
    if (child.kind !== "process") throw Error("Git preparation requires a nonterminal process");
    await child.writeStdin(
      Buffer.from(
        JSON.stringify({
          source: selection.source,
          remote: input.remote,
          base: ordinaryGitGenerationPath(selection.source),
        }),
      ),
    );
    await child.closeStdin();
    const result = await child.exited;
    if (result.code !== 0 || overflow) throw Error("Ordinary Git copy preparation failed");
    const receipt = JSON.parse(Buffer.concat(output).toString("utf8"));
    const cwd = "/workspace/project" + (selection.source.relativePath ? "/" + selection.source.relativePath : "");
    if (receipt?.cwd !== cwd) throw Error("Invalid Git copy receipt");
    await input.authorize();
    return { cwd };
  } finally {
    clearTimeout(timer);
    await child.terminate();
  }
}
