import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection, createServer, type Socket } from "node:net";
import { chmod, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { SandboxCreationFault, SandboxFault, type SandboxBackend, type SandboxEnvironment, type SandboxExit, type SandboxIdentity, type SandboxOutput, type SandboxPoolPolicy, type SandboxProcess, type SandboxResources } from "@opencraft/sandbox";

type Frame = Record<string, unknown> & { type: string; lease?: string };
const fault = (code: ConstructorParameters<typeof SandboxFault>[0], message: string) => new SandboxFault(code, message);
const encode = (frame: Frame) => JSON.stringify(frame) + "\n";
function frames(socket: Socket, accept: (frame: Frame) => void, reject: (error: Error) => void) {
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    buffered += chunk;
    if (buffered.length > 2 * 1024 * 1024) { reject(Error("Hands frame exceeds its budget")); socket.destroy(); return; }
    for (;;) {
      const at = buffered.indexOf("\n"); if (at < 0) break;
      const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
      try { const value = JSON.parse(line); if (!value || typeof value.type !== "string") throw Error(); accept(value); }
      catch { reject(Error("Invalid Hands frame")); socket.destroy(); return; }
    }
  });
}
async function privateToken(path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 4096) throw fault("SANDBOX_POLICY", "Hands token is unavailable");
  const token = (await readFile(path, "utf8")).trim();
  if (token.length < 32) throw fault("SANDBOX_POLICY", "Hands token is unavailable");
  return token;
}

