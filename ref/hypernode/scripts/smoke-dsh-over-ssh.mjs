import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const host = process.argv[2] ?? "127.0.0.1";
const port = process.argv[3] ?? "9998";
const username = process.argv[4] ?? "dsh-smoke";
const model = process.argv[5] ?? "auto";
const resumeThreadId = process.env.HYPERNODE_DSH_SMOKE_THREAD_ID?.trim() || null;
const expectedText = process.env.HYPERNODE_DSH_SMOKE_EXPECTED?.trim()
  || "HYPERNODE_DSH_OVER_SSH_OK";
const prompt = process.env.HYPERNODE_DSH_SMOKE_PROMPT?.trim()
  || `Reply with exactly ${expectedText} and nothing else.`;
const requireTool = process.env.HYPERNODE_DSH_SMOKE_REQUIRE_TOOL === "1";
const archiveAfter = process.env.HYPERNODE_DSH_SMOKE_ARCHIVE === "1";
const sentinel = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
const command = String.raw`sh -c 'CODEX_REMOTE_PAYLOAD="$1"; printf "\001\002\003\004\005\006\007\010"; codex app-server proxy' sh x`;

const child = spawn("ssh", [
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
let stage = "ssh-handshake";
const pending = new Map();
const notifications = [];
const notificationSamples = [];

child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdout.on("data", (chunk) => {
  incoming = Buffer.concat([incoming, chunk]);
  if (upgraded) drainFrames();
});

function waitFor(predicate, timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (child.exitCode != null) {
        return reject(new Error(`ssh exited ${child.exitCode} during ${stage}: ${stderr}`));
      }
      if (Date.now() - started >= timeoutMs) {
        return reject(new Error(`timed out during ${stage}: ${stderr}`));
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function maskFrame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const mask = randomBytes(4);
  let prefix;
  if (payload.length < 126) prefix = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length <= 0xffff) {
    prefix = Buffer.from([0x81, 0xfe, payload.length >>> 8, payload.length & 0xff]);
  } else throw new Error("request frame is too large");
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
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
      if (incoming.readUInt32BE(2) !== 0) throw new Error("response frame is too large");
      length = incoming.readUInt32BE(6);
      offset = 10;
    }
    if (incoming.length < offset + length) return;
    const payload = incoming.subarray(offset, offset + length);
    incoming = incoming.subarray(offset + length);
    if (length === 0) continue;
    const message = JSON.parse(payload.toString("utf8"));
    if (message.id != null && pending.has(String(message.id))) {
      const resolve = pending.get(String(message.id));
      pending.delete(String(message.id));
      resolve(message);
    } else if (message.method) {
      notifications.push(message);
      notificationSamples.push({
        atMs: performance.now(),
        method: message.method,
        threadId: message.params?.threadId ?? null,
        turnId: message.params?.turnId ?? null,
        itemId: message.params?.itemId ?? null,
        deltaLength: message.method === "item/agentMessage/delta"
          ? Array.from(message.params?.delta ?? "").length
          : 0,
      });
    }
  }
}

function request(id, method, params = {}) {
  return new Promise((resolve) => {
    pending.set(String(id), resolve);
    child.stdin.write(maskFrame({ id, method, params }));
  });
}

