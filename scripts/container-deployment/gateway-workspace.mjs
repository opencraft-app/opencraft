import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createSandboxPool,
  createWorkspaceRuntime,
  formatSandboxEnvironmentUri,
  isWorkspaceId,
  parseSandboxEnvironmentUris,
  parseWorkspaceEndpointUri,
} from "@opencraft/sandbox";
import { createSandboxProviderRegistry } from "@opencraft/sandbox/providers";
import { createSandboxEndpointListener } from "@opencraft/sandbox-node/endpoint-listener";
import { staticDockerSandboxProvider } from "@opencraft/sandbox-node/static-docker";
import { dockerProvisionerSandboxProvider } from "@opencraft/sandbox-node/docker-provisioner";
import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import { CodexCoreControlClient } from "@opencraft/account-pool-host";
import { websocketOnSocket } from "../../apps/headless-server/src/server-deployment/dsh-host-client.mjs";
import { proxyHealth } from "./proxy-core.mjs";

/** The Docker Gateway's `default` WorkspaceHost placement. The Gateway holds only
 * `workspace://default/endpoints/<name>` addresses; where they run is configuration:
 * `OPENCRAFT_WORKSPACE_ENVIRONMENTS` lists environment URIs (`static-docker://brain
 * static-docker://hands` until Brain and Hands merge). Existing clients keep dialling
 * sockets: each endpoint gets a private local listener whose every connection is one
 * workspace endpoint connection. Nothing is read from the shared `$DATA/run`.
 *
 * Further workspaces (§3.6, step 7b) resolve the same way: a workspace id selects its
 * environment URIs from configuration (`default` → `OPENCRAFT_WORKSPACE_ENVIRONMENTS`,
 * every other id → `OPENCRAFT_WORKSPACE_PROVISIONED_ENVIRONMENTS`, e.g.
 * `docker-provisioner://workspace`), and each gets its own WorkspaceRuntime, placement
 * record and local endpoint listeners. No code below branches on the provider. */

export const WORKSPACE_ID = "default";
export const DEFAULT_WORKSPACE_ENVIRONMENTS = "static-docker://brain static-docker://hands";
/** Endpoints this Gateway consumes, and how many concurrent local connections each allows
 * (callback lanes and isolated reads share codex-native). */
const CONSUMED = Object.freeze({
  "codex-control": 32,
  "codex-native": 96,
  pi: 32,
  dsh: 32,
  terminal: 8,
  files: 32,
  browser: 8,
});

const uri = (name, workspaceId = WORKSPACE_ID) =>
  parseWorkspaceEndpointUri(`workspace://${workspaceId}/endpoints/${name}`);
/** Endpoints a provisioned workspace serves through this Gateway today (Hands owners). */
const PROVISIONED_CONSUMED = Object.freeze({ terminal: 8, files: 32 });
const TOKEN_ENDPOINTS = Object.freeze(["terminal", "files"]);
const positive = (name, raw) => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
};
/** The budget the deployment declared for an environment (`OPENCRAFT_<TARGET>_CPUS`,
 * `_MEMORY_BYTES`); the provider must report exactly this as enforced. */
export function environmentResources(target, env = process.env) {
  const prefix = "OPENCRAFT_" + target.toUpperCase().replace(/[^A-Z0-9]/gu, "_");
  const cpuMillis = positive(`${prefix}_CPUS`, env[`${prefix}_CPUS`] ?? "4") * 1000;
  const memoryBytes = positive(`${prefix}_MEMORY_BYTES`, env[`${prefix}_MEMORY_BYTES`] ?? String(8 * 1024 ** 3));
  if (!Number.isSafeInteger(cpuMillis) || !Number.isSafeInteger(memoryBytes))
    throw new Error(`${prefix} budget must be whole millicpus and bytes`);
  return Object.freeze({ cpuMillis, memoryBytes });
}

/** WorkspaceHost placement records (receipt, agent incarnation) in the WorkspaceHost's
 * own state documents (`$DATA/workspaces/<id>/host`, §6.1). */
function placementStore(documents) {
  const KEY = "placement.json";
  const valid = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
  return {
    async read(address) {
      return valid(await documents.read(KEY))[formatSandboxEnvironmentUri(address)];
    },
    async write(address, record) {
      await documents.update(KEY, (current) => ({
        result: undefined,
        next: { ...valid(current), [formatSandboxEnvironmentUri(address)]: record },
      }));
    },
  };
}

