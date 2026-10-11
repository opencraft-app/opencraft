import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Duplex } from "node:stream";
import WebSocket from "ws";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";

export type SshAuthentication =
  | { readonly kind: "key"; readonly identityFile: string }
  | { readonly kind: "agent" }
  | { readonly kind: "password"; readonly resolvePassword: () => Promise<string> };

/** Backend-only, administrator-bound configuration. Never supplied by a page. */
export interface SshCodexTransportOptions {
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly knownHostsFile: string;
  readonly authentication: SshAuthentication;
  readonly codexExecutable?: string;
  readonly codexHome?: string;
  readonly socketPath?: string;
  readonly connectTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  /** Physical process boundary for tests, not a user-supplied shell command. */
  readonly spawnSsh?: (args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
}

export class SshCodexConnectionError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, message: string) { super(message); }
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function buildCodexProxyCommand(options: Pick<SshCodexTransportOptions, "codexExecutable" | "codexHome" | "socketPath">, sentinel: Buffer): string {
  if (sentinel.length !== 8) throw new Error("SSH probe sentinel must be eight bytes");
  const marker = [...sentinel].map(byte => `\\${byte.toString(8).padStart(3, "0")}`).join("");
  const executable = options.codexExecutable ?? "codex";
  if (executable !== "codex" && !isAbsolute(executable)) throw new Error("Codex executable must be absolute");
  if (options.codexHome !== undefined && !isAbsolute(options.codexHome)) throw new Error("Codex home must be absolute");
  if (options.socketPath !== undefined && !isAbsolute(options.socketPath)) throw new Error("Codex socket path must be absolute");
  // Same eight-byte probe and CODEX_REMOTE_PAYLOAD contract as Desktop/HyperNode.
  // No bootstrap, pkill, upload or account/config rewrite. Login shell owns PATH.
  const payload = `printf '${marker}'; ${options.codexHome === undefined ? "" : `export CODEX_HOME=${quote(options.codexHome)}; `}exec ${executable === "codex" ? "codex" : quote(executable)} app-server proxy${options.socketPath === undefined ? "" : ` --sock ${quote(options.socketPath)}`}`;
  return `sh -c ${quote('CODEX_REMOTE_PAYLOAD="$1"; export CODEX_REMOTE_PAYLOAD; exec "${SHELL:-/bin/sh}" -lc "$CODEX_REMOTE_PAYLOAD"')} sh ${quote(payload)}`;
}

/** Preserve partial markers and trailing HTTP bytes, with bounded banner memory. */
export class SshProbeStream extends Duplex {
  private banner = Buffer.alloc(0);
  private found = false;
  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly sentinel: Buffer) {
    super();
    child.stdout.on("data", this.receive);
    child.stdout.once("end", () => this.push(null));
    child.stdout.once("error", error => this.destroy(error));
    child.stdin.once("error", error => this.destroy(error));
  }
  private readonly receive = (chunk: Buffer): void => {
    if (this.destroyed) return;
    if (this.found) { if (!this.push(chunk)) this.child.stdout.pause(); return; }
    this.banner = Buffer.concat([this.banner, chunk]);
    const offset = this.banner.indexOf(this.sentinel);
    if (offset < 0) {
      if (this.banner.length > 64 * 1024) this.destroy(new SshCodexConnectionError("SSH_PROBE_INVALID", false, "Remote connection handshake is invalid"));
      return;
    }
    this.found = true;
    const remainder = this.banner.subarray(offset + this.sentinel.length);
    this.banner = Buffer.alloc(0);
    if (remainder.length && !this.push(remainder)) this.child.stdout.pause();
  };
  override _read(): void { this.child.stdout.resume(); }
  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.child.stdin.write(chunk, encoding, callback);
  }
  override _final(callback: (error?: Error | null) => void): void { this.child.stdin.end(callback); }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.child.stdout.off("data", this.receive);
    this.banner = Buffer.alloc(0);
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    callback(error);
  }
}

