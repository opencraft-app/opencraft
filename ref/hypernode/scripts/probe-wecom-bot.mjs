import { randomBytes } from "node:crypto";
import { connect } from "node:net";

const port = Number(process.env.HYPERNODE_PROBE_PORT ?? 9988);
const host = process.env.HYPERNODE_PROBE_HOST ?? "127.0.0.1";
const username = process.env.HYPERNODE_PROBE_USER ?? "root";
const socket = connect({ host, port });
let incoming = Buffer.alloc(0);
socket.on("data", (chunk) => { incoming = Buffer.concat([incoming, chunk]); });

function waitFor(predicate, timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = predicate();
        if (value) return resolve(value);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started >= timeoutMs) return reject(new Error("WeCom bot probe timed out"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function maskedTextFrame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const mask = randomBytes(4);
  let prefix;
  if (payload.length < 126) prefix = Buffer.from([0x81, 0x80 | payload.length]);
  else prefix = Buffer.from([0x81, 0xfe, payload.length >>> 8, payload.length & 0xff]);
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
      if (incoming.length < 10 || incoming.readUInt32BE(2) !== 0) return;
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
    const id = `wecom-probe:${++sequence}`;
    socket.write(maskedTextFrame({ id, method, params }));
    return waitFor(() => {
      drainTextFrames(messages);
      return messages.find((message) => message.id === id);
    });
  };
  const initialized = await request("initialize", {
    clientInfo: { name: "hypernode-wecom-probe", version: "1" },
    capabilities: { experimentalApi: true, "hypernode.sync.v1": true },
  });
  if (initialized.error) throw new Error(initialized.error.message);
  socket.write(maskedTextFrame({ method: "initialized", params: {} }));

  const archiveThreadId = process.env.HYPERNODE_ARCHIVE_THREAD;
  if (archiveThreadId) {
    const archived = await request("thread/archive", { threadId: archiveThreadId });
    if (archived.error) throw new Error(archived.error.message);
  }

  // Give the host tick a chance to complete WebSocket authentication and the
  // internal CodeReviewBot thread bootstrap.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const transport = await request("hypernode/wecomBot/status");
  const reviewer = await request("hypernode/codeReviewBot/status");
  const inventory = await request("mcpServerStatus/list", { detail: "toolsAndAuthOnly" });
  if (transport.error) throw new Error(transport.error.message);
  if (reviewer.error) throw new Error(reviewer.error.message);
  if (inventory.error) throw new Error(inventory.error.message);
  const wecomMcp = inventory.result?.data?.find((server) => server.name === "hypernode-wecom") ?? null;
  console.log(JSON.stringify({ transport: transport.result, reviewer: reviewer.result, wecomMcp }, null, 2));
} finally {
  socket.end();
}
