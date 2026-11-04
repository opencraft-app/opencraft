import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, isAbsolute, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createSshPasswordAgent, quoteSshShellArgument as quote, validateSshConnection, type SshConnectionOptions } from "./ssh-connection.js";

interface FileStream { readonly size: number; readonly body: Readable; dispose(): Promise<void> }
type FileHost = "local" | SshConnectionOptions;

/** The only remote command is a read of one quoted path, on an independent SSH channel. */
export function fileReadCommand(path: string, head: boolean, root?: string): string {
  const boundary = root === undefined ? '' : 'target=$(realpath -- "$1") && root=$(realpath -- "$2") || exit 1; root=${root%/}; case "$target" in "$root"/*) ;; *) exit 1;; esac; set -- "$target"; ';
  return `sh -c ${quote(boundary + 'test -f "$1" && test -r "$1" || exit 1; LC_ALL=C wc -c < "$1"' + (head ? '' : '; exec cat -- "$1"'))} sh ${quote(path)}${root === undefined ? '' : ` ${quote(root)}`}`;
}

async function remoteFile(connection: SshConnectionOptions, path: string, head: boolean, signal: AbortSignal,
  spawnSsh: (args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams, root?: string): Promise<FileStream> {
  validateSshConnection(connection);
  const auth = connection.authentication.kind === "password" ? await createSshPasswordAgent(connection.authentication.resolvePassword) : null;
  let child: ChildProcessWithoutNullStreams | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let resolveSize!: (size: number) => void, rejectSize!: (error: Error) => void;
  const size = new Promise<number>((resolve, reject) => { resolveSize = resolve; rejectSize = reject; });
  // The promise is installed before spawn or any cancellation can report failure.
  void size.catch(() => undefined);
  let header = Buffer.alloc(0), receivedHeader = false;
  const body = new Transform({ transform(chunk: Buffer, _encoding, done) {
    if (receivedHeader) { done(null, chunk); return; }
    const newline = chunk.indexOf(10);
    if (header.length + (newline < 0 ? chunk.length : newline) > 64) { done(new Error("Invalid file metadata")); return; }
    header = Buffer.concat([header, newline < 0 ? chunk : chunk.subarray(0, newline)]);
    if (newline < 0) { done(); return; }
    const text = header.toString("ascii").trim(), length = Number(text);
    if (!/^\d+$/u.test(text) || !Number.isSafeInteger(length)) { done(new Error("Invalid file metadata")); return; }
    receivedHeader = true; header = Buffer.alloc(0); resolveSize(length);
    done(null, chunk.subarray(newline + 1));
  }, flush(done) { done(receivedHeader ? undefined : new Error("File metadata unavailable")); } });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    body.destroy();
    rejectSize(new Error("File download cancelled"));
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child?.kill("SIGKILL"), 2000);
      killTimer.unref();
    }
  };
  body.on("error", error => { rejectSize(error); stop(); });
  try {
    signal.throwIfAborted();
    const args = ["-F", "/dev/null", "-T", "-p", String(connection.port), "-l", connection.username,
      "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${connection.knownHostsFile}`,
      "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no",
      "-o", `ConnectTimeout=${Math.max(1, Math.ceil((connection.connectTimeoutMs ?? 15000) / 1000))}`,
      "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"];
    if (auth) args.push("-o", "BatchMode=no", "-o", "PreferredAuthentications=password", "-o", "NumberOfPasswordPrompts=1");
    else {
      args.push("-o", "BatchMode=yes", "-o", "PreferredAuthentications=publickey");
      if (connection.authentication.kind === "key") args.push("-o", "IdentitiesOnly=yes", "-i", connection.authentication.identityFile);
    }
    args.push("--", connection.hostname, fileReadCommand(path, head, root));
    const env = { ...process.env, ...auth?.env };
    if (!auth) { delete env.SSH_ASKPASS; delete env.SSH_ASKPASS_REQUIRE; }
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawnSsh(args, env);
    const closed = new Promise<void>(resolve => child!.once("close", () => { clearTimeout(killTimer); resolve(); }));
    child.stdin.on("error", () => undefined); child.stdin.end(); child.stderr.resume();
    child.once("error", () => body.destroy(new Error("File download unavailable")));
    child.once("close", code => { if (code !== 0 && !stopped) body.destroy(new Error("File download interrupted")); });
    child.stdout.pipe(body);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const dispose = async () => { stop(); signal.removeEventListener("abort", stop); await closed; await auth?.close(); };
    try { return { size: await size, body, dispose }; }
    catch (error) { await dispose(); throw error; }
  } catch (error) { await auth?.close(); throw error; }
}

