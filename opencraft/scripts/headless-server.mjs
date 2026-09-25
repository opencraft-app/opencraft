#!/usr/bin/env node

import { access, chmod, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import lockfile from "proper-lockfile";

import { AppHostServer } from "../packages/app-host-server/src/index.ts";
import { CodexEngineAdapter } from "../apps/opencraft-daemon/src/codex-engine-adapter.ts";
import { startLocalAgentHost } from "../apps/local-agent-host/src/main.ts";
import { createWorkbenchWebServer } from "./serve-workbench-web.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || String(port) !== String(value)) {
    throw new Error("--port must be an integer from 0 to 65535");
  }
  return port;
}

export function parseHeadlessArguments(argv, env = process.env, getHomeDirectory = homedir) {
  let port = 10000;
  let host = "127.0.0.1";
  let allowUnauthenticatedPublic = false;
  let dataDirectory = env.OPENCRAFT_SERVER_DATA_DIR;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--port") {
      port = parsePort(argv[++index]);
    } else if (argument === "--host") {
      host = argv[++index];
      if (host !== "127.0.0.1" && host !== "0.0.0.0") throw new Error("--host must be 127.0.0.1 or 0.0.0.0");
    } else if (argument === "--allow-unauthenticated-public") {
      allowUnauthenticatedPublic = true;
    } else if (argument === "--data-dir") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--data-dir requires a path");
      dataDirectory = value;
    } else {
      throw new Error(`Unknown option ${argument}`);
    }
  }
  if (!dataDirectory) {
    try { dataDirectory = join(getHomeDirectory(), ".opencraft-server"); }
    catch { throw new Error("--data-dir is required when this user has no home directory"); }
  }
  if (host === "0.0.0.0" && !allowUnauthenticatedPublic) {
    throw new Error("--host 0.0.0.0 requires --allow-unauthenticated-public");
  }
  if (host !== "0.0.0.0" && allowUnauthenticatedPublic) {
    throw new Error("--allow-unauthenticated-public requires --host 0.0.0.0");
  }
  return { help: false, host, port, dataDirectory: resolve(dataDirectory), allowUnauthenticatedPublic };
}

async function secureDataDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await stat(path);
  if (!info.isDirectory() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("OpenCraft server data directory must be private to its owner (mode 0700)");
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
}

export async function startHeadlessServer(options = {}) {
  const root = resolve(options.root ?? packageRoot);
  const dataDirectory = resolve(options.dataDirectory ?? join(homedir(), ".opencraft-server"));
  const webRoot = resolve(options.webRoot ?? join(root, "web"));
  const port = options.port ?? 10000;
  const host = options.host ?? "127.0.0.1";
  parsePort(port);
  if (host !== "127.0.0.1" && host !== "0.0.0.0") throw new Error("Invalid headless listener host");
  if (host === "0.0.0.0" && options.allowUnauthenticatedPublic !== true) {
    throw new Error("Public headless listener requires explicit unauthenticated-public acknowledgement");
  }
  await access(join(webRoot, "index.html"));
  await secureDataDirectory(dataDirectory);
  const releaseLock = await lockfile.lock(join(dataDirectory, "server"), { realpath: false, retries: 0 });
  let agent;
  let web;
  let appHostServer;
  let closing = null;
  const close = () => {
    if (closing !== null) return closing;
    closing = (async () => {
      const results = await Promise.allSettled([web?.close(), appHostServer?.close(), agent?.close()]);
      await releaseLock();
      const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, "OpenCraft server shutdown failed");
    })();
    return closing;
  };
  try {
    const startAgent = options.startAgentHost ?? startLocalAgentHost;
    agent = await startAgent({
      dshExecutable: join(root, "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
      dshCapabilityPlugin: options.dshCapabilityPlugin ?? join(root, "runtime/dsh/opencraft-capability-plugin.mjs"),
      runtimeDirectory: join(root, "runtime"),
      dataDirectory: join(dataDirectory, "agent"),
      modelStorageDirectory: join(dataDirectory, "models"),
      projectStorageDirectory: join(dataDirectory, "projects"),
      projectlessWorkspaceDirectory: join(dataDirectory, "workspaces"),
      skillsDirectory: join(dataDirectory, "skills"),
    });
    appHostServer = new AppHostServer({
      logicalClientRouting: true,
      physicalHostLifetime: "server",
      createTransport(hostId) {
        if (hostId !== "local-codex") throw new Error(`Unknown server Host ${hostId}`);
        return options.createCodexTransport?.() ?? new CodexEngineAdapter({
          executable: options.codexExecutable ?? join(root, "runtime/codex/bin/codex"),
          runtimeDirectory: join(root, "runtime"),
          dataDirectory: join(dataDirectory, "codex"),
          nativeCodexHomeDirectory: join(dataDirectory, "native-codex"),
        });
      },
    });
    const createWeb = options.createWebServer ?? createWorkbenchWebServer;
    web = await createWeb({
      root: webRoot,
      appServerTarget: agent.websocketUrl,
      loopbackOnly: host === "127.0.0.1",
      appHostServer,
    });
    const address = await web.listen({ host, port });
    return { url: `http://127.0.0.1:${address.port}`, listenHost: host, listenPort: address.port, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

const isMain = process.argv[1] != null
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  void (async () => {
    const args = parseHeadlessArguments(process.argv.slice(2));
    if (args.help) {
      process.stdout.write("Usage: opencraft-server [--host 127.0.0.1|0.0.0.0] [--port 10000] [--data-dir PATH] [--allow-unauthenticated-public]\nDefault: loopback only. Public mode has no TLS or access control.\n");
      return;
    }
    const server = await startHeadlessServer(args);
    process.stdout.write(`OpenCraft WebUI: ${server.url}\n`);
    if (server.listenHost === "0.0.0.0") process.stdout.write(`Unauthenticated public listener: 0.0.0.0:${server.listenPort}\n`);
    const shutdown = () => void server.close().then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
