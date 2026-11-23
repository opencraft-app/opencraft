import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveEnvironmentIssuer, watchEnvironmentIssuer } from "../server-deployment/environment-issuer.mjs";

/** Pi engine host configuration. `issuer` is set only with ENV delivery. */
export function engineHostConfiguration(paths, root, issuer) {
  return {
    descriptorPath: paths.engineDescriptor,
    dataDirectory: paths.dataDirectory,
    runtimeDirectory: paths.runtimeDirectory,
    engines: ["dsh", "pi"],
    defaultEngine: "pi",
    executionContext: paths.executionContext,
    gitWorkerFile: join(root, "runtime", "personal-git-worker.mjs"),
    dshDescriptorPath: paths.dshDescriptor,
    fileSystemOwner: { endpoint: paths.fileSystemEndpoint, tokenFile: paths.fileSystemToken },
    ...(issuer === undefined ? {} : { environmentIssuer: issuer }),
  };
}

/** DSH host configuration. `issuer` is set only with ENV delivery. */
export function dshHostConfiguration(paths, root, env, issuer) {
  return {
    executionContext: paths.executionContext,
    fileSystemOwner: { endpoint: paths.fileSystemEndpoint, tokenFile: paths.fileSystemToken },
    artifactDirectory: join(paths.dataDirectory, "artifacts"),
    descriptorPath: paths.dshDescriptor,
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
    taskCodexCoreEndpoint: paths.coreEndpoint,
    taskCodexCoreTokenFile: paths.tokenPath,
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

/** Write both execution host configurations. Only while neither host runs:
 * DSH treats its configuration as an immutable attachment of its lifetime. */
export async function writeExecutionHostConfigurations(paths, root, env, issuer) {
  await writePrivate(paths.engineConfig, engineHostConfiguration(paths, root, issuer));
  await writePrivate(paths.dshConfig, dshHostConfiguration(paths, root, env, issuer));
}

/** The issuer Brain pins at launch. Without ENV delivery: none, and the host
 * configurations are exactly as before. With it: the vault owner's published
 * key, or an unissuable key until one is published (deliveries fail closed). */
export async function executionHostIssuer(paths, log = (message) => console.error(message)) {
  if (!paths.environmentDelivery) return undefined;
  const pinned = await resolveEnvironmentIssuer(paths.environmentIssuerFile);
  if (!pinned.published) log(JSON.stringify({ type: "environment-issuer-unavailable", reason: pinned.reason }));
  return pinned.issuer;
}

/** With ENV delivery, relaunch DSH and Pi whenever the vault owner publishes a
 * new key (first enablement or explicit rotation). `relaunch(configure)` stops
 * both hosts, awaits `configure()` and starts them again. Until it completes,
 * the hosts stay pinned to the previous key and deliveries fail closed. */
export function relaunchOnIssuerChange({
  paths,
  root,
  env,
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
      await relaunch(() => writeExecutionHostConfigurations(paths, root, env, issuer));
      log(JSON.stringify({ type: "environment-issuer-pinned" }));
    },
  });
}
