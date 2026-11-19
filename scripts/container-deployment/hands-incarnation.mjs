import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

/** This probe creates no execution lease. The private socket is owned by Hands. */
export function readHandsIncarnation(endpoint, { signal, timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let buffered = "",
      finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const aborted = () => finish(new Error("Hands probe cancelled"));
    const timer = setTimeout(() => finish(new Error("Hands probe timed out")), timeoutMs);
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(new Error("Hands probe ended without identity")));
    socket.once("connect", () => socket.write(JSON.stringify({ type: "probe", protocol: 1 }) + "\n"));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += chunk;
      if (buffered.length > 65536) {
        finish(new Error("Hands probe exceeds its budget"));
        return;
      }
      const end = buffered.indexOf("\n");
      if (end < 0) return;
      try {
        const value = JSON.parse(buffered.slice(0, end));
        if (
          value.type !== "healthy" ||
          value.protocol !== 1 ||
          typeof value.incarnation !== "string" ||
          !/^[a-zA-Z0-9-]{16,80}$/u.test(value.incarnation)
        )
          throw new Error("Hands owner identity is unavailable");
        finish(null, value.incarnation);
      } catch (error) {
        finish(error);
      }
    });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

/** Replace only after a ready, different owner is observed. A timeout alone is
 * not evidence for replacing a writer. Never replay commands or conversation input. */
export async function watchHandsIncarnation({ initial, probe, replace, signal, intervalMs = 1000 }) {
  let current = initial;
  while (!signal.aborted) {
    let observed;
    try {
      observed = await probe();
    } catch {
      /* Provider unavailable: keep the last confirmed owner identity. */
    }
    if (signal.aborted) return;
    if (observed && observed !== current) {
      await replace(observed);
      if (signal.aborted) return;
      current = observed;
    }
    try {
      await delay(intervalMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
