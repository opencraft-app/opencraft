import assert from "node:assert/strict";
import test from "node:test";

import { CodeReviewBotService } from "../src/services/code-review-bot.ts";
import { WeComBotService, weComMessageContent } from "../src/services/wecom-bot.ts";

test("extracts review text from WeCom text, voice and mixed callbacks", () => {
  assert.equal(weComMessageContent({ msgtype: "text", text: { content: " diff " } }), "diff");
  assert.equal(weComMessageContent({ msgtype: "voice", voice: { content: "审查一下" } }), "审查一下");
  assert.equal(weComMessageContent({
    msgtype: "mixed",
    mixed: { msg_item: [
      { msgtype: "text", text: { content: "first" } },
      { msgtype: "image", image: { url: "ignored" } },
      { msgtype: "text", text: { content: "second" } },
    ] },
  }), "first\nsecond");
});

test("serializes streaming replies for the same WeCom callback until each ACK", () => {
  const previous = globalThis.hostNetwork;
  const sent = [];
  globalThis.hostNetwork = {
    sendWebSocket: (_socketId, value) => sent.push(JSON.parse(value)),
  };
  try {
    const service = Object.create(WeComBotService.prototype);
    const runtime = {
      config: { key: "code-review", enabled: true },
      socketId: "socket-1",
      phase: "ready",
      lastError: null,
      replyQueues: new Map(),
      replySentAtMs: new Map(),
      outboundSends: new Map(),
    };
    service.runtimes = new Map([["code-review", runtime]]);
    const message = { botKey: "code-review", requestId: "callback-1" };

    assert.equal(service.replyStream(message, "stream-1", "working", false), true);
    assert.equal(service.replyStream(message, "stream-1", "complete", true), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.stream.content, "working");

    service.receive(runtime, { headers: { req_id: "callback-1" }, errcode: 0 }, 200);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].body.stream.content, "complete");
    assert.equal(sent[1].body.stream.finish, true);
  } finally {
    globalThis.hostNetwork = previous;
  }
});

test("sends an independent WeCom message and settles only after its ACK", () => {
  const previous = globalThis.hostNetwork;
  const sent = [];
  globalThis.hostNetwork = {
    sendWebSocket: (_socketId, value) => sent.push(JSON.parse(value)),
  };
  try {
    const service = Object.create(WeComBotService.prototype);
    const runtime = {
      config: { key: "code-review", enabled: true },
      socketId: "socket-1",
      phase: "ready",
      lastError: null,
      lastTargetId: "recent-user",
      replyQueues: new Map(),
      replySentAtMs: new Map(),
      outboundSends: new Map(),
    };
    service.runtimes = new Map([["code-review", runtime]]);

    const call = service.sendMarkdown("code-review", null, "**审查完成**");
    assert.equal(call.poll(), null);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].cmd, "aibot_send_msg");
    assert.equal(sent[0].body.chatid, "recent-user");
    assert.equal(sent[0].body.markdown.content, "**审查完成**");

    service.receive(runtime, { headers: sent[0].headers, errcode: 0 }, 250);
    assert.deepEqual(call.poll(), {
      requestId: sent[0].headers.req_id,
      chatId: "recent-user",
      deliveredAtMs: 250,
    });
  } finally {
    globalThis.hostNetwork = previous;
  }
});

test("exposes proactive WeCom sending as an MCP tool bound to the review thread", () => {
  const service = Object.create(WeComBotService.prototype);
  service.configuration = () => ({ threadId: "review-thread" });
  service.sendMarkdown = () => ({
    cancel() {},
    poll: () => ({ requestId: "send-1", chatId: "user-1", deliveredAtMs: 300 }),
  });
  const server = service.mcpServer();
  const tool = server.tools.find((candidate) => candidate.name === "send_message");
  assert.ok(tool);
  const pending = tool.call({ content: "done", chatId: "user-1" }, {
    connection: {}, server: server.name, threadId: "review-thread", tool: tool.name, meta: null,
  });
  assert.equal(pending.kind, "pending");
  assert.equal(pending.poll().structuredContent.delivered, true);
  assert.throws(() => tool.call({ content: "no" }, {
    connection: {}, server: server.name, threadId: "other-thread", tool: tool.name, meta: null,
  }), /only available/);
});

test("CodeReviewBot returns the completed agent message to the originating callback", () => {
  const replies = [];
  const service = Object.create(CodeReviewBotService.prototype);
  const review = {
    message: { botKey: "code-review", requestId: "req-1", messageId: "msg-1" },
    streamId: "stream-1",
    clientMessageId: "wecom:msg-1",
    turnId: "turn-1",
    text: "",
  };
  service.threadId = "thread-1";
  service.active = review;
  service.queue = [];
  service.lastError = null;
  service.ctx = {
    wecomBot: { replyStream: (...args) => replies.push(args) },
    storage: { sql: null },
  };

  service.receiveAppServer({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", delta: "partial" },
  });
  service.receiveAppServer({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", items: [{ type: "agentMessage", text: "final review" }] },
    },
  });

  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].slice(1), ["stream-1", "final review", true]);
  assert.equal(service.active, null);
});
