import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";

const port = Number(process.env.HYPERNODE_PROBE_PORT ?? 9988);
const host = process.env.HYPERNODE_PROBE_HOST ?? "127.0.0.1";
const username = process.env.HYPERNODE_PROBE_USER ?? "root";
const socket = connect({ host, port });
let incoming = Buffer.alloc(0);
socket.on("data", (chunk) => { incoming = Buffer.concat([incoming, chunk]); });

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
      if (Date.now() - started >= timeoutMs) return reject(new Error("direct WebSocket probe timed out"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function maskedTextFrame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const mask = randomBytes(4);
  const prefix = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.from([0x81, 0xfe, payload.length >>> 8, payload.length & 0xff]);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([prefix, mask, masked]);
}

function drainTextFrames(messages) {
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
    if (opcode === 1) messages.push(JSON.parse(payload.toString("utf8")));
  }
}

try {
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write([
    "GET /rpc HTTP/1.1",
    `Host: ${host}:${port}`,
    `X-HyperNode-User: ${username}`,
    "Upgrade: websocket",
    "Connection: keep-alive, Upgrade",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "",
    "",
  ].join("\r\n"));
  await waitFor(() => incoming.indexOf("\r\n\r\n") >= 0);
  const end = incoming.indexOf("\r\n\r\n") + 4;
  const header = incoming.subarray(0, end).toString("ascii");
  incoming = incoming.subarray(end);
  if (!header.startsWith("HTTP/1.1 101")) throw new Error(`upgrade failed: ${header}`);

  const messages = [];
  let sequence = 0;
  const request = async (method, params = {}) => {
    const id = `direct-probe:${++sequence}`;
    socket.write(maskedTextFrame({ id, method, params }));
    return waitFor(() => {
      drainTextFrames(messages);
      return messages.find((message) => message.id === id);
    }, 30_000);
  };
  const initialized = await request("initialize", {
    clientInfo: { name: "hypernode-direct-probe", version: "1" },
    capabilities: { experimentalApi: true },
  });
  if (initialized.error) throw new Error(initialized.error.message);
  socket.write(maskedTextFrame({ method: "initialized", params: {} }));
  const catalog = await request("plugin/list", { cwds: ["/workspace"] });
  if (catalog.error) throw new Error(catalog.error.message);
  const skills = await request("skills/list", { cwds: ["/workspace"], forceReload: true });
  if (skills.error) throw new Error(skills.error.message);
  const mcpStatus = await request("mcpServerStatus/list", {
    cursor: null,
    detail: "full",
    limit: 100,
  });
  if (mcpStatus.error) throw new Error(mcpStatus.error.message);
  const calculatorServer = mcpStatus.result?.data?.find((server) =>
    server.name === "hypernode-calculator");
  const privacyServer = mcpStatus.result?.data?.find((server) =>
    server.name === "hypernode-thread-privacy");
  const builderServer = mcpStatus.result?.data?.find((server) =>
    server.name === "hypernode-app-builder");
  const codexAccountsServer = mcpStatus.result?.data?.find((server) =>
    server.name === "hypernode-codex-accounts");
  const threadCatalog = await request("thread/list", {
    archived: false,
    limit: 1,
    modelProviders: [],
    sourceKinds: [],
  });
  if (threadCatalog.error) throw new Error(threadCatalog.error.message);
  const mcpContextThreadId = threadCatalog.result?.data?.[0]?.id ??
    "01999999-9999-7999-8999-999999999999";
  const calculatorResource = calculatorServer
    ? await request("mcpServer/resource/read", {
      connectorId: calculatorServer.name,
      server: calculatorServer.name,
      threadId: mcpContextThreadId,
      uri: "ui://hypernode/calculator.html",
    })
    : null;
  if (calculatorResource?.error) throw new Error(calculatorResource.error.message);
  const privacyResource = privacyServer
    ? await request("mcpServer/resource/read", {
      connectorId: privacyServer.name,
      server: privacyServer.name,
      threadId: mcpContextThreadId,
      uri: "ui://hypernode/thread-privacy.html",
    })
    : null;
  if (privacyResource?.error) throw new Error(privacyResource.error.message);
  const privacyList = privacyServer
    ? await request("mcpServer/tool/call", {
      server: privacyServer.name,
      connectorId: privacyServer.name,
      threadId: mcpContextThreadId,
      tool: "threadPrivacy.list",
      arguments: { preferredThreadId: mcpContextThreadId },
    })
    : null;
  if (privacyList?.error) throw new Error(privacyList.error.message);
  const privacyMutationThreadId = process.env.HYPERNODE_PROBE_PRIVATIZE_THREAD_ID;
  const privacyMutationVisibility = process.env.HYPERNODE_PROBE_VISIBILITY === "shared"
    ? "shared"
    : "private";
  const privacyMutation = privacyServer && privacyMutationThreadId
    ? await request("mcpServer/tool/call", {
      server: privacyServer.name,
      connectorId: privacyServer.name,
      threadId: privacyMutationThreadId,
      tool: privacyMutationVisibility === "shared"
        ? "threadPrivacy.setShared"
        : "threadPrivacy.setPrivate",
      arguments: { threadId: privacyMutationThreadId },
    })
    : null;
  if (privacyMutation?.error) throw new Error(privacyMutation.error.message);
  const calculatorCompute = calculatorServer
    ? await request("mcpServer/tool/call", {
      server: calculatorServer.name,
      connectorId: calculatorServer.name,
      threadId: mcpContextThreadId,
      tool: "calculator.compute",
      arguments: { expression: "12 * 8" },
    })
    : null;
  if (calculatorCompute?.error) throw new Error(calculatorCompute.error.message);
  const codexAccounts = codexAccountsServer
    ? await request("mcpServer/tool/call", {
      server: codexAccountsServer.name,
      connectorId: codexAccountsServer.name,
      threadId: mcpContextThreadId,
      tool: "codexAccounts.list",
      arguments: { refresh: true },
    })
    : null;
  if (codexAccounts?.error) throw new Error(codexAccounts.error.message);
  const currencyConversion = calculatorServer
    ? await request("mcpServer/tool/call", {
      server: calculatorServer.name,
      connectorId: calculatorServer.name,
      threadId: mcpContextThreadId,
      tool: "calculator.convertCurrency",
      arguments: { amount: 1000, from: "HKD", to: "CNY" },
    })
    : null;
  if (currencyConversion?.error) throw new Error(currencyConversion.error.message);
  const startedThread = process.env.HYPERNODE_PROBE_START_THREAD === "1"
    ? await request("thread/start", {
      cwd: process.env.HYPERNODE_PROBE_START_CWD ?? "/workspace/projects/mono2",
      modelProviders: [],
      sourceKinds: [],
    })
    : null;
  if (startedThread?.error) throw new Error(startedThread.error.message);
  const archiveThreadId = process.env.HYPERNODE_PROBE_ARCHIVE_THREAD_ID ?? (
    process.env.HYPERNODE_PROBE_ARCHIVE_STARTED === "1"
      ? startedThread?.result?.thread?.id
      : null
  );
  const archivedStartedThread = archiveThreadId
    ? await request("thread/archive", { threadId: archiveThreadId })
    : null;
  if (archivedStartedThread?.error) throw new Error(archivedStartedThread.error.message);
  const threadId = process.env.HYPERNODE_PROBE_THREAD_ID;
  const metadata = threadId
    ? await request("thread/metadata/update", {
      threadId,
      gitInfo: { branch: process.env.HYPERNODE_PROBE_BRANCH ?? null },
    })
    : null;
  if (metadata?.error) throw new Error(metadata.error.message);
  const thread = threadId
    ? await request("thread/read", { threadId, includeTurns: true })
    : null;
  if (thread?.error) throw new Error(thread.error.message);
  const visualizePlugin = catalog.result?.marketplaces
    ?.flatMap((marketplace) => marketplace.plugins ?? [])
    .find((plugin) => plugin.id === "visualize@openai-bundled");
  const visualizeSkill = skills.result?.data
    ?.flatMap((entry) => entry.skills ?? [])
    .find((skill) => skill.name === "visualize:visualize");
  const calculatorSkill = skills.result?.data
    ?.flatMap((entry) => entry.skills ?? [])
    .find((skill) => skill.name === "calculator");
  const visibilitySkill = skills.result?.data
    ?.flatMap((entry) => entry.skills ?? [])
    .find((skill) => skill.name === "set-visibility");
  const builderSkill = skills.result?.data
    ?.flatMap((entry) => entry.skills ?? [])
    .find((skill) => skill.name === "build-mcp-app");
  let dynamicApp = null;
  if (builderServer && process.env.HYPERNODE_PROBE_PUBLISH_APP === "1") {
    const appId = "probe-hot-app";
    const uiVariant = process.env.HYPERNODE_PROBE_UI_VARIANT ?? "stable";
    const uiHtml = '<!doctype html><html><body><button id="run">Double __VARIANT__</button><pre id="out"></pre><script>document.getElementById("run").onclick=async()=>{const r=await window.openai.callTool("probe.double",{value:21});document.getElementById("out").textContent=JSON.stringify(r.structuredContent||r)};</script></body></html>'
      .replace("__VARIANT__", uiVariant);
    const spec = {
      appId,
      title: "Hot Publish Probe",
      description: "Live verification for dynamic MCP App publication.",
      uiHtml,
      entryTool: "probe.double",
      tools: [{
        name: "probe.double",
        title: "Double a number",
        description: "Return twice the supplied number.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
          additionalProperties: false,
        },
        handler: {
          kind: "javascript",
          source: "return { structuredContent: { value: Number(args.value) * 2, revision: context.revision }, text: 'doubled' };",
        },
      }],
    };
    const save = await request("mcpServer/tool/call", {
      server: builderServer.name, connectorId: builderServer.name,
      threadId: mcpContextThreadId, tool: "appBuilder.saveDraft", arguments: { spec },
    });
    if (save.error) throw new Error(save.error.message);
    const publish = await request("mcpServer/tool/call", {
      server: builderServer.name, connectorId: builderServer.name,
      threadId: mcpContextThreadId, tool: "appBuilder.publish", arguments: { appId },
    });
    if (publish.error) throw new Error(publish.error.message);
    const refreshed = await request("mcpServerStatus/list", { cursor: null, detail: "full", limit: 100 });
    if (refreshed.error) throw new Error(refreshed.error.message);
    const server = refreshed.result?.data?.find((item) => item.name === `hypernode-app-${appId}`);
    const call = server ? await request("mcpServer/tool/call", {
      server: server.name, connectorId: server.name,
      threadId: mcpContextThreadId, tool: "probe.double", arguments: { value: 21 },
    }) : null;
    if (call?.error) throw new Error(call.error.message);
    const uri = publish.result?.structuredContent?.uiResourceUri;
    const resource = server && uri ? await request("mcpServer/resource/read", {
      server: server.name, connectorId: server.name, threadId: mcpContextThreadId, uri,
    }) : null;
    if (resource?.error) throw new Error(resource.error.message);
    dynamicApp = {
      server: server?.name ?? null,
      revision: publish.result?.structuredContent?.revision ?? null,
      uiResourceUri: uri ?? null,
      value: call?.result?.structuredContent?.value ?? null,
      htmlBytes: Buffer.byteLength(resource?.result?.contents?.[0]?.text ?? "", "utf8"),
    };
  }
  const visualPath = process.env.HYPERNODE_PROBE_VISUAL_PATH;
  let visualRead = null;
  if (visualPath) {
    const processHandle = `direct-visual-read-${Date.now()}`;
    const response = await request("process/spawn", {
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
      drainTextFrames(messages);
      return messages.find((message) =>
        message.method === "process/exited" && message.params?.processHandle === processHandle);
    });
    const lifecycle = messages.filter((message) =>
      message.id === response.id || message.params?.processHandle === processHandle);
    const stdout = Buffer.concat(lifecycle
      .filter((message) => message.method === "process/outputDelta" && message.params?.stream === "stdout")
      .map((message) => Buffer.from(message.params.deltaBase64, "base64")));
    visualRead = {
      order: lifecycle.map((message) => message.id === response.id ? "response" : message.method),
      outputDeltaCount: lifecycle.filter((message) => message.method === "process/outputDelta").length,
      bytes: stdout.length,
      sha256: createHash("sha256").update(stdout).digest("hex"),
      exitCode: exited.params?.exitCode ?? null,
      stdoutCapReached: exited.params?.stdoutCapReached ?? null,
    };
  }
  console.log(JSON.stringify({
    transport: "direct-websocket",
    url: `ws://${host}:${port}/rpc`,
    username,
    platformOs: initialized.result?.platformOs,
    visualizeVersion: visualizePlugin?.localVersion ?? null,
    visualizeSkillPath: visualizeSkill?.path ?? null,
    calculatorSkillPath: calculatorSkill?.path ?? null,
    visibilitySkillPath: visibilitySkill?.path ?? null,
    builderSkillPath: builderSkill?.path ?? null,
    mcpServerNames: mcpStatus.result?.data?.map((server) => server.name) ?? [],
    builderTools: builderServer ? Object.keys(builderServer.tools ?? {}) : [],
    codexAccountsResourceUri: codexAccountsServer?.resources?.[0]?.uri ?? null,
    codexAccountsTools: codexAccountsServer ? Object.keys(codexAccountsServer.tools ?? {}) : [],
    codexAccounts: codexAccounts?.result?.structuredContent?.accounts?.map((account) => ({
      username: account.username,
      displayName: account.displayName,
      email: account.email,
      planType: account.planType,
      active: account.active,
      selectable: account.selectable,
      source: account.source,
      owned: account.owned,
      published: account.published,
      shareId: account.shareId,
      weeklyUsage: account.weeklyUsage,
    })) ?? [],
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
    privacyMutation: privacyMutation?.result?.structuredContent ?? null,
    currencyConversion: currencyConversion?.result?.structuredContent ?? null,
    startedThreadId: startedThread?.result?.thread?.id ?? null,
    startedThreadCwd: startedThread?.result?.cwd ?? startedThread?.result?.thread?.cwd ?? null,
    archivedStartedThread: archivedStartedThread !== null,
    metadataUpdateTurns: metadata?.result?.thread?.turns?.length ?? null,
    thread: process.env.HYPERNODE_PROBE_DUMP_THREAD === "1" ? thread?.result?.thread ?? null : undefined,
    visualRead,
    dynamicApp,
  }, null, 2));

} finally {
  socket.destroy();
}
