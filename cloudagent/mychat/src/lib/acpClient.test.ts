import { describe, expect, it, vi } from "vitest";
import {
  AcpClient,
  isSameChatMessageTarget,
  mergeChatMessage,
  resolveAcpHTTPURL,
  resolveEnvdFileURL,
  resolveEnvdProxyHTTPBaseURL,
  resolveAcpTransportMode,
  resolveAcpWebSocketURL,
  stripDataURLPrefix,
  type AcpClientEvents,
  type AgentCapabilities,
  type ChatMessage,
  type PermissionRequest,
  type SessionState,
} from "./acpClient";

describe("ACP content serialization helpers", () => {
  it("strips image data URL prefixes before ACP send", () => {
    expect(stripDataURLPrefix("data:image/png;base64,abc123")).toBe("abc123");
  });

  it("keeps plain base64 strings untouched", () => {
    expect(stripDataURLPrefix("abc123")).toBe("abc123");
  });
});

describe("ACP gateway URL resolution", () => {
  it("uses explicit ws override and keeps raw /acp mode", () => {
    expect(
      resolveAcpWebSocketURL("ws://127.0.0.1:18094/acp", {
        protocol: "http:",
        host: "127.0.0.1:5173",
      }),
    ).toBe("ws://127.0.0.1:18094/acp");
    expect(resolveAcpTransportMode("ws://127.0.0.1:18094/acp")).toBe("raw");
  });

  it("builds session-scoped envd file URLs from proxy metadata", () => {
    const status = {
      sessionId: "session_1",
      sessionProxyID: "spx-abc123",
      envdProxyDomain: ".envd.cloudagent.lightvela.com.",
    };

    expect(
      resolveEnvdProxyHTTPBaseURL(status, "https://cloudagent.lightvela.com"),
    ).toBe("https://49983-spx-abc123.envd.cloudagent.lightvela.com/");
    expect(
      resolveEnvdFileURL(
        status,
        "/workspace/hello world.txt",
        "https://cloudagent.lightvela.com",
      ),
    ).toBe(
      "https://49983-spx-abc123.envd.cloudagent.lightvela.com/files?path=%2Fworkspace%2Fhello+world.txt",
    );
  });

  it("converts explicit http gateway to raw ACP websocket", () => {
    expect(
      resolveAcpWebSocketURL("http://127.0.0.1:18094", {
        protocol: "http:",
        host: "127.0.0.1:5173",
      }),
    ).toBe("ws://127.0.0.1:18094/acp");
    expect(resolveAcpTransportMode("ws://127.0.0.1:18094/acp")).toBe("raw");
  });

  it("uses query-string acp_url when no explicit option is provided", () => {
    expect(
      resolveAcpWebSocketURL(undefined, {
        protocol: "http:",
        host: "127.0.0.1:5173",
        search: "?acp_url=" + encodeURIComponent("ws://127.0.0.1:18094/acp"),
      }),
    ).toBe("ws://127.0.0.1:18094/acp");
  });

  it("keeps same-origin fallback on the app websocket path", () => {
    expect(
      resolveAcpWebSocketURL(undefined, {
        protocol: "http:",
        host: "127.0.0.1:5173",
      }),
    ).toBe("ws://127.0.0.1:5173/ws");
  });
});

describe("ACP connection lifecycle", () => {
  it("ignores stale websocket callbacks after disconnect", () => {
    const statuses: string[] = [];
    const sent: unknown[] = [];
    const errors: unknown[] = [];
    const ready: unknown[] = [];
    const sockets: Array<{
      readyState: number;
      onopen: ((event: Event) => void) | null;
      onclose: ((event: CloseEvent) => void) | null;
      onerror: ((event: Event) => void) | null;
      onmessage: ((event: MessageEvent<string>) => void) | null;
      send(message: string): void;
      close(): void;
    }> = [];

    class FakeWebSocket {
      static OPEN = 1;
      readyState = 0;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;

      constructor() {
        sockets.push(this);
      }

      send(message: string) {
        sent.push(JSON.parse(message));
      }

      close() {
        this.readyState = 3;
      }
    }

    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
      FakeWebSocket as unknown as typeof WebSocket;

    const client = new AcpClient(
      {
        onStatus: (status) => statuses.push(status),
        onReady: (capabilities) => ready.push(capabilities),
        onMessage: () => undefined,
        onSession: () => undefined,
        onSessionList: () => undefined,
        onControlOptions: () => undefined,
        onError: (error) => errors.push(error),
        onTrace: () => undefined,
      },
      { gatewayURL: "ws://127.0.0.1:18094/acp" },
    );

    client.connect();
    const staleSocket = sockets[0];
    const staleOpen = staleSocket.onopen;
    const staleMessage = staleSocket.onmessage;
    const staleClose = staleSocket.onclose;
    client.disconnect();

    staleSocket.readyState = FakeWebSocket.OPEN;
    staleOpen?.(new Event("open"));
    staleMessage?.({
      data: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { agentCapabilities: { sessionCapabilities: { list: {} } } },
      }),
    } as MessageEvent<string>);
    staleClose?.({} as CloseEvent);

    expect(statuses).toEqual(["connecting"]);
    expect(sent).toEqual([]);
    expect(errors).toEqual([]);
    expect(ready).toEqual([]);
  });
});

