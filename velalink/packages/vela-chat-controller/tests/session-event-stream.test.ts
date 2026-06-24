import assert from "node:assert/strict";
import test from "node:test";

import type {
  VeladClient,
  VelaEventStreamHandlers,
  VelaEventStreamTransport,
} from "../../vela-chat-client/src";
import { subscribeRecoveringSessionEventStream } from "../src/sessionEventStream";

async function flushMicrotasks(times = 5) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

test("recovering session event stream reconnects with the latest after_id", async () => {
  const urls: string[] = [];
  const handlers: VelaEventStreamHandlers[] = [];
  let afterId: string | null = null;
  const client = {
    sessionEventStreamUrl(sessionId: string, requestedAfterId?: string | null) {
      const url = new URL(`http://127.0.0.1:3857/api/v1/sessions/${sessionId}/events/stream`);
      if (requestedAfterId) url.searchParams.set("after_id", requestedAfterId);
      return url;
    },
  } as unknown as VeladClient;
  const transport: VelaEventStreamTransport = {
    subscribe(url, nextHandlers) {
      urls.push(url.toString());
      handlers.push(nextHandlers);
      return { close() {} };
    },
  };

  const subscription = subscribeRecoveringSessionEventStream({
    client,
    eventStreamTransport: transport,
    getAfterId: () => afterId,
    onConnectedChange: () => {},
    onEvent: () => {},
    sessionId: "sess_1",
  });

  afterId = "evt_2";
  handlers[0]?.onError?.(new Error("TAT proxy websocket closed"));
  await flushMicrotasks();

  assert.deepEqual(urls, [
    "http://127.0.0.1:3857/api/v1/sessions/sess_1/events/stream",
    "http://127.0.0.1:3857/api/v1/sessions/sess_1/events/stream?after_id=evt_2",
  ]);

  subscription.close();
});
