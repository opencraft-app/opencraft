import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Pass } from "@/domain/types";
import { accountPassCredits, ownedAccountPass } from "./account-pass-summary";

export interface AccountPassSummaryOptions {
  userId?: string;
  activePass: Pass | null;
  modifyingPass: Pass | null;
  paidBillingActive: boolean;
  global: boolean;
  enabled?: boolean;
  listMyPasses: () => Promise<Pass[]>;
}
type SummaryState = "ready" | "loading" | "error" | "none" | "idle";

/** Account owns refresh; this adapter only reads the original fallback and derives its quota. */
export function useAccountPassSummary({ userId, activePass, modifyingPass, paidBillingActive, global, enabled = true, listMyPasses }: AccountPassSummaryOptions) {
  const active = ownedAccountPass(userId, activePass);
  const modifying = ownedAccountPass(userId, modifyingPass);
  const canLoad = Boolean(userId) && enabled && (global || paidBillingActive);
  // Render-time scoping hides a previous owner's state before effect cleanup.
  const key = JSON.stringify([userId, active?.pass_id, active?.bundle_id, active?.status, active?.updated_time,
    modifying?.pass_id, modifying?.bundle_id, modifying?.status, modifying?.updated_time, canLoad]);
  // 相同账号再次进入也拥有新代次，旧成功回调不得清理新一轮数据或请求。
  const scope = useMemo(() => Symbol(key), [key]);
  const [fallback, setFallback] = useState<{ scope: symbol | null; pass: Pass | null; state: SummaryState }>({ scope: null, pass: null, state: "idle" });
  const request = useRef<{ scope: symbol; cancel: () => void } | null>(null);

  useEffect(() => {
    if (active || !canLoad) {
      setFallback({ scope, pass: null, state: "idle" });
      return;
    }
    let cancelled = false;
    const pending = { scope, cancel: () => { cancelled = true; } };
    request.current = pending;
    setFallback({ scope, pass: null, state: "loading" });
    void (async () => {
      try {
        const passes = await listMyPasses();
        if (cancelled) return;
        const first = passes.find((candidate) => ownedAccountPass(userId, candidate)) ?? null;
        setFallback({ scope, pass: first, state: first ? "ready" : "none" });
      } catch {
        if (!cancelled) setFallback({ scope, pass: null, state: "error" });
      }
    })();
    return () => {
      pending.cancel();
      if (request.current === pending) request.current = null;
    };
  }, [scope, canLoad, Boolean(active), userId, listMyPasses]);

  const clearFallback = useCallback(() => {
    if (request.current?.scope === scope) request.current.cancel();
    // A completed old account action cannot clear the new account's result.
    setFallback((current) => current.scope === scope ? { scope, pass: null, state: "none" } : current);
  }, [scope]);
  const visibleFallback = canLoad && fallback.scope === scope ? fallback : null;
  const pass = modifying ?? active ?? ownedAccountPass(userId, visibleFallback?.pass);
  const state: SummaryState = pass ? "ready" : !canLoad ? "idle" : visibleFallback?.state ?? "loading";
  return { pass, credits: accountPassCredits(pass), state, clearFallback };
}
