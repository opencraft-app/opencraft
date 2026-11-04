import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { unlink, readFile, readdir, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { chmod } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import type { CodexAccountService } from "@opencraft/account-pool-host";

/** A real socket outside PrivateTmp; native may publish an alias into its own /tmp. */
export async function nativeSocketRelay(endpoint: string, target: string) {
  await removeStaleSocket(endpoint);
  const connections = new Set<Socket>();
  const server = createServer(client => {
    const upstream = connect(target);
    connections.add(client); connections.add(upstream);
    for (const socket of [client, upstream]) {
      socket.on("close", () => { connections.delete(socket); client.destroy(); upstream.destroy(); });
      socket.on("error", () => { client.destroy(); upstream.destroy(); });
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, () => { server.off("error", reject); resolve(); }); });
  try { await chmod(endpoint, 0o600); }
  catch (reason) { server.close(); await unlink(endpoint).catch(() => {}); throw reason; }
  return { async close() {
    for (const socket of connections) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(endpoint).catch(() => {});
  } };
}

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


/** Raise inherited immunity parent-first, including a CLI launcher's native child.
 * Never lower a tool that the external guard has already assigned score 0.
 */
export async function makeNativeFamilyKillable(rootPid: number): Promise<void> {
  const pending = [rootPid], seen = new Set<number>();
  while (pending.length) {
    const pid = pending.pop()!;
    if (seen.has(pid) || pid === process.pid) continue;
    seen.add(pid);
    try {
      if ((await readFile(`/proc/${pid}/oom_score_adj`, "utf8")).trim() === "-1000") await writeFile(`/proc/${pid}/oom_score_adj`, "-999");
      // Future children inherit the new score; include earlier children forked
      // on every worker thread, including the npm launcher's native process.
      for (const task of await readdir(`/proc/${pid}/task`)) {
        try {
          for (const child of (await readFile(`/proc/${pid}/task/${task}/children`, "utf8")).trim().split(/\s+/u).filter(Boolean)) pending.push(Number(child));
        } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      }
    } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
}
