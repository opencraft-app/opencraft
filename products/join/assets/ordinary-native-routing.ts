import type { TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import type { createWorkspaceExecutionAuthority } from '@opencraft/sandbox-node/workspace-execution-channel';
import type { CodexWorkspaceHooks } from '../../../scripts/codex-workspace-hooks.mjs';
import { isWorkspacePlacement } from '@opencraft/chat-core';
import type { InstalledOrdinaryConversationRuntime, OrdinaryRuntimeAdmission } from './ordinary-conversation-runtime';
import { OrdinaryNativeCreation, OrdinaryNativeRestoration } from './ordinary-native-creation';
import { ordinaryNativeAttachment } from './ordinary-native-attachment';

const id = (value: unknown): value is string => typeof value === 'string'
  && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value);
const field = 'workspacePlacement';
/** Logical request data only. Host, principal, credentials and resolved paths
 * never come from this object. Public capability publication is separately gated. */
export function readOrdinaryWorkspacePlacement(params: Readonly<Record<string, unknown>>) {
  if (!Object.hasOwn(params, field)) return null;
  const p = params[field];
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw Error('Invalid workspace placement');
  const value = p as Record<string, unknown>;
  if (!isWorkspacePlacement(value)    || params.cwd != null || (params.runtimeWorkspaceRoots !== undefined
      && (!Array.isArray(params.runtimeWorkspaceRoots) || params.runtimeWorkspaceRoots.length !== 0))
    || (params.environments !== undefined && (!Array.isArray(params.environments) || params.environments.length !== 0)))
    throw Error('Invalid workspace placement');
  return {intentId:value.intentId,environment:structuredClone(value.environment),
    source:value.source === undefined ? {kind:'empty' as const} : structuredClone(value.source)};
}

/** A fresh instance for each physical adapter. Runtime/journal and authority
 * remain service-owned; the attachment owns only in-flight Native operations. */