describe("ACP tool call updates", () => {
  it("keeps top-level ACP tool updates on the same UI message and marks them done", () => {
    const messages: ChatMessage[] = [];
    const events: AcpClientEvents = {
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    };
    const client = new AcpClient(events);

    (
      client as unknown as {
        handleUpdate(
          conversationId: string,
          update: Record<string, unknown>,
        ): void;
      }
    ).handleUpdate("conv-1", {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "查询天气",
      kind: "search",
      rawInput: { query: "深圳天气" },
      status: "in_progress",
    });
    (
      client as unknown as {
        handleUpdate(
          conversationId: string,
          update: Record<string, unknown>,
        ): void;
      }
    ).handleUpdate("conv-1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: { temperature: "26C" },
      content: [{ type: "content", content: "晴，26C" }],
    });

    expect(messages).toHaveLength(2);
    expect(messages[1].id).toBe(messages[0].id);
    expect(messages[1].toolCalls).toEqual([
      {
        id: "tool-1",
        name: "查询天气",
        status: "done",
        kind: "search",
        input: { query: "深圳天气" },
        output: { temperature: "26C" },
        content: "晴，26C",
      },
    ]);
  });

  it("merges tool status updates instead of appending duplicate tool blocks", () => {
    const initial: ChatMessage = {
      id: "message-1",
      conversationId: "conv-1",
      role: "agent",
      sender: "主AGENTS",
      time: "01:20",
      content: "",
      toolCalls: [{ id: "tool-1", name: "查询天气", status: "running" }],
    };
    const incoming: ChatMessage = {
      ...initial,
      time: "01:21",
      toolCalls: [{ id: "tool-1", name: "查询天气", status: "done" }],
    };

    expect(mergeChatMessage(initial, incoming).toolCalls).toEqual([
      { id: "tool-1", name: "查询天气", status: "done" },
    ]);
  });

  it("overwrites streaming state only when incoming messages define it", () => {
    const initial: ChatMessage = {
      id: "message-1",
      conversationId: "conv-1",
      role: "agent",
      sender: "主AGENTS",
      time: "01:20",
      content: "hello",
      streaming: true,
    };

    expect(
      mergeChatMessage(initial, { ...initial, content: "", streaming: false })
        .streaming,
    ).toBe(false);
    expect(
      mergeChatMessage(initial, {
        ...initial,
        content: " world",
        streaming: undefined,
      }).streaming,
    ).toBe(true);
  });

  it("keeps tool calls on the active assistant message so sections can render after reasoning and body", () => {
    const messages: ChatMessage[] = [];
    const events: AcpClientEvents = {
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    };
    const client = new AcpClient(events);
    client.setActiveSession("conv-1", "session-1");

    const handleUpdate = (update: Record<string, unknown>) => {
      (
        client as unknown as {
          handleUpdate(
            conversationId: string,
            update: Record<string, unknown>,
          ): void;
        }
      ).handleUpdate("conv-1", update);
    };

    handleUpdate({
      sessionUpdate: "agent_thought_chunk",
      messageId: "message-a",
      content: { type: "text", text: "thinking" },
    });
    handleUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "read",
      status: "in_progress",
    });
    handleUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "message-a",
      content: { type: "text", text: "answer" },
    });

    expect(messages).toHaveLength(3);
    expect(messages.every((message) => message.id === messages[0].id)).toBe(
      true,
    );
    expect(messages[0].id).toContain("message-a");
    expect(
      messages.reduce((current, incoming) =>
        mergeChatMessage(current, incoming),
      ),
    ).toMatchObject({
      thought: "thinking",
      content: "answer",
      toolCalls: [{ id: "tool-1", name: "read", status: "running" }],
    });
  });

  it("aliases tool-first messages to the later ACP assistant message id", () => {
    const messages: ChatMessage[] = [];
    const events: AcpClientEvents = {
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    };
    const client = new AcpClient(events);
    client.setActiveSession("conv-1", "session-1");

    const handleUpdate = (update: Record<string, unknown>) => {
      (
        client as unknown as {
          handleUpdate(
            conversationId: string,
            update: Record<string, unknown>,
          ): void;
        }
      ).handleUpdate("conv-1", update);
    };

    handleUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "read",
      status: "in_progress",
    });
    handleUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "message-a",
      content: { type: "text", text: "answer" },
    });
    handleUpdate({
      sessionUpdate: "agent_thought_chunk",
      messageId: "message-a",
      content: { type: "text", text: "thinking" },
    });

    expect(messages).toHaveLength(3);
    expect(messages[0].id).not.toBe("message-a");
    expect(messages[1].id).toBe(messages[0].id);
    expect(messages[2].id).toBe(messages[0].id);
    expect(
      messages.reduce((current, incoming) =>
        mergeChatMessage(current, incoming),
      ),
    ).toMatchObject({
      thought: "thinking",
      content: "answer",
      toolCalls: [{ id: "tool-1", name: "read", status: "running" }],
    });
  });

  it("keeps tool blocks in event timeline order and updates them in place", () => {
    const messages: ChatMessage[] = [];
    const events: AcpClientEvents = {
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    };
    const client = new AcpClient(events);
    client.setActiveSession("conv-1", "session-1");

    const handleUpdate = (update: Record<string, unknown>) => {
      (
        client as unknown as {
          handleUpdate(
            conversationId: string,
            update: Record<string, unknown>,
          ): void;
        }
      ).handleUpdate("conv-1", update);
    };

    handleUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "web_search",
      kind: "search",
      status: "in_progress",
      rawInput: { query: "腾讯股价" },
    });
    handleUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "message-a",
      content: { type: "text", text: "answer" },
    });
    handleUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: { ok: true },
    });

    const merged = messages.reduce((current, incoming) =>
      mergeChatMessage(current, incoming),
    );
    expect(merged.timelineBlocks?.map((block) => block.type)).toEqual([
      "tools",
      "content",
    ]);
    expect(merged.timelineBlocks?.[0]).toMatchObject({
      type: "tools",
      toolCalls: [
        {
          id: "tool-1",
          name: "web_search",
          status: "done",
          kind: "search",
          input: { query: "腾讯股价" },
          output: { ok: true },
        },
      ],
    });
    expect(merged.timelineBlocks?.[1]).toMatchObject({
      type: "content",
      text: "answer",
    });
  });

  it("treats accumulated live chunks as replace updates from ACP", () => {
    const messages: ChatMessage[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });

    const handleUpdate = (update: Record<string, unknown>) => {
      (
        client as unknown as {
          handleUpdate(
            conversationId: string,
            update: Record<string, unknown>,
          ): void;
        }
      ).handleUpdate("conv-1", update);
    };

    handleUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "message-a",
      blockId: "block-a",
      _meta: { cloudagent: { accumulated: true, accumulated_text: "BROWS" } },
      content: { type: "text", text: "BROWS" },
    });
    handleUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "message-a",
      blockId: "block-a",
      _meta: {
        cloudagent: {
          accumulated: true,
          accumulated_text: "BROWSER_FINAL_123",
        },
      },
      content: { type: "text", text: "ER_FINAL_123" },
    });

    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toBe("BROWSER_FINAL_123");
    const merged = messages.reduce((current, incoming) =>
      mergeChatMessage(current, incoming),
    );
    expect(merged.content).toBe("BROWSER_FINAL_123");
    expect(merged.streaming).toBe(true);
    expect(merged.timelineBlocks?.[0]).toMatchObject({
      id: "block-a",
      type: "content",
      text: "BROWSER_FINAL_123",
    });
  });

  it("renders the accumulated ACP extension if an earlier live chunk was missed", () => {
    const messages: ChatMessage[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });

    (
      client as unknown as {
        handleUpdate(
          conversationId: string,
          update: Record<string, unknown>,
        ): void;
      }
    ).handleUpdate("conv-1", {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-a",
      blockId: "block-a",
      _meta: {
        cloudagent: {
          accumulated: true,
          accumulated_text: "BROWSER_FINAL_123",
        },
      },
      content: { type: "text", text: "ER_FINAL_123" },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("BROWSER_FINAL_123");
    expect(messages[0]?.timelineBlocks?.[0]).toMatchObject({
      id: "block-a",
      type: "content",
      text: "BROWSER_FINAL_123",
      replace: true,
    });
  });

  it("replaces matching text blocks when replay sends a snapshot", () => {
    const merged = mergeChatMessage(
      {
        id: "message-a",
        conversationId: "conv-1",
        role: "agent",
        sender: "主AGENTS",
        time: "10:00",
        content: "hello",
        timelineBlocks: [{ id: "block-a", type: "content", text: "hello" }],
      },
      {
        id: "message-a",
        conversationId: "conv-1",
        role: "agent",
        sender: "主AGENTS",
        time: "10:00",
        content: "hello world",
        snapshot: true,
        timelineBlocks: [
          {
            id: "block-a",
            type: "content",
            text: "hello world",
            snapshot: true,
          },
        ],
      },
    );

    expect(merged.content).toBe("hello world");
    expect(merged.timelineBlocks?.[0]).toMatchObject({
      id: "block-a",
      type: "content",
      text: "hello world",
    });
  });

  it("replaces matching text blocks for accumulated live chunks without settling streaming", () => {
    const first: ChatMessage = {
      id: "message-a",
      conversationId: "conv-1",
      role: "agent",
      sender: "主AGENTS",
      time: "10:00",
      content: "BROWS",
      streaming: true,
      replace: true,
      timelineBlocks: [
        {
          id: "block-a",
          type: "content",
          text: "BROWS",
          replace: true,
        },
      ],
    };
    const second: ChatMessage = {
      ...first,
      content: "BROWSER_FINAL_123",
      timelineBlocks: [
        {
          id: "block-a",
          type: "content",
          text: "BROWSER_FINAL_123",
          replace: true,
        },
      ],
    };

    const merged = mergeChatMessage(first, second);

    expect(merged.content).toBe("BROWSER_FINAL_123");
    expect(merged.streaming).toBe(true);
    expect(merged.timelineBlocks?.[0]).toMatchObject({
      id: "block-a",
      type: "content",
      text: "BROWSER_FINAL_123",
    });
  });

  it("does not mark replayed assistant snapshots as actively streaming", () => {
    const messages: ChatMessage[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });

    (
      client as unknown as {
        handleUpdate(
          conversationId: string,
          update: Record<string, unknown>,
        ): void;
      }
    ).handleUpdate("conv-1", {
      sessionUpdate: "agent_message_chunk",
      replay: true,
      messageId: "message-a",
      blockId: "block-a",
      content: { type: "text", text: "complete answer" },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: expect.stringContaining("message-a"),
      streaming: false,
      content: "complete answer",
    });
    expect(
      (
        client as unknown as { activeStreamingMessageIds: Map<string, string> }
      ).activeStreamingMessageIds.has("conv-1"),
    ).toBe(false);
  });

  it("marks the active assistant message streaming and settles it on prompt completion", () => {
    const messages: ChatMessage[] = [];
    const turns: Array<[string, string]> = [];
    const sent: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
      onTurn: (conversationId, state) => turns.push([conversationId, state]),
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");

    client.sendPrompt("conv-1", "hello", [], { optimistic: false });
    (
      client as unknown as {
        handleUpdate(
          conversationId: string,
          update: Record<string, unknown>,
        ): void;
      }
    ).handleUpdate("conv-1", {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-a",
      content: { type: "text", text: "answer" },
    });
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });

    expect(sent).toHaveLength(1);
    expect(messages.map((message) => message.streaming)).toEqual([
      true,
      false,
    ]);
    expect(messages.every((message) => message.id === messages[0].id)).toBe(
      true,
    );
    expect(messages[0].id).toContain("message-a");
    expect(
      messages.reduce((current, incoming) =>
        mergeChatMessage(current, incoming),
      ),
    ).toMatchObject({ content: "answer", streaming: false });
    expect(turns).toEqual([
      ["conv-1", "started"],
      ["conv-1", "completed"],
    ]);
  });

  it("settles reconnected streaming messages from terminal turn updates", () => {
    const messages: ChatMessage[] = [];
    const turns: Array<[string, string]> = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
      onTurn: (conversationId, state) => turns.push([conversationId, state]),
    });
    client.setActiveSession("conv-1", "session-1");
    (
      client as unknown as {
        handleUpdate(
          conversationId: string,
          update: Record<string, unknown>,
        ): void;
      }
    ).handleUpdate("conv-1", {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-a",
      blockId: "block-a",
      content: { type: "text", text: "tail" },
    });
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
	      method: "_cloudagent.turn.status",
	      params: {
	        session_id: "session-1",
	        status: "completed",
	        message_id: "message-a",
	      },
	    });

    expect(messages.map((message) => message.streaming)).toEqual([
      true,
      false,
    ]);
    expect(turns).toEqual([["conv-1", "completed"]]);
  });

  it("surfaces replay_gap instead of silently ignoring dropped replay updates", () => {
    const errors: Array<{ code: string; kind: string; message?: string }> = [];
	    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: (error) => errors.push(error),
	      onTrace: () => undefined,
	    });
    client.setActiveSession("conv-1", "session-1");

    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
	      jsonrpc: "2.0",
	      method: "_cloudagent.session.replay_gap",
	      params: { session_id: "session-1", dropped: 3 },
	    });

    expect(errors).toMatchObject([
      {
        code: "replay_gap",
        kind: "stream_replay_gap",
      },
    ]);
    expect(errors[0].message).toContain("3");
  });

  it("keeps tool-first streaming ownership on the generated UI message id", () => {
    const messages: ChatMessage[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });
    client.setActiveSession("conv-1", "session-1");
    const handleUpdate = (update: Record<string, unknown>) => {
      (
        client as unknown as {
          handleUpdate(
            conversationId: string,
            update: Record<string, unknown>,
          ): void;
        }
      ).handleUpdate("conv-1", update);
    };

    handleUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "read",
      status: "in_progress",
    });
    handleUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "message-a",
      content: { type: "text", text: "answer" },
    });

    expect(messages[0].id).not.toBe("message-a");
    expect(messages[1]).toMatchObject({
      id: messages[0].id,
      streaming: true,
    });
    expect(
      (
        client as unknown as { activeStreamingMessageIds: Map<string, string> }
      ).activeStreamingMessageIds.get("conv-1"),
    ).toBe(messages[0].id);
  });

  it("makes late prompt completion a no-op after runtime reset", () => {
    const messages: ChatMessage[] = [];
    const turns: Array<[string, string]> = [];
    const sent: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
      onTurn: (conversationId, state) => turns.push([conversationId, state]),
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");

    client.sendPrompt("conv-1", "hello", [], { optimistic: false });
    (
      client as unknown as {
        handleUpdate(
          conversationId: string,
          update: Record<string, unknown>,
        ): void;
      }
    ).handleUpdate("conv-1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "answer" },
    });
    client.resetConversationRuntime("conv-1");
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });

    expect(sent).toHaveLength(1);
    expect(messages.map((message) => message.streaming)).toEqual([
      true,
      false,
    ]);
    expect(turns).toEqual([["conv-1", "started"]]);
    expect(
      (
        client as unknown as { activeStreamingMessageIds: Map<string, string> }
      ).activeStreamingMessageIds.has("conv-1"),
    ).toBe(false);
  });

  it("scopes UI message identity by conversation", () => {
    const first = {
      id: "message-a",
      conversationId: "conv-1",
    };
    expect(
      isSameChatMessageTarget(first, {
        id: "message-a",
        conversationId: "conv-1",
      }),
    ).toBe(true);
    expect(
      isSameChatMessageTarget(first, {
        id: "message-a",
        conversationId: "conv-2",
      }),
    ).toBe(false);
  });
});

