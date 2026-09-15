import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const port = Number(process.env.HYPERNODE_PROBE_PORT ?? 9988);
const username = process.env.HYPERNODE_PROBE_USER ?? "root";
const sentinel = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
const remoteCommand = String.raw`sh -c 'CODEX_REMOTE_PAYLOAD="$1"; printf "\001\002\003\004\005\006\007\010"; codex app-server proxy' sh x`;

function waitFor(predicate, timeoutMs = 10_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = predicate();
        if (value) return resolve(value);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started >= timeoutMs) return reject(new Error("probe timed out"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

const child = spawn("ssh", [
  "-T", "-p", String(port),
  "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
  "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
  `${username}@127.0.0.1`, remoteCommand,
], { stdio: ["pipe", "pipe", "pipe"] });
let incoming = Buffer.alloc(0);
let stderr = "";
child.stdout.on("data", (chunk) => { incoming = Buffer.concat([incoming, chunk]); });
child.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  await waitFor(() => incoming.length >= sentinel.length || child.exitCode != null);
  if (!incoming.subarray(0, sentinel.length).equals(sentinel)) {
    throw new Error(`missing remote sentinel: ${incoming.toString("hex")} ${stderr}`);
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
  if (!header.startsWith("HTTP/1.1 101")) throw new Error(`upgrade failed: ${header}`);

  const responses = new Map();
  const messages = [];
  const requestLatenciesMs = {};
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
        if (incoming.readUInt32BE(2) !== 0) throw new Error("server frame too large");
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
    }
  };
  const request = async (id, method, params = {}) => {
    const startedAt = performance.now();
    child.stdin.write(maskFrame({ id, method, params }));
    const response = await waitFor(() => {
      drain();
      return responses.get(String(id));
    }, 30_000);
    requestLatenciesMs[String(id)] = Math.round((performance.now() - startedAt) * 10) / 10;
    return response;
  };

  const initialized = await request("initialize", "initialize", {
    clientInfo: { name: "hypernode-probe", version: "1" },
    capabilities: { experimentalApi: true },
  });
  if (initialized.error) throw new Error(initialized.error.message);
  child.stdin.write(maskFrame({ method: "initialized", params: {} }));
  const config = await request("config", "config/read", { cwd: "/workspace", includeLayers: false });
  const models = await request("models", "model/list", { includeHidden: true, limit: 100 });
  const skills = await request("skills", "skills/list", {
    cwds: ["/workspace"],
    forceReload: true,
  });
  if (skills.error) throw new Error(skills.error.message);
  const providerId = config.result?.config?.model_provider;
  const provider = config.result?.config?.model_providers?.[providerId];
  const data = models.result?.data ?? [];
  const calculatorSkill = skills.result?.data
    ?.flatMap((entry) => entry.skills ?? [])
    .find((skill) => skill.name === "calculator");
  const visibilitySkill = skills.result?.data
    ?.flatMap((entry) => entry.skills ?? [])
    .find((skill) => skill.name === "set-visibility");
  const threadCatalog = await request("mcp-context-threads", "thread/list", {
    archived: false,
    limit: 1,
    modelProviders: [],
    sourceKinds: [],
  });
  if (threadCatalog.error) throw new Error(threadCatalog.error.message);
  const mcpContextThreadId = threadCatalog.result?.data?.[0]?.id ??
    "01999999-9999-7999-8999-999999999999";
  const mcpStatus = await request("mcp-status", "mcpServerStatus/list", {
    cursor: null,
    detail: "full",
    limit: 100,
  });
  if (mcpStatus.error) throw new Error(mcpStatus.error.message);
  const calculatorServer = mcpStatus.result?.data?.find((server) =>
    server.name === "hypernode-calculator");
  const privacyServer = mcpStatus.result?.data?.find((server) =>
    server.name === "hypernode-thread-privacy");
  const privacyResource = privacyServer
    ? await request("privacy-resource", "mcpServer/resource/read", {
      connectorId: privacyServer.name,
      server: privacyServer.name,
      threadId: mcpContextThreadId,
      uri: "ui://hypernode/thread-privacy.html",
    })
    : null;
  if (privacyResource?.error) throw new Error(privacyResource.error.message);
  const privacyList = privacyServer
    ? await request("privacy-list", "mcpServer/tool/call", {
      server: privacyServer.name,
      connectorId: privacyServer.name,
      threadId: mcpContextThreadId,
      tool: "threadPrivacy.list",
      arguments: { preferredThreadId: mcpContextThreadId },
    })
    : null;
  if (privacyList?.error) throw new Error(privacyList.error.message);
  const calculatorResource = calculatorServer
    ? await request("mcp-resource", "mcpServer/resource/read", {
      connectorId: calculatorServer.name,
      server: calculatorServer.name,
      threadId: mcpContextThreadId,
      uri: "ui://hypernode/calculator.html",
    })
    : null;
  if (calculatorResource?.error) throw new Error(calculatorResource.error.message);
  const calculatorCompute = calculatorServer
    ? await request("mcp-compute", "mcpServer/tool/call", {
      server: calculatorServer.name,
      connectorId: calculatorServer.name,
      threadId: mcpContextThreadId,
      tool: "calculator.compute",
      arguments: { expression: "12 * 8" },
    })
    : null;
  if (calculatorCompute?.error) throw new Error(calculatorCompute.error.message);
  const currencyConversion = calculatorServer
    ? await request("mcp-currency", "mcpServer/tool/call", {
      server: calculatorServer.name,
      connectorId: calculatorServer.name,
      threadId: mcpContextThreadId,
      tool: "calculator.convertCurrency",
      arguments: { amount: 1000, from: "HKD", to: "CNY" },
    })
    : null;
  if (currencyConversion?.error) throw new Error(currencyConversion.error.message);
  const launcherThread = await request("calculator-launch-thread", "thread/start", {
    cwd: "/workspace",
    ephemeral: true,
    threadSource: "system",
    model: "auto",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  });
  if (launcherThread.error) throw new Error(launcherThread.error.message);
  const launcherThreadId = launcherThread.result?.thread?.id;
  if (!launcherThreadId) throw new Error("calculator launcher did not create an ephemeral thread");
  const launcherTurn = await request("calculator-launch-turn", "turn/start", {
    threadId: launcherThreadId,
    input: [{
      type: "text",
      text: "[$calculator](/workspace/.codex/skills/calculator/SKILL.md)&#x20;\n",
      text_elements: [],
    }],
    clientUserMessageId: `calculator-launch-${Date.now()}`,
  });
  if (launcherTurn.error) throw new Error(launcherTurn.error.message);
  const launcherTurnId = launcherTurn.result?.turn?.id;
  if (!launcherTurnId) throw new Error("calculator launcher did not start a Turn");
  const launcherCompleted = await waitFor(() => {
    drain();
    return messages.find((message) =>
      message.method === "turn/completed" && message.params?.turn?.id === launcherTurnId);
  }, 30_000);
  const launcherLifecycle = messages.filter((message) =>
    message.params?.turnId === launcherTurnId || message.params?.turn?.id === launcherTurnId);
  const launcherToolItem = launcherLifecycle.find((message) =>
    message.method === "item/completed" && message.params?.item?.type === "mcpToolCall")
    ?.params?.item;
  const launcherAgentMessageCount = launcherLifecycle.filter((message) =>
    message.params?.item?.type === "agentMessage" ||
    message.params?.turn?.items?.some?.((item) => item.type === "agentMessage"))
    .length;
  if (launcherToolItem?.status !== "completed" ||
      launcherToolItem?.appContext?.resourceUri !== "ui://hypernode/calculator.html" ||
      launcherToolItem?.result?.structuredContent?.value !== 0 ||
      launcherAgentMessageCount !== 0 ||
      launcherCompleted.params?.turn?.status !== "completed") {
    throw new Error(`calculator launcher lifecycle mismatch: ${JSON.stringify(launcherLifecycle)}`);
  }
  const privacyLauncherThread = await request("privacy-launch-thread", "thread/start", {
    cwd: "/workspace",
    ephemeral: true,
    threadSource: "system",
    model: "auto",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  });
  if (privacyLauncherThread.error) throw new Error(privacyLauncherThread.error.message);
  const privacyLauncherThreadId = privacyLauncherThread.result?.thread?.id;
  if (!privacyLauncherThreadId) throw new Error("privacy launcher did not create an ephemeral thread");
  const privacyLauncherTurn = await request("privacy-launch-turn", "turn/start", {
    threadId: privacyLauncherThreadId,
    input: [{
      type: "text",
      text: "[$set-visibility](/workspace/.codex/skills/set-visibility/SKILL.md)&#x20;\n",
      text_elements: [],
    }],
    clientUserMessageId: `privacy-launch-${Date.now()}`,
  });
  if (privacyLauncherTurn.error) throw new Error(privacyLauncherTurn.error.message);
  const privacyLauncherTurnId = privacyLauncherTurn.result?.turn?.id;
  if (!privacyLauncherTurnId) throw new Error("privacy launcher did not start a Turn");
  const privacyLauncherCompleted = await waitFor(() => {
    drain();
    return messages.find((message) =>
      message.method === "turn/completed" && message.params?.turn?.id === privacyLauncherTurnId);
  }, 30_000);
  const privacyLauncherLifecycle = messages.filter((message) =>
    message.params?.turnId === privacyLauncherTurnId ||
    message.params?.turn?.id === privacyLauncherTurnId);
  const privacyLauncherToolItem = privacyLauncherLifecycle.find((message) =>
    message.method === "item/completed" && message.params?.item?.type === "mcpToolCall")
    ?.params?.item;
  if (privacyLauncherToolItem?.status !== "completed" ||
      privacyLauncherToolItem?.appContext?.resourceUri !== "ui://hypernode/thread-privacy.html" ||
      !Array.isArray(privacyLauncherToolItem?.result?.structuredContent?.threads) ||
      privacyLauncherCompleted.params?.turn?.status !== "completed") {
    throw new Error(`privacy launcher lifecycle mismatch: ${JSON.stringify(privacyLauncherLifecycle)}`);
  }
  const rootThread = await request("root-thread", "hypernode/rootThread/read");
  if (rootThread.error) throw new Error(rootThread.error.message);
  const rootThreadId = rootThread.result?.thread?.id;
  if (!rootThreadId) throw new Error("management thread is unavailable");
  const usersStartedAt = performance.now();
  const usersTurn = await request("users-turn", "turn/start", {
    threadId: rootThreadId,
    input: [{
      type: "text",
      text: "[$users](/workspace/.codex/skills/users/SKILL.md) \n",
      text_elements: [],
    }],
    clientUserMessageId: `users-${Date.now()}`,
  });
  const usersTurnStartLatencyMs = performance.now() - usersStartedAt;
  if (usersTurn.error) throw new Error(usersTurn.error.message);
  const usersTurnId = usersTurn.result?.turn?.id;
  const usersCompleted = await waitFor(() => {
    drain();
    return messages.find((message) =>
      message.method === "turn/completed" && message.params?.turn?.id === usersTurnId);
  }, 30_000);
  if (usersCompleted.params?.turn?.status !== "completed") {
    throw new Error(`management users turn did not complete: ${JSON.stringify(usersCompleted)}`);
  }
  const visualPath = process.env.HYPERNODE_PROBE_VISUAL_PATH;
  let visualRead = null;
  if (visualPath) {
    const processHandle = `ssh-visual-read-${Date.now()}`;
    const response = await request("visual-read", "process/spawn", {
      command: ["cat", visualPath],
      cwd: "/",
      outputBytesCap: null,
      processHandle,
      streamStdin: true,
      streamStdoutStderr: true,
      timeoutMs: null,
    });
    if (response.error) throw new Error(response.error.message);
    const exited = await waitFor(() => {
      drain();
      return messages.find((message) =>
        message.method === "process/exited" && message.params?.processHandle === processHandle);
    }, 30_000);
    const lifecycle = messages.filter((message) =>
      message.id === "visual-read" || message.params?.processHandle === processHandle);
    const stdout = Buffer.concat(lifecycle
      .filter((message) => message.method === "process/outputDelta" && message.params?.stream === "stdout")
      .map((message) => Buffer.from(message.params.deltaBase64, "base64")));
    visualRead = {
      order: lifecycle.map((message) => message.id === "visual-read" ? "response" : message.method),
      outputDeltaCount: lifecycle.filter((message) => message.method === "process/outputDelta").length,
      bytes: stdout.length,
      sha256: createHash("sha256").update(stdout).digest("hex"),
      exitCode: exited.params?.exitCode ?? null,
      stdoutCapReached: exited.params?.stdoutCapReached ?? null,
    };
  }
  console.log(JSON.stringify({
    username,
    providerId,
    provider,
    selectedModel: config.result?.config?.model,
    modelCount: data.length,
    modelIds: data.map((model) => model.id),
    configError: config.error ?? null,
    modelsError: models.error ?? null,
    calculatorSkillPath: calculatorSkill?.path ?? null,
    visibilitySkillPath: visibilitySkill?.path ?? null,
    mcpServerNames: mcpStatus.result?.data?.map((server) => server.name) ?? [],
    calculatorAuthStatus: calculatorServer?.authStatus ?? null,
    calculatorTools: calculatorServer ? Object.keys(calculatorServer.tools ?? {}) : [],
    calculatorHtmlBytes: Buffer.byteLength(
      calculatorResource?.result?.contents?.[0]?.text ?? "",
      "utf8",
    ),
    calculatorValue: calculatorCompute?.result?.structuredContent?.value ?? null,
    privacyTools: privacyServer ? Object.keys(privacyServer.tools ?? {}) : [],
    privacyHtmlBytes: Buffer.byteLength(
      privacyResource?.result?.contents?.[0]?.text ?? "",
      "utf8",
    ),
    privacyOwnedThreadCount: privacyList?.result?.structuredContent?.threads?.length ?? null,
    currencyConversion: currencyConversion?.result?.structuredContent ?? null,
    calculatorLaunch: {
      lifecycle: launcherLifecycle.map((message) => message.method),
      itemType: launcherToolItem.type,
      status: launcherToolItem.status,
      resourceUri: launcherToolItem.appContext.resourceUri,
      initialValue: launcherToolItem.result.structuredContent.value,
      agentMessageCount: launcherAgentMessageCount,
      ephemeral: true,
    },
    privacyLaunch: {
      lifecycle: privacyLauncherLifecycle.map((message) => message.method),
      itemType: privacyLauncherToolItem.type,
      status: privacyLauncherToolItem.status,
      resourceUri: privacyLauncherToolItem.appContext.resourceUri,
      ownedThreadCount: privacyLauncherToolItem.result.structuredContent.threads.length,
      ephemeral: true,
    },
    managementUsersTurnStartLatencyMs: Math.round(usersTurnStartLatencyMs * 10) / 10,
    requestLatenciesMs,
    visualRead,
  }, null, 2));
} finally {
  child.kill("SIGTERM");
}
