import { createStdioPeer } from "../adapters/local/stdio-peer.mjs";
import { createAssistantSession } from "./assistant-session.mjs";
/** stdout is protocol-only; diagnostics use stderr. EOF retires this runtime. */
export function serveAssistant() {
  let session;
  let closing;
  let timer;
  let accepting = true;
  const done = () => {
    clearTimeout(timer);
    peer.close();
    process.stdin.destroy();
    process.stdout.end();
  };
  const stop = () => {
    if (closing) return;
    closing = true;
    accepting = false;
    timer = setTimeout(() => process.exit(1), 5000);
    timer.unref();
    void session.close().catch(() => {
      process.exitCode = 1;
      done();
    });
  };
  const peer = createStdioPeer({
    input: process.stdin,
    output: process.stdout,
    handle: (method, params) => {
      if (!accepting) throw Error("Assistant stopping");
      if (method === "shutdown") {
        accepting = false;
        setImmediate(stop);
        return {};
      }
      return session.handle(method, params);
    },
    onClose: stop,
  });
  session = createAssistantSession(peer, done);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
serveAssistant();