describe("ACP prompt message boundaries", () => {
  it("starts a new assistant message when a new prompt is sent even if the prior prompt response never arrived", () => {
    const messages: ChatMessage[] = [];
    const sent: unknown[] = [];
    const events: AcpClientEvents = {
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    };
    const client = new AcpClient(events);
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");

    client.sendPrompt("conv-1", "first", []);
    (
      client as unknown as {
        handleUpdate(
          conversationId: string,
          update: Record<string, unknown>,
        ): void;
      }
    ).handleUpdate("conv-1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "first reply" },
    });
    client.sendPrompt("conv-1", "second", []);
    (
      client as unknown as {
        handleUpdate(
          conversationId: string,
          update: Record<string, unknown>,
        ): void;
      }
    ).handleUpdate("conv-1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "second reply" },
    });

    const assistantMessages = messages.filter(
      (message) => message.role === "agent" && message.content,
    );
    expect(sent).toHaveLength(2);
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0].id).not.toBe(assistantMessages[1].id);
    expect(assistantMessages.map((message) => message.content)).toEqual([
      "first reply",
      "second reply",
    ]);
  });

  it("suppresses ACP user echoes that match the optimistic local prompt", () => {
    const messages: ChatMessage[] = [];
    const sent: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");

    client.sendPrompt("conv-1", "hello world", []);
    (
      client as unknown as {
        handleUpdate(
          conversationId: string,
          update: Record<string, unknown>,
        ): void;
      }
    ).handleUpdate("conv-1", {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "hello " },
    });
    (
      client as unknown as {
        handleUpdate(
          conversationId: string,
          update: Record<string, unknown>,
        ): void;
      }
    ).handleUpdate("conv-1", {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "world" },
    });

    expect(sent).toHaveLength(1);
    expect(messages.filter((message) => message.role === "user")).toHaveLength(
      1,
    );
    expect(messages[0]).toMatchObject({ role: "user", content: "hello world" });
  });

  it("can send a queued prompt without adding a second optimistic user bubble", () => {
    const messages: ChatMessage[] = [];
    const sent: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");

    client.sendPrompt("conv-1", "queued text", [], { optimistic: false });
    (
      client as unknown as {
        handleUpdate(
          conversationId: string,
          update: Record<string, unknown>,
        ): void;
      }
    ).handleUpdate("conv-1", {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "queued text" },
    });

    expect(sent).toHaveLength(1);
    expect(messages.filter((message) => message.role === "user")).toHaveLength(
      0,
    );
  });

  it("fails active prompt turns when the websocket transport is lost", () => {
    const turns: Array<[string, string]> = [];
    const sent: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
      onTurn: (conversationId, state) => turns.push([conversationId, state]),
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");

    client.sendPrompt("conv-1", "hello", []);
    (
      client as unknown as {
        handleTransportLoss(status: "disconnected" | "error"): void;
      }
    ).handleTransportLoss("disconnected");

    expect(sent).toHaveLength(1);
    expect(turns).toEqual([
      ["conv-1", "started"],
      ["conv-1", "failed"],
    ]);
  });
});

