import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";

import type { CodexMaintenanceClient } from "./codex-auth.js";

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export async function createCodexMaintenanceClient(options: {
  readonly executable: string;
  readonly codexHome: string;
  readonly requestTimeoutMs?: number;
}): Promise<CodexMaintenanceClient> {
  await mkdir(options.codexHome, { recursive: true, mode: 0o700 });
  const child = spawn(options.executable, [
    "app-server",
    "--stdio",
    "-c", 'cli_auth_credentials_store="file"',
  ], {
    cwd: options.codexHome,
    env: {
      ...process.env,
      CODEX_HOME: options.codexHome,
      OPENAI_API_KEY: undefined,
      CODEX_API_KEY: undefined,
      CODEX_ACCESS_TOKEN: undefined,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, PendingRequest>();
  const listeners = new Set<(method: string, params: unknown) => void>();
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  let sequence = 0;
  let closed = false;
  let stderrTail = "";
  child.stderr.on("data", chunk => { stderrTail = `${stderrTail}${String(chunk)}`.slice(-4_000); });
  const lines = createInterface({ input: child.stdout });
  const fail = (error: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  lines.on("line", line => {
    let value: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      value = parsed as Record<string, unknown>;
    } catch { return; }
    if (typeof value.id === "number" && ("result" in value || "error" in value)) {
      const request = pending.get(value.id);
      if (request === undefined) return;
      pending.delete(value.id);
      clearTimeout(request.timer);
      if (value.error && typeof value.error === "object") {
        const message = (value.error as Record<string, unknown>).message;
        request.reject(new Error(typeof message === "string" ? message : "Codex maintenance request failed"));
      } else request.resolve(value.result);
      return;
    }
    if (typeof value.method === "string" && !("id" in value)) {
      for (const listener of listeners) listener(value.method, value.params);
    }
  });
  child.once("error", error => fail(error));
  child.once("close", (code, signal) => {
    if (!closed) fail(new Error(`Codex maintenance process exited (${code ?? signal ?? "unknown"})${stderrTail ? `: ${stderrTail}` : ""}`));
  });

  const request = <T>(method: string, params: unknown): Promise<T> => {
    if (closed || child.stdin.destroyed) return Promise.reject(new Error("Codex maintenance process is closed"));
    const id = ++sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex maintenance request timed out: ${method}`));
      }, requestTimeoutMs);
      timer.unref();
      pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (!error) return;
        const current = pending.get(id);
        if (current === undefined) return;
        pending.delete(id);
        clearTimeout(current.timer);
        reject(error);
      });
    });
  };

  const client: CodexMaintenanceClient = {
    request,
    subscribeNotification(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() {
      if (closed) return;
      closed = true;
      lines.close();
      fail(new Error("Codex maintenance process closed"));
      listeners.clear();
      child.stdin.end();
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
        timer.unref();
        child.once("close", () => { clearTimeout(timer); resolve(); });
        child.kill("SIGTERM");
      });
    },
  };
  try {
    await request("initialize", {
      clientInfo: { name: "opencraft-account-pool", version: "0.1.0", title: "OpenCraft" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
