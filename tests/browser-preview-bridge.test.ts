import assert from "node:assert/strict";
import test from "node:test";

import {
  PREVIEW_BRIDGE_PROTOCOL_VERSION,
  PREVIEW_BRIDGE_SOURCE,
  PreviewBridgeAdapter,
  type PreviewBridgeChildMessage,
  type PreviewBridgeParentMessage,
} from "@opencraft/browser-preview-bridge";

class FakeHostWindow {
  readonly listeners = new Set<(event: MessageEvent) => void>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type === "message" && typeof listener === "function") {
      this.listeners.add(listener as (event: MessageEvent) => void);
    }
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type === "message" && typeof listener === "function") {
      this.listeners.delete(listener as (event: MessageEvent) => void);
    }
  }

  emit(source: FakeFrameWindow, origin: string, data: PreviewBridgeChildMessage) {
    for (const listener of this.listeners) listener({ source, origin, data } as unknown as MessageEvent);
  }
}

class FakeFrameWindow {
  readonly sent: Array<{ readonly message: PreviewBridgeParentMessage; readonly targetOrigin: string }> = [];

  postMessage(message: PreviewBridgeParentMessage, targetOrigin: string) {
    this.sent.push({ message, targetOrigin });
  }
}

type ChildMessageBody =
  | Extract<PreviewBridgeChildMessage, { type: "preview:ready" }>
  | Extract<PreviewBridgeChildMessage, { type: "preview:call-result" }>;

function childMessage(
  parent: PreviewBridgeParentMessage,
  body: Omit<ChildMessageBody, "source" | "protocolVersion" | "previewId" | "generation" | "nonce">,
): PreviewBridgeChildMessage {
  return {
    source: PREVIEW_BRIDGE_SOURCE,
    protocolVersion: PREVIEW_BRIDGE_PROTOCOL_VERSION,
    previewId: parent.previewId,
    generation: parent.generation,
    nonce: parent.nonce,
    ...body,
  } as PreviewBridgeChildMessage;
}

const readyBody = {
  type: "preview:ready" as const,
  capabilities: {
    domInspection: true as const,
    semanticInput: true as const,
    trustedInput: false as const,
    networkObservation: "fetch-xhr" as const,
  },
};

test("PreviewBridgeAdapter handshakes with exact origin and returns typed inspect results", async () => {
  const host = new FakeHostWindow();
  const frame = new FakeFrameWindow();
  const adapter = new PreviewBridgeAdapter({
    hostWindow: host as unknown as Window,
    frameWindow: frame as unknown as Window,
    targetOrigin: "https://preview.example",
    previewId: "preview-1",
    generation: 7,
    nonce: "fixed-nonce",
    handshakeTimeoutMs: 100,
  });
  try {
    assert.equal(frame.sent.length, 1);
    assert.equal(frame.sent[0]?.targetOrigin, "https://preview.example");
    const connect = frame.sent[0]!.message;
    assert.equal(connect.type, "platform:connect");
    host.emit(frame, "https://preview.example", childMessage(connect, readyBody));

    const inspectionPromise = adapter.inspect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const call = frame.sent.at(-1)!.message;
    assert.equal(call.type, "platform:call");
    if (call.type !== "platform:call") throw new Error("missing call");
    host.emit(frame, "https://preview.example", childMessage(call, {
      type: "preview:call-result",
      callId: call.callId,
      ok: true,
      result: {
        url: "https://preview.example/",
        title: "Preview",
        revision: 3,
        elements: [{ ref: "e1", role: "button", name: "Save", disabled: false }],
      },
    }));
    assert.deepEqual(await inspectionPromise, {
      url: "https://preview.example/",
      title: "Preview",
      revision: 3,
      elements: [{ ref: "e1", role: "button", name: "Save", disabled: false }],
    });
  } finally {
    adapter.dispose();
  }
});

test("PreviewBridgeAdapter fences wrong origin and stale generations", async () => {
  const host = new FakeHostWindow();
  const frame = new FakeFrameWindow();
  const adapter = new PreviewBridgeAdapter({
    hostWindow: host as unknown as Window,
    frameWindow: frame as unknown as Window,
    targetOrigin: "https://preview.example",
    previewId: "preview-2",
    generation: 9,
    nonce: "fixed-nonce",
    handshakeTimeoutMs: 20,
  });
  const connect = frame.sent[0]!.message;
  host.emit(frame, "https://evil.example", childMessage(connect, readyBody));
  host.emit(frame, "https://preview.example", {
    ...childMessage(connect, readyBody),
    generation: 8,
  });
  await assert.rejects(
    adapter.inspect(),
    (error: unknown) => error instanceof Error && error.message.includes("did not install"),
  );
  adapter.dispose();
});

test("opaque proxy previews accept null origin while retaining source and nonce fences", async () => {
  const host = new FakeHostWindow();
  const frame = new FakeFrameWindow();
  const otherFrame = new FakeFrameWindow();
  const adapter = new PreviewBridgeAdapter({
    hostWindow: host as unknown as Window,
    frameWindow: frame as unknown as Window,
    targetOrigin: "*",
    previewId: "preview-opaque",
    generation: 1,
    nonce: "opaque-nonce",
    handshakeTimeoutMs: 100,
  });
  try {
    const connect = frame.sent[0]!.message;
    assert.equal(frame.sent[0]?.targetOrigin, "*");
    host.emit(otherFrame, "null", childMessage(connect, readyBody));
    host.emit(frame, "null", childMessage(connect, readyBody));
    const inspection = adapter.inspect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const call = frame.sent.at(-1)!.message;
    if (call.type !== "platform:call") throw new Error("missing call");
    host.emit(frame, "null", childMessage(call, {
      type: "preview:call-result",
      callId: call.callId,
      ok: true,
      result: { url: "http://127.0.0.1:4180/", title: "Preview", revision: 1, elements: [] },
    }));
    assert.equal((await inspection).title, "Preview");
  } finally {
    adapter.dispose();
  }
});

test("PreviewBridgeAdapter cancels timed-out calls and ignores late results", async () => {
  const host = new FakeHostWindow();
  const frame = new FakeFrameWindow();
  const adapter = new PreviewBridgeAdapter({
    hostWindow: host as unknown as Window,
    frameWindow: frame as unknown as Window,
    targetOrigin: "https://preview.example",
    previewId: "preview-3",
    generation: 1,
    nonce: "fixed-nonce",
    handshakeTimeoutMs: 100,
    callTimeoutMs: 10,
  });
  const connect = frame.sent[0]!.message;
  host.emit(frame, "https://preview.example", childMessage(connect, readyBody));
  await assert.rejects(
    adapter.click({ ref: "e1", expectedRevision: 0 }),
    (error: unknown) => error instanceof Error && error.message.includes("timed out"),
  );
  assert.equal(frame.sent.at(-1)?.message.type, "platform:cancel");
  adapter.dispose();
});