/** Provider installations are deployment composition; a URI only selects among them. */
function providerComposition(env, linkRoot) {
  const installations = { "static-docker": { backend: "static-docker", linkRoot } };
  const providers = { "static-docker": staticDockerSandboxProvider() };
  if (env.OPENCRAFT_PROVISIONER_DIR) {
    const directory = env.OPENCRAFT_PROVISIONER_DIR,
      provisionedLinkRoot = env.OPENCRAFT_WORKSPACE_PROVISIONED_LINK_ROOT ?? join(linkRoot, "provisioned");
    if (!isAbsolute(directory) || !isAbsolute(provisionedLinkRoot))
      throw new Error("OPENCRAFT_PROVISIONER_DIR and OPENCRAFT_WORKSPACE_PROVISIONED_LINK_ROOT must be absolute");
    installations["docker-provisioner"] = { backend: "docker-provisioner", directory, linkRoot: provisionedLinkRoot };
    providers["docker-provisioner"] = dockerProvisionerSandboxProvider({
      aliases: (env.OPENCRAFT_PROVISIONER_IMAGES ?? "workspace").split(/[\s,]+/u).filter(Boolean),
    });
  }
  return { installations, providers };
}

/** One workspace's placement: a pool per environment over its registered provider and a
 * WorkspaceRuntime with the workspace's own placement record. */
async function placeWorkspace({
  workspaceId,
  addresses,
  registry,
  installations,
  dataDirectory,
  env,
  endpointDirectories,
  log,
}) {
  const hostDirectory = join(dataDirectory, "workspaces", workspaceId, "host");
  await mkdir(hostDirectory, { recursive: true, mode: 0o700 });
  const pools = [];
  try {
    const environments = [];
    for (const address of addresses) {
      const installation = installations[address.provider];
      if (!installation) throw new Error(`No ${address.provider} provider is installed in this deployment`);
      const { definition, templateId } = registry.environment(installation, address);
      const resources = environmentResources(templateId, env);
      const backend = definition.createBackend({
        installation,
        templateId,
        timeoutMs: 300_000,
        requestTimeoutMs: 15_000,
        // Link providers read their per-incarnation ticket themselves; no installation secret.
        readSecret: async () => {
          throw new Error("This provider has no installation secret");
        },
        // Providers that create per-workspace instances place this workspace only.
        readWorkspaceId: async () => workspaceId,
      });
      const pool = await createSandboxPool(
        {
          id: `workspace-${templateId}`.replace(/[^a-z0-9-]/gu, "-").slice(0, 32),
          capacity: resources,
          defaults: resources,
        },
        backend,
      );
      pools.push(pool);
      // Images publish endpoints at the fixed agent directory; in-process tests run agents elsewhere.
      const endpointDirectory = endpointDirectories[templateId];
      environments.push({ address, pool, ...(endpointDirectory ? { endpointDirectory } : {}) });
    }
    const runtime = createWorkspaceRuntime({
      workspaceId,
      owner: `workspace:${workspaceId}`,
      environments,
      store: placementStore(fileStateDocumentStore(hostDirectory, { private: { maxBytes: 64 * 1024 } })),
      onEvent: ({ type, ...event }) => log({ type: "workspace-placement", workspace: workspaceId, change: type, ...event }),
    });
    return { runtime, pools };
  } catch (error) {
    await Promise.allSettled(pools.map((pool) => pool.close()));
    throw error;
  }
}

/** Local listeners for a workspace's endpoints, each connection one endpoint connection. */
async function listenEndpoints({ runtime, workspaceId, consumed, directory, log, listeners }) {
  const sockets = {};
  for (const [name, maxConnections] of Object.entries(consumed)) {
    const listener = await createSandboxEndpointListener({
      connect: (onData) => runtime.connect(uri(name, workspaceId), onData),
      maxConnections,
      ...(directory ? { path: join(directory, name) } : {}),
      authorize: async () => {},
      onCleanupUnconfirmed: () =>
        log({ type: "workspace-endpoint-cleanup-unconfirmed", workspace: workspaceId, endpoint: name }),
    });
    listeners.push(listener);
    sockets[name] = listener.path;
  }
  return sockets;
}

