import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";

const require = createRequire(import.meta.url);
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const electronCliPath = require.resolve("electron/cli.js");
const veladBinaryPath =
  process.env.VELA_DESKTOP_VELAD_PATH?.trim() ||
  join(repoRoot, "target", "debug", process.platform === "win32" ? "velad.exe" : "velad");
const desktopPreviewUserDataDir =
  process.env.VELA_DESKTOP_USER_DATA_DIR?.trim() ||
  join(repoRoot, ".tmp", "desktop-preview-user-data");
const children = new Set();
let shuttingDown = false;
let rendererServer = null;

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

function runCommand(name, command, args, cwd = appRoot, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: "inherit",
    });
    children.add(child);
    child.on("exit", (code, signal) => {
      children.delete(child);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${name} exited code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
    child.on("error", reject);
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (rendererServer) {
    const server = rendererServer;
    rendererServer = null;
    void server.close();
  }
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

rmSync(join(appRoot, "dist-electron"), { recursive: true, force: true });

await runCommand("velad-build", "cargo", ["build", "-p", "velad", "--features", "embedded-vela-engine"], repoRoot);
console.log(`[dev] using local velad binary ${veladBinaryPath}`);
if (process.platform === "darwin") {
  await runCommand("macos-speech-build", "make", ["desktop-build-macos-speech"], repoRoot);
}

const rendererUrlPreference = process.env.VITE_DEV_SERVER_URL?.trim() || "http://127.0.0.1:5173";
const rendererUrlConfig = new URL(rendererUrlPreference);
rendererServer = await createViteServer({
  configFile: join(appRoot, "vite.renderer.config.ts"),
  server: {
    host: rendererUrlConfig.hostname || "127.0.0.1",
    port: Number(rendererUrlConfig.port || "5173"),
    strictPort: false,
  },
});
await rendererServer.listen();
rendererServer.printUrls();
const rendererUrl = resolveRendererUrl(rendererServer, rendererUrlConfig);
console.log(`[dev] renderer ${rendererUrl}`);

spawnChild("electron-build", "npm", ["exec", "--", "vite", "build", "--watch", "--config", "vite.electron.config.ts"], {
  VELA_ELECTRON_EMPTY_OUT_DIR: "false",
});
spawnChild("preload-build", "npm", ["exec", "--", "esbuild",
  "electron/preload.ts",
  "--bundle",
  "--platform=node",
  "--target=node22",
  "--format=cjs",
  "--external:electron",
  "--outfile=dist-electron/preload.cjs",
  "--watch=forever",
]);

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

const electronArgs = [electronCliPath, "."];
const remoteDebuggingPort = process.env.VELA_DESKTOP_REMOTE_DEBUGGING_PORT?.trim();
if (remoteDebuggingPort) {
  electronArgs.push(`--remote-debugging-port=${remoteDebuggingPort}`);
}

spawnChild("electron", process.execPath, electronArgs, {
  VITE_DEV_SERVER_URL: rendererUrl,
  VELA_DESKTOP_VELAD_PATH: veladBinaryPath,
  VELA_DESKTOP_USER_DATA_DIR: desktopPreviewUserDataDir,
});

function resolveRendererUrl(server, preferredUrl) {
  const urls = server.resolvedUrls?.local ?? [];
  const matchingHostUrl = urls.find((url) => {
    try {
      return new URL(url).hostname === preferredUrl.hostname;
    } catch {
      return false;
    }
  });
  const url = matchingHostUrl ?? urls[0];
  if (!url) throw new Error("Vite renderer server did not report a local URL");
  return url.replace(/\/$/, "");
}
