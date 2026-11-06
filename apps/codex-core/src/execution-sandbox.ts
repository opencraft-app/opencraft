import { mkdir, mkdtemp, readFile, writeFile, rename } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { readSandboxRuntimeConfiguration, verifySystemdExecutionOwner } from "@opencraft/sandbox-node/runtime";
import { ExecutionPreparationError } from "./execution-preparation.js";

export interface CodexExecutionSandbox { configuration: string; runner: string }
/** The official exec-server owns native filesystem/network sandbox enforcement.
 * OpenCraft only supplies its bounded execution transport. No local fallback. */
export async function configureCodexExecutionSandbox(home: string, executable: string, selection: CodexExecutionSandbox) {
  if (![home, executable, selection.configuration, selection.runner].every(isAbsolute)) throw new Error("Execution sandbox paths must be absolute");
  const policy = await readSandboxRuntimeConfiguration(selection.configuration);
  const boundedLocal = await verifySystemdExecutionOwner(policy);
  const path = join(home, "environments.toml"), marker = "# OpenCraft managed execution sandbox v1\n";
  try { if (!(await readFile(path, "utf8")).startsWith(marker)) throw new Error("Existing Codex execution environment requires explicit migration"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const quote = (value: string) => JSON.stringify(value);
  const args = ["--max-old-space-size=128", selection.runner, "--config", selection.configuration, "--owner", "codex", "--lifecycle-owner", String(process.pid), "--lifecycle-log", join(home, "exec-server-lifecycle.jsonl"), "--", executable, "exec-server", "--listen", "stdio"];
  const text = marker + 'default = "opencraft"\ninclude_local = ' + boundedLocal + '\n\n[[environments]]\nid = "opencraft"\n'
    + 'program = ' + quote(process.execPath) + '\nargs = [' + args.map(quote).join(', ') + ']\ninitialize_timeout_sec = 45\n'
    + '[environments.env]\n' + ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "ENV"].map(key => key + ' = ""\n').join('');
  const temporary = path + '.' + randomUUID();
  await writeFile(temporary, text, { mode: 0o600, flag: "wx" }); await rename(temporary, path);
}

/** Native's stable protocol omits experimental environments. Apply the owner policy
 * at the wire boundary while retaining every caller permission and workspace field. */
export function codexSandboxRequestPolicy(readThread: (threadId: string) => Promise<unknown>, projectlessRoot?: string, assertExecutable?: () => Promise<void>) {
  return async (method: unknown, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (["thread/start", "thread/fork", "turn/start", "turn/steer", "command/exec", "process/spawn"].includes(String(method)) || typeof method === "string" && method.startsWith("fs/")) await assertExecutable?.();
    if (method !== "thread/start" && method !== "turn/start") return params;
    let cwd = params.cwd;
    if (method === "thread/start" && cwd == null && projectlessRoot !== undefined) {
      try {
        if (!isAbsolute(projectlessRoot)) throw new Error("Projectless workspace root must be absolute");
        await mkdir(projectlessRoot, { recursive: true, mode: 0o700 });
        const directory = await mkdtemp(join(projectlessRoot, "thread-"));
        // Native persists cwd on the thread. Future turns use that binding.
        return { ...params, cwd: directory, runtimeWorkspaceRoots: [directory],
          environments: [{ environmentId: "opencraft", cwd: directory }] };
      } catch { throw new ExecutionPreparationError("projectless-workspace-create-failed"); }
    }
    if (method === "turn/start" && cwd == null) {
      if (typeof params.threadId !== "string" || !params.threadId) throw new ExecutionPreparationError("missing-thread-id");
      let value: { thread?: { cwd?: unknown } } | undefined;
      try { value = await readThread(params.threadId) as typeof value; }
      catch { throw new ExecutionPreparationError("thread-read-failed"); }
      cwd = value?.thread?.cwd;
    }
    if (cwd == null || cwd === "") throw new ExecutionPreparationError("missing-workspace");
    if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0")) throw new ExecutionPreparationError("invalid-workspace");
    return { ...params, environments: [{ environmentId: "opencraft", cwd }] };
  };
}
