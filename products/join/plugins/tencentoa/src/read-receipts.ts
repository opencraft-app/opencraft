import { parseThreadReadReceipts, type ThreadReadReceiptPort } from "@opencraft/workbench-runtime";
import { TENCENTOA_READ_RECEIPTS_PATH } from "./contract";

export function createTencentOaReadReceipts(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): ThreadReadReceiptPort {
  async function request(scope: string, signal: AbortSignal, receipts?: readonly string[]) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    const timer = setTimeout(abort, 10_000);
    try {
      const response = await fetcher(TENCENTOA_READ_RECEIPTS_PATH, {
        method: receipts ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { "x-opencraft-read-scope": scope, ...(receipts ? { "content-type": "application/json" } : {}) },
        ...(receipts ? { body: JSON.stringify({ receipts }) } : {}),
      });
      if (!response.ok) throw new Error("Account read state unavailable");
      const value = await response.json();
      if (value?.scope !== scope) throw new Error("Read state account changed");
      return parseThreadReadReceipts(value.receipts);
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }
  return { read: (scope, signal) => request(scope, signal), merge: (scope, receipts, signal) => request(scope, signal, receipts) };
}
