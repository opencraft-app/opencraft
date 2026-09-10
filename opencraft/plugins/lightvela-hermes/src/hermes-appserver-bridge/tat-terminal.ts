import type { BotTerminalSession } from "../domain/types";
import {
  TencentTatSessionMultiplexer,
  type TatPtyChannel,
} from "../lib/tencent-tat-session-multiplexer";
import { decodeUtf8, encodeUtf8 } from "../lib/utf8";

export interface HermesCommandExecNotification {
  readonly jsonrpc: "2.0";
  readonly method: "command/exec/outputDelta";
  readonly params: {
    readonly processId: string;
    readonly stream: "stdout" | "stderr";
    readonly deltaBase64: string;
    readonly capReached: false;
  };
}

export interface HermesCommandExecParams {
  readonly command?: unknown;
  readonly processId?: unknown;
  readonly cwd?: unknown;
  readonly env?: unknown;
  readonly tty?: unknown;
  readonly streamStdin?: unknown;
  readonly streamStdoutStderr?: unknown;
  readonly size?: unknown;
}

export interface HermesHostTerminal {
  subscribeNotification(
    listener: (notification: HermesCommandExecNotification) => void,
  ): () => void;
  exec(params: HermesCommandExecParams): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  write(params: Record<string, unknown>): Promise<void>;
  resize(params: Record<string, unknown>): Promise<void>;
  terminate(params: Record<string, unknown>): Promise<void>;
  dispose(): void;
}

export interface HermesTatTerminalOptions {
  readonly createSession: () => Promise<BotTerminalSession>;
  readonly WebSocketImpl?: typeof WebSocket;
  readonly createMultiplexer?: (
    session: BotTerminalSession,
  ) => TencentTatSessionMultiplexer;
}

interface OwnedProcess {
  ready: Promise<void>;
  markReady(): void;
  rejectReady(error: Error): void;
  readonly processId: string;
  multiplexer: TencentTatSessionMultiplexer | null;
  channel: TatPtyChannel | null;
  markerBuffer: string;
  exitBuffer: string;
  framingPhase: "awaiting-start" | "streaming" | "awaiting-exit";
  pendingInput: string[];
  pendingSize: { readonly cols: number; readonly rows: number } | null;
  settled: boolean;
  resolve(result: { exitCode: number; stdout: string; stderr: string }): void;
  reject(error: Error): void;
}

function requiredProcessId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("Hermes TAT terminal requires a non-empty processId");
  }
  return value;
}

function requiredCell(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new RangeError(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function terminalSize(value: unknown): { cols: number; rows: number } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("command/exec terminal size must be an object");
  }
  const size = value as Record<string, unknown>;
  return {
    cols: requiredCell(size.cols, "Terminal columns"),
    rows: requiredCell(size.rows, "Terminal rows"),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandVector(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== "string")) {
    throw new TypeError("command/exec command must be a non-empty string array");
  }
  return value as string[];
}

function base64EncodeUtf8(value: string): string {
  const bytes = encodeUtf8(value);
  let binary = "";
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + stride));
  }
  return btoa(binary);
}

function base64DecodeUtf8(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return decodeUtf8(bytes);
}

function randomMarker(kind: "START" | "EXIT"): string {
  return `__OPENCRAFT_TAT_${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}__`;
}

function markerPrintf(marker: string, suffix: string): string {
  const split = Math.ceil(marker.length / 2);
  // The complete sentinel must exist only in shell output. TAT's interactive
  // PTY echoes submitted input, so embedding it verbatim in the script would
  // make the echo indistinguishable from the framing boundary.
  return `printf '%s%s${suffix}' ${shellQuote(marker.slice(0, split))} ${shellQuote(marker.slice(split))}`;
}

function commandScript(
  params: HermesCommandExecParams,
  startMarker: string,
  exitMarker: string,
): string {
  const command = commandVector(params.command).map(shellQuote).join(" ");
  const setup: string[] = [];
  if (typeof params.cwd === "string" && params.cwd !== "") {
    setup.push(`cd -- ${shellQuote(params.cwd)} || exit 127`);
  }
  if (params.env !== null && typeof params.env === "object" && !Array.isArray(params.env)) {
    for (const [name, value] of Object.entries(params.env as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) continue;
      setup.push(value === null ? `unset ${name}` : `export ${name}=${shellQuote(String(value))}`);
    }
  }
  return [
    `${markerPrintf(startMarker, "")};`,
    "(",
    ...setup.map((line) => `${line};`),
    command,
    ");",
    "opencraft_command_status=$?;",
    `${markerPrintf(exitMarker, "%s\\n")} "$opencraft_command_status"`,
  ].join(" ");
}