describe("ACP gateway envelope handling", () => {
  it("reports malformed gateway envelopes instead of throwing out of the websocket handler", () => {
    const errors: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: (error) => errors.push(error),
      onTrace: () => undefined,
    });

    expect(() => {
      (
        client as unknown as { handleEnvelope(raw: string): void }
      ).handleEnvelope("{not-json");
    }).not.toThrow();
    expect(errors).toMatchObject([
      { code: "restore_failed", kind: "resume_rejected" },
    ]);
  });
});

describe("ACP session restore responses", () => {
  it("parses cloudagent runtime run ledger status", () => {
    const statuses: unknown[] = [];
    const sent: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
      onSessionStatus: (_conversationId, status) => statuses.push(status),
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };

    expect(client.requestSessionStatus("conv-1", "session-1")).toBe(true);
    expect(sent).toHaveLength(1);
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      id: 1,
      result: {
        session_id: "session-1",
        lifecycle_state: "live",
        recoverability: "live",
        recoverability_note: "runtime_attached",
        runtime_status: "idle",
        runtime_status_source: "runtime",
        runtime_status_error: "",
        runtime_store_load: "Restored",
        run_count: 2,
        transcript_count: 4,
        last_user_hash: "userhash",
        last_assistant_hash: "assisthash",
        run_ledger_tail: [
          {
            run_id: "run-1",
            turn_id: "turn-1",
            inbox_mode: "steer",
            status: "canceled",
            created_at_ms: 10,
            started_at_ms: 11,
            completed_at_ms: 12,
            reconciled_reason: "runtime restored with active run in progress",
          },
        ],
      },
    });

    expect(statuses).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        lifecycleState: "live",
        recoverability: "live",
        recoverabilityNote: "runtime_attached",
        runtimeStatus: "idle",
        runtimeStatusSource: "runtime",
        runtimeStatusError: undefined,
        runtimeStoreLoad: "Restored",
        runCount: 2,
        transcriptCount: 4,
        lastUserHash: "userhash",
        lastAssistantHash: "assisthash",
        runLedgerTail: [
          expect.objectContaining({
            runId: "run-1",
            turnId: "turn-1",
            inboxMode: "steer",
            status: "canceled",
            createdAtMs: 10,
            startedAtMs: 11,
            completedAtMs: 12,
            reconciledReason: "runtime restored with active run in progress",
          }),
        ],
      }),
    ]);
  });

  it("prefers the runtime ensure_ready extension and treats the result as a live session", () => {
    const sessions: unknown[] = [];
    const statuses: unknown[] = [];
    const lifecycleEvents: unknown[] = [];
    const sent: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: (session) => sessions.push(session),
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
      onSessionStatus: (_conversationId, status) => statuses.push(status),
      onWorkspaceLifecycle: (_conversationId, event) =>
        lifecycleEvents.push(event),
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    (client as unknown as { capabilities: AgentCapabilities }).capabilities = {
      _meta: {
        cloudagent: {
          methods: ["_cloudagent.runtime.ensure_ready"],
        },
      },
    };

	    expect(client.ensureRuntimeReady("conv-1", "session-1", "/workspace")).toBe(
	      true,
	    );
    expect(sent[0]).toMatchObject({
      type: "acp",
      message: {
        jsonrpc: "2.0",
        method: "_cloudagent.runtime.ensure_ready",
        params: { session_id: "session-1", cwd: "/workspace" },
      },
    });
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      method: "_cloudagent.workspace.lifecycle",
      params: {
        session_id: "session-1",
        lifecycle_id: "restore:session-1:runtime",
        operation: "restore",
        phase: "runtime",
        status: "running",
        label: "恢复 Runtime Host",
        elapsed_ms: 12,
      },
    });
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      id: 1,
	      result: {
	        session_id: "session-1",
	        configOptions: [{ id: "model", type: "select", currentValue: "m" }],
	        state: "ready",
        lifecycle_state: "live",
        recoverability: "live",
        recoverability_note: "runtime_attached",
        runtime_status: "idle",
        workspace_persistent: true,
      },
    });

    expect(sessions).toEqual([
      expect.objectContaining({
        conversationId: "conv-1",
        sessionId: "session-1",
        restoreSource: "resume",
      }),
    ]);
    expect(statuses).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        lifecycleState: "live",
        recoverability: "live",
        recoverabilityNote: "runtime_attached",
        runtimeStatus: "idle",
        workspacePersistent: true,
      }),
    ]);
    expect(lifecycleEvents).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        lifecycleId: "restore:session-1:runtime",
        operation: "restore",
        phase: "runtime",
        status: "running",
        label: "恢复 Runtime Host",
        elapsedMs: 12,
      }),
    ]);
  });

  it("treats runtime ownership held during ensure_ready as active work instead of restore failure", () => {
    const errors: unknown[] = [];
    const sent: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: (error) => errors.push(error),
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };

    expect(client.ensureRuntimeReady("conv-1", "session-1", "/workspace")).toBe(
      true,
    );
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32009,
        message: "runtime ownership is held",
        data: {
          error_code: "runtime_ownership_held",
          session_id: "session-1",
          run_id: "job-active",
          retryable: true,
        },
      },
    });

    expect(errors).toEqual([]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      type: "acp",
      message: {
        jsonrpc: "2.0",
        method: "_cloudagent.session.status",
        params: { session_id: "session-1" },
      },
    });
  });

  it("parses session/list metadata into listed sessions", () => {
    const listed: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: (sessions) => listed.push(sessions),
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: () => undefined,
    };

    client.listSessions("/tmp");
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      id: 1,
      result: {
        sessions: [
          {
            sessionId: "session-1",
            title: "Real history",
            cwd: "/tmp",
            updatedAt: "2026-05-09T03:00:00Z",
            _meta: {
              cloudagent: {
                lifecycle_state: "blocked_terminal",
                recoverability: "terminal",
                recoverability_note: "runtime_not_recovered",
                read_only: true,
                read_only_reason: "runtime_not_recovered",
              },
            },
            additionalDirectories: ["/tmp/extra"],
          },
        ],
      },
    });

    expect(listed[0]).toEqual([
      {
        sessionId: "session-1",
        title: "Real history",
        cwd: "/tmp",
        updatedAt: "2026-05-09T03:00:00Z",
        lifecycleState: "blocked_terminal",
        recoverability: "terminal",
        recoverabilityNote: "runtime_not_recovered",
        readOnly: true,
        readOnlyReason: "runtime_not_recovered",
        additionalDirectories: ["/tmp/extra"],
      },
    ]);
  });

  it("surfaces session/list failure distinctly for fail-closed UI", () => {
    const errors: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: (error) => errors.push(error),
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: () => undefined,
    };

    client.listSessions("/tmp");
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "missing" },
    });

    expect(errors).toEqual([
      {
        code: "restore_failed",
        kind: "session_list_unavailable",
        message: "missing",
      },
    ]);
  });

  it("keeps load success bound for replay but not live until the UI settles replay", () => {
    const sessions: SessionState[] = [];
    const sent: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: (state) => sessions.push(state),
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };

    client.loadSession("conv-1", "session-1", "/tmp", [], ["/tmp/extra"]);
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({ jsonrpc: "2.0", id: 1, result: { models: {} } });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      message: {
        method: "session/load",
        params: {
          sessionId: "session-1",
          cwd: "/tmp",
          mcpServers: [],
          additionalDirectories: ["/tmp/extra"],
        },
      },
    });
    expect(sessions).toEqual([
      {
        conversationId: "conv-1",
        sessionId: "session-1",
        configOptions: [],
        restoreSource: "load",
      },
    ]);
    expect(client.hasActiveSession("conv-1", "session-1")).toBe(false);
    client.setActiveSession("conv-1", "session-1");
    expect(client.hasActiveSession("conv-1", "session-1")).toBe(true);
  });

  it("maps replay updates after resume through the pre-bound session", () => {
    const messages: ChatMessage[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: () => undefined,
    };

    client.resumeSession("conv-1", "session-1", "/tmp", []);
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "old question" },
        },
      },
    });

    expect(messages).toMatchObject([
      { conversationId: "conv-1", role: "user", content: "old question" },
    ]);
  });

  it("emits replay_done without creating a chat message", () => {
    const messages: ChatMessage[] = [];
    const replayDone: string[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
      onReplayDone: (conversationId) => replayDone.push(conversationId),
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: () => undefined,
    };

    client.loadSession("conv-1", "session-1", "/tmp", []);
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
	      jsonrpc: "2.0",
	      method: "_cloudagent.session.replay_done",
	      params: { session_id: "session-1" },
	    });

    expect(replayDone).toEqual(["conv-1"]);
    expect(messages).toEqual([]);
  });

  it("emits replay_done from standard session/update without creating a chat message", () => {
    const messages: ChatMessage[] = [];
    const replayDone: string[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
      onReplayDone: (conversationId) => replayDone.push(conversationId),
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: () => undefined,
    };

    client.loadSession("conv-1", "session-1", "/tmp", []);
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "replay_done",
          lastEventSeq: 9,
        },
      },
    });

    expect(replayDone).toEqual(["conv-1"]);
    expect(messages).toEqual([]);
  });

  it("clears optimistic load bindings when restore fails", () => {
    const errors: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: (error) => errors.push(error),
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: () => undefined,
    };

    client.loadSession("conv-1", "session-1", "/tmp", []);
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "load failed" },
    });

    expect(errors).toEqual([
      {
        code: "restore_failed",
        kind: "resume_rejected",
        message: "load failed",
        conversationId: "conv-1",
      },
    ]);
    expect(client.hasActiveSession("conv-1", "session-1")).toBe(false);
  });

  it("clears optimistic load bindings when the restore request cannot be sent", () => {
    const errors: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: (error) => errors.push(error),
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 0,
      send: () => {
        throw new Error("should not send");
      },
    };

    client.loadSession("conv-1", "session-1", "/tmp", []);

    expect(errors).toEqual([
      {
        code: "restore_failed",
        kind: "resume_rejected",
        message: "Gateway is not connected",
        conversationId: "conv-1",
      },
    ]);
    expect(client.hasActiveSession("conv-1", "session-1")).toBe(false);
    expect(
      (
        client as unknown as { sessionToConversation: Map<string, string> }
      ).sessionToConversation.has("session-1"),
    ).toBe(false);
  });

  it("reports unsent new session requests against the draft conversation", () => {
    const errors: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: (error) => errors.push(error),
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 0,
      send: () => {
        throw new Error("should not send");
      },
    };

    client.createSession("draft-1", "/tmp", []);

    expect(errors).toEqual([
      {
        code: "restore_failed",
        kind: "resume_rejected",
        message: "Gateway is not connected",
        conversationId: "draft-1",
      },
    ]);
  });

  it("merges custom session params into session/new requests", () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };

    client.createSession("draft-1", "/workspace", [], {
      _meta: { cloudagent: { sandbox_backend: "talos" } },
    });

    expect(sent[0]).toMatchObject({
      message: {
        method: "session/new",
        params: {
          cwd: "/workspace",
          mcpServers: [],
          _meta: { cloudagent: { sandbox_backend: "talos" } },
        },
      },
    });
  });

  it("routes websocket send exceptions through request-specific failure handling", () => {
    const errors: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: (error) => errors.push(error),
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: () => {
        throw new Error("socket closed");
      },
    };

    expect(() =>
      client.loadSession("conv-1", "session-1", "/tmp", []),
    ).not.toThrow();

    expect(errors).toEqual([
      {
        code: "restore_failed",
        kind: "resume_rejected",
        message: "Gateway is not connected",
        conversationId: "conv-1",
      },
    ]);
    expect(
      (
        client as unknown as { sessionToConversation: Map<string, string> }
      ).sessionToConversation.has("session-1"),
    ).toBe(false);
  });

  it("coalesces reasoning and answer chunks into one assistant message id", () => {
    const messages: ChatMessage[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });
    client.setActiveSession("conv-1", "session-1");

    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking" },
        },
      },
    });
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "answer" },
        },
      },
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe(messages[1].id);
    expect(mergeChatMessage(messages[0], messages[1])).toMatchObject({
      thought: "thinking",
      content: "answer",
    });
  });

  it("appends same-id thought chunks before answer chunks and resets after a user boundary", () => {
    const messages: ChatMessage[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });
    client.setActiveSession("conv-1", "session-1");

    const handleUpdate = (update: Record<string, unknown>) => {
      (
        client as unknown as {
          handleAcp(message: Record<string, unknown>): void;
        }
      ).handleAcp({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "session-1", update },
      });
    };

    handleUpdate({
      sessionUpdate: "agent_thought_chunk",
      messageId: "message-a",
      content: { type: "text", text: "think " },
    });
    handleUpdate({
      sessionUpdate: "agent_thought_chunk",
      messageId: "message-a",
      content: { type: "text", text: "more" },
    });
    handleUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "message-a",
      content: { type: "text", text: "answer" },
    });
    handleUpdate({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "next question" },
    });
    handleUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "next answer" },
    });

    const firstMessageId = messages[0].id;
    const first = messages
      .filter((message) => message.id === firstMessageId)
      .reduce((current, incoming) => mergeChatMessage(current, incoming));
    const assistantMessages = messages.filter(
      (message) =>
        message.role === "agent" &&
        (message.content || message.thought || message.toolCalls?.length),
    );

    expect(first).toMatchObject({ thought: "think more", content: "answer" });
    expect(assistantMessages).toHaveLength(4);
    expect(assistantMessages[3].id).not.toBe(firstMessageId);
    expect(assistantMessages[3].content).toBe("next answer");
  });

  it("uses replayed user message chunks as assistant message boundaries when ACP messageId is absent", () => {
    const messages: ChatMessage[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });
    client.setActiveSession("conv-1", "session-1");

    const handleUpdate = (sessionUpdate: string, text: string) => {
      (
        client as unknown as {
          handleAcp(message: Record<string, unknown>): void;
        }
      ).handleAcp({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: { sessionUpdate, content: { type: "text", text } },
        },
      });
    };

    handleUpdate("user_message_chunk", "question one");
    handleUpdate("agent_message_chunk", "answer one");
    handleUpdate("user_message_chunk", "question two");
    handleUpdate("agent_message_chunk", "answer two");

    const assistantMessages = messages.filter(
      (message) => message.role === "agent" && message.content,
    );
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0].id).not.toBe(assistantMessages[1].id);
    expect(assistantMessages.map((message) => message.content)).toEqual([
      "answer one",
      "answer two",
    ]);
  });

  it("scopes repeated replay wire ids to the current replay turn", () => {
    const messages: ChatMessage[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });
    client.setActiveSession("conv-1", "session-1");

    const handleUpdate = (sessionUpdate: string, text: string) => {
      (
        client as unknown as {
          handleAcp(message: Record<string, unknown>): void;
        }
      ).handleAcp({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate,
            messageId: "message-a",
            content: { type: "text", text },
          },
        },
      });
    };

    handleUpdate("user_message_chunk", "first question");
    handleUpdate("agent_message_chunk", "first answer");
    handleUpdate("user_message_chunk", "second question");
    handleUpdate("agent_message_chunk", "second answer");

    const assistantMessages = messages.filter(
      (message) => message.role === "agent" && message.content,
    );
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0].id).not.toBe(assistantMessages[1].id);
    expect(assistantMessages.map((message) => message.content)).toEqual([
      "first answer",
      "second answer",
    ]);
  });

  it("uses ACP messageId to coalesce chunks and split adjacent assistant messages", () => {
    const messages: ChatMessage[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });
    client.setActiveSession("conv-1", "session-1");

    for (const [messageId, text] of [
      ["message-a", "hello"],
      ["message-a", " world"],
      ["message-b", "next"],
    ]) {
      (
        client as unknown as {
          handleAcp(message: Record<string, unknown>): void;
        }
      ).handleAcp({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId,
            content: { type: "text", text },
          },
        },
      });
    }

    expect(messages[0].id).toBe(messages[1].id);
    expect(messages[0].id).toContain("message-a");
    expect(messages[2].id).toContain("message-b");
    expect(messages[2].id).not.toBe(messages[0].id);
    expect(mergeChatMessage(messages[0], messages[1]).content).toBe(
      "hello world",
    );
  });

  it("uses ACP blockId to merge live content and thought chunks like replay", () => {
    const messages: ChatMessage[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });
    client.setActiveSession("conv-1", "session-1");

    for (const update of [
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "message-a",
        blockId: "block-thinking",
        content: { type: "text", text: "think " },
      },
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "message-a",
        blockId: "block-thinking",
        content: { type: "text", text: "more" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-a",
        blockId: "block-answer",
        content: { type: "text", text: "hello " },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-a",
        blockId: "block-answer",
        content: { type: "text", text: "world" },
      },
    ]) {
      (
        client as unknown as {
          handleAcp(message: Record<string, unknown>): void;
        }
      ).handleAcp({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "session-1", update },
      });
    }

    const merged = messages.reduce((current, incoming) =>
      mergeChatMessage(current, incoming),
    );
    expect(merged.timelineBlocks).toMatchObject([
      { id: "block-thinking", type: "thought", text: "think more" },
      { id: "block-answer", type: "content", text: "hello world" },
    ]);
  });
});

