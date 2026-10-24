import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { unlink } from "node:fs/promises";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import type { CodexAccountService } from "@opencraft/account-pool-host";

export async function removeStaleSocket(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path);
    socket.setTimeout(1_000);
    socket.once("connect", () => { socket.destroy(); reject(new Error(`Socket already has a listener: ${path}`)); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error(`Socket probe timed out: ${path}`)); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
  await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}

export async function nativeReady(path: string, child: ChildProcessWithoutNullStreams,
  auth: ReturnType<CodexAccountService["launch"]>["auth"]): Promise<WebSocket> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Codex AppServer exited during startup");
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`ws+unix://${path}:/`, { handshakeTimeout: 500 });
        const timer = setTimeout(() => { socket.terminate(); reject(new Error("Native initialize timed out")); }, 1_000);
        socket.on("error", error => { clearTimeout(timer); reject(error); });
        socket.on("close", () => { clearTimeout(timer); reject(new Error("Native connection closed during initialize")); });
        socket.on("open", () => socket.send(JSON.stringify({ id: 1, method: "initialize",
          params: { clientInfo: { name: "opencraft-core-health", version: "1" }, capabilities: { experimentalApi: true } } })));
        socket.on("message", data => {
          try {
            const value = JSON.parse(String(data));
            if (value.method === "account/chatgptAuthTokens/refresh" && value.id !== undefined) {
              const { type: _type, ...result } = auth;
              socket.send(JSON.stringify({ id: value.id, result }));
              return;
            }
            if (value.id !== 1 && value.id !== 2) return;
            if (value.error) { clearTimeout(timer); socket.terminate(); reject(new Error("Native authentication initialization rejected")); }
            else if (value.id === 1) {
              socket.send(JSON.stringify({ method: "initialized" }));
              socket.send(JSON.stringify({ id: 2, method: "account/login/start", params: auth }));
              return;
            } else { clearTimeout(timer); resolve(socket); }
          } catch (error) { clearTimeout(timer); socket.terminate(); reject(error); }
        });
      });
    } catch { await delay(50); }
  }
  throw new Error("Codex AppServer Unix listener did not become ready");
}
