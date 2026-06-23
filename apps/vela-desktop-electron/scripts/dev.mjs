import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const rendererUrl = process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173";
const veladListenAddr = process.env.VELA_DESKTOP_VELAD_LISTEN_ADDR ?? "127.0.0.1:3857";
const veladApiBaseUrl = process.env.VITE_VELA_API_BASE_URL ?? `http://${veladListenAddr}/api/v1`;
const children = new Set();
let shuttingDown = false;

function spawnChild(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: appRoot,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: "inherit",
  });
  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown && name === "electron") {
      shutdown(code ?? (signal ? 1 : 0));
    }
  });
  child.on("error", (err) => {
    console.error(`[${name}] ${err.message}`);
    if (!shuttingDown) shutdown(1);
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children) {
      child.kill("SIGKILL");
    }
    process.exit(code);
  }, 1200).unref();
}

async function waitFor(label, probe) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

spawnChild("electron-build", "vite", ["build", "--watch", "--config", "vite.electron.config.ts"]);
spawnChild("preload-build", "esbuild", [
  "electron/preload.ts",
  "--bundle",
  "--platform=node",
  "--target=node22",
  "--format=cjs",
  "--external:electron",
  "--outfile=dist-electron/preload.cjs",
  "--watch=forever",
]);
spawnChild("renderer", "vite", ["--config", "vite.renderer.config.ts", "--host", "127.0.0.1"], {
  VITE_VELA_API_BASE_URL: veladApiBaseUrl,
});

await waitFor("electron bundle", () => existsSync(join(appRoot, "dist-electron/main.js")));
await waitFor("preload bundle", () => existsSync(join(appRoot, "dist-electron/preload.cjs")));
await waitFor("renderer dev server", async () => {
  try {
    const response = await fetch(rendererUrl, { method: "HEAD" });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
});

spawnChild("electron", "electron", ["."], {
  VITE_DEV_SERVER_URL: rendererUrl,
});
