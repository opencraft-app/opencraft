import { useEffect, useState } from "react";
import { serverFetch } from "./server-context";
import type { ServerInformationAuthority } from "./server-information";
export interface RelaySummary {
  readonly id: string;
  readonly name: string;
  readonly endpoint: string | null;
  readonly connected: boolean;
}
interface State {
  readonly actorId: string | null;
  readonly phase: "loading" | "ready" | "error" | "denied";
  readonly peers: readonly RelaySummary[];
}
export function relaySummary(value: unknown): readonly RelaySummary[] {
  if (
    !value ||
    typeof value !== "object" ||
    (value as any).schemaVersion !== 1 ||
    !Array.isArray((value as any).peers) ||
    (value as any).peers.length > 256
  )
    throw Error("invalid_relay_summary");
  const seen = new Set<string>();
  return (value as any).peers.map((peer: any) => {
    if (
      !peer ||
      typeof peer.id !== "string" ||
      !peer.id ||
      peer.id.length > 256 ||
      seen.has(peer.id) ||
      typeof peer.name !== "string" ||
      peer.name.length > 512 ||
      typeof peer.connected !== "boolean"
    )
      throw Error("invalid_relay_summary");
    seen.add(peer.id);
    if (peer.endpoint !== null) {
      if (typeof peer.endpoint !== "string" || peer.endpoint.length > 2048) throw Error("invalid_relay_summary");
      const url = new URL(peer.endpoint);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.origin !== peer.endpoint)
        throw Error("invalid_relay_summary");
    }
    return { id: peer.id, name: peer.name, endpoint: peer.endpoint, connected: peer.connected };
  });
}
export function useServerRelaySummary(authority: ServerInformationAuthority | null): State {
  const actorId = authority?.actorId ?? null,
    allowed = authority?.canManage === true;
  const [state, setState] = useState<State>({ actorId: null, phase: "loading", peers: [] });
  useEffect(() => {
    if (!actorId || !allowed) return;
    let alive = true,
      busy = false,
      request: AbortController | null = null;
    const read = async () => {
      if (busy) return;
      busy = true;
      const abort = (request = new AbortController()),
        deadline = setTimeout(() => abort.abort(), 10000);
      try {
        const response = await serverFetch("/__opencraft_hub/settings", {
          credentials: "same-origin",
          cache: "no-store",
          signal: abort.signal,
        });
        if (response.status === 401 || response.status === 403) {
          if (alive) setState({ actorId, phase: "denied", peers: [] });
          return;
        }
        if (!response.ok) throw Error("relay_unavailable");
        const peers = relaySummary(await response.json());
        if (alive) setState({ actorId, phase: "ready", peers });
      } catch {
        if (alive) setState({ actorId, phase: "error", peers: [] });
      } finally {
        clearTimeout(deadline);
        busy = false;
      }
    };
    setState({ actorId, phase: "loading", peers: [] });
    void read();
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void read();
    }, 30000);
    return () => {
      alive = false;
      request?.abort();
      clearInterval(timer);
    };
  }, [actorId, allowed]);
  return !actorId
    ? { actorId: null, phase: "loading", peers: [] }
    : !allowed
      ? { actorId, phase: "denied", peers: [] }
      : state.actorId === actorId
        ? state
        : { actorId, phase: "loading", peers: [] };
}
