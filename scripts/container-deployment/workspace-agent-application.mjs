import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deploymentPaths } from "./paths.mjs";
import {
  createAgentIncarnation,
  createWorkspaceAgentSupervisor,
  prepareAgentRunDirectory,
} from "./workspace-agent-supervisor.mjs";
import { WORKSPACE_AGENT_ROLES } from "./workspace-agent-roles.mjs";
import { serveSandboxLink } from "@opencraft/sandbox-node/static-docker";
import { readCgroupLimits } from "@opencraft/sandbox-node/cgroup";

/** How the Host reaches this agent when its provider is `static-docker`: a link
 * directory mounted only into this container and the Gateway. Other providers bring
 * their own process channel (E2B commands, docker exec, container.exec) and set none. */
export async function serveAgentLink(agent, paths, env = process.env, { limits = () => readCgroupLimits() } = {}) {
  if (!paths.agentLinkDirectory) return;
  const policy = env.OPENCRAFT_AGENT_LINK_POLICY || "relay-only";
  const python = env.OPENCRAFT_AGENT_PYTHON || "/usr/bin/python3";
  const link = await serveSandboxLink({
    directory: paths.agentLinkDirectory,
    incarnation: agent.incarnation,
    python,
    policy,
    endpointDirectory: paths.agentEndpointDirectory,
    limits,
    log: (value) => console.log(JSON.stringify({ ...value, incarnation: agent.incarnation.id })),
  });
  agent.defer(() => link.close());
}

/** The in-container resident supervisor, the single entry of every workspace container.
 * It is the container's main process (not a child of a Gateway/WorkspaceHost stream), so
 * a Gateway restart never ends its children. Roles select which owners it runs; provider
 * differences stay in that composition. Any critical child failure ends the agent: the
 * container restarts with a new incarnation and upstream interrupted-turn recovery applies. */
/** `ownerPrivileges` is a policy already validated by the composition (see
 * hands-owner-privileges.mjs); `spawnOwner(command, args, options, { role })` replaces
 * `child_process.spawn` for every child and receives each Hands owner's stable role. */
export async function startWorkspaceAgent({
  roles,
  startServices,
  env = process.env,
  signals = process,
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  ownerPrivileges,
  spawnOwner,
} = {}) {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    throw new Error("The native execution bundle requires matching Linux arm64 or amd64");
  // No roles: a bare workspace environment (control endpoint and provider link only).
  if (
    !Array.isArray(roles) ||
    new Set(roles).size !== roles.length ||
    !roles.every((role) => Object.hasOwn(WORKSPACE_AGENT_ROLES, role))
  )
    throw new Error(`Select workspace agent roles from: ${Object.keys(WORKSPACE_AGENT_ROLES).join(", ")}`);
  const paths = deploymentPaths(env);
  await prepareAgentRunDirectory(paths.agentRunDirectory);
  const agent = createWorkspaceAgentSupervisor({
    runDirectory: paths.agentRunDirectory,
    incarnation: await createAgentIncarnation(),
    roles,
    ...(spawnOwner ? { spawnProcess: spawnOwner } : {}),
  });
  const interrupt = () => void agent.stop(0, "signal");
  signals.once("SIGINT", interrupt);
  signals.once("SIGTERM", interrupt);
  try {
    await agent.serveControl();
    const started = [];
    for (const role of roles)
      started.push(
        await WORKSPACE_AGENT_ROLES[role].start(agent, { paths, root, env, startServices, ownerPrivileges }),
      );
    agent.markReady();
    // The link opens only after every role is ready, so an attached Host sees a complete agent.
    await serveAgentLink(agent, paths, env);
    for (const role of started) void role.afterReady?.();
  } catch (error) {
    if (agent.state !== "stopping") console.error(error.message);
    void agent.stop(1, "startup failed");
  }
  return agent;
}

export function parseAgentRoles(argv) {
  const roles = [];
  if (argv.length === 1 && argv[0] === "--bare") return roles;
  if (argv.length === 0) throw new Error("Usage: workspace-agent.mjs --role brain|hands|browser [--role ...] | --bare");
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== "--role" || !argv[index + 1])
      throw new Error("Usage: workspace-agent.mjs --role brain|hands|browser [--role ...] | --bare");
    roles.push(argv[++index]);
  }
  return roles;
}
