import type { VeladFetch } from "./wire";

const MISSING_FETCH_TRANSPORT_MESSAGE =
  "No velad fetch transport is available in this runtime; pass a VeladFetch to createVeladClient({ baseUrl, fetch }) and createFetchVelaEventStreamTransport(veladFetch).";

export function resolveVeladFetch(fetchImpl?: VeladFetch): VeladFetch {
  if (fetchImpl) return fetchImpl;
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis) as VeladFetch;
  }
  return async () => {
    throw new Error(MISSING_FETCH_TRANSPORT_MESSAGE);
  };
}
