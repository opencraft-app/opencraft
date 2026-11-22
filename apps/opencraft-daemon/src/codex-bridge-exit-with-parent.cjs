// Preloaded into each Codex bridge stack child: the daemon holds the child's
// stdin open for its whole life. When it closes (the daemon exited, even by
// crash), the child stops through its own graceful SIGTERM path.
"use strict";
// Preloads also run in worker threads, whose stdin is empty; only the main thread watches.
if (require("node:worker_threads").isMainThread) {
  // The child's own SIGTERM handlers run its graceful shutdown; emitting the event (rather than
  // signalling) works where SIGTERM cannot be caught (Windows). Without a handler, exit after a grace.
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (process.listenerCount("SIGTERM") > 0) process.emit("SIGTERM", "SIGTERM");
    setTimeout(() => process.exit(0), 20_000).unref();
  };
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  process.stdin.once("error", stop);
  process.stdin.resume();
  process.stdin.unref?.();
}
