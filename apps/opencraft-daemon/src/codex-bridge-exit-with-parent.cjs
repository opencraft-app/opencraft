// Preloaded into each Codex bridge stack child: the daemon holds the child's
// stdin open for its whole life. When it closes (the daemon exited, even by
// crash), the child stops through its own graceful SIGTERM path.
"use strict";
// Preloads also run in worker threads, whose stdin is empty; only the main thread watches.
if (require("node:worker_threads").isMainThread) {
  const stop = () => process.kill(process.pid, "SIGTERM");
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  process.stdin.once("error", stop);
  process.stdin.resume();
  process.stdin.unref?.();
}
