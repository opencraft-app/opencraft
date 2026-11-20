import { consumeWorkspaceExecutionGrant, isWorkspaceExecutionMethod, workspaceGrantField,
  type WorkspaceExecutionSelection } from '@opencraft/sandbox-node/workspace-execution-channel';
import { codexSandboxRequestPolicy, type CodexWorkspaceNativeRequest } from './execution-sandbox.js';
import { ExecutionPreparationError } from './execution-preparation.js';

/** Enabled only with the matching Gateway authority. Every execution, including
 * local execution, needs an explicit classification; an absent remote ticket
 * can therefore never become a local request after Gateway or APP restart. */
export function privateWorkspaceExecutionPolicy(options: {
  socketPath: string; token: string; readThread(threadId: string): Promise<unknown>;
  projectlessRoot?: string; nativeRequest: CodexWorkspaceNativeRequest;
}) {
  type Bound = Extract<WorkspaceExecutionSelection, { kind: 'bound' }>;
  const registrations = new Map<string, { generation: number; url: string; pending: Promise<void> }>();
  const register = async (selection: Bound, request: CodexWorkspaceNativeRequest) => {
    let entry = registrations.get(selection.environmentId);
    if (entry && (entry.generation > selection.generation || (entry.generation === selection.generation && entry.url !== selection.execServerUrl)))
      throw new Error('Stale workspace execution incarnation');
    if (!entry || entry.generation < selection.generation) {
      if (!entry && registrations.size >= 4096) throw new Error('Workspace registration capacity reached');
      const previous = entry;
      const next = { generation: selection.generation, url: selection.execServerUrl, pending: Promise.resolve() };
      // Serialize re-registration. A new lease cannot race an old handshake into
      // becoming the final Native environment. Failed receipts stay fenced.
      next.pending = Promise.resolve().then(async () => {
        await previous?.pending.catch(() => {});
        if (registrations.get(selection.environmentId) !== next) throw new Error('Workspace registration superseded');
        await request('environment/add', { environmentId: selection.environmentId, execServerUrl: selection.execServerUrl, connectTimeoutMs: 30000 });
      });
      registrations.set(selection.environmentId, next); entry = next;
    }
    await entry.pending;
    if (registrations.get(selection.environmentId) !== entry) throw new Error('Workspace registration superseded');
  };
  return async (method: unknown, input: Record<string, unknown>) => {
    if (!isWorkspaceExecutionMethod(method)) {
      if (Object.hasOwn(input, workspaceGrantField)) throw new ExecutionPreparationError('workspace-binding-unavailable');
      return input;
    }
    const { [workspaceGrantField]: ticket, ...params } = input;
    let selection: WorkspaceExecutionSelection;
    try { selection = await consumeWorkspaceExecutionGrant(options, ticket, method, params); }
    catch { throw new ExecutionPreparationError('workspace-binding-unavailable'); }
    return codexSandboxRequestPolicy(options.readThread, options.projectlessRoot, async () => {
      if (selection.kind === 'local') return selection;
      const bound = selection;
      return { kind: 'bound', binding: {
        registerExecutionEnvironment: request => register(bound, request),
        // Gateway reauthorized at one-shot consumption; the private bridge also
        // authorizes each exec-server request and closes on lease loss.
        async executionFields() { return { cwd: bound.cwd, environments: [{ environmentId: bound.environmentId, cwd: bound.cwd }] }; },
      } };
    }, options.nativeRequest)(method, params);
  };
}
