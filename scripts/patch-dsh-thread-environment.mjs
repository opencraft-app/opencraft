import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// The pinned executor has already combined the per-call trusted DSH environment
// here. The shared daemon's process.env never receives a Thread identity.
export const threadEnvironmentEdit = [
  "\t\t\t\t...spec.dshEnv\n",
  "\t\t\t\t...spec.dshEnv,\n\t\t\t\t...this.ctx?.get(\"opencraftExecutionThread\")?.environment?.(String(spec.dshEnv?.DSH_SESSION_ID ?? \"\")),\n\t\t\t\tOPENCRAFT_THREAD_ID: spec.dshEnv?.DSH_OPENCRAFT_THREAD_ID ?? \"\"\n",
];
export const terminalThreadEnvironmentEdit = [
  "\t\tDSH_SESSION_ID: spec.owner.id,\n",
  "\t\tDSH_SESSION_ID: spec.owner.id,\n\t\t...spec.owner.ctx.get(\"opencraftExecutionThread\")?.environment?.(String(spec.owner.id)),\n\t\tOPENCRAFT_THREAD_ID: spec.owner.ctx.get(\"opencraftExecutionThread\")?.resolve(String(spec.owner.id)) ?? \"\",\n",
];
export async function patchDshThreadEnvironment(runtime) {
  const outputs = [];
  for (const [module, [before, after]] of [
    ["dsh-bash-local", threadEnvironmentEdit], ["dsh-terminal-bash", terminalThreadEnvironmentEdit],
  ]) {
    const path = resolve(runtime, `node_modules/@deepseek-ai/${module}/lib/index.js`);
    let source = await readFile(path, "utf8");
    const previous = module === "dsh-bash-local"
      ? "\t\t\t\t...spec.dshEnv,\n\t\t\t\tOPENCRAFT_THREAD_ID: spec.dshEnv?.DSH_OPENCRAFT_THREAD_ID ?? \"\"\n"
      : "\t\tDSH_SESSION_ID: spec.owner.id,\n\t\tOPENCRAFT_THREAD_ID: spec.owner.ctx.get(\"opencraftExecutionThread\")?.resolve(String(spec.owner.id)) ?? \"\",\n";
    if (!source.includes(after) && source.includes(previous)) source = source.replace(previous, before);
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2) throw new Error("Pinned DSH thread environment boundary changed; review before packaging");
    outputs.push([path, source.replace(before, after)]);
  }
  for (const [path, source] of outputs) await writeFile(path, source);
}
