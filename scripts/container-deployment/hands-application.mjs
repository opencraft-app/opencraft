import { startWorkspaceAgent } from './workspace-agent-application.mjs';
import { HANDS_OWNER_PROCESSES } from './workspace-agent-roles.mjs';
import { resolveHandsOwnerPrivileges } from './hands-owner-privileges.mjs';

export { HANDS_OWNER_PROCESSES };

/** Hands container composition: the workspace agent with the Hands and browser roles.
 * Only trusted product composition supplies services; no directory/module scanning.
 *
 * `spawnOwner(command, args, options, { role })` defaults to `child_process.spawn`,
 * which ignores the fourth argument; wrappers should select policy by `role`.
 *
 * `ownerPrivileges` optionally runs named owner roles under an unprivileged
 * `{ uid, gid, home? }` while the agent runs as UID 0 (see hands-owner-privileges.mjs).
 * It is validated before any service or owner starts; the resulting `uid`, `gid` and
 * `env.HOME` are already in the options `spawnOwner` receives. Without it, every owner
 * inherits the agent identity as before.
 *
 * `linkOwner` is set only by the root Hands composition (root-hands.mjs): the nonroot
 * Host identity the root agent serves its static-docker link to. */
export async function startContainerHands({ startServices = async () => [], spawnOwner, ownerPrivileges, linkOwner, env = process.env } = {}) {
  const privileges = await resolveHandsOwnerPrivileges(ownerPrivileges, { roles: HANDS_OWNER_PROCESSES.map(owner => owner.role), environment: env });
  const agent = await startWorkspaceAgent({ roles: ['hands', 'browser'], startServices, env, ownerPrivileges: privileges,
    ...(spawnOwner ? { spawnOwner } : {}), ...(linkOwner ? { linkOwner } : {}) });
  void agent.exited.then(code => { process.exitCode = code; });
  return agent;
}