describe("ACP permission requests", () => {
  it("surfaces agent-originated permission requests and answers with the original JSON-RPC id", () => {
    const requests: PermissionRequest[] = [];
    const sent: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
      onPermissionRequest: (request) => requests.push(request),
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");

    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      id: 77,
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { title: "exec" },
        options: [
          { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
        ],
      },
    });
    client.resolvePermission(requests[0], "allow_once");

    expect(requests).toMatchObject([
      { conversationId: "conv-1", sessionId: "session-1", title: "exec" },
    ]);
    expect(sent[0]).toEqual({
      type: "acp",
      message: {
        jsonrpc: "2.0",
        id: 77,
        result: { outcome: { outcome: "selected", optionId: "allow_once" } },
      },
    });
  });

  it("answers arbitrary ACP permission options by selected optionId", () => {
    const requests: PermissionRequest[] = [];
    const sent: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
      onPermissionRequest: (request) => requests.push(request),
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");

    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      id: "permission-1",
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { title: "read" },
        options: [
          { optionId: "inspect_only", kind: "inspect", name: "Inspect only" },
          {
            optionId: "allow_project",
            kind: "allow_project",
            name: "Allow project",
          },
        ],
      },
    });
    client.resolvePermission(requests[0], "inspect_only");

    expect(requests[0].options).toEqual([
      { optionId: "inspect_only", kind: "inspect", name: "Inspect only" },
      {
        optionId: "allow_project",
        kind: "allow_project",
        name: "Allow project",
      },
    ]);
    expect(sent[0]).toEqual({
      type: "acp",
      message: {
        jsonrpc: "2.0",
        id: "permission-1",
        result: { outcome: { outcome: "selected", optionId: "inspect_only" } },
      },
    });
  });

  it("cancels permission requests for unknown sessions instead of surfacing stale UI", () => {
    const requests: PermissionRequest[] = [];
    const sent: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
      onPermissionRequest: (request) => requests.push(request),
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };

    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      id: 55,
      method: "session/request_permission",
      params: {
        sessionId: "missing-session",
        toolCall: { title: "exec" },
        options: [
          { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
        ],
      },
    });

    expect(requests).toEqual([]);
    expect(sent[0]).toEqual({
      type: "acp",
      message: {
        jsonrpc: "2.0",
        id: 55,
        result: { outcome: { outcome: "cancelled" } },
      },
    });
  });

  it("fails the active turn when session/prompt is rejected", () => {
    const turns: Array<[string, string]> = [];
    const errors: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: (error) => errors.push(error),
      onTrace: () => undefined,
      onTurn: (conversationId, state) => turns.push([conversationId, state]),
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: () => undefined,
    };
    client.setActiveSession("conv-1", "session-1");

    client.sendPrompt("conv-1", "hello", []);
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "rejected" },
    });

    expect(turns).toEqual([
      ["conv-1", "started"],
      ["conv-1", "failed"],
    ]);
    expect(errors).toEqual([
      {
        code: "provider_rejected",
        kind: "provider_error",
        message: "rejected",
        conversationId: "conv-1",
      },
    ]);
  });
});

