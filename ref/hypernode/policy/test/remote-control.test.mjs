import assert from "node:assert/strict";
import test from "node:test";

globalThis.hypernodeConfig = {};
const { RemoteControlChannel, RemoteEnvelopeCodec } = await import("../src/services/remote-control.js");

function bytes(text) {
  return [...Buffer.from(text, "utf8")];
}

test("reassembles UTF-8 client chunks without corrupting boundaries", () => {
  const codec = new RemoteEnvelopeCodec();
  const message = { id: 0, method: "turn/start", params: { input: "跨块汉字🙂" } };
  const raw = Buffer.from(JSON.stringify(message), "utf8");
  const chunks = [raw.subarray(0, 7), raw.subarray(7, 19), raw.subarray(19)];
  let result;
  chunks.forEach((chunk, segmentId) => {
    result = codec.observe({
      type: "client_message_chunk",
      client_id: "client-1",
      stream_id: "stream-1",
      seq_id: 7,
      segment_id: segmentId,
      segment_count: chunks.length,
      message_size_bytes: raw.length,
      message_chunk_base64: chunk.toString("base64"),
    });
  });
  assert.equal(result.type, "complete");
  assert.deepEqual(result.envelope.message, message);
});

test("drops out-of-order chunks and requires a fresh segment zero", () => {
  const codec = new RemoteEnvelopeCodec();
  const base = {
    type: "client_message_chunk",
    client_id: "client-1",
    stream_id: "stream-1",
    seq_id: 8,
    segment_count: 2,
    message_size_bytes: 2,
    message_chunk_base64: Buffer.from("x").toString("base64"),
  };
  assert.equal(codec.observe({ ...base, segment_id: 1 }).type, "dropped");
  assert.equal(codec.observe({ ...base, segment_id: 0 }).type, "pending");
  assert.equal(codec.observe({ ...base, segment_id: 0 }).type, "pending");
});

test("splits oversized server messages into bounded wire envelopes", () => {
  const codec = new RemoteEnvelopeCodec();
  const message = { method: "item/agentMessage/delta", params: { delta: "汉".repeat(80_000) } };
  const pieces = codec.splitServerMessage({
    type: "server_message",
    client_id: "client-1",
    stream_id: "stream-1",
    seq_id: 9,
    message,
  });
  assert.ok(pieces.length > 1);
  assert.ok(pieces.every((piece) => Buffer.byteLength(JSON.stringify(piece), "utf8") <= 150 * 1024));
  const reassembled = Buffer.concat(pieces.map((piece) => Buffer.from(piece.message_chunk_base64, "base64")));
  assert.deepEqual(JSON.parse(reassembled.toString("utf8")), message);
});

test("keeps an ordinary response, including request id zero, unsegmented", () => {
  const codec = new RemoteEnvelopeCodec();
  const envelope = {
    type: "server_message",
    client_id: "client-1",
    stream_id: "stream-1",
    seq_id: 1,
    message: { id: 0, result: { ok: true } },
  };
  assert.deepEqual(codec.splitServerMessage(envelope), [envelope]);
  assert.deepEqual(bytes("🙂"), [240, 159, 153, 130]);
});

test("parks a failed bootstrap until remote control is explicitly enabled again", () => {
  const channel = new RemoteControlChannel({ appServer: { connections: [] } }, {
    id: "user:alice", username: "alice", installationId: "installation-alice",
  });
  let attempts = 0;
  channel.prepareEnrollment = () => {
    attempts += 1;
    if (attempts === 1) throw new Error("expired enrollment");
    return {};
  };
  channel.connect = () => {};

  channel.enable(true);
  assert.equal(channel.lastErrorKind, "connectionFailed");
  assert.equal(channel.nextReconnectAt, Number.POSITIVE_INFINITY);

  channel.enabledPreference = true;
  channel.bootstrapped = true;
  channel.tick();
  assert.equal(attempts, 1);

  channel.enable(true);
  assert.equal(attempts, 2);
  assert.equal(channel.statusValue, "connecting");
  assert.equal(channel.lastErrorKind, null);
});

test("remote pairing RPC is composed in JavaScript over the injected HTTP client", () => {
  const requests = [];
  const response = JSON.stringify({
    server_id: "server-1",
    environment_id: "environment-1",
    pairing_code: "pair-1",
    manual_pairing_code: "MANUAL",
    expires_at: "2099-01-01T00:00:00Z",
  });
  const ctx = {
    appServer: { connections: [] },
    httpClient: {
      open: (id, options) => requests.push({ id, options }),
      drain: () => ({
        status: 200,
        headers: {},
        dataBytes: [...Buffer.from(response)],
        closed: true,
        error: null,
      }),
      close: () => {},
    },
  };
  const channel = new RemoteControlChannel(ctx, {
    id: "user:alice", username: "alice", installationId: "installation-alice",
  });
  channel.enrollment = {
    serverId: "server-1", environmentId: "environment-1", token: "token-1",
  };
  channel.statusValue = "connected";

  const task = channel.startPairing({ manualCode: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, "POST");
  assert.match(requests[0].options.url, /\/wham\/remote\/control\/server\/pair$/);
  assert.deepEqual(JSON.parse(requests[0].options.body), { manual_code: true });
  assert.deepEqual(task.poll(), {
    pairingCode: "pair-1",
    manualPairingCode: "MANUAL",
    environmentId: "environment-1",
    expiresAt: 4070908800,
  });
});
