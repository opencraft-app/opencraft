import type { TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import type { ActorStore } from '@opencraft/access-control/actors';
import type { InstanceAccess } from '@opencraft/access-control';
import type { OrdinaryRuntimeAdmission } from './ordinary-conversation-runtime';

type Dependencies = {
  actors: Pick<ActorStore, 'get' | 'bindings' | 'isCurrent'>;
  getInstanceAccess(): (Pick<InstanceAccess, 'admitsActor'> & { store: Pick<InstanceAccess['store'], 'revocationRevision'> }) | null | undefined;
  /** Trusted physical Host identity, never params.hostId. */
  hostId: string;
  current(): boolean;
};
function unavailable(): never { throw Error('ordinary_workspace_admission_unavailable'); }

/** Bridges the existing authenticated Gateway request to its durable business
 * owner. Input MUST come from CodexNativeRequestAdmission.context(), not JSON.
 * Admission checks the login; the retained lease checks actor generation, current
 * membership and the exact credential scope, like the installed Bot provider.
 * A subsequent file/terminal/restore request still needs its own live admission. */
export function admitOrdinaryWorkspace(context: TransportSubmissionContext, dependencies: Dependencies): OrdinaryRuntimeAdmission {
  const { actors, hostId } = dependencies;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(hostId) || !dependencies.current()) unavailable();
  context.resourceOwner?.assertCurrent();
  const authenticated = context.actorContext;
  const principal = context.executionPrincipal;
  if (!authenticated || !actors.isCurrent(authenticated) || !principal
    || principal.provider !== 'tencentoa' || typeof principal.subject !== 'string' || !principal.subject
    || principal.subject.length > 256 || /[\x00-\x1f\x7f]/u.test(principal.subject)
    || !Number.isFinite(context.validUntil) || context.validUntil! <= Date.now()) unavailable();
  // Snapshot identities: mutating a request after admission cannot select another
  // user's vault, nor may a live lease follow a rebound login identity.
  return admitOwner(authenticated.actorId, authenticated.generation, principal.subject, dependencies);
}

/** Internal-only: ownerId must come from the central durable browser page record,
 * after the browser service has admitted access. Never expose this as an RPC. */
export function admitOrdinaryBrowserOwner(ownerId: string, dependencies: Dependencies): OrdinaryRuntimeAdmission {
  const actor = dependencies.actors.get(ownerId);
  const bindings = dependencies.actors.bindings(ownerId).filter(binding => binding.provider === 'tencentoa');
  if (!actor || actor.kind !== 'human' || !actor.enabled || bindings.length !== 1) unavailable();
  return admitOwner(actor.id, actor.generation, bindings[0]!.subject, dependencies);
}

function admitOwner(actorId: string, generation: number, subject: string, dependencies: Dependencies): OrdinaryRuntimeAdmission {
  const { actors, hostId } = dependencies;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(hostId) || !dependencies.current()
    || !subject || subject.length > 256 || /[\x00-\x1f\x7f]/u.test(subject)) unavailable();
  const scope = 'tencentoa:' + subject;
  const access = dependencies.getInstanceAccess();
  if (!access?.admitsActor(actorId)) unavailable();
  const revision = access.store.revocationRevision(actorId, actors.bindings(actorId));
  const current = () => {
    if (!dependencies.current()) return false;
    const actor = actors.get(actorId), access = dependencies.getInstanceAccess();
    if (!actor || actor.kind !== 'human' || !actor.enabled || actor.generation !== generation
      || !access?.admitsActor(actorId)
      || access.store.revocationRevision(actorId, actors.bindings(actorId)) !== revision) return false;
    const bindings = actors.bindings(actorId).filter(binding => binding.provider === 'tencentoa');
    return bindings.length === 1 && bindings[0]!.subject === subject;
  };
  if (!current()) unavailable();
  return Object.freeze({
    authority: Object.freeze({ principalId: actorId, hostId }),
    catalog: Object.freeze({ scope, current }),
    authorize: async () => { if (!current()) unavailable(); },
  });
}