describe("ACP raw websocket compatibility", () => {
  it("sends raw JSON-RPC frames when configured with a raw /acp endpoint", () => {
    const sent: unknown[] = [];
    const traces: Array<[string, unknown]> = [];
    const client = new AcpClient(
      {
        onStatus: () => undefined,
        onReady: () => undefined,
        onMessage: () => undefined,
        onSession: () => undefined,
        onSessionList: () => undefined,
        onControlOptions: () => undefined,
        onError: () => undefined,
        onTrace: (direction, message) => traces.push([direction, message]),
      },
      { gatewayURL: "ws://127.0.0.1:18094/acp" },
    );
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");
    (client as unknown as { transportMode: "raw" | "app" }).transportMode =
      "raw";

    client.sendPrompt("conv-1", "hello raw", []);

    expect(sent[0]).toMatchObject({ jsonrpc: "2.0", method: "session/prompt" });
    expect(traces[0]).toEqual(["send", sent[0]]);
  });

  it("accepts raw JSON-RPC responses without gateway envelope wrapping", () => {
    const ready: unknown[] = [];
    const traces: Array<[string, unknown]> = [];
    const client = new AcpClient(
      {
        onStatus: () => undefined,
        onReady: (capabilities) => ready.push(capabilities),
        onMessage: () => undefined,
        onSession: () => undefined,
        onSessionList: () => undefined,
        onControlOptions: () => undefined,
        onError: () => undefined,
        onTrace: (direction, message) => traces.push([direction, message]),
      },
      { gatewayURL: "ws://127.0.0.1:18094/acp" },
    );
    (
      client as unknown as {
        requestContexts: Map<string, { type: "initialize" }>;
      }
    ).requestContexts.set("1", { type: "initialize" });

    (client as unknown as { handleEnvelope(raw: string): void }).handleEnvelope(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { agentCapabilities: { loadSession: true } },
      }),
    );

    expect(ready).toEqual([{ loadSession: true }]);
    expect(traces[0]).toEqual([
      "recv",
      {
        jsonrpc: "2.0",
        id: 1,
        result: { agentCapabilities: { loadSession: true } },
      },
    ]);
  });
});

