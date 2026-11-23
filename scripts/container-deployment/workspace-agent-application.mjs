import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploymentPaths } from './paths.mjs';
import { createAgentIncarnation, createWorkspaceAgentSupervisor, prepareAgentRunDirectory } from './workspace-agent-supervisor.mjs';
import { WORKSPACE_AGENT_ROLES } from './workspace-agent-roles.mjs';

/** The in-container resident supervisor, the single entry of every workspace container.
 * It is the container's main process (not a child of a Gateway/WorkspaceHost stream), so
 * a Gateway restart never ends its children. Roles select which owners it runs; provider
 * differences stay in that composition. Any critical child failure ends the agent: the
 * container restarts with a new incarnation and upstream interrupted-turn recovery applies. */
export async function startWorkspaceAgent({ roles, startServices, env = process.env, signals = process,
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..') } = {}) {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))
    throw new Error('The native execution bundle requires matching Linux arm64 or amd64');
  if (!Array.isArray(roles) || roles.length === 0 || new Set(roles).size !== roles.length || !roles.every(role => Object.hasOwn(WORKSPACE_AGENT_ROLES, role)))
    throw new Error(`Select workspace agent roles from: ${Object.keys(WORKSPACE_AGENT_ROLES).join(', ')}`);
  const paths = deploymentPaths(env);
  await prepareAgentRunDirectory(paths.agentRunDirectory);
  const agent = createWorkspaceAgentSupervisor({ runDirectory: paths.agentRunDirectory, incarnation: await createAgentIncarnation(), roles });
  const interrupt = () => void agent.stop(0, 'signal');
  signals.once('SIGINT', interrupt); signals.once('SIGTERM', interrupt);
  try {
    await agent.serveControl();
    const started = [];
    for (const role of roles) started.push(await WORKSPACE_AGENT_ROLES[role].start(agent, { paths, root, env, startServices }));
    agent.markReady();
    for (const role of started) void role.afterReady?.();
  } catch (error) {
    if (agent.state !== 'stopping') console.error(error.message);
    void agent.stop(1, 'startup failed');
  }
  return agent;
}

export function parseAgentRoles(argv) {
  const roles = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== '--role' || !argv[index + 1]) throw new Error('Usage: workspace-agent.mjs --role brain|hands|browser [--role ...]');
    roles.push(argv[++index]);
  }
  return roles;
}