export function ordinaryNativeRouting(options: {
  hostId: string;
  runtime: InstalledOrdinaryConversationRuntime;
  authority: Awaited<ReturnType<typeof createWorkspaceExecutionAuthority>>;
  admit(context: TransportSubmissionContext): OrdinaryRuntimeAdmission;
  restoreProvisional: NonNullable<CodexWorkspaceHooks['restoreProvisionalWorkspace']>;
  onCleanupUnconfirmed(): void;
}): CodexWorkspaceHooks {
  if (!id(options.hostId)) throw Error('Invalid workspace Host');
  let closed = false, attachment: ReturnType<typeof ordinaryNativeAttachment> | undefined;
  const assert = () => { if (closed) throw Error('Ordinary Native routing retired'); };
  const remote = (threadId: string) => { assert();return options.runtime.hasPlacement(options.hostId,threadId); };
  const creation = new OrdinaryNativeCreation(options.runtime, async(context,params) => {
    assert();const placement=readOrdinaryWorkspacePlacement(params);
    if (!placement) throw Error('Workspace placement missing');
    return {...placement,admission:options.admit(context)};
  });
  const restoration = new OrdinaryNativeRestoration(options.runtime, async(context,params) => {
    assert();if(!id(params.threadId))throw Error('Invalid workspace thread');
    return {threadId:params.threadId,admission:options.admit(context)};
  });
  const finalize: NonNullable<CodexWorkspaceHooks['finalizeNativeCreation']> = async input => {
    assert();if (!attachment) throw Error('Workspace attachment unavailable');
    await attachment.finalize(input);
  };
  return {
    async readWorkspaceArtifact(threadId, path, context, signal) {
      assert();
      if (!remote(threadId)) throw Error('Workspace output has no remote placement');
      const original = options.admit(context);
      const admission = {...original, authorize: async () => {
        assert(); context.resourceOwner?.assertCurrent();
        const current = options.admit(context);
        if (current.authority.principalId !== original.authority.principalId
          || current.authority.hostId !== original.authority.hostId || current.catalog.scope !== original.catalog.scope)
          throw Error('Workspace output authority changed');
        await original.authorize();
      }};
      return options.runtime.readArtifactFor(admission, threadId, path, signal);
    },
    async prepareWorkspaceArtifact(artifact, threadId, context, signal) {
      assert();
      if (!remote(threadId)) return null;
      if (!context) throw Error('Workspace attachment execution authority unavailable');
      const admission = options.admit(context);
      const delivered = await options.runtime.prepareArtifactFor(admission, threadId, artifact, signal);
      assert(); options.admit(context); await admission.authorize();
      return delivered;
    },
    decorateNativeTransport(native,lookup) {
      assert();if(attachment)throw Error('Workspace attachment already installed');
      attachment=ordinaryNativeAttachment({
        native,lookup,authority:options.authority,creation,
        restoration:{operation:restoration,isWorkspaceResume:params=>id(params.threadId)&&remote(params.threadId)},
        isWorkspaceStart:params=>readOrdinaryWorkspacePlacement(params)!==null,
        onCleanupUnconfirmed:options.onCleanupUnconfirmed,
        async prepareExecution(request,params) {
          assert();request.context();
          if(request.method==='thread/start') {
            if(readOrdinaryWorkspacePlacement(params))throw Error('Workspace creation not admitted');
            return async()=>{assert();request.context();return {kind:'local' as const}};
          }
          if(!id(params.threadId))throw Error('Invalid execution thread');
          const threadId=params.threadId;
          if(!remote(threadId))return async()=>{
            assert();request.context();
            if(remote(threadId))throw Error('Execution placement changed');
            return {kind:'local' as const};
          };
          // Existing remote resumes use the explicit receipt handoff above.
          if(request.method!=='turn/start')throw Error('Workspace restoration not admitted');
          const admission=options.admit(request.context());
          const binding=await options.runtime.bindingFor(admission,threadId);
          return async()=>{
            assert();request.context();await admission.authorize();
            if(await options.runtime.bindingFor(admission,threadId)!==binding||!binding.executionSelection)
              throw Error('Workspace execution binding changed');
            const selection=await binding.executionSelection();
            assert();request.context();await admission.authorize();return selection;
          };
        },
      });
      const transport=attachment.transport;
      return {...transport,get status(){return transport.status},
        async send(frame,signal,progress) {
          assert();const message=JSON.parse(frame),params=message?.params;
          if(params&&typeof params==='object'){
            if(message.method!=='thread/start'&&Object.hasOwn(params,field))throw Error('Placement is creation-only');
            // History/path can override threadId in Native. This entry point
            // accepts durable IDs, never an alternate rollout chosen by a caller.
            if(['thread/resume','thread/fork'].includes(message.method)
              && (!id(params.threadId)||params.history!=null||(params.path!=null&&params.path!=='')))
              throw Error('Workspace routing requires a durable thread ID');
            if(Array.isArray(params.environments)&&params.environments.some((env:unknown)=>
              env&&typeof env==='object'&&typeof (env as {environmentId?:unknown}).environmentId==='string'
              && (env as {environmentId:string}).environmentId.startsWith('workspace-'))
              && (!id(params.threadId)||!remote(params.threadId)))
              throw Error('Workspace environment has no admitted placement');
            // Fork needs a separately admitted working copy; never inherit the
            // parent's private environment through an unclassified Native fork.
            if(message.method==='thread/fork'&&id(params.threadId)&&remote(params.threadId))
              throw Error('Sandbox conversation fork is not yet supported');
          }
          return transport.send(frame,signal,progress);
        },
        close(){closed=true;return transport.close()},
      };
    },
    finalizeNativeCreation:finalize,finalizeNativeResume:finalize,
    requiresWorkspaceResume:remote,
    async restoreProvisionalWorkspace(input){assert();await options.restoreProvisional(input);assert()},
  };
}
