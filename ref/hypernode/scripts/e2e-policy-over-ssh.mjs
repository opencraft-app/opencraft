import { randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";

const port = 19988;
const database = `.runtime/policy-e2e-${process.pid}.sqlite`;
const privateKeyPath = `.runtime/policy-e2e-${process.pid}-root-key`;
const usersRoot = `.runtime/policy-e2e-${process.pid}-users`;
const sshStack = process.env.HYPERNODE_E2E_SSH_STACK ?? "go";
const sentinel = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
const appServerCommand = String.raw`sh -c 'CODEX_REMOTE_PAYLOAD="$1"; printf "\001\002\003\004\005\006\007\010"; codex app-server proxy' sh x`;
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const server = spawn("./bin/hypernode", [
  "serve",
  "--listen", `127.0.0.1:${port}`,
  "--db", database,
  "--policy", "policy/default.js",
  "--host-key", "/etc/ssh/ssh_host_ed25519_key",
  "--allow-none=true",
  "--ssh-stack", sshStack,
  "--auth-mode=bootstrap",
  "--localhost-root=.",
  `--users-root=${usersRoot}`,
  `--model-gateway-base-url=http://127.0.0.1:${port}`,
], { stdio: ["ignore", "ignore", "pipe"] });

function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = predicate();
        if (value) return resolve(value);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started >= timeoutMs) return reject(new Error("policy E2E timed out"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function runSSH(arguments_) {
  return new Promise((resolve) => {
    const child = spawn("ssh", arguments_, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runInteractiveSSH(arguments_, input) {
  return new Promise((resolve) => {
    const child = spawn("ssh", arguments_, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function openAppServerConnection(identityArguments = [], username = "codex") {
  const child = spawn("ssh", [
    "-T", "-p", String(port), ...identityArguments,
    "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
    `${username}@127.0.0.1`, appServerCommand,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let incoming = Buffer.alloc(0);
  let stderr = "";
  child.stdout.on("data", (chunk) => { incoming = Buffer.concat([incoming, chunk]); });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await waitFor(() => incoming.length >= sentinel.length || child.exitCode != null);
  if (!incoming.subarray(0, sentinel.length).equals(sentinel)) {
    throw new Error(`reconnect missing remote sentinel: ${incoming.toString("hex")} ${stderr}`);
  }
  incoming = incoming.subarray(sentinel.length);
  child.stdin.write(
    "GET /rpc HTTP/1.1\r\n" +
    "Host: hypernode\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Version: 13\r\n" +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );
  await waitFor(() => incoming.indexOf("\r\n\r\n") >= 0);
  const end = incoming.indexOf("\r\n\r\n") + 4;
  const header = incoming.subarray(0, end).toString("ascii");
  incoming = incoming.subarray(end);
  if (!header.startsWith("HTTP/1.1 101")) throw new Error(`reconnect upgrade failed: ${header}`);

  const responses = new Map();
  const notifications = [];
  const messages = [];
  const maskFrame = (message) => {
    const payload = Buffer.from(JSON.stringify(message));
    const mask = randomBytes(4);
    const prefix = payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0xfe, payload.length >>> 8, payload.length & 0xff]);
    const masked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
    return Buffer.concat([prefix, mask, masked]);
  };
  const drain = () => {
    while (incoming.length >= 2) {
      let length = incoming[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (incoming.length < 4) return;
        length = incoming.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (incoming.length < 10) return;
        if (incoming.readUInt32BE(2) !== 0) throw new Error("reconnect server frame too large");
        length = incoming.readUInt32BE(6);
        offset = 10;
      }
      if (incoming.length < offset + length) return;
      const opcode = incoming[0] & 0x0f;
      const payload = incoming.subarray(offset, offset + length);
      incoming = incoming.subarray(offset + length);
      if (opcode !== 1) continue;
      const message = JSON.parse(payload.toString("utf8"));
      messages.push(message);
      if (message.id != null) responses.set(String(message.id), message);
      else if (message.method) notifications.push(message);
    }
  };
  return {
    child,
    messages,
    notifications,
    drain,
    request(id, method, params = {}) {
      child.stdin.write(maskFrame({ id, method, params }));
      return waitFor(() => {
        drain();
        return responses.get(String(id));
      }, 30_000).catch((error) => {
        throw new Error(`${method} (${id}) failed while waiting: ${error.message}`);
      });
    },
  };
}

let serverLog = "";
server.stderr.on("data", (chunk) => { serverLog += chunk; });

let ssh;
try {
  await waitFor(() => serverLog.includes("hypernode ingress listening"));
  ssh = spawn("ssh", [
    "-T",
    "-p", String(port),
    "-o", "BatchMode=yes",
    "-o", "PreferredAuthentications=none",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "codex@127.0.0.1",
    appServerCommand,
  ], { stdio: ["pipe", "pipe", "pipe"] });

  let incoming = Buffer.alloc(0);
  let sshError = "";
  ssh.stdout.on("data", (chunk) => { incoming = Buffer.concat([incoming, chunk]); });
  ssh.stderr.on("data", (chunk) => { sshError += chunk; });

  await waitFor(() => incoming.length >= sentinel.length || ssh.exitCode != null);
  if (!incoming.subarray(0, sentinel.length).equals(sentinel)) {
    throw new Error(`missing remote sentinel: ${incoming.toString("hex")} ${sshError}`);
  }
  incoming = incoming.subarray(sentinel.length);
  ssh.stdin.write(
    "GET /rpc HTTP/1.1\r\n" +
    "Host: hypernode\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Version: 13\r\n" +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );
  await waitFor(() => incoming.indexOf("\r\n\r\n") >= 0);
  const headerEnd = incoming.indexOf("\r\n\r\n") + 4;
  const header = incoming.subarray(0, headerEnd).toString("ascii");
  incoming = incoming.subarray(headerEnd);
  if (!header.startsWith("HTTP/1.1 101")) throw new Error(`upgrade failed: ${header}`);

  const maskFrame = (message) => {
    const payload = Buffer.from(JSON.stringify(message));
    const mask = randomBytes(4);
    const prefix = payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0xfe, payload.length >>> 8, payload.length & 0xff]);
    const masked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
    return Buffer.concat([prefix, mask, masked]);
  };

  const responses = new Map();
  const notifications = [];
  const drainFrames = () => {
    while (incoming.length >= 2) {
      let length = incoming[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (incoming.length < 4) return;
        length = incoming.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (incoming.length < 10) return;
        const high = incoming.readUInt32BE(2);
        if (high !== 0) throw new Error("server frame too large");
        length = incoming.readUInt32BE(6);
        offset = 10;
      }
      if (incoming.length < offset + length) return;
      const opcode = incoming[0] & 0x0f;
      const payload = incoming.subarray(offset, offset + length);
      incoming = incoming.subarray(offset + length);
      if (opcode === 1) {
        const message = JSON.parse(payload.toString("utf8"));
        if (message.id != null) responses.set(String(message.id), message);
        else if (message.method) notifications.push(message);
      }
    }
  };

  const request = async (id, method, params = {}, timeoutMs = 30_000) => {
    ssh.stdin.write(maskFrame({ id, method, params }));
    return waitFor(() => {
      drainFrames();
      return responses.get(id);
    }, timeoutMs).catch((error) => {
      throw new Error(`${method} (${id}) failed while waiting: ${error.message}`);
    });
  };

  const initialize = await request("initialize", "initialize", {
    clientInfo: { name: "hypernode-policy-e2e", version: "1" },
    capabilities: { experimentalApi: true },
  });
  const welcomeStarted = await waitFor(() => {
    drainFrames();
    return notifications.find((message) =>
      message.method === "item/started" && message.params?.item?.type === "agentMessage");
  });
  const account = await request("account", "account/read", { refreshToken: false });
  const configWrite = await request("config-default-model", "config/batchWrite", {
    edits: [
      { keyPath: "model", value: "gpt-5.4", mergeStrategy: "upsert" },
      { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" },
    ],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  });
  if (configWrite.error || configWrite.result?.status !== "ok") {
    throw new Error(`config/batchWrite failed: ${JSON.stringify(configWrite)}`);
  }
  const configRead = await request("config-read-after-write", "config/read", {
    cwd: "/workspace",
    includeLayers: false,
  });
  if (configRead.result?.config?.model !== "gpt-5.4" ||
      configRead.result?.config?.model_reasoning_effort !== "high") {
    throw new Error(`config defaults did not round-trip: ${JSON.stringify(configRead)}`);
  }
  const remoteControlStatus = await request(
    "remote-control-status",
    "remoteControl/status/read",
    {},
  );
  drainFrames();
  const welcomeCompleted = notifications.find((message) =>
    message.method === "item/completed" &&
    message.params?.turnId === welcomeStarted.params?.turnId &&
    message.params?.item?.type === "agentMessage");
  const principal = await request("principal", "hypernode/principal/read");
  const users = await request("users", "hypernode/users/read");
  const allThread = await request("all-thread", "hypernode/allThread/read");
  const device = await request("device", "hypernode/device/read");
  const installationIdFile = await request("installation-id-file", "fs/readFile", {
    path: "/workspace/.codex/installation_id",
  });
  const config = await request("config", "config/read", { cwd: "/workspace", includeLayers: true });
  const models = await request("models", "model/list", { includeHidden: true, limit: 100 });
  const collaborationModes = await request("collaboration-modes", "collaborationMode/list", {});
  const plugins = await request("plugins", "plugin/list", { cwds: ["/workspace"] });
  const installedPlugins = await request("plugins-installed", "plugin/installed", { cwds: ["/workspace"] });
  const pluginDetail = await request("plugin-detail", "plugin/read", {
    marketplacePath: "/workspace/.codex/marketplaces/hypernode/marketplace.json",
    pluginName: "hypernode-control",
  });
  const pluginSkill = await request("plugin-skill", "plugin/skill/read", {
    remoteMarketplaceName: "hypernode",
    remotePluginId: "hypernode-control",
    skillName: "hypernode",
  });
  const marketplaceAdd = await request("marketplace-add", "marketplace/add", {
    source: "/workspace/.codex/marketplaces/hypernode",
  });
  const skills = await request("skills", "skills/list", { cwds: ["/workspace"], forceReload: true });
  const threads = await request("threads", "thread/list", { modelProviders: [], limit: 100 });
  const firstThreadPage = await request("threads-page-1", "thread/list", { modelProviders: [], limit: 1 });
  const secondThreadPage = await request("threads-page-2", "thread/list", {
    modelProviders: [], limit: 1, cursor: firstThreadPage.result?.nextCursor,
  });
  const metadata = await request("metadata", "fs/getMetadata", { path: "/workspace" });
  const localhostMetadata = await request("localhost-metadata", "fs/getMetadata", { path: "/localhost" });

  if (initialize.result?.platformOs !== "linux") throw new Error("initialize response mismatch");
  const collaborationModeData = collaborationModes.result?.data;
  if (collaborationModes.error || !Array.isArray(collaborationModeData) ||
      !collaborationModeData.some((mode) => mode?.mode === "plan") ||
      !collaborationModeData.some((mode) => mode?.mode === "default")) {
    throw new Error(`collaborationMode/list contract mismatch: ${JSON.stringify(collaborationModes)}`);
  }
  const hypernodeMarketplace = plugins.result?.marketplaces?.find((marketplace) => marketplace.name === "hypernode");
  const hypernodePlugin = hypernodeMarketplace?.plugins?.find((plugin) => plugin.id === "hypernode-control");
  if (plugins.error || hypernodePlugin?.installed !== true || hypernodePlugin?.enabled !== true ||
      plugins.result?.featuredPluginIds?.[0] !== "hypernode-control") {
    throw new Error(`Desktop plugin catalog mismatch: ${JSON.stringify(plugins)}`);
  }
  if (!installedPlugins.result?.marketplaces?.some((marketplace) =>
    marketplace.plugins?.some((plugin) => plugin.id === "hypernode-control"))) {
    throw new Error(`installed plugin catalog mismatch: ${JSON.stringify(installedPlugins)}`);
  }
  if (pluginDetail.result?.plugin?.summary?.id !== "hypernode-control" ||
      pluginDetail.result?.plugin?.skills?.[0]?.path !== "/workspace/.codex/skills/hypernode/SKILL.md") {
    throw new Error(`plugin detail mismatch: ${JSON.stringify(pluginDetail)}`);
  }
  if (!pluginSkill.result?.contents?.includes("# HyperNode")) {
    throw new Error(`plugin skill source mismatch: ${JSON.stringify(pluginSkill)}`);
  }
  if (marketplaceAdd.result?.marketplaceName !== "hypernode" ||
      marketplaceAdd.result?.alreadyAdded !== true) {
    throw new Error(`marketplace add mismatch: ${JSON.stringify(marketplaceAdd)}`);
  }
  if (account.error || !Object.prototype.hasOwnProperty.call(account.result ?? {}, "account")) {
    throw new Error(`transparent account service mismatch: ${JSON.stringify(account)}`);
  }
  const bootstrapMessage = welcomeCompleted?.params?.item?.text ?? "";
  const privateKey = bootstrapMessage.match(
    /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]+?-----END OPENSSH PRIVATE KEY-----/,
  )?.[0];
  if (welcomeStarted.params?.item?.text !== "" || !privateKey ||
      welcomeStarted.params?.threadId !== allThread.result?.thread?.id) {
    throw new Error(`login spinner or welcome thread message mismatch: started=${JSON.stringify(welcomeStarted)} completed=${JSON.stringify(welcomeCompleted)} all=${JSON.stringify(allThread)}`);
  }
  if (principal.result?.principal?.id !== "node:root" || principal.result?.principal?.username !== "root") {
    throw new Error("unified root principal mismatch");
  }
  if (firstThreadPage.result?.data?.length !== 1 || !firstThreadPage.result?.nextCursor ||
      firstThreadPage.result.data[0]?.turns?.length !== 0 ||
      secondThreadPage.result?.data?.length !== 1 ||
      secondThreadPage.result.data[0]?.id === firstThreadPage.result.data[0]?.id ||
      secondThreadPage.result.data[0]?.turns?.length !== 0) {
    throw new Error(`thread/list pagination contract mismatch: first=${JSON.stringify(firstThreadPage)} second=${JSON.stringify(secondThreadPage)}`);
  }
  const rootUser = users.result?.users?.find((user) => user.username === "codex");
  if (rootUser?.id !== "user:codex" || rootUser?.role !== "administrator" || rootUser?.loginCount !== 1 ||
      rootUser?.linuxUid !== 20000 || !rootUser?.homePath || !rootUser?.codexHome ||
      rootUser?.codexBindingState !== "unbound" || !rootUser?.installationId ||
      rootUser?.loginOrigins?.[0]?.remoteHost !== "127.0.0.1" ||
      !rootUser?.sshPublicKey?.startsWith("ssh-ed25519 ") ||
      !rootUser?.sshKeyFingerprint?.startsWith("SHA256:")) {
    throw new Error("durable user directory mismatch");
  }
  if (remoteControlStatus.error || remoteControlStatus.result?.status !== "disabled" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        remoteControlStatus.result?.installationId ?? "",
      ) || remoteControlStatus.result?.installationId !== rootUser.installationId) {
    throw new Error(`transparent remote control status mismatch: ${JSON.stringify(remoteControlStatus)}`);
  }
  if (JSON.stringify(rootUser).includes("PRIVATE KEY")) throw new Error("private key leaked into user directory");
  await writeFile(privateKeyPath, `${privateKey}\n`, { mode: 0o600 });
  const previewSentinel = `hypernode-file-preview-${process.pid}`;
  await writeFile(`${rootUser.homePath}/preview-sentinel.txt`, previewSentinel);
  const previewMetadata = await request("localhost-preview-metadata", "fs/getMetadata", {
    path: "/localhost/preview-sentinel.txt",
  });
  const previewFile = await request("localhost-preview-file", "fs/readFile", {
    path: "/localhost/preview-sentinel.txt",
  });
  const previewMetadataKeys = Object.keys(previewMetadata.result ?? {}).sort();
  const expectedMetadataKeys = ["createdAtMs", "isDirectory", "isFile", "isSymlink", "modifiedAtMs"];
  if (JSON.stringify(previewMetadataKeys) !== JSON.stringify(expectedMetadataKeys) ||
      previewMetadata.result?.isFile !== true) {
    throw new Error(`fs/getMetadata wire contract mismatch: ${JSON.stringify(previewMetadata)}`);
  }
  if (Buffer.from(previewFile.result?.dataBase64 ?? "", "base64").toString("utf8") !== previewSentinel) {
    throw new Error(`per-user localhost projection mismatch: ${JSON.stringify(previewFile)}`);
  }
  const hostProcessHandle = `hypernode-host-process-${process.pid}`;
  const hostProcessSentinel = `HYPERNODE_HOST_PROCESS_${process.pid}`;
  const hostProcessSpawn = await request("host-process-spawn", "process/spawn", {
    command: ["/bin/sh", "-lc", `printf '${hostProcessSentinel}'`],
    processHandle: hostProcessHandle,
    cwd: "/localhost",
    streamStdoutStderr: true,
    outputBytesCap: 1024 * 1024,
    timeoutMs: 5000,
  });
  if (hostProcessSpawn.error || JSON.stringify(hostProcessSpawn.result ?? {}) !== "{}") {
    throw new Error(`process/spawn acknowledgement mismatch: ${JSON.stringify(hostProcessSpawn)}`);
  }
  const hostProcessExit = await waitFor(() => {
    drainFrames();
    return notifications.find((message) =>
      message.method === "process/exited" && message.params?.processHandle === hostProcessHandle);
  });
  const hostProcessOutput = notifications
    .filter((message) => message.method === "process/outputDelta" &&
      message.params?.processHandle === hostProcessHandle)
    .map((message) => Buffer.from(message.params?.deltaBase64 ?? "", "base64").toString("utf8"))
    .join("");
  if (hostProcessExit.params?.exitCode !== 0 ||
      !`${hostProcessOutput}${hostProcessExit.params?.stdout ?? ""}`.includes(hostProcessSentinel)) {
    throw new Error(`process host stream mismatch: exit=${JSON.stringify(hostProcessExit)} output=${JSON.stringify(hostProcessOutput)}`);
  }
  const hostPtyHandle = `hypernode-host-pty-${process.pid}`;
  const hostPtySentinel = `HYPERNODE_HOST_PTY_${process.pid}`;
  const hostPtySpawn = await request("host-pty-spawn", "process/spawn", {
    command: ["/bin/bash", "--noprofile", "--norc"],
    processHandle: hostPtyHandle,
    cwd: "/localhost",
    tty: true,
    streamStdin: true,
    streamStdoutStderr: true,
    outputBytesCap: 1024 * 1024,
    timeoutMs: 10_000,
    size: { cols: 80, rows: 24 },
  });
  if (hostPtySpawn.error) throw new Error(`process PTY spawn failed: ${JSON.stringify(hostPtySpawn)}`);
  const hostPtyResize = await request("host-pty-resize", "process/resizePty", {
    processHandle: hostPtyHandle,
    size: { cols: 120, rows: 40 },
  });
  if (hostPtyResize.error) throw new Error(`process PTY resize failed: ${JSON.stringify(hostPtyResize)}`);
  const hostPtyWrite = await request("host-pty-write", "process/writeStdin", {
    processHandle: hostPtyHandle,
    deltaBase64: Buffer.from(`printf '${hostPtySentinel}\\n'; exit\n`).toString("base64"),
    closeStdin: false,
  });
  if (hostPtyWrite.error) throw new Error(`process PTY write failed: ${JSON.stringify(hostPtyWrite)}`);
  const hostPtyExit = await waitFor(() => {
    drainFrames();
    return notifications.find((message) =>
      message.method === "process/exited" && message.params?.processHandle === hostPtyHandle);
  });
  const hostPtyOutput = notifications
    .filter((message) => message.method === "process/outputDelta" &&
      message.params?.processHandle === hostPtyHandle)
    .map((message) => Buffer.from(message.params?.deltaBase64 ?? "", "base64").toString("utf8"))
    .join("");
  if (hostPtyExit.params?.exitCode !== 0 || !hostPtyOutput.includes(hostPtySentinel)) {
    throw new Error(`process PTY stream mismatch: exit=${JSON.stringify(hostPtyExit)} output=${JSON.stringify(hostPtyOutput)}`);
  }
  const appTerminalProcessId = `hypernode-app-terminal-${process.pid}`;
  const appTerminalSentinel = `HYPERNODE_APP_TERMINAL_${process.pid}`;
  const appTerminalCompletion = request("app-terminal-start", "command/exec", {
    command: ["/bin/bash", "--noprofile", "--norc"],
    processId: appTerminalProcessId,
    tty: true,
    streamStdin: true,
    streamStdoutStderr: true,
    disableTimeout: true,
    cwd: "/localhost/generated/project",
    size: { cols: 80, rows: 24 },
    sandboxPolicy: { type: "dangerFullAccess" },
  });
  const appTerminalResize = await request("app-terminal-resize", "command/exec/resize", {
    processId: appTerminalProcessId,
    size: { cols: 120, rows: 40 },
  });
  if (appTerminalResize.error) {
    throw new Error(`app-server terminal resize failed: ${JSON.stringify(appTerminalResize)}`);
  }
  const appTerminalWrite = await request("app-terminal-write", "command/exec/write", {
    processId: appTerminalProcessId,
    deltaBase64: Buffer.from(`printf '${appTerminalSentinel}\\n'; pwd; exit\n`).toString("base64"),
  });
  if (appTerminalWrite.error) {
    throw new Error(`app-server terminal write failed: ${JSON.stringify(appTerminalWrite)}`);
  }
  const appTerminalResult = await appTerminalCompletion;
  const generatedCwd = await request("app-terminal-generated-cwd", "fs/getMetadata", {
    path: "/localhost/generated/project",
  });
  drainFrames();
  const appTerminalOutput = notifications
    .filter((message) => message.method === "command/exec/outputDelta" &&
      message.params?.processId === appTerminalProcessId)
    .map((message) => Buffer.from(message.params.deltaBase64 ?? "", "base64").toString("utf8"))
    .join("");
  if (appTerminalResult.error || appTerminalResult.result?.exitCode !== 0 ||
      !appTerminalOutput.includes(appTerminalSentinel) ||
      !appTerminalOutput.includes(`${rootUser.homePath}/generated/project`) ||
      generatedCwd.result?.isDirectory !== true) {
    throw new Error(`app-server terminal stream mismatch: result=${JSON.stringify(appTerminalResult)} output=${JSON.stringify(appTerminalOutput)}`);
  }
  if (sshStack === "vssh") {
    const terminalSentinel = `HYPERNODE_TERMINAL_${process.pid}`;
    const terminal = await runInteractiveSSH([
      "-tt", "-p", String(port),
      "-i", privateKeyPath,
      "-o", "PreferredAuthentications=publickey",
      "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
      "codex@127.0.0.1",
    ], `printf '${terminalSentinel}\\n'; pwd; exit\n`);
    if (!terminal.stdout.includes(terminalSentinel) || !terminal.stdout.includes(rootUser.homePath)) {
      throw new Error(`vSSH terminal service mismatch: ${JSON.stringify(terminal)}`);
    }
    const echoServer = createServer((socket) => socket.pipe(socket));
    await new Promise((resolve, reject) => {
      echoServer.once("error", reject);
      echoServer.listen(0, "127.0.0.1", resolve);
    });
    try {
      const echoPort = echoServer.address().port;
      const forwardSentinel = `HYPERNODE_DIRECT_TCPIP_${process.pid}`;
      const forwarded = await runInteractiveSSH([
        "-T", "-p", String(port),
        "-i", privateKeyPath,
        "-o", "PreferredAuthentications=publickey",
        "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        "-W", `127.0.0.1:${echoPort}`,
        "codex@127.0.0.1",
      ], forwardSentinel);
      if (forwarded.code !== 0 || forwarded.stdout !== forwardSentinel) {
        throw new Error(`vSSH direct-tcpip mismatch: ${JSON.stringify(forwarded)}`);
      }
    } finally {
      await new Promise((resolve) => echoServer.close(resolve));
    }
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(device.result?.installationId ?? "")) {
    throw new Error("stable synthetic device identity mismatch");
  }
  if (device.result?.userId !== rootUser.id || device.result?.bindingState !== "unbound" ||
      device.result?.loginMethods?.[0] !== "chatgptDeviceCode") {
    throw new Error(`per-user Codex device state mismatch: ${JSON.stringify(device)}`);
  }
  if (Buffer.from(installationIdFile.result?.dataBase64 ?? "", "base64").toString("utf8") !== device.result.installationId) {
    throw new Error("Codex installation_id VFS projection mismatch");
  }
  if (!config.result?.config || typeof config.result.config !== "object") {
    throw new Error(`transparent config service mismatch: ${JSON.stringify(config)}`);
  }
  if (!Array.isArray(models.result?.data) || models.result.data.length === 0 ||
      !models.result.data.some((model) => Array.isArray(model.supportedReasoningEfforts))) {
    throw new Error(`transparent model service mismatch: ${JSON.stringify(models)}`);
  }
  if (!Array.isArray(plugins.result?.marketplaces)) throw new Error("plugin service mismatch");
  const menuSkill = skills.result?.data?.[0]?.skills?.find((skill) => skill.name === "hypernode");
  const usersSkill = skills.result?.data?.[0]?.skills?.find((skill) => skill.name === "users");
  const accountsSkill = skills.result?.data?.[0]?.skills?.find((skill) => skill.name === "accounts");
  const accountSkill = skills.result?.data?.[0]?.skills?.find((skill) => skill.name === "codex-account");
  const sessionsSkill = skills.result?.data?.[0]?.skills?.find((skill) => skill.name === "sessions");
  if (menuSkill) throw new Error("obsolete Hypernode menu skill is still present");
  if (usersSkill?.interface?.displayName !== "用户列表") {
    throw new Error("virtual users skill catalog mismatch");
  }
  if (accountsSkill?.interface?.displayName !== "Codex 账户") {
    throw new Error("virtual Codex accounts skill catalog mismatch");
  }
  if (accountSkill?.interface?.displayName !== "添加 Codex 账户") {
    throw new Error("virtual Codex account skill catalog mismatch");
  }
  if (sessionsSkill?.interface?.displayName !== "活跃会话") {
    throw new Error("virtual active-thread skill catalog mismatch");
  }
  const rootThreadId = threads.result?.data?.find((thread) => thread.name === "☁️ 管理员")?.id;
  const allThreadId = threads.result?.data?.find((thread) => thread.name === "☁️ All")?.id;
  const transparentRoot = threads.result?.data?.find((thread) => thread.name === "☁️ Codex 透明 Thread");
  if (!rootThreadId || !allThreadId || transparentRoot || allThreadId !== allThread.result?.thread?.id) {
    throw new Error("system thread catalog mismatch");
  }
  const bindingTurn = await request("codex-account-binding", "turn/start", {
    threadId: rootThreadId,
    input: [{
      type: "text",
      text: "[$codex-account](/workspace/.codex/skills/codex-account/SKILL.md)",
    }],
    clientUserMessageId: "codex-account-binding-e2e",
  });
  if (!bindingTurn.result?.turn?.id) {
    throw new Error(`management account binding did not start: ${JSON.stringify(bindingTurn)}`);
  }
  const devicePrompt = await waitFor(() => {
    drainFrames();
    return notifications.find((message) =>
      message.method === "item/completed" &&
      message.params?.item?.type === "agentMessage" &&
      /auth\.openai\.com\/codex\/device/.test(message.params.item.text ?? "") &&
      /一次性验证码/.test(message.params.item.text ?? ""));
  }, 30_000);
  if (!devicePrompt.params?.item?.text || devicePrompt.params.item.text.includes("auth.json")) {
    throw new Error("device login prompt was not delivered as a sensitive management message");
  }
  const bindingState = await request("account-binding-state", "hypernode/accountBinding/read");
  if (bindingState.result?.bindingState !== "pending" || bindingState.result?.flow?.phase !== "awaitingUser") {
    throw new Error(`device login state mismatch: ${JSON.stringify(bindingState)}`);
  }
  if (metadata.result?.isDirectory !== true) throw new Error("VFS service mismatch");
  if (localhostMetadata.result?.isDirectory !== true) {
    throw new Error("localhost host filesystem projection mismatch");
  }

  const now = Date.now();
  execFileSync("sqlite3", [database, `
    INSERT INTO do_users(
      id, username, role, authentication, created_at_ms, last_login_at_ms, login_count,
      ssh_public_key, ssh_key_fingerprint, codex_binding_state
    ) VALUES (
      'user:reader', 'reader', 'member', 'publickey', ${now}, ${now}, 0,
      ${sqlLiteral(rootUser.sshPublicKey)}, ${sqlLiteral(rootUser.sshKeyFingerprint)}, 'unbound'
    )
  `]);
  const otherReader = await openAppServerConnection([
    "-i", privateKeyPath,
    "-o", "PreferredAuthentications=publickey",
  ], "reader");
  await otherReader.request("reader-initialize", "initialize", {
    clientInfo: { name: "hypernode-readonly-e2e", version: "1" },
    capabilities: { experimentalApi: true },
  });
  const allFanout = await openAppServerConnection([
    "-i", privateKeyPath,
    "-o", "PreferredAuthentications=publickey",
  ]);
  try {
    await allFanout.request("all-fanout-initialize", "initialize", {
      clientInfo: { name: "hypernode-all-fanout-e2e", version: "1" },
      capabilities: { experimentalApi: true },
    });
    const editingLease = await request("write-lease-acquire", "hypernode/threadWriteLease/acquire", {
      threadId: allThreadId,
    });
    if (editingLease.result?.lease?.phase !== "editing" ||
        editingLease.result?.lease?.holderUsername !== "codex") {
      throw new Error(`thread write lease acquisition mismatch: ${JSON.stringify(editingLease)}`);
    }
    const lastEditorWarning = await waitFor(() => {
      otherReader.drain();
      return otherReader.notifications.find((message) =>
        message.method === "warning" && message.params?.threadId === allThreadId);
    });
    if (!/此会话于 .* 前被 codex 编辑/.test(lastEditorWarning.params?.message ?? "")) {
      throw new Error(`last editor warning mismatch: ${JSON.stringify(lastEditorWarning)}`);
    }
    const sameUserWarning = await waitFor(() => {
      allFanout.drain();
      return allFanout.notifications.find((message) =>
        message.method === "warning" && message.params?.threadId === allThreadId);
    });
    if (!/前被 codex 编辑/.test(sameUserWarning.params?.message ?? "")) {
      throw new Error(`same-user last editor warning mismatch: ${JSON.stringify(sameUserWarning)}`);
    }
    const sessionsTurn = await request("active-sessions-turn", "turn/start", {
      threadId: rootThreadId,
      input: [{
        type: "text",
        text: "[$sessions](/workspace/.codex/skills/sessions/SKILL.md)",
      }],
      clientUserMessageId: "active-sessions-e2e",
    });
    const sessionsTurnId = sessionsTurn.result?.turn?.id;
    const sessionsCompleted = await waitFor(() => {
      drainFrames();
      return notifications.find((message) =>
        message.method === "turn/completed" && message.params?.turn?.id === sessionsTurnId);
    });
    const sessionsText = sessionsCompleted.params?.turn?.items
      ?.filter((item) => item.type === "agentMessage")
      .map((item) => item.text)
      .join("\n") ?? "";
    if (!sessionsText.includes("当前带写入租约的会话") ||
        !sessionsText.includes("上一次对话") || !sessionsText.includes("codex")) {
      throw new Error(`active sessions management output mismatch: ${sessionsText}`);
    }
    const leaseRead = await allFanout.request(
      "write-lease-read",
      "hypernode/threadWriteLease/read",
      { threadId: allThreadId },
    );
    if (leaseRead.result?.lease?.connectionId !== editingLease.result?.lease?.connectionId) {
      throw new Error(`thread write lease projection mismatch: ${JSON.stringify(leaseRead)}`);
    }
    const blockedTurn = await allFanout.request("write-lease-blocked-turn", "turn/start", {
      threadId: allThreadId,
      input: [{ type: "text", text: "must be rejected by single writer" }],
    });
    if (blockedTurn.error?.code !== -32061 ||
        blockedTurn.error?.data?.kind !== "threadWriteLeaseHeld" ||
        blockedTurn.error?.data?.holderUsername !== "codex") {
      throw new Error(`second writer was not rejected deterministically: ${JSON.stringify(blockedTurn)}`);
    }
    const blockedMetadata = await allFanout.request(
      "write-lease-blocked-metadata",
      "thread/metadata/update",
      { threadId: allThreadId, gitInfo: null },
    );
    if (blockedMetadata.error?.data?.kind !== "threadWriteLeaseHeld") {
      throw new Error(`secondary thread mutation bypassed the lease: ${JSON.stringify(blockedMetadata)}`);
    }
    const heartbeat = await request(
      "write-lease-heartbeat",
      "hypernode/threadWriteLease/heartbeat",
      { threadId: allThreadId },
    );
    if (heartbeat.result?.lease?.expiresAtMs < editingLease.result?.lease?.expiresAtMs) {
      throw new Error(`thread write lease heartbeat did not renew TTL: ${JSON.stringify(heartbeat)}`);
    }
    const releasedLease = await request(
      "write-lease-release",
      "hypernode/threadWriteLease/release",
      { threadId: allThreadId },
    );
    if (releasedLease.result?.released !== true) throw new Error("thread write lease did not release");
    const fanoutTurn = await request("all-fanout-turn", "turn/start", {
      threadId: allThreadId,
      input: [{ type: "text", text: "all thread fanout sentinel" }],
      clientUserMessageId: "all-fanout-sentinel",
    });
    const fanoutTurnId = fanoutTurn.result?.turn?.id;
    if (!fanoutTurnId) throw new Error(`AllThread fanout turn failed: ${JSON.stringify(fanoutTurn)}`);
    const primaryFanout = await waitFor(() => {
      drainFrames();
      return notifications.find((message) =>
        message.method === "turn/completed" && message.params?.turn?.id === fanoutTurnId);
    });
    const secondaryFanout = await waitFor(() => {
      allFanout.drain();
      return allFanout.notifications.find((message) =>
        message.method === "turn/completed" && message.params?.turn?.id === fanoutTurnId);
    });
    const forTurn = (message) =>
      message.params?.turnId === fanoutTurnId || message.params?.turn?.id === fanoutTurnId;
    const expectedFanoutMethods = [
      "turn/started",
      "item/started",
      "item/completed",
      "item/started",
      "item/agentMessage/delta",
      "item/completed",
      "turn/completed",
    ];
    const primaryEvents = notifications.filter(forTurn);
    const secondaryEvents = allFanout.notifications.filter(forTurn);
    const secondaryUserItem = secondaryEvents.find((message) =>
      message.method === "item/completed" && message.params?.item?.type === "userMessage");
    if (!JSON.stringify(primaryFanout).includes("all thread fanout sentinel") ||
        JSON.stringify(primaryFanout) !== JSON.stringify(secondaryFanout) ||
        secondaryFanout.params?.turn?.itemsView !== "summary" ||
        primaryEvents.map((message) => message.method).join() !== expectedFanoutMethods.join() ||
        secondaryEvents.map((message) => message.method).join() !== expectedFanoutMethods.join() ||
        secondaryUserItem?.params?.item?.clientId !== "all-fanout-sentinel" ||
        secondaryUserItem?.params?.item?.content?.[0]?.text !== "all thread fanout sentinel") {
      throw new Error(`AllThread notifications did not fan out identically: primary=${JSON.stringify(primaryEvents)} secondary=${JSON.stringify(secondaryEvents)}`);
    }
    const leaseAfterTurn = await allFanout.request(
      "write-lease-after-turn",
      "hypernode/threadWriteLease/read",
      { threadId: allThreadId },
    );
    if (leaseAfterTurn.result?.lease !== null) {
      throw new Error(`completed turn retained its write lease: ${JSON.stringify(leaseAfterTurn)}`);
    }
  } finally {
    allFanout.child.kill("SIGTERM");
    otherReader.child.kill("SIGTERM");
  }

  // This is the important transparent-routing gate: a newly-created thread,
  // not merely the pre-created system thread, must be owned by real Codex.
  const dynamicTransparent = await request("transparent-dynamic-start", "thread/start", {
    cwd: "/localhost",
    model: "gpt-5.6-sol",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "read-only",
  });
  const dynamicTransparentId = dynamicTransparent.result?.thread?.id;
  if (!dynamicTransparentId ||
      dynamicTransparent.result?.cwd !== "/localhost" ||
      dynamicTransparent.result?.approvalPolicy !== "never" ||
      dynamicTransparent.result?.sandbox?.type !== "readOnly" ||
      !dynamicTransparent.result?.thread?.name?.startsWith("☁️") ||
      JSON.stringify(dynamicTransparent).includes(process.cwd())) {
    throw new Error(`dynamic transparent Codex start mismatch: ${JSON.stringify(dynamicTransparent)}`);
  }
  const dynamicResume = await request("transparent-dynamic-resume", "thread/resume", {
    threadId: dynamicTransparentId,
    cwd: "/localhost",
  });
  if (dynamicResume.result?.thread?.id !== dynamicTransparentId || dynamicResume.result?.cwd !== "/localhost") {
    throw new Error(`dynamic transparent Codex resume mismatch: ${JSON.stringify(dynamicResume)}`);
  }

  const unboundTurn = await request("transparent-unbound-turn", "turn/start", {
    threadId: dynamicTransparentId,
    input: [{ type: "text", text: "must not reach the Responses API" }],
  });
  if (unboundTurn.error?.code !== -32051 ||
      unboundTurn.error?.data?.kind !== "codexAccountNotBound" ||
      unboundTurn.error?.data?.installationId !== rootUser.installationId ||
      unboundTurn.error?.data?.loginMethod !== "chatgptDeviceCode") {
    throw new Error(`unbound Codex turn was not gated: ${JSON.stringify(unboundTurn)}`);
  }

  const ephemeralTransparent = await request("transparent-ephemeral-start", "thread/start", {
    cwd: "/localhost",
    ephemeral: true,
    threadSource: "system",
    model: "gpt-5.6-sol",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  });
  const ephemeralTransparentId = ephemeralTransparent.result?.thread?.id;
  const listAfterEphemeral = await request("threads-after-ephemeral", "thread/list", {
    modelProviders: [], limit: 100,
  });
  if (!ephemeralTransparentId || listAfterEphemeral.result?.data?.some((thread) => thread.id === ephemeralTransparentId)) {
    throw new Error("ephemeral transparent helper leaked into the thread catalog");
  }

  if (process.env.HYPERNODE_E2E_REAL_TURN === "1") {
    const transparentTurn = await request("transparent-turn", "turn/start", {
      threadId: dynamicTransparentId,
      input: [{ type: "text", text: "Reply with exactly HYPERNODE_TRANSPARENT_OK and do not use tools." }],
      clientUserMessageId: "transparent-real-turn",
    });
    const transparentTurnId = transparentTurn.result?.turn?.id;
    if (!transparentTurnId) throw new Error(`transparent turn/start failed: ${JSON.stringify(transparentTurn)}`);
    const completed = await waitFor(() => {
      drainFrames();
      return notifications.find((message) =>
        message.method === "turn/completed" && message.params?.turn?.id === transparentTurnId);
    }, 120_000);
    const agentText = completed.params?.turn?.items
      ?.filter((item) => item.type === "agentMessage")
      .map((item) => item.text)
      .join("\n") ?? "";
    if (!agentText.includes("HYPERNODE_TRANSPARENT_OK")) {
      throw new Error(`transparent real turn response mismatch: ${JSON.stringify(completed)}`);
    }
    const runningTitle = notifications.find((message) =>
      message.method === "thread/name/updated" && message.params?.threadId === dynamicTransparentId &&
      message.params?.threadName?.startsWith("🔒 我 · "));
    const completedTitle = notifications.find((message) =>
      message.method === "thread/name/updated" && message.params?.threadId === dynamicTransparentId &&
      message.params?.threadName?.startsWith("✅ 我 · "));
    if (!runningTitle || !completedTitle) {
      throw new Error(`transparent execution title lifecycle mismatch: ${JSON.stringify({ runningTitle, completedTitle })}`);
    }
    const releasedExecution = await request(
      "transparent-execution-released",
      "hypernode/threadExecution/read",
      { threadId: dynamicTransparentId },
    );
    if (releasedExecution.result?.execution !== null) {
      throw new Error(`transparent completion retained account execution: ${JSON.stringify(releasedExecution)}`);
    }

    const pooled = await openAppServerConnection([
      "-i", privateKeyPath,
      "-o", "PreferredAuthentications=publickey",
    ]);
    try {
      await pooled.request("pool-initialize", "initialize", {
        clientInfo: { name: "hypernode-pool-e2e", version: "1" },
        capabilities: { experimentalApi: true },
      });
      const pooledResume = await pooled.request("pool-resume", "thread/resume", {
        threadId: dynamicTransparentId,
        cwd: "/localhost",
      });
      const pooledHistory = pooledResume.result?.thread?.turns
        ?.flatMap((turn) => turn.items ?? [])
        .filter((item) => item.type === "agentMessage")
        .map((item) => item.text)
        .join("\n") ?? "";
      if (!pooledHistory.includes("HYPERNODE_TRANSPARENT_OK")) {
        throw new Error(`pooled frontend could not attach to the active thread: ${JSON.stringify(pooledResume)}`);
      }

      const pooledTurn = await pooled.request("pool-turn", "turn/start", {
        threadId: dynamicTransparentId,
        input: [{ type: "text", text: "Reply with exactly HYPERNODE_POOL_OK and do not use tools." }],
        clientUserMessageId: "transparent-pool-turn",
      });
      const pooledTurnId = pooledTurn.result?.turn?.id;
      if (!pooledTurnId) throw new Error(`pooled turn/start failed: ${JSON.stringify(pooledTurn)}`);
      const [primaryCompleted, pooledCompleted] = await Promise.all([
        waitFor(() => {
          drainFrames();
          return notifications.find((message) =>
            message.method === "turn/completed" && message.params?.turn?.id === pooledTurnId);
        }, 120_000),
        waitFor(() => {
          pooled.drain();
          return pooled.notifications.find((message) =>
            message.method === "turn/completed" && message.params?.turn?.id === pooledTurnId);
        }, 120_000),
      ]);
      if (!JSON.stringify(primaryCompleted).includes("HYPERNODE_POOL_OK") ||
          !JSON.stringify(pooledCompleted).includes("HYPERNODE_POOL_OK")) {
        throw new Error("pooled thread notifications were not broadcast to both frontends");
      }
    } finally {
      pooled.child.kill("SIGTERM");
    }
  }

  const rootHelp = await request("root-help", "turn/start", {
    threadId: rootThreadId,
    input: [{
      type: "text",
      text: "[$hypernode](/workspace/.codex/skills/hypernode/SKILL.md)&#x20;\n",
      text_elements: [],
    }],
    clientUserMessageId: "root-help-sentinel",
  });
  drainFrames();
  const rootHelpTurnId = rootHelp.result?.turn?.id;
  const rootHelpReply = notifications.find((message) =>
    message.method === "item/completed" &&
    message.params?.turnId === rootHelpTurnId &&
    message.params?.item?.type === "agentMessage");
  if (!rootHelpTurnId || rootHelpReply?.params?.item?.text !== "hello") {
    throw new Error("root management help command mismatch");
  }
  const usersHelp = await request("root-users", "turn/start", {
    threadId: rootThreadId,
    input: [{
      type: "text",
      text: "[$users](/workspace/.codex/skills/users/SKILL.md)&#x20;\n",
      text_elements: [],
    }],
    clientUserMessageId: "root-users-sentinel",
  });
  drainFrames();
  const usersReply = notifications.find((message) =>
    message.method === "item/completed" &&
    message.params?.turnId === usersHelp.result?.turn?.id &&
    message.params?.item?.type === "agentMessage");
  if (!usersReply?.params?.item?.text?.includes("codex (administrator)") ||
      !usersReply.params.item.text.includes("from 127.0.0.1")) {
    throw new Error(`root users command mismatch: response=${JSON.stringify(usersHelp)} reply=${JSON.stringify(usersReply)} tail=${JSON.stringify(notifications.slice(-10))}`);
  }

  const projectCreated = await request("project-create", "project/create", {
    name: "Policy E2E Project",
    roots: [{ path: "/workspace/project-e2e" }],
    metadata: { source: "protocol-e2e" },
    idempotencyKey: "policy-e2e-project-v1",
  });
  const projectId = projectCreated.result?.project?.id;
  const projectCreatedAgain = await request("project-create-again", "project/create", {
    name: "Policy E2E Project",
    roots: [{ path: "/workspace/project-e2e" }],
    idempotencyKey: "policy-e2e-project-v1",
  });
  if (!projectId || projectCreatedAgain.result?.project?.id !== projectId) {
    throw new Error(`project creation/idempotency mismatch: ${JSON.stringify(projectCreated)}`);
  }
  const projectedThread = await request("project-thread-start", "thread/start", {
    cwd: "/workspace/project-e2e",
    projectId,
    model: "gpt-5.6-sol",
  });
  const projectedThreadId = projectedThread.result?.thread?.id;
  const projectThreads = await request("project-thread-list", "thread/list", {
    projectId,
    cwd: "/workspace/project-e2e",
    modelProviders: [],
    limit: 100,
  });
  const unassignedThreads = await request("unassigned-thread-list", "thread/list", {
    projectId: null,
    modelProviders: [],
    limit: 100,
  });
  if (!projectedThreadId || projectedThread.result?.thread?.projectId !== projectId ||
      projectThreads.result?.data?.length !== 1 || projectThreads.result.data[0].id !== projectedThreadId ||
      unassignedThreads.result?.data?.some((thread) => thread.id === projectedThreadId)) {
    throw new Error(`canonical project projection mismatch: thread=${JSON.stringify(projectedThread)} list=${JSON.stringify(projectThreads)}`);
  }
  const initialSections = await request("thread-section-list", "threadSection/list", { limit: 20 });
  if (!initialSections.result?.data?.some((section) => section.id === "01984de2-8f74-7c91-a3b2-5c5e937cf318")) {
    throw new Error(`built-in pinned section missing: ${JSON.stringify(initialSections)}`);
  }
  const sectionCreated = await request("thread-section-create", "threadSection/create", {
    name: "Policy E2E Section",
    appearance: { icon: "folder", color: "blue" },
  });
  const sectionId = sectionCreated.result?.section?.id;
  if (!sectionId) throw new Error(`thread section create failed: ${JSON.stringify(sectionCreated)}`);
  const sectionMove = await request("thread-section-move", "thread/section/move", {
    threadId: projectedThreadId,
    sectionId,
    beforeThreadId: null,
  });
  if (sectionMove.error) throw new Error(`thread section move failed: ${JSON.stringify(sectionMove)}`);
  const sectionThreads = await request("thread-section-threads", "thread/list", {
    sectionId,
    sortKey: "section_position",
    sortDirection: "asc",
    limit: 20,
  });
  if (sectionThreads.result?.data?.length !== 1 || sectionThreads.result.data[0]?.id !== projectedThreadId ||
      sectionThreads.result.data[0]?.section?.id !== sectionId) {
    throw new Error(`thread section projection mismatch: ${JSON.stringify(sectionThreads)}`);
  }
  const sectionUpdated = await request("thread-section-update", "threadSection/update", {
    sectionId,
    name: "Policy E2E Section Renamed",
  });
  if (sectionUpdated.result?.section?.name !== "Policy E2E Section Renamed") {
    throw new Error(`thread section update failed: ${JSON.stringify(sectionUpdated)}`);
  }
  await request("thread-section-clear", "thread/section/move", {
    threadId: projectedThreadId,
    sectionId: null,
    beforeThreadId: null,
  });
  const sectionDeleted = await request("thread-section-delete", "threadSection/delete", { sectionId });
  if (sectionDeleted.error) throw new Error(`thread section delete failed: ${JSON.stringify(sectionDeleted)}`);
  const projectCleared = await request("project-thread-clear", "thread/metadata/update", {
    threadId: projectedThreadId,
    projectId: "",
  });
  if (projectCleared.result?.thread?.projectId !== null) {
    throw new Error(`project assignment clear mismatch: ${JSON.stringify(projectCleared)}`);
  }
  const authorityThread = await request("authority-project-thread-start", "thread/start", {
    cwd: "/workspace/projects/authority-e2e",
    projectId: null,
    model: "gpt-5.6-sol",
  });
  const authorityProjectId = authorityThread.result?.thread?.projectId;
  const authorityProject = authorityProjectId
    ? await request("authority-project-read", "project/read", { projectId: authorityProjectId })
    : null;
  if (!authorityProjectId?.startsWith("project-hypernode-") ||
      authorityProject?.result?.project?.roots?.[0]?.path !== "/workspace/projects/authority-e2e") {
    throw new Error(`authoritative project inference mismatch: ${JSON.stringify({ authorityThread, authorityProject })}`);
  }
  const monoThread = await request("cold-bootstrap-mono-thread", "thread/start", {
    cwd: "/workspace/projects/mono2",
    projectId: null,
    model: "gpt-5.6-sol",
  });
  const monoThreadId = monoThread.result?.thread?.id;
  const monoProjectId = monoThread.result?.thread?.projectId;
  if (!monoThreadId || !monoProjectId) {
    throw new Error(`cold bootstrap fixture creation failed: ${JSON.stringify(monoThread)}`);
  }
  const coldClient = await openAppServerConnection([
    "-i", privateKeyPath,
    "-o", "PreferredAuthentications=publickey",
  ], "codex");
  try {
    await coldClient.request("cold-initialize", "initialize", {
      clientInfo: { name: "hypernode-zero-cache-desktop-e2e", version: "1" },
      capabilities: { experimentalApi: true },
    });
    coldClient.drain();
    coldClient.messages.splice(0);
    coldClient.notifications.splice(0);

    const coldThreads = await coldClient.request("cold-thread-list", "thread/list", {
      modelProviders: [],
      limit: 1000,
    });
    const coldThread = coldThreads.result?.data?.find((thread) => thread.id === monoThreadId);
    const projectInvalidation = await waitFor(() => {
      coldClient.drain();
      return coldClient.notifications.find((message) =>
        message.method === "project/changed" && message.params?.projectId === monoProjectId);
    });
    const threadListWireIndex = coldClient.messages.findIndex((message) => message.id === "cold-thread-list");
    const projectInvalidationWireIndex = coldClient.messages.indexOf(projectInvalidation);
    if (coldThread?.projectId !== null || threadListWireIndex < 0 ||
        projectInvalidationWireIndex <= threadListWireIndex) {
      throw new Error(`cold project discovery ordering mismatch: ${JSON.stringify({
        coldThread,
        monoProjectId,
        threadListWireIndex,
        projectInvalidationWireIndex,
      })}`);
    }

    const coldProjects = await coldClient.request("cold-project-list", "project/list", { limit: 1000 });
    const monoProject = coldProjects.result?.data?.find((project) => project.id === monoProjectId);
    const monoBinding = await waitFor(() => {
      coldClient.drain();
      return coldClient.notifications.find((message) =>
        message.method === "thread/project/updated" &&
        message.params?.threadId === monoThreadId &&
        message.params?.projectId === monoProjectId);
    });
    const projectListWireIndex = coldClient.messages.findIndex((message) => message.id === "cold-project-list");
    const bindingWireIndex = coldClient.messages.indexOf(monoBinding);
    const hydratedThreads = await coldClient.request("cold-thread-list-hydrated", "thread/list", {
      modelProviders: [],
      limit: 1000,
    });
    const hydratedMonoThread = hydratedThreads.result?.data?.find((thread) => thread.id === monoThreadId);
    if (monoProject?.name !== "mono2" || monoProject?.roots?.[0]?.path !== "/workspace/projects/mono2" ||
        projectListWireIndex < 0 || bindingWireIndex <= projectListWireIndex ||
        hydratedMonoThread?.projectId !== monoProjectId) {
      throw new Error(`zero-cache project hydration mismatch: ${JSON.stringify({
        monoProject,
        projectListWireIndex,
        bindingWireIndex,
        hydratedMonoThread,
      })}`);
    }
  } finally {
    coldClient.child.kill("SIGTERM");
  }
  const missingThreadId = "01a03875-5a74-728c-9eed-34506d7c2ac0";
  const missingResume = await request("missing-project-thread", "thread/resume", {
    threadId: missingThreadId,
    cwd: "/workspace/project-e2e",
  });
  drainFrames();
  if (!missingResume.error?.message?.includes("thread not found") ||
      !notifications.some((message) => message.method === "thread/archived" && message.params?.threadId === missingThreadId)) {
    throw new Error(`dangling project thread did not self-heal: ${JSON.stringify(missingResume)}`);
  }

  const started = await request("start", "thread/start", {
    cwd: "/workspace",
    model: "gpt-5.6-sol",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
  });
  const startedThreadId = started.result?.thread?.id;
  if (!startedThreadId || started.result?.sandbox?.type !== "workspaceWrite") {
    throw new Error("thread lifecycle start mismatch");
  }
  const readStarted = await request("read-started", "thread/read", { threadId: startedThreadId });
  if (readStarted.result?.thread?.id !== startedThreadId) throw new Error("thread lifecycle read mismatch");
  const resumed = await request("resume-started", "thread/resume", {
    threadId: startedThreadId,
    cwd: "/workspace/resumed",
  });
  if (resumed.result?.thread?.id !== startedThreadId || resumed.result?.cwd !== "/workspace/resumed") {
    throw new Error("thread lifecycle resume mismatch");
  }

  const turnNotificationOffset = notifications.length;
  const turnStarted = await request("turn-start", "turn/start", {
    threadId: startedThreadId,
    input: [{ type: "text", text: "turn lifecycle sentinel" }],
    clientUserMessageId: "client-turn-sentinel",
  });
  drainFrames();
  const turnId = turnStarted.result?.turn?.id;
  if (!turnId || turnStarted.result?.turn?.status !== "inProgress") {
    throw new Error("turn start response mismatch");
  }
  const lifecycleMethodNames = new Set([
    "thread/status/changed",
    "turn/started",
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "turn/completed",
  ]);
  const lifecycleEvents = notifications.slice(turnNotificationOffset).filter((message) =>
    message.params?.threadId === startedThreadId && lifecycleMethodNames.has(message.method));
  const lifecycleMethods = lifecycleEvents.map((message) =>
    message.method === "thread/status/changed"
      ? `${message.method}:${message.params.status?.type}`
      : message.method);
  const expectedLifecycleMethods = [
    "thread/status/changed:active",
    "turn/started",
    "item/started",
    "item/completed",
    "item/started",
    "item/agentMessage/delta",
    "item/completed",
    "turn/completed",
    "thread/status/changed:idle",
  ];
  if (lifecycleMethods.join("\n") !== expectedLifecycleMethods.join("\n")) {
    throw new Error(`thread runtime lifecycle order mismatch: ${lifecycleMethods.join(", ")}`);
  }
  const turnEvents = notifications.filter((message) => message.params?.turnId === turnId || message.params?.turn?.id === turnId);
  const methods = turnEvents.map((message) => message.method);
  const expectedMethods = [
    "turn/started",
    "item/started",
    "item/completed",
    "item/started",
    "item/agentMessage/delta",
    "item/completed",
    "turn/completed",
  ];
  if (methods.join("\n") !== expectedMethods.join("\n")) {
    throw new Error(`turn lifecycle notification order mismatch: ${methods.join(", ")}`);
  }
  const userCompleted = turnEvents.find((message) =>
    message.method === "item/completed" && message.params?.item?.type === "userMessage");
  const agentCompleted = turnEvents.find((message) =>
    message.method === "item/completed" && message.params?.item?.type === "agentMessage");
  const completedTurn = turnEvents.find((message) => message.method === "turn/completed");
  if (userCompleted?.params?.item?.clientId !== "client-turn-sentinel") {
    throw new Error("turn user item client id mismatch");
  }
  if (!agentCompleted?.params?.item?.text?.includes("turn lifecycle sentinel")) {
    throw new Error("turn agent item mismatch");
  }
  if (completedTurn?.params?.turn?.status !== "completed") {
    throw new Error("turn completion mismatch");
  }
  const readAfterTurn = await request("read-after-turn", "thread/read", { threadId: startedThreadId });
  if (readAfterTurn.result?.thread?.turns?.[0]?.status !== "completed") {
    throw new Error("completed turn was not retained by thread manager");
  }
  const adoptedTurn = await request("turn-start-adopt", "turn/start", {
    threadId: "019c0011-7a00-7000-8000-000000000099",
    input: [{ type: "text", text: "adopt stale client thread" }],
  });
  if (adoptedTurn.result?.turn?.status !== "inProgress") {
    throw new Error("turn start did not adopt a stale client thread id");
  }

  const rootArchive = await request("archive-root", "thread/archive", { threadId: rootThreadId });
  if (!rootArchive.error?.message?.includes("system threads cannot be archived")) {
    throw new Error("root thread archive was not rejected");
  }
  const allArchive = await request("archive-all", "thread/archive", { threadId: allThreadId });
  if (!allArchive.error?.message?.includes("system threads cannot be archived")) {
    throw new Error("all thread archive was not rejected");
  }
  const archiveReader = await openAppServerConnection([
    "-i", privateKeyPath,
    "-o", "PreferredAuthentications=publickey",
  ], "reader");
  try {
    await archiveReader.request("archive-reader-initialize", "initialize", {
      clientInfo: { name: "hypernode-archive-reader-e2e", version: "1" },
      capabilities: { experimentalApi: true },
    });
    await request("archive", "thread/archive", { threadId: startedThreadId });
    const readerArchived = await waitFor(() => {
      archiveReader.drain();
      return archiveReader.notifications.find((message) =>
        message.method === "thread/archived" && message.params?.threadId === startedThreadId);
    });
    if (readerArchived.params?.threadId !== startedThreadId) {
      throw new Error(`thread archive was not fanned out: ${JSON.stringify(readerArchived)}`);
    }
    const activeAfterArchive = await request("active-after-archive", "thread/list", { archived: false });
    const archived = await request("archived", "thread/list", { archived: true });
    if (activeAfterArchive.result?.data?.some((thread) => thread.id === startedThreadId)) {
      throw new Error("archived thread remained active");
    }
    if (archived.result?.data?.[0]?.id !== startedThreadId) throw new Error("archived thread was not listed");
    const unarchive = await request("unarchive", "thread/unarchive", { threadId: startedThreadId });
    if (unarchive.result?.thread?.id !== startedThreadId) throw new Error("thread unarchive mismatch");
    const readerUnarchived = await waitFor(() => {
      archiveReader.drain();
      return archiveReader.notifications.find((message) =>
        message.method === "thread/unarchived" && message.params?.threadId === startedThreadId);
    });
    if (readerUnarchived.params?.threadId !== startedThreadId) {
      throw new Error(`thread unarchive was not fanned out: ${JSON.stringify(readerUnarchived)}`);
    }
  } finally {
    archiveReader.child.kill("SIGTERM");
  }

  const keyLogin = await runSSH([
    "-T", "-p", String(port), "-i", privateKeyPath,
    "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
    "-o", "PreferredAuthentications=publickey",
    "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
    "codex@127.0.0.1", "whoami",
  ]);
  if (keyLogin.code !== 0 || keyLogin.stdout !== "codex\n") {
    throw new Error(`issued SSH key login failed: ${JSON.stringify(keyLogin)}`);
  }
  const returningUser = await openAppServerConnection([
    "-i", privateKeyPath,
    "-o", "PreferredAuthentications=publickey",
  ]);
  try {
    await returningUser.request("returning-initialize", "initialize", {
      clientInfo: { name: "hypernode-returning-user-e2e", version: "1" },
      capabilities: { experimentalApi: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    returningUser.drain();
    const duplicateWelcome = returningUser.notifications.find((message) =>
      message.method === "item/started" && message.params?.item?.type === "agentMessage");
    if (duplicateWelcome) {
      throw new Error(`returning user received duplicate onboarding: ${JSON.stringify(duplicateWelcome)}`);
    }
  } finally {
    returningUser.child.kill("SIGTERM");
  }
  const noneLogin = await runSSH([
    "-T", "-p", String(port),
    "-o", "BatchMode=yes", "-o", "PreferredAuthentications=none",
    "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
    "codex@127.0.0.1", "true",
  ]);
  if (noneLogin.code === 0) throw new Error("none authentication remained enabled after key issuance");

  if (sshStack === "vssh") {
    const vsshDiagnostics = execFileSync("sqlite3", [database, `
      SELECT
        (SELECT count(*) FROM connections WHERE client_version LIKE 'SSH-2.0-%') || ',' ||
        (SELECT count(*) FROM connections WHERE authenticated = 1) || ',' ||
        (SELECT count(*) FROM events WHERE type = 'transport.identification') || ',' ||
        (SELECT count(*) FROM events WHERE type = 'auth.result' AND json_extract(payload, '$.accepted') = 1) || ',' ||
        (SELECT count(*) FROM events WHERE type = 'session.request' AND json_extract(payload, '$.request') = 'exec') || ',' ||
        (SELECT count(*) FROM events WHERE type = 'rpc.request' AND json_extract(payload, '$.method') = 'fs/readFile') || ',' ||
        (SELECT count(*) FROM events WHERE type = 'rpc.response' AND json_extract(payload, '$.method') = 'fs/readFile' AND json_extract(payload, '$.decodedBytes') > 0);
    `], { encoding: "utf8" }).trim().split(",").map(Number);
    if (vsshDiagnostics.some((count) => count < 1)) {
      throw new Error(`vSSH protocol diagnostics were not persisted: ${vsshDiagnostics.join(",")}`);
    }
  }

  if (process.env.HYPERNODE_E2E_REAL_TURN === "1") {
    ssh.kill("SIGTERM");
    await waitFor(() => ssh.exitCode != null, 10_000);
    const reconnected = await openAppServerConnection([
      "-i", privateKeyPath,
      "-o", "PreferredAuthentications=publickey",
    ]);
    try {
      await reconnected.request("reconnect-initialize", "initialize", {
        clientInfo: { name: "hypernode-reconnect-e2e", version: "1" },
        capabilities: { experimentalApi: true },
      });
      const recovered = await reconnected.request("reconnect-resume", "thread/resume", {
        threadId: dynamicTransparentId,
        cwd: "/localhost",
      });
      const recoveredText = recovered.result?.thread?.turns
        ?.flatMap((turn) => turn.items ?? [])
        .filter((item) => item.type === "agentMessage")
        .map((item) => item.text)
        .join("\n") ?? "";
      if (recovered.result?.thread?.id !== dynamicTransparentId ||
          recovered.result?.cwd !== "/localhost" ||
          !recoveredText.includes("HYPERNODE_TRANSPARENT_OK") ||
          JSON.stringify(recovered).includes(process.cwd())) {
        throw new Error(`transparent reconnect recovery mismatch: ${JSON.stringify(recovered)}`);
      }
    } finally {
      reconnected.child.kill("SIGTERM");
    }
  }

  const sensitiveRows = Number(execFileSync("sqlite3", [database,
    "SELECT count(*) FROM events WHERE type='stream.stdout.binary' AND json_extract(payload,'$.redacted')=1;",
  ], { encoding: "utf8" }).trim());
  const persistedPrivateKeys = Number(execFileSync("sqlite3", [database,
    "SELECT (SELECT count(*) FROM policy_kv WHERE value LIKE '%OPENSSH PRIVATE KEY%') + " +
    "(SELECT count(*) FROM do_users WHERE coalesce(ssh_public_key,'') LIKE '%PRIVATE KEY%');",
  ], { encoding: "utf8" }).trim());
  if (sensitiveRows < 1 || persistedPrivateKeys !== 0) {
    throw new Error("bootstrap private-key redaction mismatch");
  }

  console.log("SSH -> WebSocket -> Cordis policy E2E passed");
} catch (error) {
  if (serverLog.trim()) console.error(serverLog.trim());
  throw error;
} finally {
  ssh?.kill("SIGTERM");
  server.kill("SIGTERM");
  await Promise.allSettled([
    unlink(database),
    unlink(`${database}-shm`),
    unlink(`${database}-wal`),
    unlink(privateKeyPath),
    rm(usersRoot, { recursive: true, force: true }),
  ]);
}
