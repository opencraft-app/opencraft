import { validateWorkspaceExecutionSelection } from "@opencraft/sandbox-node/workspace-execution-channel";
import { randomUUID } from "node:crypto";
import type { SandboxEnvironment } from "@opencraft/sandbox";
import { createSandboxJsonRpcBridge } from "@opencraft/sandbox-node/json-rpc-bridge";
import { SandboxProcessService } from "./sandbox-process-service.js";
import type { ProcessContext } from "@opencraft/appserver-protocol";
import type { OrdinaryExecutionBinding } from "./ordinary-conversation-owner.js";
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
  terminalSupported?: boolean;
  probeTerminalAdmission?(): Promise<void>;
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
  let processes = processContext?.threadId && options.terminalSupported !== false ? new SandboxProcessService({ ...options,
    context: { ...processContext, threadId: processContext.threadId }, authorize }) : undefined;
  const processServices = new Set<SandboxProcessService>();
  if (processes) processServices.add(processes);
  const threadViews = new Map<string, OrdinaryExecutionBinding>();
  const threadClosures = new Map<string, Promise<void>>();
  let boundThreadId = processContext?.threadId ?? null;
  const validateThread = (threadId: string) => {
    if (typeof threadId !== "string" || !threadId || threadId.length > 512 || /[\x00-\x1f]/u.test(threadId))
      throw Error("Invalid sandbox thread identity");
  };
  const bridge = await createSandboxJsonRpcBridge({ sandbox: options.sandbox,
    command: { command: ["/opt/opencraft/runtime/codex/bin/codex", "exec-server", "--listen", "stdio"], cwd: options.cwd,
      env: { PATH: "/opt/opencraft/bin:/usr/local/bin:/usr/bin:/bin", HOME: "/home/user" } }, authorize,
    onLost() {
      closed = true;
      for (const service of processServices) void service.close().catch(() => options.onCleanupUnconfirmed());
      void files.close().catch(() => {});
      options.onLost();
    } });
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
    await files.close().catch(() => {});
    throw error;
  }
  let closing: Promise<void> | undefined;
  const binding = {
    environmentId,
    // Runtime attaches the browser after preparation; views must observe that attachment.
    browser: undefined as OrdinaryExecutionBinding["browser"],
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
      validateThread(threadId);
      if (boundThreadId && boundThreadId !== threadId) throw Error("Sandbox thread binding conflict");
      if (threadViews.has(threadId)) throw Error("Sandbox thread binding conflict");
      if (processContext && !processes && options.terminalSupported !== false) {
        processes = new SandboxProcessService({ ...options, context: { ...processContext, threadId }, authorize });
        processServices.add(processes);
      }
      boundThreadId = threadId;
    },
    /** Trusted owner only: membership must already be persisted and authorized.
     * This is a thread projection of one workspace lease, never fork admission. */
    async forThread(threadId: string): Promise<OrdinaryExecutionBinding> {
      await authorize();
      validateThread(threadId);
      const pendingClose = threadClosures.get(threadId);
      if (pendingClose) { await pendingClose; return binding.forThread(threadId); }
      if (threadId === boundThreadId) {
        if (processContext && !processes && options.terminalSupported !== false) {
          processes = new SandboxProcessService({ ...options, context: { ...processContext, threadId }, authorize });
          processServices.add(processes);
        }
      }
      const cached = threadViews.get(threadId);
      if (cached) {
        if (!cached.isCurrent?.()) throw Error("Sandbox thread view expired");
        return cached;
      }
      let viewClosed = false;
      const authorizeView = async () => {
        if (viewClosed) throw Error("Sandbox thread view expired");
        await authorize();
        if (viewClosed) throw Error("Sandbox thread view expired");
      };
      const threadProcesses = threadId === boundThreadId ? processes : processContext && options.terminalSupported !== false
        ? new SandboxProcessService({ ...options, context: { ...processContext, threadId }, authorize: authorizeView }) : undefined;
      if (threadProcesses) processServices.add(threadProcesses);
      const viewFiles: Pick<SandboxWorkspaceFiles, 'request'> = {
        async request(...args) { await authorizeView(); const value = await files.request(...args); await authorizeView(); return value; },
      };
      const view: OrdinaryExecutionBinding = {
        isCurrent: () => !viewClosed && !closed,
        files: viewFiles,
        processes: threadProcesses,
        get browser() {
          const browser = binding.browser;
          if (!browser) return undefined;
          return {
            assertCurrent() { if (viewClosed || closed) throw Error('Sandbox thread view expired'); browser.assertCurrent(); },
            async connect() {
              await authorizeView();
              const transport = await browser.connect();
              try { await authorizeView(); return transport; }
              catch (cause) { try { await transport.close(); } catch { options.onCleanupUnconfirmed(); } throw cause; }
            },
          };
        },
        async registerExecutionEnvironment(request) { await authorizeView(); await registerExecutionEnvironment(request); await authorizeView(); },
        async executionSelection() { await authorizeView(); const selection = await binding.executionSelection(); await authorizeView(); return selection; },
        async executionFields() { await authorizeView(); const fields = await binding.executionFields(); await authorizeView(); return fields; },
        async bindThread(id) { await authorizeView(); if (id !== threadId) throw Error("Sandbox thread binding conflict"); },
        close() {
          const pending = threadClosures.get(threadId);
          if (pending) return pending;
          if (viewClosed) return Promise.resolve();
          viewClosed = true;
          const closing = Promise.resolve().then(async () => {
            await threadProcesses?.close();
            if (threadProcesses) processServices.delete(threadProcesses);
            if (threadViews.get(threadId) === view) threadViews.delete(threadId);
            threadClosures.delete(threadId);
          });
          threadClosures.set(threadId, closing);
          return closing;
        },
      };
      threadViews.set(threadId, view);
      return view;
    },
    /** Retire only this thread's processes; the workspace bridge stays live. */
    async closeThread(threadId: string): Promise<void> {
      // Retained owner custody may clean up after business admission is revoked.
      validateThread(threadId);
      const pending = threadClosures.get(threadId);
      if (pending) return pending;
      const view = threadViews.get(threadId);
      if (view) await view.close();
      if (threadId !== boundThreadId) return;
      const retiring = view ? undefined : processes;
      const closing = Promise.resolve().then(async () => {
        await retiring?.close();
        if (retiring) processServices.delete(retiring);
        processes = undefined;
        threadClosures.delete(threadId);
      });
      threadClosures.set(threadId, closing);
      return closing;
    },
    async executionFields() {
      await authorize();
      return { cwd: options.cwd, runtimeWorkspaceRoots: [options.cwd],
        environments: [{ environmentId, cwd: options.cwd }] };
    },
    close(): Promise<void> {
      return closing ??= (async () => {
        closed = true;
        const results = await Promise.allSettled([bridge.close(), ...[...processServices].map(service => service.close()), files.close()]);
        if (results.some(result => result.status === "rejected")) { options.onCleanupUnconfirmed(); throw Error("Sandbox binding cleanup unconfirmed"); }
      })();
    },
  };
  return binding;
}
