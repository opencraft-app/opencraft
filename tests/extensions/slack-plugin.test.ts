import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SlackPlugin } from "../../plugins/slack/src/server";
import type { ImMessage } from "../../plugins/im/src/server";
test("Socket Mode ACK precedes admission; workspace, sender, thread and original reply are retained", async () => {
  class Socket extends EventEmitter {
    frames: any[] = [];
    send(text: string, cb?: () => void) {
      this.frames.push(JSON.parse(text));
      cb?.();
    }
    terminate() {
      this.emit("close");
    }
    close() {
      this.emit("close");
    }
  }
  const socket = new Socket(),
    messages: ImMessage[] = [],
    calls: any[] = [];
  const plugin = new SlackPlugin(
    {
      botToken: "fixture-bot",
      appToken: "fixture-app",
      workspaceId: "T1",
      botUserId: "BOT",
      receive: async (m) => {
        assert.ok(socket.frames.length);
        messages.push(m);
      },
    },
    async (token, method, body) => {
      calls.push({ token, method, body });
      return { ok: true, url: "wss://fixture.invalid" };
    },
    () => socket as any,
  );
  plugin.start();
  await new Promise((r) => setImmediate(r));
  socket.emit("open");
  const send = (team = "T1", event: any = {}) =>
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "events_api",
          envelope_id: "envelope",
          payload: {
            team_id: team,
            event_id: "Ev1",
            event: {
              type: "app_mention",
              channel: "C1",
              user: "U1",
              ts: "1.0",
              thread_ts: "0.0",
              text: "<@BOT> hello",
              ...event,
            },
          },
        }),
      ),
    );
  send("foreign");
  send("T1", { bot_id: "B1" });
  send();
  await new Promise((r) => setImmediate(r));
  assert.equal(socket.frames.length, 3);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].source, {
    chatId: "C1",
    chatType: "group",
    senderId: "U1",
    threadId: "0.0",
  });
  assert.equal(messages[0].text, "hello");
  await messages[0].reply("answer");
  assert.deepEqual(calls.at(-1), {
    token: "fixture-bot",
    method: "chat.postMessage",
    body: {
      channel: "C1",
      text: "answer",
      thread_ts: "0.0",
      reply_broadcast: false,
      unfurl_links: false,
      unfurl_media: false,
    },
  });
  plugin.close();
  await assert.rejects(messages[0].reply("late"));
});
