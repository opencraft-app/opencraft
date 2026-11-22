import { spawn } from "node:child_process";

// Only the Linux smoke harness owns this new process group. Never pass an
// existing application or service process into this lifecycle.
export function startHeadlessSmokeProcess(file, args, options) {
  if (process.platform !== "linux") throw new Error("Headless smoke process groups require Linux");
  const child = spawn(file, args, { ...options, detached: true });
  const closed = new Promise(resolve => child.once("close", resolve));
  let closing;
  const signal = name => {
    if (!child.pid) return;
    try { process.kill(-child.pid, name); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  return {
    child,
    close() {
      return closing ??= (async () => {
        let timeout;
        try {
          signal("SIGTERM");
          await Promise.race([
            closed,
            new Promise((resolve, reject) => {
              timeout = setTimeout(() => {
                try { signal("SIGKILL"); closed.then(resolve, reject); }
                catch (error) { reject(error); }
              }, 5_000);
            }),
          ]);
        } finally {
          clearTimeout(timeout);
          // A closed leader can leave descendants with ignored stdio behind.
          signal("SIGKILL");
        }
      })();
    },
  };
}
