import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { CodexEngineAdapter } from "../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { SshCodexTransport } from "../apps/opencraft-daemon/src/ssh-codex-transport.js";

function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
async function password(): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("Password probe requires a terminal; passwords are not accepted in argv or environment");
  process.stderr.write("SSH password (hidden): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => { process.stdin.off("data", onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write("\n"); };
    const onData = (data: Buffer) => {
      for (const character of data.toString()) {
        if (character === "\r" || character === "\n") { finish(); const result = value; value = ""; resolve(result); return; }
        if (character === "\u0003") { finish(); value = ""; reject(new Error("Probe cancelled")); return; }
        if (character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

const hostname = argument("--host");
const knownHostsFile = argument("--known-hosts");
if (!hostname || !knownHostsFile) throw new Error("Usage: probe-ssh-codex.ts --host HOST --port PORT --user USER --known-hosts PATH [--key PATH] [--socket PATH]");
const key = argument("--key");
let secret = key ? "" : await password();
const physical = new SshCodexTransport({ hostname, port: Number(argument("--port") ?? 22), username: argument("--user") ?? "root", knownHostsFile,
  authentication: key ? { kind: "key", identityFile: key } : { kind: "password", resolvePassword: async () => secret },
  ...(argument("--socket") ? { socketPath: argument("--socket") } : {}),
});
const broker = new CodexEngineAdapter({ kind: "remote", transport: physical, logDiagnostic: () => undefined });
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
let sequence = 0;
broker.subscribeMessage(frame => {
  const message = JSON.parse(frame);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id); clearTimeout(waiter.timer);
  if (message.error) waiter.reject(new Error(`Read-only protocol probe rejected (${message.error.code})`)); else waiter.resolve(message.result);
});
async function request(method: string, params: unknown = {}): Promise<any> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Read-only protocol probe timed out")); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    void broker.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "readonly-ssh-probe" })).catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
  });
}
try {
  await broker.connect();
  await request("initialize");
  const threads = await request("thread/list", { limit: 1 });
  const models = await request("model/list", {});
  process.stdout.write(JSON.stringify({ ok: true, ssh: true, websocket: true, initialize: true, threadList: Array.isArray(threads.data), modelList: Array.isArray(models.data), remoteWrites: false }) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, code: physical.status.failure?.code ?? "SSH_PROBE_FAILED", reason: physical.status.reason ?? (error instanceof Error ? error.message : "Probe failed"), remoteWrites: false }) + "\n");
  process.exitCode = 1;
} finally {
  secret = "";
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Probe ended")); }
  await broker.close();
}
