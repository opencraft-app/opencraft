import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveEnvironmentIssuer, watchEnvironmentIssuer } from "../server-deployment/environment-issuer.mjs";

/** The AppServer owner's control credential: its own per-incarnation file with an
 * external proxy; the embedded account Core (restore path) forwards health with the
 * account token, so that mode keeps one token. */
export function appServerControlTokenFile(paths) {
  return paths.proxyMode === "embedded" ? paths.tokenPath : paths.appServerTokenFile;
}

/** Pi engine host configuration (agent-private). `issuer` is set only with ENV delivery. */
export function engineHostConfiguration(paths, root, issuer) {
  return {
    descriptorPath: paths.engineDescriptor,
    socketPath: paths.engineSocket,
    dataDirectory: paths.dataDirectory,
    runtimeDirectory: paths.runtimeDirectory,
    engines: paths.proxyMode === "workspace-egress" ? ["pi"] : ["dsh", "pi"],
    defaultEngine: "pi",
    executionContext: paths.executionContext,
    gitWorkerFile: join(root, "runtime", "personal-git-worker.mjs"),
    dshDescriptorPath: paths.dshDescriptor,
    fileSystemOwner: { endpoint: paths.fileSystemEndpoint, tokenFile: paths.fileSystemToken },
    ...(issuer === undefined ? {} : { environmentIssuer: issuer }),
  };
}

/** The split Codex AppServer's ENV delivery configuration
 * (`--environment-launch-config`): the pinned issuer key, this owner's
 * attachment and the server data directory whose durable admission (the Codex
 * input lease, the creation reservation) its own Worker reads. */
export function codexAppServerEnvironmentLaunch(paths, root, machineId, issuer) {
  if (typeof machineId !== "string" || !/^[0-9a-f-]{36}$/iu.test(machineId))
    throw new Error("The Codex AppServer attachment requires the deployment machine ID");
  return {
    issuer,
    instance: `server:${machineId}:codex`,
    admissionWorkerFile: join(root, "runtime", "execution-admission-worker.mjs"),
    directory: paths.dataDirectory,
  };
}

/** AppServer arguments for ENV delivery: none without it. */
export function codexAppServerEnvironmentArguments(paths) {
  return paths.environmentDelivery ? ["--environment-launch-config", paths.codexEnvironmentLaunchConfig] : [];
}

/** DSH host configuration (agent-private). `issuer` is set only with ENV delivery. */
export function dshHostConfiguration(paths, root, env, issuer) {
  return {
    executionContext: paths.executionContext,
    fileSystemOwner: { endpoint: paths.fileSystemEndpoint, tokenFile: paths.fileSystemToken },
    artifactDirectory: join(paths.dataDirectory, "artifacts"),
    descriptorPath: paths.dshDescriptor,
    socketPath: paths.dshSocket,
    controlSocketPath: paths.dshControlSocket,
    dataDirectory: join(paths.dataDirectory, "agent"),
    machineIdentityDirectory: paths.dataDirectory,
    runtimeDirectory: paths.runtimeDirectory,
    dshExecutable:
      env.OPENCRAFT_DSH_EXECUTABLE?.trim() || join(root, "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
    dshCapabilityPlugin: join(root, "runtime/dsh/opencraft-capability-plugin.mjs"),
    modelStorageDirectory: join(paths.dataDirectory, "models"),
    speechModelManagement: true,
    projectStorageDirectory: join(paths.dataDirectory, "projects"),
    projectlessWorkspaceDirectory: paths.dshProjectlessDirectory,
    skillsDirectory: join(paths.dataDirectory, "skills"),
    // Task catalog reads Codex threads from this container's AppServer, not through the account Core.
    taskCodexCoreEndpoint: paths.appServerEndpoint,
    taskCodexCoreTokenFile: appServerControlTokenFile(paths),
    ...(issuer === undefined ? {} : { environmentIssuer: issuer }),
  };
}

async function writePrivate(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Write the execution host configurations. Only while none of their owners
 * runs: DSH treats its configuration as an immutable attachment of its
 * lifetime, and the Codex AppServer reads its delivery file once at launch.
 * With ENV delivery (`issuer` set) the AppServer's file pins the same key;
 * without it no such file exists. */
export async function writeExecutionHostConfigurations(paths, root, env, issuer, machineId) {
  await writePrivate(paths.engineConfig, engineHostConfiguration(paths, root, issuer));
  await writePrivate(paths.dshConfig, dshHostConfiguration(paths, root, env, issuer));
  if (issuer === undefined) await rm(paths.codexEnvironmentLaunchConfig, { force: true });
  else
    await writePrivate(
      paths.codexEnvironmentLaunchConfig,
      codexAppServerEnvironmentLaunch(paths, root, machineId, issuer),
    );
}

/** The issuer the Brain role pins at launch. Without ENV delivery: none, and the host
 * configurations are exactly as before. With it: the vault owner's published
 * key, or an unissuable key until one is published (deliveries fail closed). */
export async function executionHostIssuer(paths, log = (message) => console.error(message)) {
  if (!paths.environmentDelivery) return undefined;
  const pinned = await resolveEnvironmentIssuer(paths.environmentIssuerFile);
  if (!pinned.published) log(JSON.stringify({ type: "environment-issuer-unavailable", reason: pinned.reason }));
  return pinned.issuer;
}

/** With ENV delivery, relaunch DSH, Pi and the Codex AppServer whenever the
 * vault owner publishes a new key (first enablement or explicit rotation).
 * `relaunch(configure)` stops them, awaits `configure()` and starts them again
 * (the Brain role does this through its workspace-agent supervisor).
 * Until it completes, they stay pinned to the previous key and deliveries fail
 * closed. */
export function relaunchOnIssuerChange({
  paths,
  root,
  env,
  machineId,
  pinned,
  signal,
  relaunch,
  interval,
  watch = watchEnvironmentIssuer,
  log = (message) => console.error(message),
}) {
  if (!paths.environmentDelivery) return Promise.resolve();
  return watch({
    path: paths.environmentIssuerFile,
    pinned,
    signal,
    interval,
    log,
    replace: async (issuer) => {
      await relaunch(() => writeExecutionHostConfigurations(paths, root, env, issuer, machineId), issuer);
      log(JSON.stringify({ type: "environment-issuer-pinned" }));
    },
  });
}
