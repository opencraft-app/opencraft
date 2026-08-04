import type {TerminalSession} from "../platform/api.js";
import type {
  TerminalCallbacks,
  TerminalConnection,
} from "./tat-pty.js";

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export type TerminalControlKey =
  | "arrow_down"
  | "arrow_left"
  | "arrow_right"
  | "arrow_up"
  | "ctrl_c"
  | "tab";

export type TerminalControllerStatus =
  | "closed"
  | "connecting"
  | "ready"
  | "error";

export interface TerminalControllerState {
  error?: string | undefined;
  output: Uint8Array;
  status: TerminalControllerStatus;
  truncated: boolean;
}

export interface TerminalOpener {
  open(
    session: TerminalSession,
    callbacks: TerminalCallbacks,
  ): Promise<TerminalConnection>;
}

export interface TerminalControllerOptions {
  createSession(): Promise<TerminalSession>;
  maxOutputBytes?: number;
  opener: TerminalOpener;
}

export class TerminalController {
  private readonly createSession: () => Promise<TerminalSession>;
  private readonly listeners = new Set<(state: TerminalControllerState) => void>();
  private readonly maxOutputBytes: number;
  private readonly opener: TerminalOpener;
  private connection: TerminalConnection | null = null;
  private generation = 0;
  private state: TerminalControllerState = {
    output: new Uint8Array(),
    status: "closed",
    truncated: false,
  };

  public constructor(options: TerminalControllerOptions) {
    this.createSession = options.createSession;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1) {
      throw new Error("终端输出上限无效");
    }
    this.opener = options.opener;
  }

  public async open(): Promise<void> {
    const generation = ++this.generation;
    this.connection?.close();
    this.connection = null;
    this.update({output: new Uint8Array(), status: "connecting", truncated: false});
    try {
      const session = await this.createSession();
      if (generation !== this.generation) return;
      const connection = await this.opener.open(session, {
        onClose: (reason) => {
          if (generation !== this.generation) return;
          this.connection = null;
          this.update({
            ...(reason === "error" ? {error: "终端连接已异常关闭"} : {}),
            status: reason === "error" ? "error" : "closed",
          });
        },
        onError: (error) => {
          if (generation !== this.generation) return;
          this.update({error: error.message, status: "error"});
        },
        onOutput: (data) => {
          if (generation === this.generation) this.appendOutput(data);
        },
      });
      if (generation !== this.generation) {
        connection.close();
        return;
      }
      this.connection = connection;
      this.update({error: undefined, status: "ready"});
    } catch (error) {
      if (generation !== this.generation) return;
      this.connection = null;
      this.update({
        error: error instanceof Error ? error.message : "终端连接失败",
        status: "error",
      });
    }
  }

  public close(): void {
    this.generation += 1;
    const connection = this.connection;
    this.connection = null;
    connection?.close();
    this.update({error: undefined, status: "closed"});
  }

  public resize(cols: number, rows: number): void {
    this.requireConnection().resize(cols, rows);
  }

  public sendControl(key: TerminalControlKey): void {
    this.requireConnection().write(controlBytes[key]);
  }

  public snapshot(): TerminalControllerState {
    return this.state;
  }

  public submitLine(value: string): void {
    this.writeText(`${value}\r`);
  }

  public subscribe(
    listener: (state: TerminalControllerState) => void,
  ): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  public write(data: Uint8Array): void {
    if (data.byteLength === 0) return;
    this.requireConnection().write(data);
  }

  public writeText(value: string): void {
    if (!value) return;
    this.write(new TextEncoder().encode(value));
  }

  private appendOutput(data: Uint8Array): void {
    if (data.byteLength === 0) return;
    const combined = new Uint8Array(this.state.output.byteLength + data.byteLength);
    combined.set(this.state.output);
    combined.set(data, this.state.output.byteLength);
    const truncated = combined.byteLength > this.maxOutputBytes;
    const output = truncated
      ? combined.slice(combined.byteLength - this.maxOutputBytes)
      : combined;
    this.update({output, truncated: this.state.truncated || truncated});
  }

  private requireConnection(): TerminalConnection {
    if (!this.connection || this.state.status !== "ready") {
      throw new Error("终端尚未就绪");
    }
    return this.connection;
  }

  private update(patch: Partial<TerminalControllerState>): void {
    const next = {...this.state, ...patch};
    if (patch.error === undefined && "error" in patch) {
      delete next.error;
    }
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}

const controlBytes: Record<TerminalControlKey, Uint8Array> = {
  arrow_down: Uint8Array.from([0x1b, 0x5b, 0x42]),
  arrow_left: Uint8Array.from([0x1b, 0x5b, 0x44]),
  arrow_right: Uint8Array.from([0x1b, 0x5b, 0x43]),
  arrow_up: Uint8Array.from([0x1b, 0x5b, 0x41]),
  ctrl_c: Uint8Array.from([0x03]),
  tab: Uint8Array.from([0x09]),
};
