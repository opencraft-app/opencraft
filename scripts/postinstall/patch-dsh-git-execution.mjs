import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Keep the SDK's own validation, approval, process and job owners. Prepare only
// at its existing async boundary, before a foreground/background/PTY allocation.
export const bashGitEdit = [
  "\t\t\tvalidateBashArgs(args);\n",
  '\t\t\tvalidateBashArgs(args);\n\t\t\tconst opencraftEnvironment = await ctx.get("opencraftExecutionThread")?.prepare?.(exec) ?? {};\n\t\t\texec.signal.throwIfAborted();\n',
];
export const bashGitEnvironmentEdit = ["\t\t\t\tdshEnv,\n", "\t\t\t\tdshEnv,\n\t\t\t\tenv: opencraftEnvironment,\n"];
export const terminalGitEdit = [
  "\tasync spawn(spec) {\n\t\tspec.signal?.throwIfAborted();\n",
  '\tasync spawn(spec) {\n\t\tspec.signal?.throwIfAborted();\n\t\tconst opencraftEnvironment = await spec.owner.ctx.get("opencraftExecutionThread")?.prepare?.({agent: spec.owner, signal: spec.signal}) ?? {};\n\t\tspec.signal?.throwIfAborted();\n',
];
export const terminalGitEnvironmentEdit = [
  "\t\t\tenv: childEnvironment(spec, this.config.shellDialect),\n",
  "\t\t\tenv: {...childEnvironment(spec, this.config.shellDialect), ...opencraftEnvironment},\n",
];
export async function patchDshGitExecution(runtime) {
  const outputs = [];
  for (const [name, edits] of [
    ["dsh-tool-bash", [bashGitEdit, bashGitEnvironmentEdit]],
    ["dsh-terminal-bash", [terminalGitEdit, terminalGitEnvironmentEdit]],
  ]) {
    const path = resolve(runtime, `node_modules/@deepseek-ai/${name}/lib/index.js`);
    const original = await readFile(path, "utf8");
    let source = original;
    for (const [before, after] of edits) {
      if (source.split(after).length === 2) continue;
      if (source.split(before).length !== 2)
        throw Error("Pinned DSH asynchronous Git boundary changed; review before packaging");
      source = source.replace(before, after);
    }
    if (source !== original) outputs.push([path, source]);
  }
  // Validate both modules before writing either; never partially accept drift.
  for (const [path, source] of outputs) await writeFile(path, source);
}
