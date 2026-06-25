import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type MacosSpeechEvent =
  | { type: "state"; state: "idle" | "requesting-permission" | "listening" | "stopping" | "error" }
  | { type: "partial_transcript"; text: string }
  | { type: "final_transcript"; text: string }
  | { type: "error"; code: string; message: string };

export interface MacosSpeechStartOptions {
  language?: string;
  interimResults?: boolean;
}

export interface MacosSpeechLogger {
  write(source: string, message: string): void;
}

export interface MacosSpeechManagerOptions {
  appPath: string;
  resourcesPath: string;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  logger: MacosSpeechLogger;
  env?: NodeJS.ProcessEnv;
  helperPath?: string;
  spawnImpl?: typeof spawn;
}

export class MacosSpeechManager {
  private readonly appPath: string;
  private readonly resourcesPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly isPackaged: boolean;
  private readonly logger: MacosSpeechLogger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly helperPath?: string;
  private readonly spawnImpl: typeof spawn;
  private child: ChildProcessWithoutNullStreams | null = null;
  private listeners = new Set<(event: MacosSpeechEvent) => void>();

  constructor(options: MacosSpeechManagerOptions) {
    this.appPath = options.appPath;
    this.resourcesPath = options.resourcesPath;
    this.platform = options.platform;
    this.isPackaged = options.isPackaged;
    this.logger = options.logger;
    this.env = options.env ?? process.env;
    this.helperPath = options.helperPath;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  isAvailable() {
    return this.platform === "darwin" && this.isEnabledForRuntime() && existsSync(this.resolveHelperPath());
  }

  start(options: MacosSpeechStartOptions = {}) {
    if (!this.isAvailable()) {
      this.logger.write("[macos-speech]", `unavailable: ${this.unavailableReason()}`);
      this.emit({
        type: "error",
        code: "macos_speech_unavailable",
        message: "macOS Speech helper is unavailable.",
      });
      return { accepted: false };
    }
    if (this.child) return { accepted: true };

    const args = ["--language", options.language || "en-US"];
    this.logger.write("[macos-speech]", `starting helper ${this.resolveHelperPath()}`);
    const child = this.spawnImpl(this.resolveHelperPath(), args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.attachChild(child);
    return { accepted: true };
  }

  stop() {
    const child = this.child;
    if (!child) return { accepted: false };
    try {
      child.stdin.write("stop\n");
    } catch {
      child.kill();
    }
    return { accepted: true };
  }

  onEvent(listener: (event: MacosSpeechEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private resolveHelperPath() {
    if (this.helperPath) return this.helperPath;
    if (this.platform === "win32") return join(this.resourcesPath, "bin", "vela-speech-macos.exe");
    const packagedPath = join(this.resourcesPath, "bin", "vela-speech-macos");
    if (existsSync(packagedPath)) return packagedPath;
    return join(this.appPath, "native", "macos-speech", "build", "vela-speech-macos");
  }

  private isEnabledForRuntime() {
    return this.isPackaged || this.env.VELA_DESKTOP_ENABLE_DEV_MACOS_SPEECH === "1";
  }

  private unavailableReason() {
    if (this.platform !== "darwin") return `platform=${this.platform}`;
    if (!this.isEnabledForRuntime()) {
      return "disabled in dev; set VELA_DESKTOP_ENABLE_DEV_MACOS_SPEECH=1 to test native macOS Speech";
    }
    return `helper missing at ${this.resolveHelperPath()}`;
  }

  private attachChild(child: ChildProcessWithoutNullStreams) {
    let stdoutBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line) this.handleStdoutLine(line);
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.logger.write("[macos-speech:stderr]", chunk.trimEnd());
    });
    child.on("error", (error) => {
      this.emit({
        type: "error",
        code: "macos_speech_spawn_failed",
        message: error.message,
      });
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      this.logger.write(
        "[macos-speech]",
        `helper exited code=${code ?? "null"} signal=${signal ?? "null"}`,
      );
      this.emit({ type: "state", state: "idle" });
    });
  }

  private handleStdoutLine(line: string) {
    try {
      const event = parseMacosSpeechEvent(JSON.parse(line));
      if (event) {
        this.logEvent(event);
        this.emit(event);
      }
    } catch (error) {
      this.logger.write(
        "[macos-speech]",
        `ignored invalid helper event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private emit(event: MacosSpeechEvent) {
    this.listeners.forEach((listener) => listener(event));
  }

  private logEvent(event: MacosSpeechEvent) {
    if (event.type === "state") {
      this.logger.write("[macos-speech]", `state=${event.state}`);
      return;
    }
    if (event.type === "error") {
      this.logger.write("[macos-speech]", `error code=${event.code} message=${event.message}`);
      return;
    }
    this.logger.write("[macos-speech]", `${event.type} length=${event.text.length}`);
  }
}

export function parseMacosSpeechEvent(value: unknown): MacosSpeechEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (event.type === "state") {
    const state = event.state;
    if (
      state === "idle" ||
      state === "requesting-permission" ||
      state === "listening" ||
      state === "stopping" ||
      state === "error"
    ) {
      return { type: "state", state };
    }
  }
  if (event.type === "partial_transcript" || event.type === "final_transcript") {
    return typeof event.text === "string" ? { type: event.type, text: event.text } : null;
  }
  if (event.type === "error") {
    return {
      type: "error",
      code: typeof event.code === "string" ? event.code : "macos_speech_error",
      message: typeof event.message === "string" ? event.message : "macOS speech failed.",
    };
  }
  return null;
}
