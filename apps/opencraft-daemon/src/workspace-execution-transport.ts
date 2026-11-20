import type { DuplexTransport } from '@opencraft/appserver-client/transport';
import { isWorkspaceExecutionMethod, workspaceGrantField, type createWorkspaceExecutionAuthority,
  type WorkspaceExecutionMethod, type WorkspaceExecutionSelection } from '@opencraft/sandbox-node/workspace-execution-channel';

/** Decorate the private physical Native transport, after adapter model/MCP/actor
 * admission. This is NOT a renderer transport and cannot replace business auth.
 * prepare must resolve the durable placement (including internal/queued turns),
 * never infer local execution from a missing/expired remote binding. */
export function workspaceExecutionTransport(native: DuplexTransport,
  authority: Awaited<ReturnType<typeof createWorkspaceExecutionAuthority>>,
  prepare: (method: WorkspaceExecutionMethod, params: Readonly<Record<string, unknown>>, request: Readonly<{ id: string | number }>) => Promise<() => Promise<WorkspaceExecutionSelection>>,
): DuplexTransport {
  return {
    get status() { return native.status; },
    connect: signal => native.connect(signal),
    async send(frame, signal, progress) {
      signal?.throwIfAborted();
      const message = JSON.parse(frame);
      const params = message?.params;
      if (params && Object.hasOwn(params, workspaceGrantField)) throw new Error('Caller cannot supply private workspace admission');
      if (!isWorkspaceExecutionMethod(message?.method)) return native.send(frame, signal, progress);
      if ((typeof message.id !== 'string' && typeof message.id !== 'number') || !params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid workspace execution request');
      // Freeze the wire snapshot passed to trusted preparation. A callback may
      // retain references, but it cannot change the admitted request later.
      const freeze = (value: unknown) => { if (value && typeof value === 'object') { Object.freeze(value); for (const v of Object.values(value)) freeze(v); } };
      freeze(params);
      // This ID is correlation only. The deployment resolves it through the
      // adapter's private admission lookup, not through renderer identity fields.
      const resolve = await prepare(message.method, params, Object.freeze({ id: message.id }));
      signal?.throwIfAborted();
      const grant = authority.mint(message.method, params, resolve);
      const cancel = () => grant.cancel(); signal?.addEventListener('abort', cancel, { once: true });
      try {
        signal?.throwIfAborted();
        await native.send(JSON.stringify({ ...message, params: { ...params, [workspaceGrantField]: grant.ticket } }), signal, progress);
      } catch (error) { grant.cancel(); throw error; }
      finally { signal?.removeEventListener('abort', cancel); }
    },
    subscribeMessage: listener => native.subscribeMessage(listener),
    subscribeStatus: listener => native.subscribeStatus(listener),
    ...(native.captureMessageScope ? { captureMessageScope: () => native.captureMessageScope!() } : {}),
    ...(native.subscribeRecoveryHint ? { subscribeRecoveryHint: (listener: () => void) => native.subscribeRecoveryHint!(listener) } : {}),
    // The authority is shared by Gateway sessions and outlives this attachment.
    close: () => native.close(),
  };
}
