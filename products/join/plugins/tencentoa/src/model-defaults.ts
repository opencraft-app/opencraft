import { parseAccountModelDefaultsRecord, type AccountModelDefaultsPort, type AccountModelSelection } from "@opencraft/workbench-runtime";
import { TENCENTOA_MODEL_DEFAULTS_PATH } from "./contract";

export function createTencentOaModelDefaults(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): AccountModelDefaultsPort {
  async function request(scope: string, hostId: string, signal: AbortSignal, write?: { revision: number; selection: AccountModelSelection }) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    const timer = setTimeout(abort, 10_000);
    try {
      const response = await fetcher(`${TENCENTOA_MODEL_DEFAULTS_PATH}?hostId=${encodeURIComponent(hostId)}`, {
        method: write ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { "x-opencraft-account-scope": scope, ...(write ? { "content-type": "application/json" } : {}) },
        ...(write ? { body: JSON.stringify(write) } : {}),
      });
      if (!response.ok) throw new Error(response.status === 409 ? "Model defaults changed; retry your selection" : "Account model defaults unavailable");
      const value = await response.json();
      if (value?.scope !== scope || value?.hostId !== hostId) throw new Error("Model defaults account changed");
      return parseAccountModelDefaultsRecord(value.record);
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }
  return { read: (scope, host, signal) => request(scope, host, signal),
    write: (scope, host, revision, selection, signal) => request(scope, host, signal, { revision, selection }) };
}
