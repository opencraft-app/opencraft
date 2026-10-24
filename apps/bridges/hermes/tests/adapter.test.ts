import { describe, expect, test } from "bun:test";
import { HermesAppServerAdapter, mapMessages } from "../src/adapter";

describe("Hermes to AppServer mapping", () => {
  test("groups transcript messages into turns", () => {
    const turns = mapMessages("s-1", [
      { role: "user", content: "hello", row_id: 1 },
      { role: "assistant", content: "world", row_id: 2 },
      { role: "user", content: [{ type: "text", text: "again" }], row_id: 3 },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.items.map((item) => item.type)).toEqual(["userMessage", "agentMessage"]);
  });

  test("marks the newest turn active while Hermes is running", () => {
    expect(mapMessages("s-1", [{ role: "user", content: "hello" }], true)[0]?.status).toBe("inProgress");
  });

  test("keeps attachment-only history turns and lifts Hermes image directives", () => {
    const turns = mapMessages("s-1", [{ role: "user", content: "@image:`/tmp/a b.png`", row_id: 4 }]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.items[0]).toMatchObject({
      type: "userMessage",
      content: [{ type: "localImage", path: "/tmp/a b.png" }],
    });
  });

  test("projects native Hermes vision history without duplicating its persisted image ref", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const turns = mapMessages("s-1", [{
      role: "user",
      content: [
        { type: "text", text: "@image:/tmp/a.png\ncaption\n[screenshot]" },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
      row_id: 5,
    }]);
    expect(turns[0]?.items[0]).toMatchObject({
      type: "userMessage",
      content: [
        { type: "text", text: "caption" },
        { type: "image", url: dataUrl },
      ],
    });
  });
});

describe("AppServer queue projection", () => {
  test("supports add, list, update, reorder and delete with stable ids", () => {
    const gateway = { onEvent: () => () => undefined };
    const adapter = new HermesAppServerAdapter(gateway as never, "/tmp");
    const first = adapter.addQueuedSubmission("thread-1", [{ type: "text", text: "first" }], "client-1");
    const second = adapter.addQueuedSubmission("thread-1", [{ type: "text", text: "second" }], "client-2");
    expect(adapter.listQueuedSubmissions("thread-1", null, 100).data.map((item) => item.id)).toEqual([first.id, second.id]);

    const updated = adapter.updateQueuedSubmission("thread-1", first.id, [{ type: "text", text: "updated" }]);
    expect(updated.input).toEqual([{ type: "text", text: "updated" }]);
    adapter.reorderQueuedSubmissions("thread-1", [second.id, first.id]);
    expect(adapter.listQueuedSubmissions("thread-1", null, 100).data.map((item) => item.id)).toEqual([second.id, first.id]);
    expect(adapter.deleteQueuedSubmission("thread-1", second.id)).toBe(true);
    expect(adapter.deleteQueuedSubmission("thread-1", "missing")).toBe(false);
  });
});

describe("Hermes image submission", () => {
  test("stages image bytes before prompt.submit and preserves optimistic image content", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const gateway = {
      onEvent: () => () => undefined,
      async call(method: string, params: Record<string, unknown>) {
        calls.push({ method, params });
        if (method === "session.create") return { session_id: "live-1", stored_session_id: "stored-1", message_count: 0, messages: [] };
        if (method === "image.attach_bytes") return { attached: true, path: "/tmp/upload.png" };
        if (method === "prompt.submit") return { status: "streaming" };
        throw new Error(`unexpected ${method}`);
      },
    };
    const adapter = new HermesAppServerAdapter(gateway as never, "/tmp");
    const thread = await adapter.startThread();
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const turn = await adapter.startTurn(thread.id, [
      { type: "text", text: "inspect this" },
      { type: "image", url: dataUrl },
    ]);
    expect(calls.slice(1).map((call) => call.method)).toEqual(["image.attach_bytes", "prompt.submit"]);
    expect(calls[1]?.params).toMatchObject({
      session_id: "live-1",
      content_base64: "iVBORw0KGgo=",
      filename: "image-2.png",
    });
    expect(calls[2]?.params).toEqual({ session_id: "live-1", text: "inspect this" });
    expect(turn.items[0]).toMatchObject({
      type: "userMessage",
      content: [{ type: "text", text: "inspect this" }, { type: "image", url: dataUrl }],
    });
  });

  test("allows an image-only turn and rolls staged images back when submit fails", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const gateway = {
      onEvent: () => () => undefined,
      async call(method: string, params: Record<string, unknown>) {
        calls.push({ method, params });
        if (method === "session.create") return { session_id: "live-1", stored_session_id: "stored-1", message_count: 0, messages: [] };
        if (method === "image.attach_bytes") return { attached: true, path: "/tmp/upload.png" };
        if (method === "image.detach") return { detached: true };
        if (method === "prompt.submit") throw new Error("submit failed");
        throw new Error(`unexpected ${method}`);
      },
    };
    const adapter = new HermesAppServerAdapter(gateway as never, "/tmp");
    const thread = await adapter.startThread();
    await expect(adapter.startTurn(thread.id, [{ type: "image", url: "data:image/png;base64,iVBORw0KGgo=" }])).rejects.toThrow("submit failed");
    expect(calls.map((call) => call.method)).toEqual(["session.create", "image.attach_bytes", "prompt.submit", "image.detach"]);
    expect(calls.at(-1)?.params).toEqual({ session_id: "live-1", path: "/tmp/upload.png" });
  });
});