describe("ACP attachment prompt blocks", () => {
  it("sends uploaded attachments as URI-only wrapper file resources", async () => {
    const sent: { type: string; message: { params: { prompt: unknown[] } } }[] =
      [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");

    client.sendPrompt("conv-1", "read this", [
      {
        name: "notes.md",
        type: "text/markdown",
        size: 12,
        uploaded: {
          fileId: "file_123",
          name: "notes.md",
          mimeType: "text/markdown",
          size: 12,
          downloadUrl: "/v1/files/file_123/content",
          relativePath: "docs/notes.md",
        },
      },
    ]);
    await Promise.resolve();

    expect(sent[0].message.params.prompt).toEqual([
      { type: "text", text: "read this" },
      {
        type: "resource",
        resource: {
          uri: "wrapper-file://file_123",
          mimeType: "text/markdown",
          name: "notes.md",
          size: 12,
          relativePath: "docs/notes.md",
        },
      },
    ]);
  });

  it("uploads browser files before sending wrapper file resources", async () => {
    const sent: { type: string; message: { params: { prompt: unknown[] } } }[] =
      [];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id: "file_png",
        filename: "image.png",
        content_type: "image/png",
        bytes: 4,
        download_url: "/v1/files/file_png/content",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new AcpClient(
      {
        onStatus: () => undefined,
        onReady: () => undefined,
        onMessage: () => undefined,
        onSession: () => undefined,
        onSessionList: () => undefined,
        onControlOptions: () => undefined,
        onError: () => undefined,
        onTrace: () => undefined,
      },
      { gatewayURL: "ws://127.0.0.1:18094/acp" },
    );
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");

    client.sendPrompt("conv-1", "", [
      {
        name: "image.png",
        type: "image/png",
        size: 4,
        file: new Blob(["data"], { type: "image/png" }),
        relativePath: "images/image.png",
      },
    ]);
    for (let index = 0; index < 5 && sent.length === 0; index += 1) {
      await Promise.resolve();
    }

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18094/v1/files",
      expect.objectContaining({
        method: "POST",
        headers: { "X-Tenant-ID": "tenant-live", "X-Project-ID": "project-live" },
      }),
    );
    expect(sent[0].message.params.prompt).toEqual([
      {
        type: "resource",
        resource: {
          uri: "wrapper-file://file_png",
          mimeType: "image/png",
          name: "image.png",
          size: 4,
          relativePath: "images/image.png",
        },
      },
    ]);
    vi.unstubAllGlobals();
  });

  it("rejects frontend-only text attachments instead of sending synthetic text blocks", () => {
    const sent: { type: string; message: { params: { prompt: unknown[] } } }[] =
      [];
    const errors: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: (error) => errors.push(error),
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");

    client.sendPrompt("conv-1", "", [
      { name: "notes.md", type: "text/markdown", size: 12, data: "# hi" },
    ]);

    expect(sent).toEqual([]);
    expect(errors).toMatchObject([
      { code: "unsupported", kind: "attachment_type_unavailable" },
    ]);
  });

  it("derives HTTP file endpoints from ACP websocket URLs", () => {
    expect(resolveAcpHTTPURL("/v1/files", "ws://127.0.0.1:18094/acp")).toBe(
      "http://127.0.0.1:18094/v1/files",
    );
  });
});

describe("ACP attachment and artifact session updates", () => {
  it("merges attachment and artifact updates into timeline attachment blocks", () => {
    const messages: ChatMessage[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });
    const handleUpdate = (update: Record<string, unknown>) => {
      (
        client as unknown as {
          handleUpdate(
            conversationId: string,
            update: Record<string, unknown>,
          ): void;
        }
      ).handleUpdate("conv-1", update);
    };

    handleUpdate({
      sessionUpdate: "attachment",
      messageId: "user-1",
      blockId: "attachments-1",
      kind: "input",
      attachments: [
        {
          id: "file_1",
          name: "TODO.md",
          mimeType: "text/markdown",
          size: 12,
          url: "/v1/files/file_1/content",
          workspacePath: "./inputs/TODO.md",
        },
      ],
    });
    handleUpdate({
      sessionUpdate: "artifact",
      messageId: "assistant-1",
      blockId: "artifacts-1",
      kind: "artifact",
      attachments: [
        {
          id: "file_2",
          name: "report.txt",
          mimeType: "text/plain",
          size: 20,
          url: "/v1/files/file_2/content",
        },
      ],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "user",
      timelineBlocks: [
        {
          id: "attachments-1",
          type: "attachments",
          attachments: [
            {
              id: "file_1",
              name: "TODO.md",
              type: "text/markdown",
              downloadUrl: "/v1/files/file_1/content",
              relativePath: "./inputs/TODO.md",
            },
          ],
        },
      ],
    });
    expect(messages[1]).toMatchObject({
      role: "agent",
      timelineBlocks: [
        {
          id: "artifacts-1",
          type: "attachments",
          attachments: [
            {
              id: "file_2",
              name: "report.txt",
              type: "text/plain",
              downloadUrl: "/v1/files/file_2/content",
            },
          ],
        },
      ],
    });

    const merged = mergeChatMessage(messages[1], {
      ...messages[1],
      timelineBlocks: [
        {
          id: "artifacts-1",
          type: "attachments",
          attachments: [
            {
              id: "file_2",
              name: "report-renamed.txt",
              type: "text/plain",
              size: 20,
            },
          ],
        },
      ],
    });
    expect(merged.timelineBlocks?.[0]).toMatchObject({
      type: "attachments",
      attachments: [{ id: "file_2", name: "report-renamed.txt" }],
    });
  });
});


