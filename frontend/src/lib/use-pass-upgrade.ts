import { useCallback, useEffect, useState } from "react";
import type { Pass, PassModifyOption } from "@/domain/types";
import { useRepositories } from "@/contexts/repository-context";
import { readUpgradeCheckout, saveUpgradeCheckout, type UpgradeCheckoutRecord } from "@/lib/upgrade-checkout";

const isActive = (pass: Pass) => pass.status === "active" && !pass.deleted_time && !pass.isolated_time && Date.parse(pass.expired_time) > Date.now();
const empty = { pass: null, options: [], resume: null, error: false, loading: false };
type UpgradeResume = { pass: Pass; record: UpgradeCheckoutRecord };

/** Eligibility is display guidance only; the order endpoint rechecks instance state. */
export function usePassUpgrade({ userId, passId, enabled, currentPass }: {
  userId?: string;
  passId?: string;
  enabled: boolean;
  currentPass?: Pass | null;
}) {
  const { plans } = useRepositories();
  const { listMyPasses, listModifyBundles, getModifyCheckout } = plans;
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const currentInvalid = currentPass != null && (currentPass.user_id !== userId || !isActive(currentPass));
  const key = JSON.stringify([userId, passId, enabled, currentPass?.pass_id, currentPass?.bundle_id, currentPass?.status, currentPass?.expired_time, currentPass?.isolated_time, currentPass?.deleted_time, currentPass?.updated_time, currentInvalid, attempt]);
  const [state, setState] = useState<{ key: string; pass: Pass | null; options: PassModifyOption[]; resume: UpgradeResume | null; error: boolean; loading: boolean }>({ key: "", ...empty });
  const canLoad = enabled && !!userId;

  useEffect(() => {
    if (!canLoad) return;
    let cancelled = false;
    setState({ key, ...empty, loading: true });
    void (async () => {
      let resume: UpgradeResume | null = null;
      try {
        const own = (await listMyPasses()).filter((pass) => pass.user_id === userId && !pass.deleted_time && pass.status !== "deleted");
        const active = own.filter(isActive);
        const pass = passId ? own.find((p) => p.pass_id === passId) : active.length === 1 ? active[0] : own.length === 1 ? own[0] : undefined;
        if (!pass) {
          if (!cancelled) setState({ key, ...empty });
          return;
        }
        const record = readUpgradeCheckout(window.localStorage, userId!, pass.pass_id);
        resume = record ? { pass, record } : null;
        const { checkout } = await getModifyCheckout(pass.pass_id);
        if (cancelled) return;
        if (checkout) {
          if (!checkout.target_bundle_id || !checkout.deal_name) throw new Error("Invalid upgrade checkout");
          const recovered: UpgradeCheckoutRecord = { phase: "ordered", targetBundleId: checkout.target_bundle_id, dealName: checkout.deal_name };
          // The modal reads this same non-secret record, including on a newly signed-in device.
          saveUpgradeCheckout(window.localStorage, userId!, pass.pass_id, recovered);
          resume = { pass, record: recovered };
        }
        if (!isActive(pass) || (currentInvalid && currentPass?.pass_id === pass.pass_id)) {
          if (!cancelled) setState({ key, ...empty, resume });
          return;
        }
        const result = await listModifyBundles(pass.pass_id);
        if (result.source_bundle_id !== pass.bundle_id) throw new Error("Upgrade source changed");
        const options = result.modify_bundle_set.filter((option) => option.target_bundle_id && option.target_bundle_id !== pass.bundle_id && option.bundle.bundle_id === option.target_bundle_id);
        if (!cancelled) setState({ key, pass, options, resume, loading: false, error: false });
      } catch {
        if (!cancelled) setState({ key, ...empty, resume, error: true });
      }
    })();
    return () => { cancelled = true; };
  }, [canLoad, key, passId, listMyPasses, listModifyBundles, getModifyCheckout, userId, currentInvalid, currentPass?.pass_id]);

  useEffect(() => {
    if (!canLoad || state.key !== key || !state.pass) return;
    const remaining = Date.parse(state.pass.expired_time) - Date.now();
    const timeout = window.setTimeout(retry, Math.max(0, Math.min(remaining, 2_147_483_647)));
    return () => window.clearTimeout(timeout);
  }, [canLoad, key, retry, state.key, state.pass]);

  const visible = canLoad && state.key === key && (!state.pass || isActive(state.pass)) ? state : { ...empty, loading: canLoad };
  return { ...visible, retry, revisionKey: key };
}
