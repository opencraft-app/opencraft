import { useState, useEffect, useRef } from "react";
import { mergeGitConnections, type GitConnectionsSnapshot } from "./contract.js";
export function useGitConnectionController<
  S extends GitConnectionsSnapshot,
  I extends { host: string; revision: number; action: string },
>({
  scope,
  onUnauthorized,
  fetcher,
  endpoint,
  parse,
  merge = mergeGitConnections,
  errorText,
  namespaceOf,
}: {
  scope: string;
  onUnauthorized(): void;
  fetcher: typeof fetch;
  endpoint: string;
  parse(value: unknown, scope: string): S;
  merge?(before: S | null, next: S): S;
  errorText(code: string): string;
  namespaceOf?(input: I): string;
}) {
  const [snapshot, setSnapshot] = useState<S | null>(null),
    [operationErrors, setOperationErrors] = useState<Record<string, string>>({});
  const [operationCodes, setOperationCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [unauthorized, setUnauthorized] = useState(false);
  const snapshotRef = useRef<S | null>(null);
  const operations = useRef(new Set<AbortController>()),
    generation = useRef(0),
    latestRequests = useRef(new Map<string, number>());
  const load = async (input?: I) => {
    const namespace = input ? (namespaceOf?.(input) ?? `${input.host}:credentials`) : "read";
    const epoch = generation.current,
      requestId = (latestRequests.current.get(namespace) ?? 0) + 1;
    latestRequests.current.set(namespace, requestId);
    const reportError = (message: string, code = "") => {
      if (generation.current === epoch && latestRequests.current.get(namespace) === requestId) {
        setOperationCodes((previous) => ({ ...previous, [namespace]: code }));
        setOperationErrors((previous) => ({
          ...previous,
          [namespace]: message,
        }));
      }
    };
    const abort = new AbortController();
    operations.current.add(abort);
    setBusy(true);
    reportError("");
    const timer = setTimeout(() => abort.abort(), 30_000);
    try {
      const response = await fetcher(endpoint, {
        method: input ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: abort.signal,
        headers: {
          "x-opencraft-account-scope": scope,
          ...(input ? { "content-type": "application/json" } : {}),
        },
        ...(input ? { body: JSON.stringify(input) } : {}),
      });
      if (generation.current !== epoch || abort.signal.aborted) return false;
      if (response.status === 401 || response.status === 403) {
        // A denial retires every in-flight response for this account, not just
        // this request; a late successful read cannot restore its old metadata.
        ++generation.current;
        for (const operation of operations.current) operation.abort();
        operations.current.clear();
        setBusy(false);
        snapshotRef.current = null;
        setSnapshot(null);
        setUnauthorized(true);
        onUnauthorized();
        return false;
      }
      const body = await response.json();
      if (generation.current !== epoch || abort.signal.aborted) return false;
      if (!response.ok) {
        reportError(
          errorText(typeof body?.error === "string" ? body.error : "unavailable"),
          body?.error ?? "unavailable",
        );
        return false;
      }
      const next = merge(snapshotRef.current, parse(body, scope));
      snapshotRef.current = next;
      setSnapshot(next);
      return true;
    } catch {
      reportError(errorText("unavailable"));
      return false;
    } finally {
      clearTimeout(timer);
      operations.current.delete(abort);
      if (generation.current === epoch) setBusy(operations.current.size > 0);
    }
  };
  useEffect(() => {
    snapshotRef.current = null;
    latestRequests.current.clear();
    setSnapshot(null);
    setUnauthorized(false);
    setOperationErrors({});
    setOperationCodes({});
    void load();
    return () => {
      ++generation.current;
      for (const operation of operations.current) operation.abort();
      operations.current.clear();
    };
  }, [scope]);
  return {
    snapshot: snapshot?.scope === scope ? snapshot : null,
    busy,
    unauthorized,
    operationErrors,
    operationCodes,
    clearHostErrors(host: string) {
      setOperationErrors((previous) =>
        Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(host + ":"))),
      );
      setOperationCodes((previous) =>
        Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(host + ":"))),
      );
    },
    load,
    getSnapshot: () => (snapshotRef.current?.scope === scope ? snapshotRef.current : null),
  };
}
