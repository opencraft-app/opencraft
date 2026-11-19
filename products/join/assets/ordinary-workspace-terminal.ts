import type { HostTerminalService, HostTerminalServiceSelector } from '../../../scripts/host-terminal-transport';
import type { TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import type { InstalledOrdinaryConversationRuntime, OrdinaryRuntimeAdmission } from './ordinary-conversation-runtime';
import type { OrdinaryExecutionBinding } from '../../../apps/local-agent-host/src/ordinary-conversation-owner';

/** Trusted selector for both Gateway terminal ingresses. Classification is a
 * host-wide journal lookup; authorization is a separate principal-scoped lookup.
 * Never turn an authorization/restore failure into permission to spawn locally. */
export function ordinaryWorkspaceTerminalSelector(options: {
  runtime: Pick<InstalledOrdinaryConversationRuntime, 'hasPlacement' | 'bindingFor'>;
  admit(context: TransportSubmissionContext): OrdinaryRuntimeAdmission;
  local: HostTerminalServiceSelector;
}): HostTerminalServiceSelector {
  // Stable wrapper identity keeps HostTerminalSession from accumulating another
  // stream subscription on every resize/write/attach request.
  const wrappers = new WeakMap<OrdinaryExecutionBinding, Map<string, HostTerminalService>>();
  return async (inputScope, context) => {
    const scope = { ...inputScope };
    if (!scope.threadId || !options.runtime.hasPlacement(scope.hostId, scope.threadId))
      return options.local(scope, context);
    const admission = options.admit(context), threadId = scope.threadId;
    if (admission.authority.hostId !== scope.hostId || scope.account !== admission.catalog.scope || scope.projectId !== null)
      throw Error('Workspace terminal scope mismatch');
    await admission.authorize();
    const binding = await options.runtime.bindingFor(admission, threadId), service = binding.processes;
    if (!service || !binding.isCurrent) throw Error('Workspace terminal unavailable');
    const current = () => {
      if (!admission.catalog.current() || !binding.isCurrent!() || binding.processes !== service)
        throw Error('Workspace terminal binding retired');
    };
    const check = async () => {
      current(); await admission.authorize();
      if (await options.runtime.bindingFor(admission, threadId) !== binding) throw Error('Workspace terminal binding replaced');
      current();
    };
    await check();
    const key = JSON.stringify([admission.authority, admission.catalog.scope, threadId]);
    let cached = wrappers.get(binding);
    if (!cached) { cached = new Map(); wrappers.set(binding, cached); }
    const existing = cached.get(key);
    if (existing) return existing;
    const proxy: HostTerminalService = {
      async probe() { await check(); await service.probe(); await check(); },
      subscribe(listener) {
        current();
        return service.subscribe((method, params) => {
          // HostTerminalSession independently checks each watching request/login.
          // This additional fence is the retained lease's business authority.
          try { current(); } catch { return; }
          listener(method, params);
        });
      },
      async dispatch(method, params, requested, assertCurrent, accepted) {
        if (!requested || requested.account !== scope.account || requested.hostId !== scope.hostId
          || requested.threadId !== threadId || requested.projectId !== null) throw Error('Workspace terminal scope changed');
        await check();
        const checkNow = () => { current(); assertCurrent?.(); };
        return service.dispatch(method, params, requested, checkNow, () => { checkNow(); accepted?.(); });
      },
    };
    cached.set(key, proxy);
    return proxy;
  };
}
