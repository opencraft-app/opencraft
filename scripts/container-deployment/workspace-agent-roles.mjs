import { createServer } from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { readPrivateToken } from "./paths.mjs";
import { readPrivateJson } from "../../apps/headless-server/src/server-deployment/dsh-host-client.mjs";
import { handsResources } from "./resources.mjs";
import { coreHealth } from "../server-deployment/execution.mjs";
import { readDshHostIdentity } from "../../apps/headless-server/src/server-deployment/dsh-host-client.mjs";
import { readEngineHostIdentity } from "../../apps/headless-server/src/server-deployment/engine-host-client.mjs";
import { readHandsIncarnation, watchHandsIncarnation } from "./hands-incarnation.mjs";
import { codexCoreArguments, waitForProxy } from "./proxy-core.mjs";
import { handsOwnerSpawnOptions } from "./hands-owner-privileges.mjs";
import {
  appServerControlTokenFile,
  codexAppServerEnvironmentArguments,
  executionHostIssuer,
  relaunchOnIssuerChange,
  writeExecutionHostConfigurations,
} from "./execution-hosts.mjs";
import { readDaemonMachineIdentity } from "../../apps/opencraft-daemon/src/machine-identity.ts";

/** Roles are composition: which owners this agent supervises. They contain no provider
 * branch; a container (static Compose service today, a provisioned workspace later)
 * selects roles, and the supervisor treats every role child the same way. */

const privateDirectory = async (path, message) => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await stat(path);
  if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error(message);
};
const isSocket = async (path) => (await stat(path)).isSocket() || Promise.reject(new Error(`${path} is not a socket`));
const node = (root) => join(root, "bin/node");
const runtime = (root, entry) => join(root, "runtime", entry);

/** Brain's ENV issuer relaunch, entirely through the supervisor: Pi (it attaches DSH),
 * DSH and the AppServer (with its native process group) are retired deliberately, so
 * no stop is reported as a child failure; then `configure()` rewrites their launch
 * files and the AppServer, DSH and Pi start again as ordinary critical children. A
 * successor that does not become ready throws; the caller then ends the agent. Once
 * they are ready the agent's endpoint generation moves, so a Host observing it drops
 * the descriptors it cached for the retired owners. */
export async function relaunchBrainOwners(
  agent,
  owners,
  { configure, startAppServer, startHosts, appServerReady, hostsReady },
) {
  await agent.retire(owners.engineHost, { timeoutMs: 30_000 });
  await agent.retire(owners.dshHost, { timeoutMs: 30_000 });
  await agent.retire(owners.appServer);
  if (agent.signal.aborted) return;
  await configure();
  owners.appServer = startAppServer();
  await appServerReady();
  Object.assign(owners, startHosts());
  await hostsReady();
  // The DSH and Pi descriptors (pid, token) changed under the same incarnation.
  agent.endpointsReplaced();
}

/** Brain: Codex AppServer owner (+ native app-server), DSH and Pi engine hosts, and the
 * embedded account Core only when no proxy service owns it. */
