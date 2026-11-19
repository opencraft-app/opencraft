// Stable phase-1 import path. All implementation lives in its owning layer.
export { LocalRunner as Runner } from "./runtime/local-runner.mjs";
export { request } from "./adapters/local/unix-socket.mjs";
