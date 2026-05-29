import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";

import { expect, test } from "@playwright/test";

const agentMessageSelector = '[data-testid="chat-message"][data-role="agent"]';

test("renders all live answer chunks without requiring a page reload", async ({
  page,
}) => {
  const acp = await startMockACPServer();
  try {
    await page.goto(`/?acp_url=${encodeURIComponent(acp.url)}`);
    await expect(page.getByLabel("Open session properties")).toContainText(
      "connected",
    );

    await page.getByLabel("New 会话").click();
    await expect(page.getByTestId("prompt-input")).toBeEnabled();

    const agentMessages = page.locator(agentMessageSelector);
    const before = await agentMessages.count();
    await page.getByTestId("prompt-input").fill("你好");
    await page.getByTestId("send-button").click();

    const liveMessage = agentMessages.nth(before);
    await expect(liveMessage).toContainText("你好！有什么我", {
      timeout: 5_000,
    });
    await expect(liveMessage).toContainText("你好！有什么我可以帮助你的吗？", {
      timeout: 5_000,
    });
  } finally {
    await acp.close();
  }
});

test("replaces accumulated live answer snapshots without duplicating prefix", async ({
  page,
}) => {
  const acp = await startMockACPServer({ promptMode: "accumulated" });
  try {
    await page.goto(`/?acp_url=${encodeURIComponent(acp.url)}`);
    await expect(page.getByLabel("Open session properties")).toContainText(
      "connected",
    );

    await page.getByLabel("New 会话").click();
    await expect(page.getByTestId("prompt-input")).toBeEnabled();

    const agentMessages = page.locator(agentMessageSelector);
    const before = await agentMessages.count();
    await page.getByTestId("prompt-input").fill("输出标记");
    await page.getByTestId("send-button").click();

    const liveMessage = agentMessages.nth(before);
    await expect(liveMessage).toContainText("BROWS", { timeout: 5_000 });
    await expect(liveMessage).toContainText("BROWSER_ACCUMULATED_OK", {
      timeout: 5_000,
    });
    await expect(liveMessage).not.toContainText(
      "BROWSBROWSER_ACCUMULATED_OK",
    );
  } finally {
    await acp.close();
  }
});

test("surfaces CloudAgent turn status failures and unlocks the composer", async ({
  page,
}) => {
  const acp = await startMockACPServer({ promptMode: "error" });
  try {
    await page.goto(`/?acp_url=${encodeURIComponent(acp.url)}`);
    await expect(page.getByLabel("Open session properties")).toContainText(
      "connected",
    );

    await page.getByLabel("New 会话").click();
    await expect(page.getByTestId("prompt-input")).toBeEnabled();
    await page.getByTestId("prompt-input").fill("触发错误");
    await page.getByTestId("send-button").click();

    await expect(
      page.getByRole("log").getByText("Sandbox instance quota exceeded"),
    ).toBeVisible({ timeout: 5_000 });
    await page.getByTestId("prompt-input").fill("下一条消息");
    await expect(page.getByTestId("send-button")).toBeEnabled();
  } finally {
    await acp.close();
  }
});

test("clears workspace restore spinner after replay and runtime restore", async ({
  page,
}) => {
  const sessionId = "session-workspace-restore";
	  const acp = await startMockACPServer({
	    listedSessionId: sessionId,
	    workspaceRestore: true,
	    workspaceRestoreDelayMs: 300,
	  });
  try {
    await page.goto(`/?acp_url=${encodeURIComponent(acp.url)}`);
    await page.evaluate((id) => {
      localStorage.setItem(
        "mychat.acp.chat.v1",
        JSON.stringify({ activeSessionId: id }),
      );
    }, sessionId);
    await page.reload();

    await expect(page.getByLabel("Open session properties")).toContainText(
      "connected",
    );
    await expect(page.getByTestId("workspace-restore-spinner")).toBeVisible();
    await expect(page.getByTestId("workspace-restore-spinner")).toBeHidden({
      timeout: 5_000,
    });
    await expect(page.getByTestId("prompt-input")).toBeEnabled();
    await expect(page.getByLabel("Open session properties")).toContainText(
      "connected · session-",
    );
  } finally {
    await acp.close();
  }
});

