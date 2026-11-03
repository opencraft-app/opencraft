import { mkdtempSync, writeFileSync, lstatSync, readFileSync, unlinkSync, rmdirSync, rmSync } from "node:fs";
import { dirname, basename, join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import type { Readable, Writable } from "node:stream";
import { createSandbox, SandboxFault, type SandboxCommand, type SandboxPool, type SandboxProcess } from "@opencraft/sandbox";

/** JSONL readers also recognize Unicode line separators; keep each message on one physical line. */
export const sandboxMessage = (message: unknown): string => JSON.stringify(message).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029") + "\n";

/** Loader settings supplied by a task only enter its bounded process. */
export const sandboxControllerEnvironment = (): Record<string, string> => ({ PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" });

export function prepareSandboxInvocation(options: { runner: string; configuration: string; owner: string; command: SandboxCommand["command"]; cwd: string; env: Readonly<Record<string, string | undefined>>; terminal?: boolean }) {
  if (!isAbsolute(options.runner) || !isAbsolute(options.configuration)) throw new SandboxFault("SANDBOX_POLICY", "Sandbox runner requires explicit absolute paths");
  const envelope: SandboxCommand = { command: options.command, cwd: options.cwd,
    env: Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) };
  const text = JSON.stringify(envelope);
  if (Buffer.byteLength(text) > 384 * 1024) throw new SandboxFault("SANDBOX_POLICY", "Sandbox command exceeds its transport budget");
  const directory = mkdtempSync(join(tmpdir(), "opencraft-sandbox-input-")), input = join(directory, "input.json");
  try { writeFileSync(input, text, { mode: 0o600 }); }
  catch { rmSync(directory, { recursive: true, force: true }); throw new SandboxFault("SANDBOX_START", "Sandbox input could not be prepared"); }
  return { argv: [process.execPath, "--max-old-space-size=128", options.runner, "--config", options.configuration, "--owner", options.owner,
    ...(options.terminal ? ["--terminal"] : []), "--input", input], env: sandboxControllerEnvironment(),
    dispose() { rmSync(directory, { recursive: true, force: true }); } };
}

export function readSandboxInvocation(path: string): SandboxCommand {
  try {
    const directory = dirname(path), file = lstatSync(path), parent = lstatSync(directory);
    if (!isAbsolute(path) || basename(path) !== "input.json" || !basename(directory).startsWith("opencraft-sandbox-input-")
      || !file.isFile() || !parent.isDirectory() || file.uid !== process.getuid?.() || parent.uid !== process.getuid?.()
      || (file.mode & 0o077) || (parent.mode & 0o077) || file.size > 384 * 1024) throw Error();
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
    unlinkSync(path); rmdirSync(directory);
    return value as SandboxCommand; // The common spawn boundary validates every command field.
  } catch { throw new SandboxFault("SANDBOX_POLICY", "Sandbox input is unavailable or invalid"); }
}

export async function forwardSandboxCommand(options: {
  pool: SandboxPool; owner: string; command: SandboxCommand;
  input: Readable; output: Writable; error: Writable; signal?: AbortSignal;
  onReady?(child: SandboxProcess): void;
}): Promise<number> {
  const sandbox = await createSandbox(options.pool, { owner: options.owner, signal: options.signal });
  let failed = false, child: SandboxProcess | undefined;
  const cancel = () => { void sandbox.close().catch(() => { failed = true; }); };
  const output = (target: Writable, data: Uint8Array) => {
    if (failed) return;
    if (target.destroyed || target.writableLength + data.byteLength > 8 * 1024 * 1024) { failed = true; cancel(); return; }
    target.write(data, error => { if (error) { failed = true; cancel(); } });
  };
  const outputError = () => { failed = true; cancel(); };
  options.output.on("error", outputError); options.error.on("error", outputError);
  let pendingInput = Promise.resolve();
  const input = (data: Buffer) => {
    options.input.pause();
    pendingInput = pendingInput.then(() => child!.writeStdin(data)).then(() => { if (!failed) options.input.resume(); }, () => { failed = true; cancel(); });
  };
  const eof = () => { pendingInput = pendingInput.then(async () => { if (child?.kind === "process") await child.closeStdin(); }).catch(() => { failed = true; cancel(); }); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    options.signal?.throwIfAborted();
    child = await sandbox.spawn(options.command, event => output(event.stream === "stdout" ? options.output : options.error, event.data));
    options.signal?.throwIfAborted(); options.onReady?.(child);
    options.input.on("data", input); options.input.once("end", eof);
    if (options.input.readableEnded) eof(); else options.input.resume();
    const exit = await child.exited;
    if (failed) throw new SandboxFault("SANDBOX_START", "Sandbox transport failed");
    return exit.code ?? 128;
  } finally {
    options.input.pause(); options.input.off("data", input); options.input.off("end", eof);
    options.signal?.removeEventListener("abort", cancel);
    options.output.off("error", outputError); options.error.off("error", outputError);
    await sandbox.close();
  }
}