/**
 * Connection-scoped terminal authority for the Hermes Host.
 *
 * The dashboard transport already owns one TAT session and its bootstrap PTY.
 * A command process therefore leases a separate TAT session. This preserves
 * AppServer's processId lifetime and prevents terminal input from ever leaking
 * into the dashboard bootstrap shell.
 */
export class HermesTatTerminalService implements HermesHostTerminal {
  private readonly listeners = new Set<(notification: HermesCommandExecNotification) => void>();
  private readonly processes = new Map<string, OwnedProcess>();
  private disposed = false;

  constructor(private readonly options: HermesTatTerminalOptions) {}

  subscribeNotification(
    listener: (notification: HermesCommandExecNotification) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  exec(params: HermesCommandExecParams): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    if (this.disposed) throw new Error("Hermes TAT terminal service is disposed");
    const processId = requiredProcessId(params.processId);
    if (this.processes.has(processId)) throw new Error(`Terminal process already exists: ${processId}`);
    commandVector(params.command);
    const initialSize = params.size === undefined ? null : terminalSize(params.size);
    const startMarker = randomMarker("START");
    const exitMarker = randomMarker("EXIT");

    return new Promise((resolve, reject) => {
      let markReady!: () => void;
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { markReady = resolve; rejectReady = reject; });
      void ready.catch(() => undefined);
      const owned: OwnedProcess = {
        ready, markReady, rejectReady,
        processId,
        multiplexer: null,
        channel: null,
        markerBuffer: "",
        exitBuffer: "",
        framingPhase: params.tty === true && params.streamStdin === true
          ? "streaming"
          : "awaiting-start",
        pendingInput: [],
        pendingSize: initialSize,
        settled: false,
        resolve,
        reject,
      };
      this.processes.set(processId, owned);
      void this.start(owned, params, startMarker, exitMarker);
    });
  }

  private async start(
    owned: OwnedProcess,
    params: HermesCommandExecParams,
    startMarker: string,
    exitMarker: string,
  ): Promise<void> {
    try {
      const command = commandVector(params.command);
      const directPty = params.tty === true && params.streamStdin === true;
      const initialSize = owned.pendingSize;
      const env = params.env !== null && typeof params.env === "object" && !Array.isArray(params.env)
        ? Object.fromEntries(
            Object.entries(params.env as Record<string, unknown>)
              .filter(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && value !== null)
              .map(([name, value]) => [name, String(value)]),
          )
        : {};
      const bootstrap = await this.options.createSession();
      if (owned.settled || this.disposed) return;
      const multiplexer = this.options.createMultiplexer?.(bootstrap)
        ?? new TencentTatSessionMultiplexer(bootstrap, { WebSocketImpl: this.options.WebSocketImpl });
      owned.multiplexer = multiplexer;
      const channel = await multiplexer.openPty({
        onOutput: (output) => {
          if (directPty) this.emitOutput(owned.processId, output);
          else this.acceptOutput(owned, startMarker, exitMarker, output);
        },
        onError: (error) => {
          if (directPty && /logout/iu.test(error.message)) this.finish(owned, 0);
          else this.fail(owned, error);
        },
      }, {
        ...(initialSize === null ? {} : initialSize),
        ...(directPty ? { program: command[0], args: command.slice(1) } : {}),
        ...(typeof params.cwd === "string" && params.cwd !== "" ? { cwd: params.cwd } : {}),
        env,
      });
      if (owned.settled || this.disposed) {
        channel.release();
        multiplexer.close();
        return;
      }
      owned.channel = channel;
      const pendingSize = owned.pendingSize;
      owned.pendingSize = null;
      if (pendingSize !== null && !channel.resize(pendingSize.cols, pendingSize.rows)) {
        this.fail(owned, new Error("TAT PTY rejected the initial terminal size"));
        return;
      }
      if (!directPty) {
        if (!channel.sendInput(`${commandScript(params, startMarker, exitMarker)}\r`)) {
          this.fail(owned, new Error("TAT PTY rejected the terminal command"));
          return;
        }
      }
      for (const input of owned.pendingInput.splice(0)) {
        if (!channel.sendInput(input)) {
          this.fail(owned, new Error("TAT PTY rejected buffered terminal input"));
          return;
        }
      }
      owned.markReady();
    } catch (error) {
      this.fail(owned, error instanceof Error ? error : new Error(String(error)));
    }
  }

  async write(params: Record<string, unknown>): Promise<void> {
    const owned = this.requireProcess(params.processId);
    const delta = params.deltaBase64;
    if (typeof delta === "string" && delta !== "") {
      const input = base64DecodeUtf8(delta);
      if (owned.channel === null) owned.pendingInput.push(input);
      else if (!owned.channel.sendInput(input)) {
        throw new Error(`Terminal ${owned.processId} is not accepting input`);
      }
    }
    if (params.closeStdin === true) {
      if (owned.channel === null) owned.pendingInput.push("\u0004");
      else if (!owned.channel.sendInput("\u0004")) {
        throw new Error(`Terminal ${owned.processId} could not close stdin`);
      }
    }
  }

  whenReady(processId: string): Promise<void> {
    return this.requireProcess(processId).ready;
  }

  async resize(params: Record<string, unknown>): Promise<void> {
    const owned = this.requireProcess(params.processId);
    const size = terminalSize(params.size);
    if (owned.channel === null) {
      owned.pendingSize = size;
      return;
    }
    if (!owned.channel.resize(size.cols, size.rows)) {
      throw new Error(`Terminal ${owned.processId} rejected the resize`);
    }
  }

  async terminate(params: Record<string, unknown>): Promise<void> {
    const owned = this.requireProcess(params.processId);
    this.finish(owned, 130);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const process of [...this.processes.values()]) this.finish(process, 130);
    this.listeners.clear();
  }

  private requireProcess(processIdValue: unknown): OwnedProcess {
    const processId = requiredProcessId(processIdValue);
    const owned = this.processes.get(processId);
    if (owned === undefined || owned.settled) throw new Error(`Unknown terminal process: ${processId}`);
    return owned;
  }

  private acceptOutput(
    owned: OwnedProcess,
    startMarker: string,
    exitMarker: string,
    output: string,
  ): void {
    if (owned.settled) return;
    if (owned.framingPhase === "awaiting-start") {
      const combined = owned.markerBuffer + output;
      const markerIndex = combined.indexOf(startMarker);
      if (markerIndex >= 0) {
        owned.markerBuffer = "";
        owned.framingPhase = "streaming";
        this.acceptOutput(
          owned,
          startMarker,
          exitMarker,
          combined.slice(markerIndex + startMarker.length),
        );
        return;
      }
      const retainedLength = this.markerPrefixSuffixLength(combined, startMarker);
      owned.markerBuffer = combined.slice(combined.length - retainedLength);
      return;
    }
    if (owned.framingPhase === "awaiting-exit") {
      this.acceptExitCode(owned, output);
      return;
    }
    const combined = owned.markerBuffer + output;
    const markerIndex = combined.indexOf(exitMarker);
    if (markerIndex >= 0) {
      this.emitOutput(owned.processId, combined.slice(0, markerIndex));
      owned.markerBuffer = "";
      owned.framingPhase = "awaiting-exit";
      this.acceptExitCode(owned, combined.slice(markerIndex + exitMarker.length));
      return;
    }
    const retainedLength = this.markerPrefixSuffixLength(combined, exitMarker);
    const emitLength = combined.length - retainedLength;
    this.emitOutput(owned.processId, combined.slice(0, emitLength));
    owned.markerBuffer = combined.slice(emitLength);
  }

  private markerPrefixSuffixLength(value: string, marker: string): number {
    const maximum = Math.min(value.length, marker.length - 1);
    for (let length = maximum; length > 0; length -= 1) {
      if (marker.startsWith(value.slice(-length))) return length;
    }
    return 0;
  }

  private acceptExitCode(owned: OwnedProcess, output: string): void {
    owned.exitBuffer += output;
    const match = owned.exitBuffer.match(/^(-?\d+)\r?\n/u);
    if (match === null) return;
    this.finish(owned, Number(match[1]));
  }

  private emitOutput(processId: string, output: string): void {
    if (output === "") return;
    const notification: HermesCommandExecNotification = {
      jsonrpc: "2.0",
      method: "command/exec/outputDelta",
      params: {
        processId,
        stream: "stdout",
        deltaBase64: base64EncodeUtf8(output),
        capReached: false,
      },
    };
    for (const listener of this.listeners) listener(notification);
  }

  private finish(owned: OwnedProcess, exitCode: number): void {
    if (owned.settled) return;
    owned.settled = true;
    owned.rejectReady(new Error("Terminal exited before becoming ready"));
    if (owned.framingPhase === "streaming") {
      this.emitOutput(owned.processId, owned.markerBuffer);
    }
    owned.markerBuffer = "";
    owned.pendingInput.length = 0;
    owned.pendingSize = null;
    this.processes.delete(owned.processId);
    owned.channel?.release();
    owned.multiplexer?.close();
    owned.resolve({ exitCode, stdout: "", stderr: "" });
  }

  private fail(owned: OwnedProcess, error: Error): void {
    if (owned.settled) return;
    owned.settled = true;
    owned.rejectReady(error);
    if (owned.framingPhase === "streaming") {
      this.emitOutput(owned.processId, owned.markerBuffer);
    }
    owned.markerBuffer = "";
    owned.pendingInput.length = 0;
    owned.pendingSize = null;
    this.processes.delete(owned.processId);
    owned.channel?.release();
    owned.multiplexer?.close();
    owned.reject(error);
  }
}