test("does not surface legacy replayed ACP error updates as fresh provider errors after reload", async ({
  page,
}) => {
  const sessionId = "session-replayed-error";
  const acp = await startMockACPServer({
    listedSessionId: sessionId,
    replayError: true,
  });
  try {
    await page.goto(`/?acp_url=${encodeURIComponent(acp.url)}`);
    await page.evaluate((id) => {
      localStorage.setItem(
        "mychat.acp.chat.v1",
        JSON.stringify({ activeSessionId: id }),
      );
    }, sessionId);
    await page.reload();

    await expect(page.getByLabel("Open session properties")).toContainText(
      "connected",
    );
    await expect(page.getByTestId("prompt-input")).toBeEnabled();
    await expect(
      page.getByRole("log").getByText("old stream error"),
    ).toHaveCount(0);
  } finally {
    await acp.close();
  }
});

test("clears workspace restore spinner from session status when restore response is lost", async ({
  page,
}) => {
  const sessionId = "session-workspace-status-ready";
  const acp = await startMockACPServer({
    listedSessionId: sessionId,
    workspaceRestore: true,
    workspaceRestoreHang: true,
  });
  try {
    await page.goto(`/?acp_url=${encodeURIComponent(acp.url)}`);
    await page.evaluate((id) => {
      localStorage.setItem(
        "mychat.acp.chat.v1",
        JSON.stringify({ activeSessionId: id }),
      );
    }, sessionId);
    await page.reload();

    await expect(page.getByTestId("workspace-restore-spinner")).toBeVisible();
    await expect(page.getByTestId("workspace-restore-spinner")).toBeHidden({
      timeout: 5_000,
    });
    await expect(page.getByTestId("prompt-input")).toBeEnabled();
  } finally {
    await acp.close();
  }
});

