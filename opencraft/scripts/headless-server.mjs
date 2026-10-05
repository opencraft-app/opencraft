#!/usr/bin/env node

import { access, chmod, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import lockfile from "proper-lockfile";

import { AppHostServer } from "../packages/app-host-server/src/index.ts";
import { CodexEngineAdapter } from "../apps/opencraft-daemon/src/codex-engine-adapter.ts";
import { readSshCodexServerBindings, createSshCodexEngineAdapter } from "../apps/opencraft-daemon/src/ssh-codex-connections.ts";
import { SshManagement } from "../apps/opencraft-daemon/src/ssh-management.ts";
import { startLocalAgentHost } from "../apps/local-agent-host/src/main.ts";
import { createWorkbenchWebServer } from "./serve-workbench-web.mjs";
import { assertHeadlessWebRelease } from "./headless-web-release.mjs";
import { LocalDesktopService } from "../apps/local-agent-host/src/desktop/local-desktop-service.ts";
import { createNativeObserver, localDesktopMachineIdentity } from "../apps/local-agent-host/src/desktop/native-observer.ts";

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
  let localDesktop = false;
  let dataDirectory = env.OPENCRAFT_SERVER_DATA_DIR;
  let sshServersFile;
  let sshPublicOrigin;
  let sshPublicAccess = false;
  let sshAccessFile;
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
    } else if (argument === "--local-desktop") {
      localDesktop = true;
    } else if (argument === "--data-dir") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--data-dir requires a path");
      dataDirectory = value;
    } else if (argument === "--ssh-servers") {
      sshServersFile = argv[++index];
      if (!sshServersFile || !sshServersFile.startsWith("/")) throw new Error("--ssh-servers requires an absolute private configuration path");
    } else if (argument === "--ssh-public-origin") {
      sshPublicOrigin = argv[++index];
      const url = new URL(sshPublicOrigin);
      if (url.protocol !== "https:" || url.origin !== sshPublicOrigin) throw new Error("--ssh-public-origin requires a fixed HTTPS origin");
    } else if (argument === "--ssh-public-access") {
      sshPublicAccess = true;
    } else if (argument === "--ssh-access-file") {
      sshAccessFile = argv[++index];
      if (!sshAccessFile?.startsWith("/")) throw new Error("--ssh-access-file requires a private absolute path");
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
  if (sshPublicAccess && sshPublicOrigin) throw new Error("Choose either --ssh-public-access or --ssh-public-origin");
  if (sshServersFile && host !== "127.0.0.1" && !sshPublicOrigin && !sshPublicAccess) throw new Error("SSH Servers require a protected listener");
  if (localDesktop && host !== "127.0.0.1") throw new Error("Local desktop requires a loopback-only listener");
  return { help: false, host, port, dataDirectory: resolve(dataDirectory), allowUnauthenticatedPublic,
    ...(localDesktop ? { localDesktop: true } : {}),
    ...(sshServersFile ? { sshServersFile } : {}), ...(sshPublicOrigin ? { sshPublicOrigin } : {}), ...(sshPublicAccess ? { sshPublicAccess: true } : {}), ...(sshAccessFile ? { sshAccessFile } : {}) };
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
  const sshServers = options.sshServers ?? (options.sshServersFile ? await readSshCodexServerBindings(options.sshServersFile) : []);
  if (options.sshPublicAccess && options.sshPublicOrigin) throw new Error("Choose either SSH public access or a fixed origin");
  if (sshServers.length && host !== "127.0.0.1" && !options.sshPublicOrigin && !options.sshPublicAccess) throw new Error("SSH Servers cannot be exposed through an unauthenticated public listener");
  const remoteServers = new Map(sshServers.map(binding => [binding.descriptor.serverId, binding]));
  if (remoteServers.size !== sshServers.length) throw new Error("Duplicate SSH Server identity");
  if (options.localDesktop && host !== "127.0.0.1") throw new Error("Local desktop requires a loopback-only listener");
  await access(join(webRoot, "index.html"));
  await assertHeadlessWebRelease(webRoot);
  await secureDataDirectory(dataDirectory);
  const releaseLock = await lockfile.lock(join(dataDirectory, "server"), { realpath: false, retries: 0 });
  let agent;
  let web;
  let appHostServer;
  let sshManagement;
  let desktop;
  let closing = null;
  const close = () => {
    if (closing !== null) return closing;
    closing = (async () => {
      desktop?.close(); // Retire viewers before the execution provider; never stop the desktop.
      const results = await Promise.allSettled([web?.close(), appHostServer?.close(), agent?.close()]);
      sshManagement?.close();
      await releaseLock();
      const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, "OpenCraft server shutdown failed");
    })();
    return closing;
  };
  try {
    if (options.localDesktop === true) {
      const observer = createNativeObserver();
      await observer.inspect(AbortSignal.timeout(5_000));
      const environmentId = await localDesktopMachineIdentity();
      const principalId = `local-owner:${process.getuid()}`;
      const serverId = `local-codex:${createHash("sha256").update(JSON.stringify([dataDirectory, principalId])).digest("hex")}`;
      desktop = new LocalDesktopService({ serverId, environmentId, principalId, observer });
    }
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
        const remote = remoteServers.get(hostId);
        if (remote) return createSshCodexEngineAdapter(remote);
        if (hostId.startsWith("ssh:")) return createSshCodexEngineAdapter(sshManagement.store.binding(hostId));
        if (hostId !== "local-codex") throw new Error(`Unknown server Host ${hostId}`);
        return options.createCodexTransport?.() ?? new CodexEngineAdapter({
          executable: options.codexExecutable ?? join(root, "runtime/codex/bin/codex"),
          runtimeDirectory: join(root, "runtime"),
          dataDirectory: join(dataDirectory, "codex"),
          nativeCodexHomeDirectory: join(dataDirectory, "native-codex"),
          desktop,
        });
      },
    });
    // Local anonymous features remain usable. Public remote access is enabled
    // only with explicit operator opt-in; all remote sockets require a session.
    if (host === "127.0.0.1" || options.sshPublicOrigin || options.sshPublicAccess) sshManagement = new SshManagement({
      directory: join(dataDirectory, "ssh"), publicOrigin: options.sshPublicOrigin, publicAccess: options.sshPublicAccess, accessFile: options.sshAccessFile,
      resetConnection: id => appHostServer.resetHost(id), connectionState: id => appHostServer.hostState(id),
      connectConnection: (id, assertAdmission) => appHostServer.ensureHostConnected(id, assertAdmission),
      legacyServers: sshServers.map(binding => binding.descriptor),
    });
    const createWeb = options.createWebServer ?? createWorkbenchWebServer;
    web = await createWeb({
      root: webRoot,
      appServerTarget: agent.websocketUrl,
      loopbackOnly: host === "127.0.0.1",
      appHostServer,
      sshServerDescriptors: sshServers.map(binding => binding.descriptor),
      sshManagement,
      desktopService: desktop ?? null,
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
      process.stdout.write("Usage: opencraft-server [--host 127.0.0.1|0.0.0.0] [--port 10000] [--data-dir PATH] [--ssh-servers PRIVATE_JSON] [--ssh-public-origin HTTPS_ORIGIN | --ssh-public-access] [--ssh-access-file PRIVATE_FILE] [--allow-unauthenticated-public] [--local-desktop]\nDefault: loopback only. SSH management requires a private access key. Public SSH requires explicit opt-in; HTTP access exposes credentials without transport encryption. Local desktop requires loopback and an installed verified observer.\n");
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