export const brainRole = {
  name: "brain",
  async start(agent, { paths, root, env }) {
    await privateDirectory(paths.dataDirectory, "The data directory must be owned by this user with mode 0700");
    await mkdir(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
    await mkdir(paths.runDirectory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(join(paths.dataDirectory, "native-host"), { realpath: false, retries: 0 });
    agent.defer(() => release());
    // Earlier releases kept launch configuration, engine descriptors and the AppServer
    // sockets in the shared run directory; under the lock no other Brain uses them.
    for (const name of [
      "engine-host-config.json",
      "dsh-host-config.json",
      "codex-hands-sandbox.json",
      "native-internal.sock",
      "engine-host.json",
      "dsh-host.json",
      "codex-app-server.sock",
      "native.sock",
      "codex-app-server-environment.json",
    ])
      await rm(join(paths.runDirectory, name), { force: true });
    const executionResources = handsResources(env);
    try {
      await writeFile(paths.tokenPath, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await readPrivateToken(paths.tokenPath);
    // The AppServer owner's own control credential, fresh per incarnation and handed to
    // the Host only through the control endpoint. The embedded account Core (restore
    // path) forwards health with the account token, so that mode keeps one token.
    const appServerTokenFile = appServerControlTokenFile(paths);
    if (paths.proxyMode === "external")
      await writeFile(paths.appServerTokenFile, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    await privateDirectory(paths.codexPrivateDirectory, "The Codex private directory must be private");
    // With ENV delivery, DSH, Pi and the Codex AppServer pin the Gateway vault owner's
    // published issuer key. Brain starts before that owner, so only the stable
    // published key (or an unissuable one until it exists) can be pinned. The
    // AppServer's attachment names the machine the Gateway reads from the shared data directory.
    const pinnedIssuer = await executionHostIssuer(paths);
    const machineId = paths.environmentDelivery
      ? (await readDaemonMachineIdentity(paths.dataDirectory)).machineId
      : undefined;
    // Launch configuration is agent-private: only this container's children read it.
    await writeExecutionHostConfigurations(paths, root, env, pinnedIssuer, machineId);
    await writeFile(
      paths.sandboxConfig,
      JSON.stringify({
        schemaVersion: 1,
        backend: {
          id: "hands-unix",
          options: { endpoint: paths.handsExecutionEndpoint, tokenFile: paths.handsExecutionToken },
        },
        pool: { idPrefix: "codex-hands", capacity: executionResources, defaults: executionResources },
        environment: {
          mode: "selected",
          names: [
            "PATH",
            "LANG",
            "LC_ALL",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "NO_PROXY",
            "NODE_EXTRA_CA_CERTS",
            "SSL_CERT_FILE",
          ],
        },
      }) + "\n",
      { mode: 0o600 },
    );
    await mkdir(join(paths.dataDirectory, "codex"), { recursive: true, mode: 0o700 });
    const start = (name, entry, argv = [], extra = {}, options = {}) =>
      agent.start(name, node(root), [runtime(root, entry), ...argv], {
        cwd: paths.runtimeDirectory,
        env: { ...env, ...extra },
        ...options,
      });
    if (paths.proxyMode === "external") {
      // The proxy service owns the account Core and its fixed port; Brain only waits for it.
      console.log(
        JSON.stringify({
          type: "model-proxy-ready",
          ...(await waitForProxy(paths.coreEndpoint, paths.tokenPath, { signal: agent.signal })),
        }),
      );
    } else {
      // One fixed proxy port for this independently supervised execution lifetime.
      let proxyPort = paths.proxyPort;
      if (proxyPort === null) {
        const listener = createServer();
        listener.listen(0, "127.0.0.1");
        await once(listener, "listening");
        proxyPort = listener.address().port;
        await new Promise((accept) => listener.close(accept));
      }
      start(
        "codex-core",
        "codex-core.cjs",
        codexCoreArguments(paths, root, proxyPort, { runtimeEndpoint: paths.appServerEndpoint }),
      );
    }
    // Capture the Hands identity before Native can attach an execution lease.
    const handsIncarnation = await agent.waitUntil(
      (signal) => readHandsIncarnation(paths.handsExecutionEndpoint, { signal }),
      { description: "Hands execution owner" },
    );
    const appServerArgs = [
      "--endpoint",
      paths.appServerEndpoint,
      "--core-endpoint",
      paths.coreEndpoint,
      "--token-file",
      paths.tokenPath,
      "--control-token-file",
      appServerTokenFile,
      "--codex-executable",
      runtime(root, "codex/bin/codex"),
      "--runtime-directory",
      paths.runtimeDirectory,
      "--data-directory",
      join(paths.dataDirectory, "codex"),
      "--private-directory",
      paths.codexPrivateDirectory,
      // ENV delivery only: the receiver's launch file in this agent's private run directory.
      ...codexAppServerEnvironmentArguments(paths),
    ];
    const appServerEnv = {
      OPENCRAFT_SANDBOX_CONFIG: paths.sandboxConfig,
      OPENCRAFT_CODEX_PROJECTLESS_DIR: paths.codexProjectlessDirectory,
    };
    // The AppServer owner and its native process form one process group.
    const startAppServer = () =>
      start("codex-app-server", "codex-app-server.cjs", appServerArgs, appServerEnv, { processGroup: true });
    // With an external proxy, engines reach configured providers through it with their own caller token.
    const callerFile = (name) =>
      paths.proxyMode === "external"
        ? { OPENCRAFT_PROXY_CALLER_FILE: join(paths.runDirectory, "proxy-callers", name + ".json") }
        : {};
    const startHosts = () => ({
      dshHost: start("dsh-host", "dsh-host.mjs", [], {
        OPENCRAFT_DSH_HOST_CONFIG: paths.dshConfig,
        ...callerFile("dsh"),
      }),
      engineHost: start("engine-host", "engine-host.mjs", [], {
        OPENCRAFT_ENGINE_HOST_CONFIG: paths.engineConfig,
        ...callerFile("pi"),
      }),
    });
    const appServerReady = () =>
      agent.waitUntil(() => coreHealth(paths.appServerEndpoint, appServerTokenFile), {
        description: "Codex execution owner",
      });
    const hostsReady = () =>
      agent.waitUntil(
        () =>
          Promise.all([
            coreHealth(paths.appServerEndpoint, appServerTokenFile),
            readEngineHostIdentity(paths.engineDescriptor),
            readDshHostIdentity(paths.dshDescriptor),
          ]),
        { description: "Native execution Host" },
      );
    const owners = { appServer: startAppServer(), ...startHosts() };
    await hostsReady();
    // The Host reaches every Brain owner only as a named endpoint; credentials and
    // engine descriptors come from `describe` on the control endpoint.
    await agent.publishEndpoint("codex-control", paths.appServerEndpoint, async () => ({
      token: await readPrivateToken(appServerTokenFile),
    }));
    await agent.publishEndpoint("codex-native", paths.appServerNativeSocket);
    await agent.publishEndpoint("pi", paths.engineSocket, () => readPrivateJson(paths.engineDescriptor));
    await agent.publishEndpoint("dsh", paths.dshSocket, async () => {
      const { ownerHandoff: _ownerHandoff, ...descriptor } = await readPrivateJson(paths.dshDescriptor);
      return descriptor;
    });
    // AppServer replacements (Hands rebinding, issuer rotation) run one at a time.
    let replacing = Promise.resolve();
    const serially = (operation) => (replacing = replacing.catch(() => {}).then(operation));
    return {
      // Runs after the agent is ready.
      afterReady: () =>
        Promise.all([
          // A different Hands owner invalidates every cached stdio execution connection,
          // so the AppServer is replaced, never patched.
          watchHandsIncarnation({
            initial: handsIncarnation,
            signal: agent.signal,
            probe: () => readHandsIncarnation(paths.handsExecutionEndpoint, { signal: agent.signal }),
            replace: () =>
              serially(async () => {
                const next = await agent.replace(owners.appServer, startAppServer);
                if (!next) return;
                owners.appServer = next;
                await appServerReady();
                console.log(JSON.stringify({ type: "codex-hands-owner-rebound" }));
              }),
          }).catch(() => agent.stop(1, "Hands owner rebinding failed")),
          // ENV delivery only: a new vault-owner key (first enablement or explicit
          // rotation) relaunches Pi, DSH and the AppServer with it. Until that completes
          // they keep the previous key and deliveries fail closed.
          relaunchOnIssuerChange({
            paths,
            root,
            env,
            machineId,
            pinned: pinnedIssuer,
            signal: agent.signal,
            relaunch: (configure) =>
              serially(() =>
                relaunchBrainOwners(agent, owners, {
                  configure,
                  startAppServer,
                  startHosts,
                  appServerReady,
                  hostsReady,
                }),
              ),
          }).catch(() => agent.stop(1, "Environment issuer relaunch failed")),
        ]),
    };
  },
};

/**
 * Owner processes of the `hands` and `browser` roles. `role` is the stable identity a
 * composition uses for per-owner policy (for example dropping privileges for the
 * browser); `name` is the agent component and endpoint; entry paths are packaging
 * details and may change.
 */
export const HANDS_OWNER_PROCESSES = Object.freeze([
  Object.freeze({ role: "browser", name: "browser", entry: "browser/owner.cjs", args: Object.freeze([]) }),
  Object.freeze({ role: "execution", name: "exec", entry: "hands-execution-owner.mjs", args: Object.freeze([]) }),
  Object.freeze({
    role: "terminal",
    name: "terminal",
    entry: "hands-terminal-owner.mjs",
    args: Object.freeze(["--hands-terminal-owner"]),
  }),
  Object.freeze({ role: "files", name: "files", entry: "hands-files-owner.mjs", args: Object.freeze([]) }),
]);
const handsOwner = (role) => HANDS_OWNER_PROCESSES.find((owner) => owner.role === role);

/** Starts one Hands owner, under its dropped identity when the composition's validated
 * `ownerPrivileges` names its role (see hands-owner-privileges.mjs). */
function startHandsOwner(agent, { paths, root, env, ownerPrivileges = {} }, owner) {
  const options = handsOwnerSpawnOptions({ cwd: paths.runtimeDirectory, env }, ownerPrivileges[owner.role]);
  return agent.start(owner.name, node(root), [runtime(root, owner.entry), ...owner.args], {
    cwd: options.cwd,
    env: options.env,
    owner: { role: owner.role },
    ...(options.uid !== undefined ? { identity: { uid: options.uid, gid: options.gid } } : {}),
  });
}

/** Hands: fixed Codex exec-server owner, terminal owner (holds the PTYs; Host/Gateway
 * disconnects never end them) and the resident filesystem owner. */
export const handsRole = {
  name: "hands",
  async start(agent, context) {
    const { paths, env, startServices = async () => [] } = context;
    const services = await startServices(() => void agent.stop(1, "composition service failed"));
    agent.defer(() => Promise.all(services.map((service) => service.close())));
    const owners = [
      [handsOwner("execution"), env.OPENCRAFT_HANDS_EXECUTION_SOCKET],
      [handsOwner("terminal"), paths.terminalEndpoint],
      [handsOwner("files"), paths.fileSystemEndpoint],
    ];
    if (!owners[0][1]?.startsWith("/")) throw new Error("Set OPENCRAFT_HANDS_EXECUTION_SOCKET to an absolute path");
    for (const [owner] of owners) startHandsOwner(agent, context, owner);
    await agent.waitUntil(() => Promise.all(owners.map(([, socket]) => isSocket(socket))), {
      attempts: 120,
      description: "Hands owners",
    });
    const tokens = { terminal: paths.terminalToken, files: paths.fileSystemToken };
    for (const [{ name }, socket] of owners)
      await agent.publishEndpoint(
        name,
        socket,
        tokens[name] ? async () => ({ token: await readPrivateToken(tokens[name]) }) : undefined,
      );
    return {};
  },
};

/** Optional remote browser owner. */
export const browserRole = {
  name: "browser",
  async start(agent, context) {
    const { env, ownerPrivileges = {} } = context;
    const data = env.OPENCRAFT_BROWSER_DATA_DIR;
    if (!data || !data.startsWith("/")) throw new Error("Set OPENCRAFT_BROWSER_DATA_DIR to an absolute path");
    // A dropped browser keeps the declared directory it was validated against; the
    // supervisor never creates or re-owns it.
    if (!ownerPrivileges.browser)
      await privateDirectory(data, "Hands data directory must be private and owned by this user");
    startHandsOwner(agent, context, handsOwner("browser"));
    const socket = join(data, "owner.sock");
    await agent.waitUntil(() => isSocket(socket), { attempts: 120, description: "Browser owner" });
    await agent.publishEndpoint("browser", socket);
    return {};
  },
};

export const WORKSPACE_AGENT_ROLES = Object.freeze({ brain: brainRole, hands: handsRole, browser: browserRole });
