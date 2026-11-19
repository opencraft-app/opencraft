import type { HostFileBinding, HostFileSelector } from '../../../scripts/host-filesystem-transport';
import type { TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import type { InstalledOrdinaryConversationRuntime, OrdinaryRuntimeAdmission } from './ordinary-conversation-runtime';

/** One selector shared by the existing Host filesystem session. Scope absence
 * delegates to the existing local policy explicitly; a requested remote scope
 * never falls back to Host paths, not even after a missing/retired binding. */
export function ordinaryWorkspaceFileSelector(options: {
  runtime: Pick<InstalledOrdinaryConversationRuntime, 'bindingFor'>;
  admit(context: TransportSubmissionContext): OrdinaryRuntimeAdmission;
  local: HostFileSelector;
}): HostFileSelector {
  return async (context, params) => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw Error('Invalid file request');
    if (!Object.hasOwn(params, 'workspaceThreadId')) return options.local(context, params);
    const threadId = (params as Record<string, unknown>).workspaceThreadId;
    if (typeof threadId !== 'string' || !threadId || threadId.length > 512 || /[\x00-\x1f\x7f]/u.test(threadId))
      throw Error('Invalid workspace file scope');
    const admission = options.admit(context);
    await admission.authorize();
    const binding = await options.runtime.bindingFor(admission, threadId);
    if (!binding.files) throw Error('Workspace files unavailable');
    const files = binding.files;
    const result: HostFileBinding = {
      files,
      async assertCurrent() {
        // Revalidate the current request as well as the original durable grant.
        // A fresh grant cannot revive this request after revoke/re-enable.
        const fresh = options.admit(context);
        if (fresh.authority.principalId !== admission.authority.principalId
          || fresh.authority.hostId !== admission.authority.hostId || fresh.catalog.scope !== admission.catalog.scope)
          throw Error('Workspace file authority changed');
        await admission.authorize();
        const current = await options.runtime.bindingFor(admission, threadId);
        if (current !== binding || current.files !== files) throw Error('Workspace file binding retired');
        await admission.authorize();
      },
    };
    await result.assertCurrent();
    return result;
  };
}
