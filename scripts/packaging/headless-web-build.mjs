import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertHeadlessWebRelease } from "../../apps/headless-server/src/headless-web-release.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workbenchRoot = join(repositoryRoot, "apps/workbench-web");

/** The single Host entry a headless server Web release is built for. */
export function headlessWebHostDefinitions() {
  return [
    {
      hostId: "opencraft-server",
      label: "Server",
      kind: "durable",
      executionLocation: "This server",
      url: "/appserver",
      workspaceBrowseRoots: ["/"],
    },
  ];
}

/** Build environment that turns a Web build into a headless server Web release. */
export function headlessWebBuildEnvironment() {
  return {
    OPENCRAFT_HEADLESS_SERVER_BUILD: "true",
    VITE_HYPERNODE_PLUGIN: "disabled",
    VITE_APPSERVER_HOSTS_JSON: JSON.stringify(headlessWebHostDefinitions()),
  };
}

/**
 * The `@opencraft/workbench-web` build script, step by step, so an installation
 * Vite config can run the same build. A test keeps this equal to package.json.
 */
export function workbenchWebBuildSteps(viteConfig) {
  return [
    ["node", ["../../scripts/postinstall/patch-novnc-desktop-events.mjs"]],
    ["vite", ["build", ...(viteConfig === undefined ? [] : ["--config", viteConfig])]],
    ["node", ["--max-old-space-size=4096", "../../scripts/check/check-browser-compatibility.mjs"]],
  ];
}

function runCommand(command, args, { cwd, env }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} failed (${signal ?? code})`)),
    );
  });
}

/**
 * A product prefix is a separately locked npm project inside this checkout (for
 * example `products/acme`) that a distribution layers over the core lock. It
 * must be a normalized relative path below the repository root, reached without
 * symbolic links, with its own `package.json` and `package-lock.json`. Returns
 * its absolute path.
 */
export function resolveProductPrefix(prefix, root = repositoryRoot) {
  if (
    typeof prefix !== "string" ||
    !prefix ||
    isAbsolute(prefix) ||
    posix.normalize(prefix) !== prefix ||
    prefix === "." ||
    prefix.endsWith("/") ||
    prefix.split("/").includes("..")
  )
    throw new Error("The product prefix must be a normalized relative directory inside the repository");
  const directory = join(root, prefix);
  if (!existsSync(join(directory, "package.json")) || !existsSync(join(directory, "package-lock.json")))
    throw new Error(`The product prefix ${prefix} must contain package.json and package-lock.json`);
  if (realpathSync(directory) !== join(realpathSync(root), prefix))
    throw new Error(`The product prefix ${prefix} must not be reached through a symbolic link`);
  return directory;
}

/**
 * Build the release Web tree for a headless server and verify it with
 * `assertHeadlessWebRelease`. Pass either `script` (an npm script, default
 * `build:web:release`) or `viteConfig` (an absolute path to an installation
 * config that wraps `createWorkbenchWebConfig`). With `prefix` (see
 * `resolveProductPrefix`), `script` is that product project's script instead of
 * a root one. `env` adds build variables; the headless variables always win.
 * Resolves to the verified release metadata. `run` and `verify` are test seams.
 */
export async function buildHeadlessWeb({
  script,
  viteConfig,
  prefix,
  env = {},
  run = runCommand,
  verify = assertHeadlessWebRelease,
} = {}) {
  if (script !== undefined && viteConfig !== undefined) throw new Error("Pass either script or viteConfig, not both");
  if (viteConfig !== undefined && (typeof viteConfig !== "string" || !isAbsolute(viteConfig))) {
    throw new Error("viteConfig must be an absolute path");
  }
  if (prefix !== undefined && viteConfig !== undefined)
    throw new Error("A product prefix selects a script, not a viteConfig");
  const buildEnv = { ...env, ...headlessWebBuildEnvironment() };
  if (viteConfig === undefined) {
    const project = prefix === undefined ? [] : ["--prefix", resolveProductPrefix(prefix)];
    await run("npm", [...project, "run", script ?? "build:web:release"], { cwd: repositoryRoot, env: buildEnv });
  } else {
    const releaseEnv = { ...buildEnv, OPENCRAFT_RELEASE_MINIFY: "standard" };
    await run("npm", ["run", "build:preview-bridge"], { cwd: repositoryRoot, env: releaseEnv });
    for (const [command, args] of workbenchWebBuildSteps(viteConfig)) {
      const [executable, argv] =
        command === "vite"
          ? [process.execPath, [join(repositoryRoot, "node_modules/vite/bin/vite.js"), ...args]]
          : [process.execPath, args];
      await run(executable, argv, { cwd: workbenchRoot, env: releaseEnv });
    }
  }
  return verify(join(workbenchRoot, "dist"));
}
