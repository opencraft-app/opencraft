import { validateWorkspaceExecutionSelection } from "@opencraft/sandbox-node/workspace-execution-channel";
import { randomUUID } from "node:crypto";
import type { SandboxEnvironment } from "@opencraft/sandbox";
import { createSandboxJsonRpcBridge } from "@opencraft/sandbox-node/json-rpc-bridge";
import { SandboxProcessService } from "./sandbox-process-service.js";
import type { ProcessContext } from "@opencraft/appserver-protocol";
import { SandboxWorkspaceFiles } from "./sandbox-workspace-files.js";

/** One Host-owned execution incarnation. Admission supplies the already authorized
 * persistent workspace/compute lease. Closing this transport does not delete that
 * workspace or release its compute budget; its lifecycle owner does that separately. */
export async function createSandboxConversationBinding(options: {
  sandbox: Pick<SandboxEnvironment, "spawn">;
  cwd: string;
  /** Stable Host-owned ID for Native sticky environments across compute restart. */
  environmentId?: string;
  /** Exact durable lease identity supplied by the ordinary workspace owner. */
  workspaceLease?: { workspaceId: string; generation: number };
  /** Trusted admission context, never copied from process request metadata. */
  processContext?: Pick<ProcessContext, "projectId" | "resourceOwnerId"> & { threadId?: string | null };
  authorize(): Promise<void>;
  onLost(): void;
  onCleanupUnconfirmed(): void;
  /** Legacy direct-Native registration. Omit when the final policy owns registration. */
  nativeRequest?(method: string, params: Record<string, unknown>): Promise<unknown>;
}) {
  const environmentId = options.environmentId ?? "workspace-" + randomUUID();
  if (!/^workspace-[a-zA-Z0-9_-]{1,160}$/.test(environmentId)) throw Error("Invalid sandbox environment identity");
  const workspaceLease = options.workspaceLease ? { ...options.workspaceLease } : undefined;
  if (workspaceLease && (!/^ws-[a-zA-Z0-9_-]{1,160}$/.test(workspaceLease.workspaceId)
    || !Number.isSafeInteger(workspaceLease.generation) || workspaceLease.generation < 1
    || environmentId !== 'workspace-' + workspaceLease.workspaceId)) throw Error('Invalid workspace lease identity');
  let closed = false;
  const authorize = async () => {
    if (closed) throw new Error("Sandbox conversation binding expired");
    await options.authorize();
    if (closed) throw new Error("Sandbox conversation binding expired");
  };
  // Validate the resolved root before registering the preinstalled executable.
  const files = new SandboxWorkspaceFiles({ sandbox: options.sandbox, root: options.cwd,
    python: "/usr/bin/python3", writable: true, authorize,
    onCleanupUnconfirmed: options.onCleanupUnconfirmed });
  const processContext = options.processContext ? { ...options.processContext } : undefined;
  let processes = processContext?.threadId ? new SandboxProcessService({ ...options,
    context: { ...processContext, threadId: processContext.threadId }, authorize }) : undefined;
  let boundThreadId = processContext?.threadId ?? null;
  const bridge = await createSandboxJsonRpcBridge({ sandbox: options.sandbox,
    command: { command: ["/opt/opencraft/runtime/codex/bin/codex", "exec-server", "--listen", "stdio"], cwd: options.cwd,
      env: { PATH: "/opt/opencraft/bin:/usr/local/bin:/usr/bin:/bin", HOME: "/home/user" } }, authorize,
    onLost() { closed = true; void processes?.close().catch(() => options.onCleanupUnconfirmed()); options.onLost(); } });
  type NativeRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;
  // Each target is an actual Native owner channel. A router channel is not a
  // target: it can select a different generation for an existing thread.
  const registrations = new WeakMap<NativeRequest, Promise<void>>();
  const registerExecutionEnvironment = async (request: NativeRequest) => {
    await authorize();
    let pending = registrations.get(request);
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        await authorize();
        await request("environment/add", { environmentId, execServerUrl: bridge.url, connectTimeoutMs: 30000 });
        await authorize();
      });
      registrations.set(request, pending);
      // Keep failed/uncertain registration fenced for this target. Retrying an
      // upsert could replace a live exec-server connection after a lost receipt.
    }
    await pending;
    await authorize();
  };
  try {
    if (options.nativeRequest) await registerExecutionEnvironment(options.nativeRequest);
  } catch (error) {
    closed = true;
    try { await bridge.close(); } catch { options.onCleanupUnconfirmed(); }
    throw error;
  }
  return {
    environmentId,
    isCurrent: () => !closed,
    registerExecutionEnvironment,
    /** Private Gateway admission only. Never expose the bridge URL in client/thread metadata. */
    async executionSelection() {
      await authorize();
      if (!workspaceLease) throw Error('Durable workspace lease identity unavailable');
      return validateWorkspaceExecutionSelection({ kind: 'bound', ...workspaceLease, environmentId,
        cwd: options.cwd, execServerUrl: bridge.url });
    },
    files,
    get processes() { return processes; },
    /** Called only after the owner has persisted the Native thread receipt. */
    async bindThread(threadId: string) {
      await authorize();
      if (typeof threadId !== "string" || !threadId || threadId.length > 512 || /[\x00-\x1f]/u.test(threadId))
        throw Error("Invalid sandbox thread identity");
      if (boundThreadId && boundThreadId !== threadId) throw Error("Sandbox thread binding conflict");
      if (processContext && !processes) processes = new SandboxProcessService({ ...options,
        context: { ...processContext, threadId }, authorize });
      boundThreadId = threadId;
    },
    async executionFields() {
      await authorize();
      return { cwd: options.cwd, runtimeWorkspaceRoots: [options.cwd],
        environments: [{ environmentId, cwd: options.cwd }] };
    },
    async close() {
      closed = true;
      const results = await Promise.allSettled([bridge.close(), processes?.close()]);
      if (results.some(result => result.status === "rejected")) { options.onCleanupUnconfirmed(); throw Error("Sandbox binding cleanup unconfirmed"); }
    },
  };
}