describe("ACP session lifecycle controls", () => {
  it("sends session/close and clears only the live binding on success", () => {
    const sent: unknown[] = [];
    const closed: Array<[string, string]> = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
      onSessionClosed: (conversationId, sessionId) =>
        closed.push([conversationId, sessionId]),
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");

    expect(client.closeSession("conv-1")).toBe(true);
    expect(sent[0]).toMatchObject({
      type: "acp",
      message: {
        jsonrpc: "2.0",
        method: "session/close",
        params: { sessionId: "session-1" },
      },
    });

    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });

    expect(closed).toEqual([["conv-1", "session-1"]]);
    expect(client.hasActiveSession("conv-1")).toBe(false);
    expect(
      (
        client as unknown as { sessions: Map<string, string> }
      ).sessions.get("conv-1"),
    ).toBe("session-1");
  });

  it("settles stale streaming state on close failure without restoring it", () => {
    const messages: ChatMessage[] = [];
    const errors: unknown[] = [];
    const sent: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: (error) => errors.push(error),
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");
    (
      client as unknown as {
        handleUpdate(
          conversationId: string,
          update: Record<string, unknown>,
        ): void;
      }
    ).handleUpdate("conv-1", {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-a",
      content: { type: "text", text: "answer" },
    });

    expect(client.closeSession("conv-1")).toBe(true);
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      id: 1,
      error: { message: "close failed" },
    });

    expect(messages.map((message) => message.streaming)).toEqual([
      true,
      false,
    ]);
    expect(errors).toHaveLength(1);
    expect(
      (
        client as unknown as { activeStreamingMessageIds: Map<string, string> }
      ).activeStreamingMessageIds.has("conv-1"),
    ).toBe(false);
  });

  it("surfaces CloudAgent turn status failures and settles the active turn", () => {
    const messages: ChatMessage[] = [];
    const errors: unknown[] = [];
    const turns: Array<[string, string]> = [];
    const sent: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: (error) => errors.push(error),
      onTrace: () => undefined,
      onTurn: (conversationId, state) => turns.push([conversationId, state]),
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");

    client.sendPrompt("conv-1", "convert timestamp", [], { optimistic: false });
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: "message-a",
          content: { text: "thinking" },
        },
      },
    });
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
	      method: "_cloudagent.turn.status",
	      params: {
	        session_id: "session-1",
	        status: "failed",
	        message_id: "message-a",
	        error: {
          code: "provider_error",
          message: "Sandbox instance quota exceeded",
        },
      },
    });

    expect(messages.map((message) => message.streaming)).toEqual([
      true,
      false,
    ]);
    expect(errors).toEqual([
      expect.objectContaining({
        code: "provider_error",
        kind: "provider_error",
        message: "Sandbox instance quota exceeded",
        conversationId: "conv-1",
      }),
    ]);
    expect(turns).toEqual([
      ["conv-1", "started"],
      ["conv-1", "failed"],
    ]);
  });

  it("ignores non-standard ACP session error updates", () => {
    const errors: unknown[] = [];
    const turns: Array<[string, string]> = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: (error) => errors.push(error),
      onTrace: () => undefined,
      onTurn: (conversationId, state) => turns.push([conversationId, state]),
    });
    client.setActiveSession("conv-1", "session-1");

    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "error",
          messageId: "message-a",
          error: {
            code: "provider_error",
            message: "old stream error",
          },
        },
      },
    });

    expect(errors).toEqual([]);
    expect(turns).toEqual([]);
  });

  it("sends session/delete and removes the full binding on success", () => {
    const sent: unknown[] = [];
    const deleted: Array<[string, string]> = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: () => undefined,
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
      onSessionDeleted: (conversationId, sessionId) =>
        deleted.push([conversationId, sessionId]),
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");

    expect(client.deleteSession("conv-1")).toBe(true);
    expect(sent[0]).toMatchObject({
      type: "acp",
      message: {
        jsonrpc: "2.0",
        method: "session/delete",
        params: { sessionId: "session-1" },
      },
    });

    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });

    expect(deleted).toEqual([["conv-1", "session-1"]]);
    expect(client.hasActiveSession("conv-1")).toBe(false);
    expect(
      (
        client as unknown as { sessions: Map<string, string> }
      ).sessions.has("conv-1"),
    ).toBe(false);
  });

  it("settles stale streaming state on delete failure without restoring it", () => {
    const messages: ChatMessage[] = [];
    const errors: unknown[] = [];
    const sent: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: (error) => errors.push(error),
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");
    (
      client as unknown as {
        handleUpdate(
          conversationId: string,
          update: Record<string, unknown>,
        ): void;
      }
    ).handleUpdate("conv-1", {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-a",
      content: { type: "text", text: "answer" },
    });

    expect(client.deleteSession("conv-1")).toBe(true);
    (
      client as unknown as { handleAcp(message: Record<string, unknown>): void }
    ).handleAcp({
      jsonrpc: "2.0",
      id: 1,
      error: { message: "delete failed" },
    });

    expect(messages.map((message) => message.streaming)).toEqual([
      true,
      false,
    ]);
    expect(errors).toHaveLength(1);
    expect(
      (
        client as unknown as { activeStreamingMessageIds: Map<string, string> }
      ).activeStreamingMessageIds.has("conv-1"),
    ).toBe(false);
  });

  it("does not reuse turn-local wire ids across completed prompts", () => {
    const messages: ChatMessage[] = [];
    const sent: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");
    const handleUpdate = (update: Record<string, unknown>) => {
      (
        client as unknown as {
          handleUpdate(
            conversationId: string,
            update: Record<string, unknown>,
          ): void;
        }
      ).handleUpdate("conv-1", update);
    };
    const completePrompt = (id: number) => {
      (
        client as unknown as { handleAcp(message: Record<string, unknown>): void }
      ).handleAcp({ jsonrpc: "2.0", id, result: {} });
    };

    client.sendPrompt("conv-1", "first", [], { optimistic: false });
    handleUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "message-a",
      content: { type: "text", text: "first answer" },
    });
    completePrompt(1);
    client.sendPrompt("conv-1", "second", [], { optimistic: false });
    handleUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "message-a",
      content: { type: "text", text: "second answer" },
    });

    const contentMessages = messages.filter((message) => message.content);
    expect(contentMessages).toHaveLength(2);
    expect(contentMessages[0].id).not.toBe(contentMessages[1].id);
    expect(contentMessages.map((message) => message.content)).toEqual([
      "first answer",
      "second answer",
    ]);
  });

  it("does not reuse turn-local tool ids across completed prompts", () => {
    const messages: ChatMessage[] = [];
    const sent: unknown[] = [];
    const client = new AcpClient({
      onStatus: () => undefined,
      onReady: () => undefined,
      onMessage: (message) => messages.push(message),
      onSession: () => undefined,
      onSessionList: () => undefined,
      onControlOptions: () => undefined,
      onError: () => undefined,
      onTrace: () => undefined,
    });
    (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = {
      OPEN: 1,
    };
    (
      client as unknown as {
        ws: { readyState: number; send(message: string): void };
      }
    ).ws = {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    client.setActiveSession("conv-1", "session-1");
    const handleUpdate = (update: Record<string, unknown>) => {
      (
        client as unknown as {
          handleUpdate(
            conversationId: string,
            update: Record<string, unknown>,
          ): void;
        }
      ).handleUpdate("conv-1", update);
    };
    const completePrompt = (id: number) => {
      (
        client as unknown as { handleAcp(message: Record<string, unknown>): void }
      ).handleAcp({ jsonrpc: "2.0", id, result: {} });
    };

    client.sendPrompt("conv-1", "first", [], { optimistic: false });
    handleUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "search",
    });
    completePrompt(1);
    client.sendPrompt("conv-1", "second", [], { optimistic: false });
    handleUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "search",
    });

    const toolMessages = messages.filter((message) => message.toolCalls?.length);
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0].id).not.toBe(toolMessages[1].id);
  });
});
