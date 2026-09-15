import assert from "node:assert/strict";
import test from "node:test";

import { VSSHConnectionForTest } from "../src/services/vssh.js";

function connectionHarness() {
  const packets = [];
  const connection = Object.create(VSSHConnectionForTest.prototype);
  connection.sendPacket = (packet) => packets.push(Uint8Array.from(packet));
  connection.service = {
    audit() {},
    ctx: { portForward: { close() {} } },
  };
  connection.metadata = { connectionId: "test" };
  return { connection, packets };
}

test("session close waits for output larger than the SSH receive window", () => {
  const { connection, packets } = connectionHarness();
  const channel = {
    localId: 1,
    remoteId: 7,
    remoteWindow: 2 * 1024 * 1024,
    remoteMaxPacket: 32 * 1024,
    pendingOutput: [],
    finishPending: null,
    closed: false,
  };
  const output = new Uint8Array(3 * 1024 * 1024);

  connection.sendChannelData(channel, output, false);
  connection.finishChannel(channel, 0);

  assert.equal(channel.closed, false);
  assert.deepEqual(channel.finishPending, { kind: "session", exitCode: 0 });
  assert.equal(channel.pendingOutput.length, 1);
  assert.equal(channel.pendingOutput[0].offset, 2 * 1024 * 1024);
  assert.equal(packets.some((packet) => packet[0] === 96 || packet[0] === 97), false);

  channel.remoteWindow += 1024 * 1024;
  connection.flushChannelData(channel);

  assert.equal(channel.pendingOutput.length, 0);
  assert.equal(channel.finishPending, null);
  assert.equal(channel.closed, true);
  assert.equal(packets.filter((packet) => packet[0] === 94).length, 96);
  assert.deepEqual(packets.slice(-3).map((packet) => packet[0]), [98, 96, 97]);
});

test("forward close also waits for its pending output", () => {
  const { connection, packets } = connectionHarness();
  const channel = {
    localId: 2,
    remoteId: 8,
    remoteWindow: 1,
    remoteMaxPacket: 32 * 1024,
    pendingOutput: [],
    finishPending: null,
    closed: false,
    forward: { hostname: "127.0.0.1", port: 80 },
    sessionId: "forward",
  };

  connection.sendChannelData(channel, Uint8Array.of(1, 2), false);
  connection.finishForwardChannel(channel, null);
  assert.equal(channel.closed, false);
  assert.equal(channel.pendingOutput[0].offset, 1);

  channel.remoteWindow += 1;
  connection.flushChannelData(channel);
  assert.equal(channel.closed, true);
  assert.deepEqual(packets.slice(-2).map((packet) => packet[0]), [96, 97]);
});