const privateRunDirectory = async (path) => {
  for (const name of ["endpoints", "credentials"]) {
    await rm(join(path, name), { recursive: true, force: true });
    await mkdir(join(path, name), { recursive: true, mode: 0o700 });
  }
};

/** Workspaces other than `default` (§3.6, step 7b): each id is placed on first use over
 * the configured provisioned environments, with its own placement record, local endpoint
 * listeners under `<run>/workspaces/<id>/` and credential copies. Also the operator tool's
 * entry (workspace-admin.mjs), which never touches the `default` workspace. */
export function provisionedWorkspaces({
  dataDirectory,
  env = process.env,
  log = (value) => console.log(JSON.stringify(value)),
  providers,
  endpointDirectories = {},
  runDirectory,
  credentialsRoot,
}) {
  if (!isAbsolute(dataDirectory) || !isAbsolute(credentialsRoot ?? runDirectory ?? ""))
    throw new Error("Provisioned workspaces need absolute data and local directories");
  const linkRoot = env.OPENCRAFT_WORKSPACE_LINK_ROOT ?? "/run/opencraft-links";
  const composition = providerComposition(env, linkRoot);
  const registry = createSandboxProviderRegistry(providers ?? composition.providers);
  // Where every other workspace runs; unset means this deployment places only `default`.
  const provisioned = env.OPENCRAFT_WORKSPACE_PROVISIONED_ENVIRONMENTS
    ? parseSandboxEnvironmentUris(env.OPENCRAFT_WORKSPACE_PROVISIONED_ENVIRONMENTS)
    : undefined;
  const others = new Map();
  const localOf = (workspaceId) =>
    runDirectory ? join(runDirectory, "workspaces", workspaceId) : join(credentialsRoot, "workspaces", workspaceId);
  const credentialsOf = (workspaceId) =>
    runDirectory ? join(localOf(workspaceId), "credentials") : localOf(workspaceId);
  const closeEntry = async (entry) => {
    const results = await Promise.allSettled(entry.listeners.map((listener) => listener.close()));
    results.push(...(await Promise.allSettled([entry.runtime.close()])));
    await Promise.allSettled(entry.pools.map((pool) => pool.close()));
    await rm(localOf(entry.workspaceId), { recursive: true, force: true });
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Workspace endpoint cleanup is unconfirmed");
  };
  /** Copies endpoint credentials (only for endpoints the agents publish) into a private directory. */
  const writeTokens = async (runtime, workspaceId, published) => {
    const files = {};
    for (const name of TOKEN_ENDPOINTS) {
      if (!published.has(name)) continue;
      const value = (await runtime.describe(uri(name, workspaceId))).token;
      if (typeof value !== "string" || value.length < 32 || value.length > 512)
        throw new Error(`Workspace endpoint ${name} has no credential`);
      files[name] = join(credentialsOf(workspaceId), `${name}.token`);
      await writeFile(files[name], value + "\n", { mode: 0o600 });
    }
    return files;
  };
  const open = (workspaceId) => {
    if (!isWorkspaceId(workspaceId) || workspaceId === WORKSPACE_ID) throw new Error("Invalid workspace id");
    if (!provisioned) throw new Error(`This deployment places no workspace other than ${WORKSPACE_ID}`);
    let opening = others.get(workspaceId);
    if (opening) return opening;
    opening = (async () => {
      const placed = await placeWorkspace({
        workspaceId,
        addresses: provisioned,
        registry,
        installations: composition.installations,
        dataDirectory,
        env,
        endpointDirectories,
        log,
      });
      const entry = { workspaceId, ...placed, listeners: [] };
      try {
        if (runDirectory) await privateRunDirectory(localOf(workspaceId));
        else await mkdir(credentialsOf(workspaceId), { recursive: true, mode: 0o700 });
        entry.sockets = await listenEndpoints({
          runtime: placed.runtime,
          workspaceId,
          consumed: PROVISIONED_CONSUMED,
          directory: runDirectory && join(localOf(workspaceId), "endpoints"),
          log,
          listeners: entry.listeners,
        });
        entry.observe = async () => {
          const environments = await placed.runtime.observe();
          const published = new Set(environments.flatMap((environment) => environment.endpoints));
          entry.tokenFiles = await writeTokens(placed.runtime, workspaceId, published);
          return environments;
        };
        // Placing the workspace now (not on its first connection) reports a failure to the caller.
        await entry.observe();
        return entry;
      } catch (error) {
        await closeEntry(entry).catch(() => {});
        throw error;
      }
    })();
    others.set(workspaceId, opening);
    opening.catch(() => {
      if (others.get(workspaceId) === opening) others.delete(workspaceId);
    });
    return opening;
  };
  return {
    ids: () => [...others.keys()],
    /** Places (create, or re-attach by receipt) and serves a workspace's endpoints. */
    open: async (workspaceId) => open(workspaceId),
    /** Idle sleep (§3.7.2): providers that can sleep stop; the others stay resident. */
    async sleep(workspaceId) {
      return (await open(workspaceId)).runtime.sleep();
    },
    /** Removes the workspace's instances and cached volumes (content truth is Git). */
    async discard(workspaceId) {
      const entry = await open(workspaceId);
      others.delete(workspaceId);
      // Local connections end before their environment goes away.
      await Promise.allSettled(entry.listeners.splice(0).map((listener) => listener.close()));
      await entry.runtime.discard();
      await closeEntry(entry);
      log({ type: "workspace-discarded", workspace: workspaceId });
    },
    async close() {
      const results = await Promise.allSettled([...others.values()].map(async (opening) => closeEntry(await opening)));
      others.clear();
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Workspace endpoint cleanup is unconfirmed");
    },
  };
}

