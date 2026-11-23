import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  createSandboxPool,
  createWorkspaceRuntime,
  formatSandboxEnvironmentUri,
  parseSandboxEnvironmentUris,
  parseWorkspaceEndpointUri,
} from "@opencraft/sandbox";
import { createSandboxProviderRegistry } from "@opencraft/sandbox/providers";
import { createSandboxEndpointListener } from "@opencraft/sandbox-node/endpoint-listener";
import { staticDockerSandboxProvider } from "@opencraft/sandbox-node/static-docker";
import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import { CodexCoreControlClient } from "@opencraft/account-pool-host";
import { websocketOnSocket } from "../../apps/headless-server/src/server-deployment/dsh-host-client.mjs";
import { proxyHealth } from "./proxy-core.mjs";

/** The Docker Gateway's `default` WorkspaceHost placement. The Gateway holds only
 * `workspace://default/endpoints/<name>` addresses; where they run is configuration:
 * `OPENCRAFT_WORKSPACE_ENVIRONMENTS` lists environment URIs (`static-docker://brain
 * static-docker://hands` until Brain and Hands merge). Existing clients keep dialling
 * sockets: each endpoint gets a private local listener whose every connection is one
 * workspace endpoint connection. Nothing is read from the shared `$DATA/run`. */

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

const uri = (name) => parseWorkspaceEndpointUri(`workspace://${WORKSPACE_ID}/endpoints/${name}`);
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

export async function openGatewayWorkspace({
  dataDirectory,
  env = process.env,
  log = (value) => console.log(JSON.stringify(value)),
  providers = { "static-docker": staticDockerSandboxProvider() },
  endpointDirectories = {},
} = {}) {
  if (!isAbsolute(dataDirectory)) throw new Error("Gateway data directory must be absolute");
  const linkRoot = env.OPENCRAFT_WORKSPACE_LINK_ROOT ?? "/run/opencraft-links";
  if (!isAbsolute(linkRoot)) throw new Error("OPENCRAFT_WORKSPACE_LINK_ROOT must be absolute");
  // Provider installations are deployment composition; a URI only selects among them.
  const installations = { "static-docker": { backend: "static-docker", linkRoot } };
  const registry = createSandboxProviderRegistry(providers);
  const addresses = parseSandboxEnvironmentUris(env.OPENCRAFT_WORKSPACE_ENVIRONMENTS ?? DEFAULT_WORKSPACE_ENVIRONMENTS);
  const hostDirectory = join(dataDirectory, "workspaces", WORKSPACE_ID, "host");
  await mkdir(hostDirectory, { recursive: true, mode: 0o700 });
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
    for (const name of ["endpoints", "credentials"]) {
      await rm(join(runDirectory, name), { recursive: true, force: true });
      await mkdir(join(runDirectory, name), { mode: 0o700 });
    }
  }
  const pools = [],
    listeners = [];
  let runtime, credentials;
  const close = async () => {
    // Local connections end first (their relays terminate), then the environment sessions.
    const results = await Promise.allSettled(listeners.map((listener) => listener.close()));
    results.push(...(await Promise.allSettled([runtime?.close()])));
    await Promise.allSettled(pools.map((pool) => pool.close()));
    if (credentials) await rm(credentials, { recursive: true, force: true });
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Workspace endpoint cleanup is unconfirmed");
  };
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
        // static-docker reads its per-incarnation link ticket itself; no installation secret.
        readSecret: async () => {
          throw new Error("This provider has no installation secret");
        },
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
    runtime = createWorkspaceRuntime({
      workspaceId: WORKSPACE_ID,
      owner: `workspace:${WORKSPACE_ID}`,
      environments,
      store: placementStore(fileStateDocumentStore(hostDirectory, { private: { maxBytes: 64 * 1024 } })),
      onEvent: ({ type, ...event }) =>
        log({ type: "workspace-placement", workspace: WORKSPACE_ID, change: type, ...event }),
    });
    const sockets = {};
    for (const [name, maxConnections] of Object.entries(CONSUMED)) {
      const listener = await createSandboxEndpointListener({
        connect: (onData) => runtime.connect(uri(name), onData),
        maxConnections,
        ...(runDirectory ? { path: join(runDirectory, "endpoints", name) } : {}),
        authorize: async () => {},
        onCleanupUnconfirmed: () =>
          log({ type: "workspace-endpoint-cleanup-unconfirmed", workspace: WORKSPACE_ID, endpoint: name }),
      });
      listeners.push(listener);
      sockets[name] = listener.path;
    }
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
    const tokenFiles = { terminal: join(credentials, "terminal.token"), files: join(credentials, "files.token") };
    const refreshTokens = async () => {
      for (const [name, path] of Object.entries(tokenFiles))
        await writeFile(path, (await token(name)) + "\n", { mode: 0o600 });
    };
    await refreshTokens();
    // Engine descriptors: the in-environment socket is replaced by this Gateway's listener.
    const engineDescriptor = (name) => async () => {
      const descriptor = await describe(name);
      return { ...descriptor, websocketUrl: websocketOnSocket(descriptor.websocketUrl, sockets[name]) };
    };
    const codexRuntime = {
      endpoint: sockets["codex-control"],
      nativeSocket: sockets["codex-native"],
      token: () => token("codex-control"),
    };
    return {
      runtime,
      sockets,
      tokenFiles,
      codexRuntime,
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