/** Password is delivered through a private local socket, never argv/env/stdin RPC. */
export async function createSshPasswordAgent(resolvePassword: () => Promise<string>): Promise<{ env: NodeJS.ProcessEnv; close(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-ssh-auth-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "askpass.sock");
  const sockets = new Set<import("node:net").Socket>();
  let used = false;
  let closed = false;
  let closeOperation: Promise<void> | null = null;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(5_000, () => socket.destroy());
    if (used || closed) { socket.end(); return; }
    used = true;
    void resolvePassword().then(password => {
      if (!closed && !socket.destroyed && !/[\r\n\0]/u.test(password)) socket.end(password + "\n");
      else socket.destroy();
    }, () => socket.destroy());
  });
  const close = (): Promise<void> => {
    if (closeOperation) return closeOperation;
    closed = true;
    closeOperation = (async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    })();
    return closeOperation;
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
    const helper = join(directory, "askpass.cjs");
    await writeFile(helper, `const net = require('node:net'); const s = net.connect(${JSON.stringify(socketPath)}); s.setTimeout(5000, () => process.exit(1)); s.on('data', b => process.stdout.write(b)); s.on('error', () => process.exit(1)); s.on('end', () => process.exit(0));`, { mode: 0o600 });
    const executable = join(directory, "askpass");
    await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(helper)}\n`, { mode: 0o700 });
    return { env: { SSH_ASKPASS: executable, SSH_ASKPASS_REQUIRE: "force", DISPLAY: "opencraft-askpass" }, close };
  } catch (error) { await close(); throw error; }
}

export function classifySshFailure(stderr: string, code: number | null): SshCodexConnectionError {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known/u.test(stderr)) {
    return new SshCodexConnectionError("SSH_HOST_KEY", false, "SSH host identity must be verified");
  }
  if (/Permission denied|Authentication failed|Too many authentication failures/u.test(stderr)) {
    return new SshCodexConnectionError("SSH_AUTHENTICATION", false, "SSH authentication failed");
  }
  if (code === 127 || /unknown.*proxy|unrecognized.*proxy|unexpected argument.*proxy|command not found|No such file or directory|Connection refused.*socket/iu.test(stderr)) {
    return new SshCodexConnectionError("SSH_CODEX_UNAVAILABLE", false, "An existing compatible Codex service is required");
  }
  return new SshCodexConnectionError("SSH_LINK_LOST", true, "Remote connection was interrupted");
}

export class SshCodexTransport implements DuplexTransport {
  private currentStatus: TransportStatus = { state: "idle" };
  private readonly messages = new Set<(frame: string) => void>();
  private readonly statuses = new Set<(status: TransportStatus) => void>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private socket: WebSocket | null = null;
  private stream: SshProbeStream | null = null;
  private auth: Awaited<ReturnType<typeof createSshPasswordAgent>> | null = null;
  private operation: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private heartbeatDeadline: NodeJS.Timeout | null = null;
  private generation = 0;
  private cancelConnect: (() => void) | null = null;

  constructor(private readonly options: SshCodexTransportOptions) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/u.test(options.hostname) || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(options.username)
      || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || !isAbsolute(options.knownHostsFile)) throw new Error("Invalid SSH endpoint or trust configuration");
    if (options.authentication.kind === "key" && !isAbsolute(options.authentication.identityFile)) throw new Error("SSH identity file must be absolute");
    buildCodexProxyCommand(options, Buffer.alloc(8));
  }
  get status(): TransportStatus { return this.currentStatus; }
  connect(signal?: AbortSignal): Promise<void> {
    if (this.closing) return Promise.reject(new Error("SSH transport is closed"));
    if (this.status.state === "failed") return Promise.reject(new SshCodexConnectionError(this.status.failure?.code ?? "SSH_LINK_LOST", this.status.failure?.recovery !== "manual", this.status.reason ?? "Remote connection failed"));
    if (this.status.state === "open") return Promise.resolve();
    if (this.operation) return this.operation;
    const generation = ++this.generation;
    this.setStatus({ state: "connecting" });
    const operation = this.open(generation, signal).finally(() => { if (this.operation === operation) this.operation = null; });
    this.operation = operation;
    return operation;
  }
  private async open(generation: number, signal?: AbortSignal): Promise<void> {
    const timeoutMs = this.options.connectTimeoutMs ?? 15_000;
    let stderr = "";
    let deadline: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    try {
      if (signal?.aborted) throw signal.reason;
      if (this.options.authentication.kind === "password") this.auth = await createSshPasswordAgent(this.options.authentication.resolvePassword);
      if (generation !== this.generation || signal?.aborted) throw new Error("SSH connection was cancelled");
      const marker = randomBytes(8);
      const args = ["-F", "/dev/null", "-T", "-p", String(this.options.port), "-l", this.options.username,
        "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${this.options.knownHostsFile}`, "-o", "GlobalKnownHostsFile=/dev/null",
        "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no",
        "-o", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`, "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"];
      if (this.options.authentication.kind === "password") args.push("-o", "BatchMode=no", "-o", "PreferredAuthentications=password", "-o", "NumberOfPasswordPrompts=1");
      else {
        args.push("-o", "BatchMode=yes", "-o", "PreferredAuthentications=publickey");
        if (this.options.authentication.kind === "key") args.push("-o", "IdentitiesOnly=yes", "-i", this.options.authentication.identityFile);
      }
      args.push("--", this.options.hostname, buildCodexProxyCommand(this.options, marker));
      const env = { ...process.env, ...this.auth?.env };
      // Do not inherit an unrelated askpass or Electron's Node mode.
      if (!this.auth) { delete env.SSH_ASKPASS; delete env.SSH_ASKPASS_REQUIRE; }
      delete env.ELECTRON_RUN_AS_NODE;
      const child = this.options.spawnSsh?.(args, env) ?? spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], env });
      this.child = child;
      child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-4096); });
      const stream = new SshProbeStream(child, marker);
      this.stream = stream;
      const socket = new WebSocket("ws://codex-app-server/rpc", { perMessageDeflate: false, maxPayload: this.options.maxFrameBytes ?? 16 * 1024 * 1024, createConnection: () => stream });
      this.socket = socket;
      const current = () => generation === this.generation && this.socket === socket;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (error: SshCodexConnectionError) => {
          if (!current() || ["failed", "closing", "closed"].includes(this.status.state)) return;
          this.setStatus({ state: "failed", reason: error.message, failure: { code: error.code, recovery: error.retryable ? "automatic" : "manual" } });
          if (!settled) { settled = true; reject(error); }
          socket.terminate();
          child.kill("SIGTERM");
          this.stopHeartbeat();
          void this.auth?.close();
        };
        this.cancelConnect = () => {
          if (!settled) { settled = true; reject(new SshCodexConnectionError("SSH_CONNECT_CANCELLED", true, "Remote connection was cancelled")); }
        };
        child.once("error", () => fail(new SshCodexConnectionError("SSH_EXECUTABLE", false, "SSH executable is unavailable")));
        child.once("close", code => fail(classifySshFailure(stderr, code)));
        // Prefer SSH exit classification over a generic EOF from ws.
        socket.on("error", error => {
          if (error instanceof SshCodexConnectionError) fail(error);
          else if (/^Unexpected server response:|^Invalid Sec-WebSocket|^Invalid Upgrade header/u.test(error.message)) {
            fail(new SshCodexConnectionError("SSH_RPC_PROTOCOL", false, "Remote service rejected the connection protocol"));
          } else if (child.exitCode !== null) fail(classifySshFailure(stderr, child.exitCode));
        });
        socket.on("close", () => { if (current() && settled && this.status.state === "open") fail(classifySshFailure(stderr, child.exitCode)); });
        socket.once("open", () => {
          if (!current() || settled) return;
          settled = true;
          if (deadline) clearTimeout(deadline);
          if (abort) signal?.removeEventListener("abort", abort);
          this.setStatus({ state: "open" });
          void this.auth?.close();
          this.startHeartbeat(socket, () => fail(new SshCodexConnectionError("SSH_RPC_HEARTBEAT", true, "Remote service stopped responding")));
          resolve();
        });
        socket.on("message", (data, binary) => {
          if (!current() || this.status.state !== "open") return;
          if (binary) { fail(new SshCodexConnectionError("SSH_RPC_PROTOCOL", false, "Remote service sent an invalid frame")); return; }
          const frame = data.toString();
          try {
            const value = JSON.parse(frame);
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid RPC");
          } catch { fail(new SshCodexConnectionError("SSH_RPC_PROTOCOL", false, "Remote service sent an invalid frame")); return; }
          for (const listener of this.messages) listener(frame);
        });
        deadline = setTimeout(() => fail(new SshCodexConnectionError("SSH_CONNECT_TIMEOUT", true, "Remote connection timed out")), timeoutMs);
        abort = () => fail(new SshCodexConnectionError("SSH_CONNECT_CANCELLED", true, "Remote connection was cancelled"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    } catch (error) {
      if (!this.closing && this.status.state !== "failed" && generation === this.generation) this.setStatus({ state: "failed", reason: "Remote connection failed", failure: { code: "SSH_SETUP_FAILED", recovery: "manual" } });
      await this.disposePhysical();
      throw error;
    } finally {
      this.cancelConnect = null;
      if (deadline) clearTimeout(deadline);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
  private startHeartbeat(socket: WebSocket, fail: () => void): void {
    socket.on("pong", () => { if (this.socket === socket && this.heartbeatDeadline) { clearTimeout(this.heartbeatDeadline); this.heartbeatDeadline = null; } });
    this.heartbeat = setInterval(() => {
      if (this.socket !== socket || this.heartbeatDeadline || socket.readyState !== WebSocket.OPEN) return;
      this.heartbeatDeadline = setTimeout(fail, this.options.heartbeatTimeoutMs ?? 10_000);
      this.heartbeatDeadline.unref();
      socket.ping();
    }, this.options.heartbeatIntervalMs ?? 20_000);
    this.heartbeat.unref();
  }
  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline);
    this.heartbeat = this.heartbeatDeadline = null;
  }
  async send(frame: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    const socket = this.socket;
    if (!socket || this.status.state !== "open" || socket.readyState !== WebSocket.OPEN) throw new Error("Remote connection is not open");
    const max = this.options.maxFrameBytes ?? 16 * 1024 * 1024;
    if (Buffer.byteLength(frame) > max || socket.bufferedAmount > max) throw new Error("Remote connection frame or buffer limit exceeded");
    // No mutation replay. A failed callback after write means an unknown outcome.
    await new Promise<void>((resolve, reject) => socket.send(frame, error => error ? reject(new Error("Remote delivery outcome is unknown")) : resolve()));
  }
  subscribeMessage(listener: (frame: string) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  subscribeStatus(listener: (status: TransportStatus) => void): () => void { this.statuses.add(listener); return () => this.statuses.delete(listener); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.cancelConnect?.();
    ++this.generation;
    this.setStatus({ state: "closing" });
    this.closing = this.disposePhysical().then(() => { this.setStatus({ state: "closed" }); });
    return this.closing;
  }
  private async disposePhysical(): Promise<void> {
    this.stopHeartbeat();
    this.socket?.terminate(); this.socket = null;
    this.stream?.destroy(); this.stream = null;
    const child = this.child; this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1_000);
        timer.unref();
        child.once("close", () => { clearTimeout(timer); resolve(); });
        child.kill("SIGTERM");
      });
    }
    await this.auth?.close(); this.auth = null;
  }
  private setStatus(status: TransportStatus): void { this.currentStatus = status; for (const listener of this.statuses) listener(status); }
}
