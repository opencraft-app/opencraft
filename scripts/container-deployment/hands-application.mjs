import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deploymentPaths } from "./paths.mjs";

export async function startContainerHands({ startServices = async () => [], spawnOwner = spawn } = {}) {
  const data = process.env.OPENCRAFT_BROWSER_DATA_DIR;
  if (!data || !data.startsWith("/")) throw new Error("Set OPENCRAFT_BROWSER_DATA_DIR to an absolute path");
  await mkdir(data, { recursive: true, mode: 0o700 });
  const info = await stat(data);
  if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
    throw new Error("Hands data directory must be private and owned by this user");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    children = [];
  let stopping;
  let services = [],
    starting = true,
    failed = false;
  const stop = (code) =>
    (stopping ??= (async () => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const results = await Promise.allSettled([
        ...children.map(
          (child) =>
            new Promise((resolve) =>
              child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("close", resolve),
            ),
        ),
        ...services.map((service) => service.close()),
      ]);
      process.exitCode = results.some((result) => result.status === "rejected") ? 1 : code;
    })());
  // Only trusted product composition supplies services; no directory/module scanning.
  services = await startServices(() => {
    failed = true;
    if (!starting) void stop(1);
  });
  starting = false;
  if (failed) {
    await stop(1);
    return;
  }
  for (const entry of [
    "browser/owner.cjs",
    "hands-execution-owner.mjs",
    "hands-terminal-owner.mjs",
    "hands-files-owner.mjs",
  ]) {
    const child = spawnOwner(
      join(root, "bin/node"),
      [join(root, "runtime", entry), ...(entry === "hands-terminal-owner.mjs" ? ["--hands-terminal-owner"] : [])],
      { cwd: process.env.OPENCRAFT_WORKSPACE_DIR, env: process.env, stdio: "inherit", shell: false },
    );
    child.once("error", () => void stop(1));
    child.once("exit", () => {
      if (!stopping) void stop(1);
    });
    children.push(child);
  }
  process.once("SIGINT", () => void stop(0));
  process.once("SIGTERM", () => void stop(0));
  let ready = false;
  for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
    try {
      const paths = deploymentPaths();
      const sockets = await Promise.all(
        [
          join(data, "owner.sock"),
          process.env.OPENCRAFT_HANDS_EXECUTION_SOCKET,
          paths.terminalEndpoint,
          paths.fileSystemEndpoint,
        ].map((path) => stat(path)),
      );
      if (sockets.every((value) => value.isSocket())) {
        ready = true;
        break;
      }
    } catch {}
    if (attempt < 119) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready && !stopping) await stop(1);
  if (stopping) await stopping;
  else console.log("OpenCraft Hands browser, terminal, filesystem and Codex exec-server owners ready.");
}