async function localFile(path: string, head: boolean, signal: AbortSignal, root?: string): Promise<FileStream> {
  if (root !== undefined) {
    const [canonical, boundary] = await Promise.all([realpath(path), realpath(root)]);
    if (!canonical.startsWith(boundary.replace(/\/$/u, "") + sep)) throw new Error("File outside preview");
    path = canonical;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat(); signal.throwIfAborted();
    if (!info.isFile()) throw new Error("Not a regular file");
    const body = head ? Readable.from([]) : handle.createReadStream({ signal });
    if (head) await handle.close();
    return { size: info.size, body, dispose: async () => { body.destroy(); await handle.close(); } };
  } catch (error) { await handle.close(); throw error; }
}

/** Authenticated binary data plane; never sends file bodies through chat RPC. */
export class HostFileDownloads {
  private readonly active = new Set<AbortController>();
  private closed = false;
  constructor(private readonly resolveHost: (hostId: string) => FileHost,
    private readonly spawnSsh = (args: readonly string[], env: NodeJS.ProcessEnv) => spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], env })) {}

  /** Bounded report snapshots reuse the same installation-owned data plane. */
  async readPreview(hostId: string, path: string, signal: AbortSignal, maxBytes: number, root?: string): Promise<Buffer> {
    if (!hostId || hostId.length > 128 || !isAbsolute(path) || path.length > 8192 || /[\0\r\n]/u.test(path)
      || (root !== undefined && (!isAbsolute(root) || /[\0\r\n]/u.test(root)))) throw new Error("Invalid preview path");
    if (this.closed || this.active.size >= 8) throw new Error("File reader unavailable");
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
    this.active.add(controller);
    const deadline = setTimeout(() => controller.abort(), 30_000);
    let file: FileStream | undefined;
    try {
      const host = this.resolveHost(hostId);
      file = host === "local" ? await localFile(path, false, combined, root) : await remoteFile(host, path, false, combined, this.spawnSsh, root);
      if (file.size > maxBytes) throw new Error("Preview too large");
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of file.body) {
        combined.throwIfAborted(); bytes += chunk.length;
        if (bytes > maxBytes) throw new Error("Preview too large");
        chunks.push(Buffer.from(chunk));
      }
      combined.throwIfAborted();
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(deadline);
      try { await file?.dispose(); } finally { this.active.delete(controller); }
    }
  }

  async handle(request: IncomingMessage, response: ServerResponse, authorize: (hostId: string) => boolean): Promise<void> {
    response.setHeader("cache-control", "private, no-store");
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405); response.end(); return; }
    const url = new URL(request.url ?? "/", "http://invalid"), hostId = url.searchParams.get("hostId") ?? "", path = url.searchParams.get("path") ?? "";
    if (!hostId || hostId.length > 128 || !isAbsolute(path) || path.length > 8192 || /[\0\r\n]/u.test(path)) { response.writeHead(400); response.end(); return; }
    if (!authorize(hostId)) { response.writeHead(403); response.end(); return; }
    if (this.closed || this.active.size >= 8) { response.writeHead(503); response.end(); return; }
    const controller = new AbortController(), abort = () => controller.abort();
    this.active.add(controller);
    response.once("close", abort);
    request.once("aborted", abort);
    const deadline = setTimeout(abort, 30 * 60_000);
    const admission = setInterval(() => { if (!authorize(hostId)) abort(); }, 1000);
    let file: FileStream | undefined;
    try {
      const host = this.resolveHost(hostId), head = request.method === "HEAD";
      file = host === "local" ? await localFile(path, head, controller.signal) : await remoteFile(host, path, head, controller.signal, this.spawnSsh);
      controller.signal.throwIfAborted();
      if (!authorize(hostId)) throw new Error("File access expired");
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(file.size),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(basename(path)).replace(/[!'()*]/gu, c => `%${c.charCodeAt(0).toString(16)}`)}`,
        "x-content-type-options": "nosniff" });
      if (head) response.end();
      else await pipeline(file.body, response, { signal: controller.signal });
    } catch {
      if (!response.headersSent && !response.destroyed) { response.writeHead(502); response.end(); }
      else response.destroy();
    } finally {
      clearTimeout(deadline); clearInterval(admission);
      response.off("close", abort); request.off("aborted", abort);
      try { await file?.dispose(); } finally { this.active.delete(controller); }
    }
  }
  close(): void { this.closed = true; for (const controller of this.active) controller.abort(); }
}