try {
  stage = "remote-sentinel";
  await waitFor(() => incoming.length >= sentinel.length);
  if (!incoming.subarray(0, sentinel.length).equals(sentinel)) throw new Error("missing remote sentinel");
  incoming = incoming.subarray(sentinel.length);
  child.stdin.write(
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
  const initialized = await request("initialize", "initialize", {
    clientInfo: { name: "hypernode-dsh-smoke", title: "HyperNode DSH Smoke", version: "1" },
  });
  if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
  child.stdin.write(maskFrame({ method: "initialized", params: {} }));

  stage = "model/list";
  const models = await request("models", "model/list", { includeHidden: true, limit: 100 });
  if (!models.result?.data?.some((entry) => entry.id === model || entry.model === model)) {
    throw new Error(`model ${model} is absent: ${JSON.stringify(models.result?.data?.map((entry) => entry.id))}`);
  }

  stage = resumeThreadId ? "thread/resume" : "thread/start";
  const started = resumeThreadId
    ? await request("thread", "thread/resume", { threadId: resumeThreadId, cwd: "/workspace/projects" })
    : await request("thread", "thread/start", {
      cwd: "/workspace/projects",
      model,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
  if (started.error) throw new Error(`${stage} failed: ${JSON.stringify(started.error)}`);
  const threadId = started.result?.thread?.id;
  if (!threadId) throw new Error(`${stage} omitted thread id: ${JSON.stringify(started)}`);

  stage = "turn/start";
  const turn = await request("turn", "turn/start", {
    threadId,
    model,
    input: [{ type: "text", text: prompt }],
    clientUserMessageId: "dsh-over-ssh-smoke",
  });
  if (turn.error) throw new Error(`turn/start failed: ${JSON.stringify(turn.error)}`);
  const turnId = turn.result?.turn?.id;
  if (!turnId) throw new Error(`turn/start omitted turn id: ${JSON.stringify(turn)}`);

  stage = "turn/completed";
  const completed = await waitFor(() => notifications.find((message) => (
    message.method === "turn/completed" && message.params?.turn?.id === turnId
  )), 180_000);
  const methods = notifications
    .filter((message) => message.params?.threadId === threadId)
    .map((message) => message.method);
  for (const required of [
    "turn/started", "item/started", "item/completed", "item/agentMessage/delta", "turn/completed",
  ]) {
    if (!methods.includes(required)) throw new Error(`missing ${required}: ${JSON.stringify(methods)}`);
  }
  const completedItems = completed.params?.turn?.items ?? [];
  if (requireTool && !completedItems.some((item) => item.type === "commandExecution")) {
    throw new Error(`DSH response omitted commandExecution: ${JSON.stringify(completedItems)}`);
  }
  const text = completedItems
    ?.filter((item) => item.type === "agentMessage")
    .map((item) => item.text)
    .join("\n") ?? "";
  if (!text.includes(expectedText)) {
    throw new Error(`unexpected DSH response: ${JSON.stringify(completed.params?.turn)}`);
  }
  const deltaSamples = notificationSamples.filter((sample) => (
    sample.threadId === threadId
      && sample.turnId === turnId
      && sample.method === "item/agentMessage/delta"
  ));
  const deltaGapsMs = deltaSamples.slice(1).map((sample, index) => (
    Number((sample.atMs - deltaSamples[index].atMs).toFixed(3))
  ));
  const pacer = await request("pacer", "hypernode/textDeltaPacer/read", {});
  if (pacer.error) throw new Error(`text pacer diagnostics failed: ${JSON.stringify(pacer.error)}`);
  const serverTiming = pacer.result?.recentItems?.filter?.((item) => (
    item.threadId === threadId && item.turnId === turnId
  )) ?? [];
  const deltaTimingByItem = [...new Set(deltaSamples.map((sample) => sample.itemId))]
    .map((itemId) => {
      const samples = deltaSamples.filter((sample) => sample.itemId === itemId);
      const gapsMs = samples.slice(1).map((sample, index) => (
        Number((sample.atMs - samples[index].atMs).toFixed(3))
      ));
      return {
        itemId,
        frameCount: samples.length,
        graphemeCount: samples.reduce((sum, sample) => sum + sample.deltaLength, 0),
        minimumGapMs: gapsMs.length ? Math.min(...gapsMs) : null,
        maximumGapMs: gapsMs.length ? Math.max(...gapsMs) : null,
        averageGapMs: gapsMs.length
          ? Number((gapsMs.reduce((sum, gap) => sum + gap, 0) / gapsMs.length).toFixed(3))
          : null,
        deltaLengths: samples.map((sample) => sample.deltaLength),
        gapsMs,
      };
    });
  if (archiveAfter && !resumeThreadId) {
    const archived = await request("archive", "thread/archive", { threadId });
    if (archived.error) throw new Error(`thread/archive failed: ${JSON.stringify(archived.error)}`);
  }
  console.log(JSON.stringify({
    host,
    port: Number(port),
    username,
    model,
    threadId,
    turnId,
    methods,
    text,
    deltaTiming: {
      frameCount: deltaSamples.length,
      graphemeCount: deltaSamples.reduce((sum, sample) => sum + sample.deltaLength, 0),
      minimumGapMs: deltaGapsMs.length ? Math.min(...deltaGapsMs) : null,
      maximumGapMs: deltaGapsMs.length ? Math.max(...deltaGapsMs) : null,
      averageGapMs: deltaGapsMs.length
        ? Number((deltaGapsMs.reduce((sum, gap) => sum + gap, 0) / deltaGapsMs.length).toFixed(3))
        : null,
      deltaLengths: deltaSamples.map((sample) => sample.deltaLength),
      gapsMs: deltaGapsMs,
    },
    deltaTimingByItem,
    serverTiming,
  }, null, 2));
} finally {
  child.stdin.end();
  setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
}
