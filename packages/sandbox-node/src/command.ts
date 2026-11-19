import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { createSandbox, SandboxFault, type SandboxCommand, type SandboxPool, type SandboxProcess } from "@opencraft/sandbox";
import type { SandboxLifecycleEvent } from "./lifecycle.js";

/** JSONL readers also recognize Unicode line separators; keep each message on one physical line. */
export const sandboxMessage = (message: unknown): string => JSON.stringify(message).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029") + "\n";

/** Loader settings supplied by a task only enter its bounded process. */
export const sandboxControllerEnvironment = (): Record<string, string> => ({ PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" });

export function prepareSandboxInvocation(options: { runner: string; configuration: string; owner: string; command: SandboxCommand["command"]; cwd: string; env: Readonly<Record<string, string | undefined>>; terminal?: boolean }) {
  if (!isAbsolute(options.runner) || !isAbsolute(options.configuration)) throw new SandboxFault("SANDBOX_POLICY", "Sandbox runner requires explicit absolute paths");
  const envelope: SandboxCommand = { command: options.command, cwd: options.cwd,
    env: Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) };
  const input = sandboxMessage(envelope);
  if (Buffer.byteLength(input) > 384 * 1024) throw new SandboxFault("SANDBOX_POLICY", "Sandbox command exceeds its transport budget");
  return { argv: [process.execPath, "--max-old-space-size=128", options.runner, "--config", options.configuration, "--owner", options.owner,
    ...(options.terminal ? ["--terminal"] : []), "--input-stdin"], env: sandboxControllerEnvironment(), input };
}

/** Consume exactly one bounded control frame, then return the stream to its
 * payload owner without losing binary input received in the same chunk. */
export function readSandboxInvocation(input: Readable, signal?: AbortSignal): Promise<SandboxCommand> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      input.pause(); input.off("data", data); input.off("end", fail); input.off("error", fail);
      signal?.removeEventListener("abort", fail);
    };
    const fail = () => { cleanup(); reject(new SandboxFault("SANDBOX_POLICY", "Sandbox input is unavailable or invalid")); };
    const data = (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const newline = chunk.indexOf(10), header = newline < 0 ? chunk : chunk.subarray(0, newline);
      bytes += header.length;
      if (bytes >= 384 * 1024) { fail(); return; }
      chunks.push(header);
      if (newline < 0) return;
      cleanup();
      try {
        const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw Error();
        const rest = chunk.subarray(newline + 1);
        if (rest.length) input.unshift(rest);
        resolve(envelope as SandboxCommand); // The common spawn boundary validates each command field.
      } catch { fail(); }
    };
    if (signal?.aborted || input.destroyed || input.readableEnded) { fail(); return; }
    input.on("data", data); input.once("end", fail); input.once("error", fail);
    signal?.addEventListener("abort", fail, { once: true });
    input.resume();
  });
}

export async function forwardSandboxCommand(options: {
  pool: SandboxPool; owner: string; command: SandboxCommand;
  input: Readable; output: Writable; error: Writable; signal?: AbortSignal;
  onReady?(child: SandboxProcess): void;
  lifecycle?(event: SandboxLifecycleEvent): void;
}): Promise<number> {
  options.lifecycle?.({event: "starting"});
  const sandbox = await createSandbox(options.pool, { owner: options.owner, signal: options.signal });
  const log = (event: SandboxLifecycleEvent) => options.lifecycle?.({...event, sandboxId: sandbox.identity.id});
  let failed = false, child: SandboxProcess | undefined;
  let reason: SandboxLifecycleEvent["reason"];
  const cancel = (cause: SandboxLifecycleEvent["reason"]) => { if (!reason) { reason = cause; log({event: "close-requested", reason}); } void sandbox.close().catch(() => { failed = true; }); };
  const aborted = () => cancel("signal");
  const output = (target: Writable, data: Uint8Array) => {
    if (failed) return;
    if (target.destroyed || target.writableLength + data.byteLength > 8 * 1024 * 1024) { failed = true; cancel("output-closed"); return; }
    target.write(data, error => { if (error) { failed = true; cancel("output-closed"); } });
  };
  const outputError = () => { failed = true; cancel("output-closed"); };
  options.output.on("error", outputError); options.error.on("error", outputError);
  options.output.on("close", outputError); options.error.on("close", outputError);
  let pendingInput = Promise.resolve();
  const input = (data: Buffer) => {
    options.input.pause();
    pendingInput = pendingInput.then(() => child!.writeStdin(data)).then(() => { if (!failed) options.input.resume(); }, () => { failed = true; cancel("stdin-write-failed"); });
  };
  const eof = () => { log({event: "stdin-eof"}); pendingInput = pendingInput.then(async () => { if (child?.kind === "process") await child.closeStdin(); }).catch(() => { failed = true; cancel("stdin-write-failed"); }); };
  options.signal?.addEventListener("abort", aborted, { once: true });
  try {
    options.signal?.throwIfAborted();
    child = await sandbox.spawn(options.command, event => output(event.stream === "stdout" ? options.output : options.error, event.data));
    log({event: "started"});
    options.signal?.throwIfAborted(); options.onReady?.(child);
    options.input.on("data", input); options.input.once("end", eof);
    if (options.input.readableEnded) eof(); else options.input.resume();
    const exit = await child.exited;
    log({event: "unit-exited", code: exit.code, ...(exit.signal ? {signal: exit.signal} : {})});
    if (failed) throw new SandboxFault("SANDBOX_START", "Sandbox transport failed");
    return exit.code ?? 128;
  } catch (error) { log({event: "failed"}); throw error; } finally {
    if (!reason) log({event: "close-requested", reason: failed ? "transport-failed" : "command-finished"});
    options.input.pause(); options.input.off("data", input); options.input.off("end", eof);
    options.signal?.removeEventListener("abort", aborted);
    options.output.off("error", outputError); options.error.off("error", outputError);
    options.output.off("close", outputError); options.error.off("close", outputError);
    await sandbox.close();
    log({event: "closed"});
  }
}
