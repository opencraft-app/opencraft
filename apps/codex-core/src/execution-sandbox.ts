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
  const args = ["--max-old-space-size=128", selection.runner, "--config", selection.configuration, "--owner", "codex", "--", executable, "exec-server", "--listen", "stdio"];
  const text = marker + 'default = "opencraft"\ninclude_local = ' + boundedLocal + '\n\n[[environments]]\nid = "opencraft"\n'
    + 'program = ' + quote(process.execPath) + '\nargs = [' + args.map(quote).join(', ') + ']\ninitialize_timeout_sec = 45\n'
    + '[environments.env]\n' + ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "ENV"].map(key => key + ' = ""\n').join('');
  const temporary = path + '.' + randomUUID();
  await writeFile(temporary, text, { mode: 0o600, flag: "wx" }); await rename(temporary, path);
}

/** Trusted admission must classify every execution request when installed. A
 * missing/revoked remote binding must throw, never be classified as local. This
 * callback is in-process owner wiring, not a renderer-selectable environment. */
export type CodexWorkspaceNativeRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type CodexWorkspaceResolver = (
  method: "thread/start" | "thread/resume" | "turn/start", params: Readonly<Record<string, unknown>>,
) => Promise<{ kind: "local" } | { kind: "bound"; binding: {
  /** Register on the final Native generation, never through the generation router. */
  registerExecutionEnvironment?(request: CodexWorkspaceNativeRequest): Promise<void>;
  /** Reauthorizes the principal and checks the live compute incarnation. */
  executionFields(): Promise<{ cwd: string; environments: { environmentId: string; cwd: string }[] }>;
} }>;

/** Native's stable protocol omits experimental environments. Apply the owner policy
 * at the wire boundary while retaining every caller permission and workspace field. */
export function codexSandboxRequestPolicy(readThread: (threadId: string) => Promise<unknown>, projectlessRoot?: string, resolveWorkspace?: CodexWorkspaceResolver, nativeRequest?: CodexWorkspaceNativeRequest) {
  return async (method: unknown, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (method !== "thread/start" && method !== "thread/resume" && method !== "turn/start") return params;
    if (resolveWorkspace) {
      let selection: Awaited<ReturnType<CodexWorkspaceResolver>>;
      try { selection = await resolveWorkspace(method, params); }
      catch { throw new ExecutionPreparationError("workspace-binding-unavailable"); }
      if (selection?.kind === "bound") {
        // Native history/path resume can override threadId. A bound workspace
        // may only resume its authorized persisted thread, never another rollout.
        if (method === "thread/resume" && (params.history != null || (params.path != null && params.path !== "")))
          throw new ExecutionPreparationError("workspace-binding-conflict");
        let fields: Awaited<ReturnType<Extract<Awaited<ReturnType<CodexWorkspaceResolver>>, { kind: "bound" }>["binding"]["executionFields"]>>;
        try { fields = await selection.binding.executionFields(); }
        catch { throw new ExecutionPreparationError("workspace-binding-unavailable"); }
        // Never use caller environments or roots to redirect the trusted binding.
        const cwd = fields?.cwd, env = fields?.environments;
        if (typeof cwd !== "string" || !cwd.startsWith("/") || /[\\\x00-\x1f]/u.test(cwd)
          || cwd.split("/").some(p => p === "." || p === "..")
          || !Array.isArray(env) || env.length !== 1 || env[0]?.cwd !== cwd
          || typeof env[0]?.environmentId !== "string" || !/^workspace-[a-zA-Z0-9_-]{1,160}$/u.test(env[0].environmentId))
          throw new ExecutionPreparationError("invalid-workspace-binding");
        if ((params.cwd != null && params.cwd !== cwd) || (params.runtimeWorkspaceRoots !== undefined
          && (!Array.isArray(params.runtimeWorkspaceRoots) || params.runtimeWorkspaceRoots.length !== 1 || params.runtimeWorkspaceRoots[0] !== cwd)))
          throw new ExecutionPreparationError("workspace-binding-conflict");
        const environmentId = env[0].environmentId;
        if (selection.binding.registerExecutionEnvironment) {
          if (!nativeRequest) throw new ExecutionPreparationError("workspace-binding-unavailable");
          try {
            await selection.binding.registerExecutionEnvironment(nativeRequest);
            // Registration can await a remote handshake. Recheck authorization and
            // incarnation before forwarding; a changed binding is never replayed.
            const current = await selection.binding.executionFields();
            if (current.cwd !== cwd || current.environments.length !== 1
              || current.environments[0]?.environmentId !== environmentId || current.environments[0]?.cwd !== cwd)
              throw new Error("Workspace incarnation changed");
          } catch { throw new ExecutionPreparationError("workspace-binding-unavailable"); }
        }
        return { ...params, cwd, runtimeWorkspaceRoots: [cwd], environments: [{ environmentId, cwd }] };
      }
      if (selection?.kind !== "local") throw new ExecutionPreparationError("workspace-binding-unavailable");
    }
    // Preserve legacy local resume behavior; only bound restores need routing.
    if (method === "thread/resume") return params;
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
