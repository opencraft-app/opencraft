import { parentPort, workerData } from "node:worker_threads";
import webpush from "web-push";
import { PushStore } from "./store";
const store = new PushStore(workerData.path);
parentPort!.postMessage({ ready: true, outcome: store.outcome });
const methods = new Set([
  "keys",
  "get",
  "register",
  "master",
  "setMaster",
  "setEnabled",
  "saveTarget",
  "remove",
  "hasActor",
  "devices",
  "watch",
  "watches",
  "bindTurn",
  "retireWatch",
  "finish",
  "due",
  "settled",
  "retry",
  "prune",
  "close",
]);
parentPort!.on("message", ({ id, method, args }) => {
  try {
    if (!methods.has(method)) throw Error("invalid_store_method");
    const result =
      method === "keys"
        ? store.keys(() => webpush.generateVAPIDKeys())
        : Reflect.apply((store as unknown as Record<string, (...params: unknown[]) => unknown>)[method]!, store, args);
    parentPort!.postMessage({ id, result });
    if (method === "close") parentPort!.close();
  } catch {
    parentPort!.postMessage({ id, error: "notification_storage_unavailable" });
  }
});
