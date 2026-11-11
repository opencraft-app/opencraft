/**
 * ACP client-side services: bounded filesystem, terminal lifetime and
 * elicitation routing.
 *
 * The bridge process already runs inside the Host sandbox. These handlers keep
 * every path inside the session cwd and never widen the sandbox; commands are
 * ordinary children of the bridge. A read-only session may read files but may
 * not write or start a terminal.
 */

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AcpRpcError } from "./acp";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TERMINAL_BYTES = 512 * 1024;
const MAX_TERMINALS = 8;

export interface AcpClientHostOptions {
  readonly cwd: string;
  readonly readOnly: boolean;
  readonly allowWrite: boolean;
  readonly allowTerminal: boolean;
  readonly onElicitation: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new AcpRpcError(-32602, `${field} must be a non-empty string`);
  return value;
}

/** Reject a resolved path that is not under root. */
function inside(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new AcpRpcError(-32602, "path escapes the session workspace");
}

class TerminalHandle {
  output = "";
  truncated = false;
  exit: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
  readonly done: Promise<void>;

  constructor(readonly child: ReturnType<typeof spawn>, readonly limit: number) {
    this.done = new Promise<void>((resolveDone) => {
      const append = (chunk: Buffer) => {
        if (this.output.length >= this.limit) { this.truncated = true; return; }
        this.output += chunk.toString("utf8");
        if (Buffer.byteLength(this.output, "utf8") > this.limit) {
          this.output = Buffer.from(this.output, "utf8").subarray(0, this.limit).toString("utf8");
          this.truncated = true;
        }
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.once("error", (error) => {
        this.output += `\n[terminal error: ${error.message}]`;
        this.truncated = true;
        if (this.exit === null) this.exit = { exitCode: null, signal: null };
        resolveDone();
      });
      child.once("exit", (code, signal) => {
        this.exit = { exitCode: code, signal };
        resolveDone();
      });
    });
  }
}

export class AcpClientHost {
  private readonly terminals = new Map<string, TerminalHandle>();
  private root: string | null = null;
  private closed = false;
  private readOnly: boolean;
  private allowWrite: boolean;
  private allowTerminal: boolean;

  constructor(private readonly options: AcpClientHostOptions) {
    this.readOnly = options.readOnly;
    this.allowWrite = options.allowWrite;
    this.allowTerminal = options.allowTerminal;
  }

  async setPolicy(policy: { readOnly: boolean; allowWrite: boolean; allowTerminal: boolean }): Promise<void> {
    this.readOnly = policy.readOnly;
    this.allowWrite = policy.allowWrite;
    this.allowTerminal = policy.allowTerminal;
    if (!this.allowTerminal) {
      await Promise.all([...this.terminals.keys()].map((id) => this.releaseTerminal({ terminalId: id })));
    }
  }

  async handle(method: string, params: Record<string, unknown>): Promise<unknown | undefined> {
    if (this.closed) throw new AcpRpcError(-32603, "ACP client services are closing");
    switch (method) {
      case "fs/read_text_file":
        return this.readTextFile(params);
      case "fs/write_text_file":
        return this.writeTextFile(params);
      case "terminal/create":
        return this.createTerminal(params);
      case "terminal/output":
        return this.terminalOutput(params);
      case "terminal/wait_for_exit":
        return this.waitForExit(params);
      case "terminal/kill":
        return this.killTerminal(params);
      case "terminal/release":
        return this.releaseTerminal(params);
      case "elicitation/create":
        if (this.readOnly) throw new AcpRpcError(-32603, "elicitation is disabled in a read-only session");
        return this.options.onElicitation(params);
      default:
        return undefined;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.terminals.keys()].map((id) => this.releaseTerminal({ terminalId: id })));
    this.terminals.clear();
  }

  private async workspace(): Promise<string> {
    if (this.root === null) this.root = await realpath(this.options.cwd);
    return this.root;
  }

  private async readPath(value: unknown): Promise<string> {
    const raw = stringValue(value, "path");
    const candidate = isAbsolute(raw) ? resolve(raw) : resolve(this.options.cwd, raw);
    const resolved = await realpath(candidate);
    inside(await this.workspace(), resolved);
    return resolved;
  }

