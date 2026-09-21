import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const host = process.argv[2] ?? "127.0.0.1";
const port = process.argv[3] ?? "9988";
const username = process.argv[4] ?? "skipzhang";
const iterations = Number(process.argv[5] ?? 10);
const sentinel = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
const command = String.raw`sh -c 'CODEX_REMOTE_PAYLOAD="$1"; printf "\001\002\003\004\005\006\007\010"; codex app-server proxy' sh x`;

const ssh = spawn("ssh", [
  "-T", "-p", port,
  "-o", "BatchMode=yes",
  "-o", "PreferredAuthentications=none",
  "-o", "StrictHostKeyChecking=no",
  "-o", "UserKnownHostsFile=/dev/null",
  `${username}@${host}`,
  command,
], { stdio: ["pipe", "pipe", "pipe"] });

let incoming = Buffer.alloc(0);
let stderr = "";
let upgraded = false;
const pending = new Map();
let stage = "ssh-handshake";

ssh.stderr.on("data", (chunk) => { stderr += chunk; });
ssh.stdout.on("data", (chunk) => {
  incoming = Buffer.concat([incoming, chunk]);
  if (upgraded) drainFrames();
});

function waitFor(predicate, timeoutMs = 10_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (ssh.exitCode != null) return reject(new Error(`ssh exited ${ssh.exitCode} during ${stage}: ${stderr}`));
      if (Date.now() - started >= timeoutMs) return reject(new Error(`benchmark timed out during ${stage}: ${stderr}`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function maskFrame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const mask = randomBytes(4);
  let prefix;
  if (payload.length < 126) prefix = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length <= 0xffff) prefix = Buffer.from([0x81, 0xfe, payload.length >>> 8, payload.length & 0xff]);
  else throw new Error("benchmark request frame is too large");
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([prefix, mask, masked]);
}

function drainFrames() {
  while (incoming.length >= 2) {
    let length = incoming[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (incoming.length < 4) return;
      length = incoming.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (incoming.length < 10) return;
      if (incoming.readUInt32BE(2) !== 0) throw new Error("benchmark response frame is too large");
      length = incoming.readUInt32BE(6);
      offset = 10;
    }
    if (incoming.length < offset + length) return;
    const payload = incoming.subarray(offset, offset + length);
    incoming = incoming.subarray(offset + length);
    if ((payload[0] ?? 0) === 0 && length === 0) continue;
    const message = JSON.parse(payload.toString("utf8"));
    const waiter = pending.get(String(message.id));
    if (waiter) {
      pending.delete(String(message.id));
      waiter({ message, bytes: length, elapsedMs: performance.now() - waiter.startedAt });
    }
  }
}

function request(id, method, params = {}) {
  return new Promise((resolve) => {
    resolve.startedAt = performance.now();
    pending.set(String(id), resolve);
    ssh.stdin.write(maskFrame({ id, method, params }));
  });
}

try {
  stage = "remote-sentinel";
  await waitFor(() => incoming.length >= sentinel.length);
  if (!incoming.subarray(0, sentinel.length).equals(sentinel)) throw new Error("missing remote sentinel");
  incoming = incoming.subarray(sentinel.length);
  ssh.stdin.write(
    "GET /rpc HTTP/1.1\r\n" +
    "Host: hypernode\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Version: 13\r\n" +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );
  stage = "websocket-upgrade";
  await waitFor(() => incoming.indexOf("\r\n\r\n") >= 0);
  incoming = incoming.subarray(incoming.indexOf("\r\n\r\n") + 4);
  upgraded = true;
  drainFrames();

  stage = "initialize";
  await request("initialize", "initialize", { clientInfo: { name: "hypernode-benchmark", version: "1" } });
  ssh.stdin.write(maskFrame({ method: "initialized", params: {} }));
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    stage = `thread/list ${index + 1}/${iterations}`;
    samples.push(await request(`list-${index}`, "thread/list", { limit: 20 }));
  }
  const latencies = samples.map((sample) => sample.elapsedMs).sort((left, right) => left - right);
  console.log(JSON.stringify({
    host, port: Number(port), username,
    responseBytes: samples.map((sample) => sample.bytes),
    minMs: latencies[0],
    medianMs: latencies[Math.floor(latencies.length / 2)],
    p95Ms: latencies[Math.floor(latencies.length * 0.95)],
    maxMs: latencies.at(-1),
  }, null, 2));
} finally {
  ssh.stdin.end();
  setTimeout(() => ssh.kill("SIGKILL"), 1_000).unref();
}
