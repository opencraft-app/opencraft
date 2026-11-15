import type { ActorContext } from '@opencraft/identity-core/actors';
import type { ActorStore } from './actors.js';

const binding = {provider: 'opencraft-deployment', subject: 'anonymous-operator'};

/** The reserved binding belongs to deployment authority, not an installed account. */
export function isDeploymentOperator(actors: ActorStore, id: string): boolean {
  return actors.findHuman(binding)?.id === id;
}

/** Trusted Headless assembly only. Never attach this context to a browser login.
 * A new boot fences old execution delegations, including when login is enabled.
 */
export function deploymentOperator(actors: ActorStore, enabled: boolean, current: () => boolean) {
  const prior = actors.findHuman(binding);
  if (prior) actors.setEnabled(prior.id, false, 'deployment-operator');
  if (!enabled) return { context: () => undefined, owns: (_id: string) => false };
  if (prior) actors.setEnabled(prior.id, true, 'deployment-operator');
  const actor = actors.resolveHuman({...binding, displayName: 'Deployment operator', expiresAt: Date.now() + 86_400_000})!;
  return {
    context(): ActorContext | undefined {
      if (!current()) return undefined;
      const context = {...actor, expiresAt: Date.now() + 86_400_000};
      return actors.isCurrent(context) ? context : undefined;
    },
    owns: (id: string) => id === actor.actorId,
  };
}
