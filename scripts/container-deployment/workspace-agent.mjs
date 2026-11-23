import { parseAgentRoles, startWorkspaceAgent } from './workspace-agent-application.mjs';

// Container entry: `workspace-agent.mjs --role brain`, `--role hands --role browser`, ...
try {
  const agent = await startWorkspaceAgent({ roles: parseAgentRoles(process.argv.slice(2)) });
  process.exitCode = await agent.exited;
} catch (error) { console.error(error.message); process.exitCode = 1; }