export interface HandsUnixBackendOptions { endpoint: string; tokenFile: string }
export async function handsUnixSandboxBackend(options: HandsUnixBackendOptions): Promise<SandboxBackend> {
  if (!isAbsolute(options?.endpoint) || !isAbsolute(options?.tokenFile) || options.endpoint === options.tokenFile) throw fault("SANDBOX_POLICY", "Invalid Hands endpoint");
  const token = await privateToken(options.tokenFile);
  let policy: SandboxPoolPolicy | undefined, closed = false;
  return {
    id: "hands-unix",
    async initialize(value, signal) { if (policy || closed || signal.aborted) throw fault("SANDBOX_UNAVAILABLE", "Hands owner is unavailable"); policy = value; },
    async create(identity, resources, signal) {
      if (!policy || closed || signal.aborted) throw new SandboxCreationFault("not-created");
      const socket = createConnection(options.endpoint);
      let ready = false, ended = false, graceful = false, lease = "", spawned = false, processId = "";
      let output: ((event: SandboxOutput) => void) | undefined;
      let startResolve: ((value: SandboxProcess) => void) | undefined, startReject: ((error: unknown) => void) | undefined;
      let exitResolve!: (value: SandboxExit) => void;
      const exited = new Promise<SandboxExit>(resolve => { exitResolve = resolve; });
      const pending: Frame[] = [];
      let wake: (() => void) | undefined, protocolError: Error | undefined;
      const fail = (error: Error) => { protocolError ??= error; startReject?.(fault("SANDBOX_START", "Hands execution transport failed")); wake?.(); };
      frames(socket, frame => {
        if (ready && frame.lease !== lease) { fail(Error("Stale Hands lease")); socket.destroy(); return; }
        if (frame.type === "output" && typeof frame.data === "string" && (frame.stream === "stdout" || frame.stream === "stderr")) output?.({ stream: frame.stream, data: Buffer.from(frame.data, "base64") });
        else if (frame.type === "started" && typeof frame.processId === "string") { processId = frame.processId; startResolve?.(remoteProcess()); }
        else if (frame.type === "exit") exitResolve({ code: typeof frame.code === "number" ? frame.code : null, ...(typeof frame.signal === "string" ? { signal: frame.signal } : {}) });
        else { pending.push(frame); wake?.(); }
      }, fail);
      socket.once("error", fail);
      socket.once("close", () => { ended = true; if (!graceful && !protocolError) fail(Error("Hands owner disconnected")); });
      const next = async (...types: string[]) => {
        for (;;) {
          const at = pending.findIndex(frame => types.includes(frame.type));
          if (at >= 0) return pending.splice(at, 1)[0]!;
          if (protocolError) throw protocolError;
          await new Promise<void>(resolve => { wake = resolve; }); wake = undefined;
        }
      };
      const send = (frame: Frame) => { if (ended || !socket.write(encode(frame))) { /* backpressure is bounded by Node; drain is not an acknowledgement. */ } };
      const onAbort = () => socket.destroy(Error("Hands creation cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
        send({ type: "open", token, identity, resources });
        const frame = await next("ready", "rejected");
        if (frame.type === "rejected") { socket.end(); throw new SandboxCreationFault("not-created"); }
        if (typeof frame.lease !== "string" || frame.lease.length < 16 || JSON.stringify(frame.resources) !== JSON.stringify(resources)) throw Error("Hands identity mismatch");
        lease = frame.lease; ready = true;
      } catch (error) {
        socket.destroy();
        if (error instanceof SandboxCreationFault) throw error;
        throw new SandboxCreationFault("unknown", identity);
      } finally { signal.removeEventListener("abort", onAbort); }
      const remoteProcess = (): SandboxProcess => ({ kind: "process", id: processId, exited,
        async writeStdin(data) { send({ type: "stdin", lease, processId, data: Buffer.from(data).toString("base64") }); },
        async closeStdin() { send({ type: "stdin-close", lease, processId }); },
        async terminate() { send({ type: "terminate", lease, processId }); await exited; },
      });
      const environment: SandboxEnvironment = {
        resources: Object.freeze({ ...resources }), capabilities: { terminal: false }, processLimits: { tasks: 4096, fileDescriptorsPerProcess: 65536 },
        spawn(command, onOutput) {
          if (spawned || ended || command.terminal) return Promise.reject(fault("SANDBOX_START", "Hands accepts one non-terminal executor per lease"));
          spawned = true; output = onOutput;
          return new Promise<SandboxProcess>((resolve, reject) => { startResolve = resolve; startReject = reject; send({ type: "start", lease, command }); });
        },
        async close() {
          if (ended) { if (protocolError) throw fault("SANDBOX_CLEANUP", "Hands cleanup is unconfirmed"); return; }
          send({ type: "close", lease });
          const frame = await next("closed");
          if (frame.type !== "closed") throw fault("SANDBOX_CLEANUP", "Hands cleanup is unconfirmed");
          graceful = true; socket.end(); ended = true;
        },
      };
      return environment;
    },
    async close() { closed = true; },
  };
}

export interface HandsExecutionOwnerOptions { endpoint: string; tokenFile: string; executable: string; workspace: string; projectlessWorkspace?: string; resources: SandboxResources; verifyCgroup?: boolean }
export async function verifyHandsCgroup(resources: SandboxResources, root = "/sys/fs/cgroup") {
  let cpu: string, memory: string, tasks: string;
  try {
    [cpu, memory, tasks] = await Promise.all(["cpu.max", "memory.max", "pids.max"].map(name => readFile(join(root, name), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const [quota, period, memoryLimit, taskLimit] = await Promise.all([
      readFile(join(root, "cpu,cpuacct/cpu.cfs_quota_us"), "utf8"),
      readFile(join(root, "cpu,cpuacct/cpu.cfs_period_us"), "utf8"),
      readFile(join(root, "memory/memory.limit_in_bytes"), "utf8"),
      readFile(join(root, "pids/pids.max"), "utf8"),
    ]);
    cpu = `${quota.trim()} ${period.trim()}`; memory = memoryLimit; tasks = taskLimit;
  }
  const [quota, period] = cpu.trim().split(/\s+/u).map(Number);
  if (!quota || quota < 0 || !period || Math.abs(quota / period * 1000 - resources.cpuMillis) > 1
    || Number(memory.trim()) !== resources.memoryBytes || Number(tasks.trim()) !== 4096)
    throw Error("Hands cgroup does not enforce the declared execution budget");
}
export async function startHandsExecutionOwner(options: HandsExecutionOwnerOptions) {
  if (![options.endpoint, options.tokenFile, options.executable, options.workspace].every(isAbsolute)) throw Error("Invalid Hands owner configuration");
  const [workspace, executable] = await Promise.all([realpath(options.workspace), realpath(options.executable)]);
  const projectless = options.projectlessWorkspace;
  if (projectless !== undefined && (!isAbsolute(projectless) || await realpath(projectless) !== projectless))
    throw Error("Invalid Hands projectless workspace");
  const roots = projectless === undefined ? [workspace] : [workspace, projectless];
  if (options.verifyCgroup) await verifyHandsCgroup(options.resources);
  let token: string;
  try { token = await privateToken(options.tokenFile); }
  catch {
    token = randomBytes(32).toString("hex");
    await writeFile(options.tokenFile, token + "\n", { mode: 0o600, flag: "wx" });
  }
  await rm(options.endpoint, { force: true });
  const active = new Set<Socket>();
  const server = createServer(socket => {
    active.add(socket); let lease = "", opened = false, closing = false, child: ChildProcessWithoutNullStreams | undefined;
    const send = (frame: Frame) => socket.writable && socket.write(encode({ ...frame, ...(lease ? { lease } : {}) }));
    const stop = async () => {
      if (closing) return; closing = true;
      if (child && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid!, "SIGTERM"); } catch {}
        await Promise.race([new Promise(resolve => child!.once("close", resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
        if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      }
    };
    frames(socket, async frame => {
      try {
        if (!opened) {
          if (frame.type === "probe" && frame.protocol === 1) { send({ type: "healthy", protocol: 1, resources: options.resources }); socket.end(); return; }
          if (frame.type !== "open" || typeof frame.token !== "string") throw Error();
          const left = createHash("sha256").update(frame.token).digest(), right = createHash("sha256").update(token).digest();
          if (!timingSafeEqual(left, right) || !frame.identity || JSON.stringify(frame.resources) !== JSON.stringify(options.resources)) { send({ type: "rejected" }); socket.end(); return; }
          opened = true; lease = randomBytes(18).toString("hex"); send({ type: "ready", resources: options.resources }); return;
        }
        if (frame.lease !== lease) throw Error();
        if (frame.type === "start") {
          if (child || !frame.command || typeof frame.command !== "object") throw Error();
          const command = frame.command as { command?: unknown; cwd?: unknown; env?: unknown; terminal?: unknown };
          const allowedEnvironment = new Set(["PATH", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]);
          if (!Array.isArray(command.command) || command.command.length !== 4 || await realpath(String(command.command[0])) !== executable
            || command.command[1] !== "exec-server" || command.command[2] !== "--listen" || command.command[3] !== "stdio" || command.terminal
            || typeof command.cwd !== "string" || typeof command.env !== "object" || !command.env
            || Object.entries(command.env).some(([key, value]) => !allowedEnvironment.has(key) || typeof value !== "string" || value.includes("\0"))) throw Error();
          const cwd = await realpath(command.cwd);
          if (!roots.some(root => {
            const rel = relative(root, cwd);
            return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
          })) throw Error();
          child = spawn(executable, command.command.slice(1), { cwd,
            env: { HOME: dirname(options.tokenFile), ...command.env as Record<string, string> },
            stdio: ["pipe", "pipe", "pipe"], detached: true, shell: false });
          const processId = createHash("sha256").update(lease).digest("hex").slice(0, 24);
          child.stdout.on("data", data => send({ type: "output", stream: "stdout", data: data.toString("base64") }));
          child.stderr.on("data", data => send({ type: "output", stream: "stderr", data: data.toString("base64") }));
          child.once("error", () => send({ type: "exit", code: null }));
          child.once("close", (code, signal) => send({ type: "exit", code, ...(signal ? { signal } : {}) }));
          child.stdin.on("error", () => {}); send({ type: "started", processId }); return;
        }
        if (frame.type === "stdin" && child && typeof frame.data === "string") { child.stdin.write(Buffer.from(frame.data, "base64")); return; }
        if (frame.type === "stdin-close" && child) { child.stdin.end(); return; }
        if (frame.type === "terminate") { await stop(); return; }
        if (frame.type === "close") { await stop(); send({ type: "closed" }); socket.end(); return; }
        throw Error();
      } catch { await stop(); socket.destroy(); }
    }, () => { void stop(); });
    socket.once("close", () => { active.delete(socket); void stop(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.endpoint, resolve); });
  await chmod(options.endpoint, 0o600);
  return { close: async () => { for (const socket of active) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(options.endpoint, { force: true }); } };
}
