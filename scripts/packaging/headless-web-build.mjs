import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
 * Build the release Web tree for a headless server and verify it with
 * `assertHeadlessWebRelease`. Pass either `script` (a root npm script, default
 * `build:web:release`) or `viteConfig` (an absolute path to an installation
 * config that wraps `createWorkbenchWebConfig`). `env` adds build variables;
 * the headless variables always win. Resolves to the verified release metadata.
 * `run` and `verify` are test seams.
 */
export async function buildHeadlessWeb({
  script,
  viteConfig,
  env = {},
  run = runCommand,
  verify = assertHeadlessWebRelease,
} = {}) {
  if (script !== undefined && viteConfig !== undefined) throw new Error("Pass either script or viteConfig, not both");
  if (viteConfig !== undefined && (typeof viteConfig !== "string" || !isAbsolute(viteConfig))) {
    throw new Error("viteConfig must be an absolute path");
  }
  const buildEnv = { ...env, ...headlessWebBuildEnvironment() };
  if (viteConfig === undefined) {
    await run("npm", ["run", script ?? "build:web:release"], { cwd: repositoryRoot, env: buildEnv });
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
