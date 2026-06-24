import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RuntimeLogger {
  write(source: string, message: string): void;
}

export class RotatingLogWriter implements RuntimeLogger {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(path: string, maxBytes: number, maxFiles: number) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    mkdirSync(dirname(path), { recursive: true });
  }

  write(source: string, message: string) {
    const lines = message
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return;
    const timestamp = new Date().toISOString();
    const payload = lines.map((line) => `${timestamp} ${source} ${line}`).join("\n") + "\n";
    this.rotateIfNeeded(Buffer.byteLength(payload));
    appendFileSync(this.path, payload);
  }

  private rotateIfNeeded(incomingBytes: number) {
    const currentBytes = existsSync(this.path) ? statSync(this.path).size : 0;
    if (currentBytes + incomingBytes <= this.maxBytes) return;

    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const from = `${this.path}.${index}`;
      const to = `${this.path}.${index + 1}`;
      if (existsSync(to)) rmSync(to, { force: true });
      if (existsSync(from)) renameSync(from, to);
    }
    if (existsSync(this.path)) renameSync(this.path, `${this.path}.1`);
  }
}

export function runtimeLogPath(userDataPath: string) {
  return join(userDataPath, "logs", "vela-desktop.log");
}
