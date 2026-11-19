import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
export async function service(command, args, { cwd, log, env = {} }) {
  const child = spawn(command, args, {
    cwd,
    env: { PATH: "/opt/opencraft/bin:/usr/bin:/bin", LANG: "C.UTF-8", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sink = createWriteStream(log, { flags: "a" });
  child.stderr.pipe(sink);
  let resolveFirst, rejectFirst;
  const first = new Promise((r, j) => {
    resolveFirst = r;
    rejectFirst = j;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (l) => {
    try {
      resolveFirst(JSON.parse(l));
    } catch {
      sink.write(l + "\n");
    }
  });
  child.on("error", rejectFirst);
  child.on("exit", (c) => rejectFirst(new Error("Service exit " + c)));
  let info;
  try {
    info = await Promise.race([
      first,
      new Promise((_, j) => {
        const t = setTimeout(() => j(new Error("Service startup timeout")), 180000);
        t.unref();
      }),
    ]);
  } catch (e) {
    child.kill("SIGKILL");
    throw e;
  }
  return {
    info,
    child,
    close: () => {
      child.kill("SIGTERM");
      sink.end();
    },
  };
}
export function rpc(command, args, { cwd, log, env = {} }) {
  const child = spawn(command, args, {
    cwd,
    env: { PATH: "/opt/opencraft/bin:/usr/bin:/bin", LANG: "C.UTF-8", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const sink = createWriteStream(log, { flags: "a" });
  child.stderr.pipe(sink);
  let id = 0;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (l) => {
    let v;
    try {
      v = JSON.parse(l);
    } catch {
      sink.write(l + "\n");
      return;
    }
    const p = pending.get(v.id);
    if (!p) {
      sink.write(l + "\n");
      return;
    }
    pending.delete(v.id);
    clearTimeout(p.timer);
    v.ok ? p.resolve(v.result) : p.reject(Object.assign(new Error(v.message ?? v.error), { code: v.error }));
  });
  const fail = (e) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    pending.clear();
  };
  child.stdin.on("error", fail);
  child.on("error", fail);
  child.on("exit", (c) => fail(new Error("RPC process exit " + c)));
  return {
    child,
    call: (value, timeoutMs = 600000) =>
      new Promise((resolve, reject) => {
        const key = ++id;
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error("RPC timeout"));
          child.kill("SIGKILL");
        }, timeoutMs);
        pending.set(key, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ ...value, id: key }) + "\n");
      }),
    close: async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          once(child, "exit"),
          new Promise((r) => {
            const t = setTimeout(() => {
              child.kill("SIGKILL");
              r();
            }, 3000);
            t.unref();
          }),
        ]);
      }
      sink.end();
    },
  };
}