  private async writePath(value: unknown): Promise<string> {
    const raw = stringValue(value, "path");
    const candidate = isAbsolute(raw) ? resolve(raw) : resolve(this.options.cwd, raw);
    const parent = await realpath(dirname(candidate));
    inside(await this.workspace(), parent);
    const target = join(parent, basename(candidate));
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new AcpRpcError(-32602, "refusing to write through a symlink");
      if (!info.isFile()) throw new AcpRpcError(-32602, "target is not a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return target;
  }

  private async readTextFile(params: Record<string, unknown>): Promise<{ content: string }> {
    const path = await this.readPath(params.path);
    const info = await stat(path);
    if (!info.isFile()) throw new AcpRpcError(-32602, "path is not a file");
    if (info.size > MAX_FILE_BYTES) throw new AcpRpcError(-32602, "file exceeds the bridge read limit");
    const content = await readFile(path, "utf8");
    const line = params.line === undefined ? 0 : Number(params.line);
    const limit = params.limit === undefined ? undefined : Number(params.limit);
    if (!Number.isSafeInteger(line) || line < 0 || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))) {
      throw new AcpRpcError(-32602, "line/limit must be non-negative integers");
    }
    if (line === 0 && limit === undefined) return { content };
    const lines = content.split("\n");
    const start = line === 0 ? 0 : Math.max(0, line - 1);
    const selected = limit === undefined ? lines.slice(start) : lines.slice(start, start + limit);
    return { content: selected.join("\n") };
  }

  private async writeTextFile(params: Record<string, unknown>): Promise<null> {
    if (!this.allowWrite) throw new AcpRpcError(-32603, "file writes are disabled in this permission mode");
    if (typeof params.content !== "string") throw new AcpRpcError(-32602, "content must be a string");
    const content = params.content;
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new AcpRpcError(-32602, "content exceeds the bridge write limit");
    const path = await this.writePath(params.path);
    const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC
      | ((fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    return null;
  }

  private async createTerminal(params: Record<string, unknown>): Promise<{ terminalId: string }> {
    if (!this.allowTerminal) throw new AcpRpcError(-32603, "terminal is disabled in this permission mode");
    if (this.terminals.size >= MAX_TERMINALS) throw new AcpRpcError(-32603, "too many terminals");
    const command = stringValue(params.command, "command");
    const rawArgs = Array.isArray(params.args) ? params.args : [];
    if (!rawArgs.every((arg) => typeof arg === "string")) throw new AcpRpcError(-32602, "terminal args must be strings");
    const cwd = params.cwd === undefined
      ? this.options.cwd
      : isAbsolute(String(params.cwd)) ? resolve(String(params.cwd)) : resolve(this.options.cwd, String(params.cwd));
    const realCwd = await realpath(cwd);
    inside(await this.workspace(), realCwd);
    const incoming = record(params.env);
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (incoming !== undefined) {
      for (const [key, value] of Object.entries(incoming)) if (typeof value === "string") env[key] = value;
    }
    const requestedLimit = Number(params.outputByteLimit ?? MAX_TERMINAL_BYTES);
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(MAX_TERMINAL_BYTES, requestedLimit)
      : MAX_TERMINAL_BYTES;
    const child = spawn(command, rawArgs as string[], { cwd: realCwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const terminal = new TerminalHandle(child, limit);
    // A spawn failure can reject the write side before the child error handler
    // runs; this listener makes that a terminal error, never an uncaught EventEmitter throw.
    child.stdin.on("error", () => {});
    try { child.stdin.end(); } catch { /* the child error path settles the terminal */ }
    const id = `acp-terminal:${randomUUID()}`;
    this.terminals.set(id, terminal);
    return { terminalId: id };
  }

  private terminal(params: Record<string, unknown>): TerminalHandle {
    const id = stringValue(params.terminalId, "terminalId");
    const terminal = this.terminals.get(id);
    if (terminal === undefined) throw new AcpRpcError(-32602, "unknown terminalId");
    return terminal;
  }

  private terminalOutput(params: Record<string, unknown>): Record<string, unknown> {
    const terminal = this.terminal(params);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      ...(terminal.exit === null ? {} : { exitStatus: terminal.exit }),
    };
  }

  private async waitForExit(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const terminal = this.terminal(params);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        terminal.done,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new AcpRpcError(-32603, "terminal wait timed out")), 120_000);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return { exitStatus: terminal.exit };
  }

  private async killTerminal(params: Record<string, unknown>): Promise<null> {
    const terminal = this.terminal(params);
    if (terminal.exit === null) {
      terminal.child.kill("SIGTERM");
      await Promise.race([terminal.done, new Promise<void>((resolveDone) => setTimeout(resolveDone, 2_000).unref?.())]);
      if (terminal.exit === null) terminal.child.kill("SIGKILL");
    }
    return null;
  }

  private async releaseTerminal(params: Record<string, unknown>): Promise<null> {
    const id = stringValue(params.terminalId, "terminalId");
    const terminal = this.terminals.get(id);
    if (terminal === undefined) return null;
    this.terminals.delete(id);
    if (terminal.exit === null) {
      terminal.child.kill("SIGTERM");
      await Promise.race([terminal.done, new Promise<void>((resolveDone) => setTimeout(resolveDone, 1_000).unref?.())]);
      if (terminal.exit === null) terminal.child.kill("SIGKILL");
    }
    return null;
  }
}
