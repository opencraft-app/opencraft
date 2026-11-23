import { isAbsolute, join, resolve } from "node:path";
import { loadRuntimePlugins } from "@opencraft/runtime-plugin-host";
import { main as runtimePluginAdmin } from "@opencraft/runtime-plugin-host/install";
import { createHostFileSystemPluginSource } from "../../apps/headless-server/src/host-filesystem-plugin-source.mjs";

/**
 * Explicit utility modes of the container Gateway entry. They are platform tools: they
 * never start the Gateway, Hands or any other core owner, and the Hands environment
 * bootstrap never calls them.
 *
 *   gateway.mjs --runtime-plugin-executor ABSOLUTE_SELECTION_STORE
 *   gateway.mjs --runtime-plugin-admin check STORE
 *   gateway.mjs --runtime-plugin-admin install PACKAGE STORE [--enable] [--gid=N] [--configuration-file=FILE]
 */
export const RUNTIME_PLUGIN_EXECUTOR_MODE = "--runtime-plugin-executor";
export const RUNTIME_PLUGIN_ADMIN_MODE = "--runtime-plugin-admin";

// All or none: a partial byte-source configuration fails instead of reading local packages.
const SOURCE_KEYS = Object.freeze([
  "OPENCRAFT_RUNTIME_PLUGIN_VFS_DIRECTORY",
  "OPENCRAFT_RUNTIME_PLUGIN_VFS_ENDPOINT",
  "OPENCRAFT_RUNTIME_PLUGIN_VFS_TOKEN_FILE",
]);

/** Loads the selected plugins in the `execution` role (no routes, no authority). */
export function startRuntimePluginExecutor(options) {
  return loadRuntimePlugins({ ...options, role: "execution" });
}

/**
 * Long-running executor process. Plugin bytes come from the local selection store, or,
 * when every `OPENCRAFT_RUNTIME_PLUGIN_VFS_*` field is set, from the Hands host-filesystem
 * RPC into a private snapshot cache (`OPENCRAFT_RUNTIME_PLUGIN_CACHE_DIRECTORY`, default
 * `<store>/executor-cache`). SIGINT/SIGTERM close the activated plugins.
 */
export async function runRuntimePluginExecutor(args, env = process.env) {
  if (args.length !== 1 || !isAbsolute(args[0]) || resolve(args[0]) === "/")
    throw Error(`Usage: ${RUNTIME_PLUGIN_EXECUTOR_MODE} ABSOLUTE_SELECTION_STORE`);
  const directory = resolve(args[0]);
  const configured = SOURCE_KEYS.filter((key) => env[key] !== undefined);
  if (configured.length && configured.length !== SOURCE_KEYS.length)
    throw Error("Configure all runtime plugin source fields");
  const [root, endpoint, tokenFile] = SOURCE_KEYS.map((key) => env[key]);
  const host = await startRuntimePluginExecutor({
    directory,
    cacheDirectory: env.OPENCRAFT_RUNTIME_PLUGIN_CACHE_DIRECTORY ?? join(directory, "executor-cache"),
    ...(configured.length
      ? { packageSource: () => createHostFileSystemPluginSource({ root, endpoint, tokenFile }) }
      : {}),
  });
  const keepalive = setInterval(() => {}, 60_000);
  let stopped;
  const close = () =>
    (stopped ??= (async () => {
      try {
        await host.close();
      } finally {
        clearInterval(keepalive);
      }
    })());
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void close());
  console.log(
    JSON.stringify({ type: "runtime-plugin-executor-ready", selected: host.selected, skipped: host.skipped.length }),
  );
  return { host, close };
}

/**
 * Dispatches a utility mode. Returns false when `args` names none, so the caller starts
 * its Gateway; a downstream Gateway entry composes the same modes the same way.
 */
export async function runGatewayUtilityMode(args = process.argv.slice(2), env = process.env) {
  if (args[0] === RUNTIME_PLUGIN_EXECUTOR_MODE) {
    await runRuntimePluginExecutor(args.slice(1), env);
    return true;
  }
  if (args[0] === RUNTIME_PLUGIN_ADMIN_MODE) {
    console.log(JSON.stringify(await runtimePluginAdmin(args.slice(1))));
    return true;
  }
  return false;
}