async function startMockACPServer(
  options: {
    promptMode?: "success" | "error" | "accumulated";
    listedSessionId?: string;
	    workspaceRestore?: boolean;
	    workspaceRestoreHang?: boolean;
	    workspaceRestoreDelayMs?: number;
	    replayError?: boolean;
  } = {},
) {
  const sessionId = options.listedSessionId ?? "session-streaming-render";
  const messageId = "message-streaming-render";
  const promptMode = options.promptMode ?? "success";
  const server = createServer();
  const sockets = new Set<Socket>();

  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"),
    );
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));

    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const parsed = readClientFrame(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.bytes);
        if (parsed.opcode === 0x8) {
          socket.end();
          continue;
        }
        if (parsed.opcode !== 0x1) continue;
        handleClientMessage(socket, JSON.parse(parsed.text), {
          sessionId,
          messageId,
          promptMode,
          listedSessionId: options.listedSessionId,
	          workspaceRestore: options.workspaceRestore,
	          workspaceRestoreHang: options.workspaceRestoreHang,
	          workspaceRestoreDelayMs: options.workspaceRestoreDelayMs,
	          replayError: options.replayError,
        });
      }
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock ACP server did not bind a TCP port");
  }

  return {
    url: `ws://127.0.0.1:${address.port}/acp`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function handleClientMessage(
  socket: Socket,
  message: {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
  },
  ids: {
    sessionId: string;
    messageId: string;
    promptMode: "success" | "error" | "accumulated";
    listedSessionId?: string;
	    workspaceRestore?: boolean;
	    workspaceRestoreHang?: boolean;
	    workspaceRestoreDelayMs?: number;
	    replayError?: boolean;
  },
) {
  if (!message.method) return;
  if (message.method === "initialize") {
    sendJSON(socket, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: true },
          promptCapabilities: {},
          _meta: ids.workspaceRestore
            ? {
                cloudagent: {
	                  methods: [
	                    "_cloudagent.runtime.ensure_ready",
	                    "_cloudagent.session.status",
	                  ],
                },
              }
            : undefined,
        },
      },
    });
    return;
  }
  if (message.method === "session/list") {
    sendJSON(socket, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessions: ids.listedSessionId
          ? [
	              {
	                sessionId: ids.sessionId,
	                cwd: "/workspace",
	                title: "Recovered workspace",
	                updatedAt: new Date().toISOString(),
	                _meta: {
	                  cloudagent: {
	                    state: "ready",
	                    read_only: false,
	                  },
	                },
	              },
            ]
          : [],
      },
    });
    return;
  }
  if (message.method === "session/load") {
    sendUpdate(socket, ids.sessionId, {
      sessionUpdate: "user_message_chunk",
      content: { text: "Recovered workspace" },
      replay: true,
    });
    if (ids.replayError) {
      sendUpdate(socket, ids.sessionId, {
        sessionUpdate: "error",
        messageId: "message-replayed-error",
        error: {
          code: "provider_error",
          message: "old stream error",
        },
        replay: true,
      });
    }
    sendJSON(socket, {
	      jsonrpc: "2.0",
	      method: "_cloudagent.session.replay_done",
	      params: { session_id: ids.sessionId },
	    });
    sendJSON(socket, {
      jsonrpc: "2.0",
      id: message.id,
	      result: {
	        configOptions: [],
	        _meta: {
	          cloudagent: {
	            state: "ready",
	            read_only: false,
	          },
	        },
	      },
    });
    return;
  }
		  if (message.method === "_cloudagent.runtime.ensure_ready") {
	    if (ids.workspaceRestoreHang) return;
	    const sendReady = () => sendJSON(socket, {
	      jsonrpc: "2.0",
	      id: message.id,
	      result: {
        session_id: ids.sessionId,
        state: "ready",
        read_only: false,
        runtime_status: "attached",
	        sandbox: { daemon_addr: "http://127.0.0.1:4567" },
	      },
	    });
	    if (ids.workspaceRestoreDelayMs) {
	      setTimeout(sendReady, ids.workspaceRestoreDelayMs);
	    } else {
	      sendReady();
	    }
	    return;
	  }
  if (message.method === "session/new") {
    sendJSON(socket, {
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: ids.sessionId, configOptions: [] },
    });
    return;
  }
  if (message.method === "_cloudagent.session.status") {
    sendJSON(socket, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        session_id: ids.sessionId,
        state: "ready",
        read_only: false,
        runtime_status: "attached",
        ready: true,
      },
    });
    return;
  }
  if (message.method === "session/prompt") {
    const requestId = message.id;
    sendUpdate(socket, ids.sessionId, {
      sessionUpdate: "agent_thought_chunk",
      messageId: ids.messageId,
      blockId: "block-streaming-render-thought",
      content: { type: "text", text: "收到问候，直接回复。" },
    });
    if (ids.promptMode === "error") {
      sendJSON(socket, {
        jsonrpc: "2.0",
	        method: "_cloudagent.turn.status",
	        params: {
	          session_id: ids.sessionId,
	          status: "failed",
	          message_id: ids.messageId,
          error: {
            code: "provider_error",
            message: "Sandbox instance quota exceeded",
          },
        },
      });
      sendJSON(socket, {
        jsonrpc: "2.0",
        id: requestId,
        result: { stopReason: "refusal" },
      });
      return;
    }
    if (ids.promptMode === "accumulated") {
      sendUpdate(socket, ids.sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: ids.messageId,
        blockId: "block-streaming-render-answer",
        _meta: {
          cloudagent: { accumulated: true, accumulated_text: "BROWS" },
        },
        content: { type: "text", text: "BROWS" },
      });
      sendUpdate(socket, ids.sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: ids.messageId,
        blockId: "block-streaming-render-answer",
        _meta: {
          cloudagent: {
            accumulated: true,
            accumulated_text: "BROWSER_ACCUMULATED_OK",
          },
        },
        content: { type: "text", text: "ER_ACCUMULATED_OK" },
      });
      setTimeout(() => {
        sendJSON(socket, {
          jsonrpc: "2.0",
          id: requestId,
          result: { stopReason: "end_turn" },
        });
      }, 100);
      return;
    }
    sendUpdate(socket, ids.sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: ids.messageId,
      blockId: "block-streaming-render-answer",
      content: { type: "text", text: "你好！有什么我" },
    });
    sendUpdate(socket, ids.sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: ids.messageId,
      blockId: "block-streaming-render-answer",
      content: { type: "text", text: "可以帮助你的吗？" },
    });
    setTimeout(() => {
      sendJSON(socket, {
        jsonrpc: "2.0",
        id: requestId,
        result: { stopReason: "end_turn" },
      });
    }, 100);
    return;
  }
  if (message.method === "session/close" || message.method === "session/delete") {
    sendJSON(socket, { jsonrpc: "2.0", id: message.id, result: {} });
  }
}

function sendUpdate(
  socket: Socket,
  sessionId: string,
  update: Record<string, unknown>,
) {
  sendJSON(socket, {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });
}

function sendJSON(socket: Socket, value: unknown) {
  socket.write(encodeServerFrame(JSON.stringify(value)));
}

function encodeServerFrame(text: string) {
  const payload = Buffer.from(text);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function readClientFrame(buffer: Buffer):
  | { bytes: number; opcode: number; text: string }
  | undefined {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return undefined;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return undefined;
    const longLength = buffer.readBigUInt64BE(offset);
    if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("websocket frame is too large");
    }
    length = Number(longLength);
    offset += 8;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return {
    bytes: offset + length,
    opcode,
    text: payload.toString("utf8"),
  };
}