export async function openGatewayWorkspace({
  dataDirectory,
  env = process.env,
  log = (value) => console.log(JSON.stringify(value)),
  providers,
  endpointDirectories = {},
} = {}) {
  if (!isAbsolute(dataDirectory)) throw new Error("Gateway data directory must be absolute");
  const linkRoot = env.OPENCRAFT_WORKSPACE_LINK_ROOT ?? "/run/opencraft-links";
  if (!isAbsolute(linkRoot)) throw new Error("OPENCRAFT_WORKSPACE_LINK_ROOT must be absolute");
  const composition = providerComposition(env, linkRoot);
  const installations = composition.installations;
  const registry = createSandboxProviderRegistry(providers ?? composition.providers);
  const addresses = parseSandboxEnvironmentUris(env.OPENCRAFT_WORKSPACE_ENVIRONMENTS ?? DEFAULT_WORKSPACE_ENVIRONMENTS);
  // Local endpoint sockets and credential copies: a container-private tmpfs when the
  // deployment provides one (stable paths for operators and smoke probes), else temporary.
  const runDirectory = env.OPENCRAFT_GATEWAY_RUN_DIR || undefined;
  if (runDirectory !== undefined) {
    if (
      !isAbsolute(runDirectory) ||
      [dataDirectory, linkRoot].some((root) => runDirectory === root || runDirectory.startsWith(root + "/"))
    )
      throw new Error("OPENCRAFT_GATEWAY_RUN_DIR must be container-private");
    const info = await lstat(runDirectory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
      throw new Error("OPENCRAFT_GATEWAY_RUN_DIR must be a private directory owned by this user");
    await privateRunDirectory(runDirectory);
    await rm(join(runDirectory, "workspaces"), { recursive: true, force: true });
  }
  const pools = [],
    listeners = [];
  let runtime, credentials, others;
  const close = async () => {
    // Local connections end first (their relays terminate), then the environment sessions.
    const results = await Promise.allSettled([others?.close(), ...listeners.map((listener) => listener.close())]);
    results.push(...(await Promise.allSettled([runtime?.close()])));
    await Promise.allSettled(pools.map((pool) => pool.close()));
    if (credentials) await rm(credentials, { recursive: true, force: true });
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Workspace endpoint cleanup is unconfirmed");
  };
  try {
    const placed = await placeWorkspace({
      workspaceId: WORKSPACE_ID,
      addresses,
      registry,
      installations,
      dataDirectory,
      env,
      endpointDirectories,
      log,
    });
    runtime = placed.runtime;
    pools.push(...placed.pools);
    const sockets = await listenEndpoints({
      runtime,
      workspaceId: WORKSPACE_ID,
      consumed: CONSUMED,
      directory: runDirectory && join(runDirectory, "endpoints"),
      log,
      listeners,
    });
    const describe = (name) => runtime.describe(uri(name));
    const token = async (name) => {
      const value = (await describe(name)).token;
      if (typeof value !== "string" || value.length < 32 || value.length > 512)
        throw new Error(`Workspace endpoint ${name} has no credential`);
      return value;
    };
    // Clients that read a token file get a Gateway-private copy (Hands tokens persist
    // across Hands restarts; they are refreshed whenever health observes the workspace).
    credentials = runDirectory
      ? join(runDirectory, "credentials")
      : await mkdtemp(join(tmpdir(), "opencraft-workspace-credentials-"));
    await chmod(credentials, 0o700);
    others = provisionedWorkspaces({
      dataDirectory,
      env,
      log,
      providers,
      endpointDirectories,
      runDirectory,
      credentialsRoot: credentials,
    });
    const tokenFiles = { terminal: join(credentials, "terminal.token"), files: join(credentials, "files.token") };
    const refreshTokens = async () => {
      for (const [name, path] of Object.entries(tokenFiles))
        await writeFile(path, (await token(name)) + "\n", { mode: 0o600 });
    };
    await refreshTokens();
    // Engine descriptors: the in-environment socket is replaced by this Gateway's listener.
    // Execution identity comes only from what the owner reports through its endpoint (PIDs
    // stay in the environment's namespace); `fence` attributes each report to the agent
    // incarnation that was bound around it (workspace-host-split §3.4).
    const fence = (name) => (operation) => runtime.fenced(uri(name), operation);
    const engineDescriptor = (name) =>
      Object.assign(
        async () => {
          const descriptor = await describe(name);
          return { ...descriptor, websocketUrl: websocketOnSocket(descriptor.websocketUrl, sockets[name]) };
        },
        { fence: fence(name) },
      );
    const codexRuntime = {
      endpoint: sockets["codex-control"],
      nativeSocket: sockets["codex-native"],
      token: () => token("codex-control"),
      fence: fence("codex-control"),
    };
    // The vault publishes before the Brain relaunches. Start the Gateway's clients
    // only after the replacement owners are ready with that publication.
    const awaitEnvironmentPin = async (issuer, { timeoutMs = 60_000, pollMs = 250 } = {}) => {
      const deadline = performance.now() + timeoutMs;
      do {
        await runtime.observe();
        const descriptor = await describe("codex-control");
        // A Brain from before issuer reporting still uses the legacy startup path.
        if (descriptor.environmentIssuer === undefined || descriptor.environmentIssuer === issuer) return;
        await delay(pollMs);
      } while (performance.now() < deadline);
      throw new Error("Brain did not activate the published environment issuer");
    };
    /** Workspaces resolved by id through configuration (§3.6): `default` here, others provisioned. */
    const workspaces = {
      ids: () => [WORKSPACE_ID, ...others.ids()],
      open: others.open,
      sleep: (workspaceId) => (workspaceId === WORKSPACE_ID ? runtime.sleep() : others.sleep(workspaceId)),
      discard: others.discard,
    };
    // Workspaces this deployment keeps placed from startup; one failing never blocks the Gateway.
    for (const workspaceId of (env.OPENCRAFT_WORKSPACES ?? "").split(/[\s,]+/u).filter(Boolean))
      void others.open(workspaceId).catch((error) =>
        log({ type: "workspace-open-failed", workspace: workspaceId, error: error.message }),
      );
    return {
      runtime,
      sockets,
      tokenFiles,
      codexRuntime,
      awaitEnvironmentPin,
      workspaces,
      piDescriptor: engineDescriptor("pi"),
      dshDescriptor: engineDescriptor("dsh"),
      async codexHealth() {
        return new CodexCoreControlClient(codexRuntime.endpoint, await codexRuntime.token()).health(
          AbortSignal.timeout(5000),
        );
      },
      /** Execution health: the AppServer owner (workspace) beside the account Core it uses. */
      async executionHealth(coreEndpoint, tokenPath) {
        const [appServer, accounts] = await Promise.all([this.codexHealth(), proxyHealth(coreEndpoint, tokenPath)]);
        return { ...appServer, pid: accounts.pid, appServerPid: appServer.appServerPid ?? appServer.pid };
      },
      /** Probes every environment's agent (re-binding a changed incarnation) and refreshes credentials. */
      async observe() {
        const environments = await runtime.observe();
        await refreshTokens();
        return environments;
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
