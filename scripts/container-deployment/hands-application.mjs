import { startWorkspaceAgent } from './workspace-agent-application.mjs';

/** Hands container composition: the workspace agent with the Hands and browser roles.
 * Only trusted product composition supplies services; no directory/module scanning. */
export async function startContainerHands({ startServices = async () => [] } = {}) {
  const agent = await startWorkspaceAgent({ roles: ['hands', 'browser'], startServices });
  void agent.exited.then(code => { process.exitCode = code; });
  return agent;
}
