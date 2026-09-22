import { motion, useInView, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { useRepositories } from "@/contexts/repository-context";
import { Button } from "@/components/ui/button";
import type { Pass } from "@/domain/types";
import { useT } from "@/i18n/t";
import { assetUrl } from "@/lib/asset-url";
import { formatPassDate } from "@/lib/pass-renewal";
import { UPGRADE_POLL_INTERVAL_MS } from "@/lib/upgrade-checkout";

/** Reuses the creation screen's coffee artwork while keeping the Pass visible. */
export function AgentUpgradingView({ pass, failed = false, paused = false, refreshing = false, onRetry }: {
  pass: Pass | null;
  failed?: boolean;
  paused?: boolean;
  refreshing?: boolean;
  onRetry?: () => void;
}) {
  const t = useT();
  const { plans: { getModifyCheckout, listBundles } } = useRepositories();
  const passId = pass?.pass_id;
  const targetKey = JSON.stringify([pass?.user_id, passId]);
  const [target, setTarget] = useState<{ key: string; name: string } | null>(null);
  const targetName = target?.key === targetKey ? target.name : null;
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const reduceMotion = useReducedMotion();
  const animate = inView && !reduceMotion && !failed && !paused;
  const showRecovery = paused || refreshing;
  const showUpgradeTitle = Boolean(pass) && !failed && !paused;

  useEffect(() => {
    if (!passId || paused || failed) return;
    let cancelled = false;
    let retry: number | undefined;
    const loadTarget = async () => {
      try {
        // The modifying Pass still describes the old plan. Resolve display metadata
        // from its upgrade order; this must not affect payment/delivery checks.
        const [result, bundles] = await Promise.all([getModifyCheckout(passId), listBundles()]);
        if (cancelled) return;
        const name = bundles.find(bundle => bundle.bundle_id === result.checkout?.target_bundle_id)?.bundle_name;
        if (name) {
          setTarget({ key: targetKey, name });
          return;
        }
      } catch { /* Keep the target unknown and retry without blocking upgrade progress. */ }
      if (!cancelled) retry = window.setTimeout(() => { void loadTarget(); }, UPGRADE_POLL_INTERVAL_MS);
    };
    void loadTarget();
    return () => { cancelled = true; window.clearTimeout(retry); };
  }, [getModifyCheckout, listBundles, passId, targetKey, paused, failed]);

  return (
    <div ref={ref} className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-16 md:py-20">
      <motion.div
        aria-hidden="true"
        animate={animate ? { y: [0, -6, 0] } : { y: 0 }}
        transition={animate ? { duration: 2.4, repeat: Infinity, ease: "easeInOut" } : { duration: 0 }}
        className="mb-4 size-[78px] overflow-hidden"
        style={{
          backgroundImage: `url(${assetUrl("/hermes-loading.png")})`,
          backgroundRepeat: "no-repeat",
          backgroundPosition: "0 0",
          backgroundSize: "156px 156px",
        }}
      />
      <div role="status" aria-live="polite" className="text-center">
        <h2 className="text-balance text-base font-semibold text-[var(--text-primary)]">
          {failed ? t("套餐升级失败") : paused ? t("暂时无法确认升级进度") : pass ? t("正在升级您的 LightVela 套餐") : t("正在确认套餐升级状态")}
          {showUpgradeTitle && (
            <span aria-hidden="true" className="inline-flex">
              {[0, 1, 2].map(index => (
                <motion.span
                  key={index}
                  animate={animate ? { opacity: [0.25, 1, 0.25] } : { opacity: 1 }}
                  transition={animate ? { duration: 1.2, repeat: Infinity, delay: index * 0.2 } : { duration: 0 }}
                >
                  .
                </motion.span>
              ))}
            </span>
          )}
        </h2>
        <p className="mt-2 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
          {failed ? t("订单已关闭或失败，请联系支持确认后再操作。") : paused ? t("已暂停自动查询，请刷新状态或联系支持，避免重复付款。") : pass ? t("套餐升级中，完成后将自动展示 Agent。") : t("暂时无法确认订单状态，请稍后查询，避免重复付款。")}
        </p>
      </div>
      {pass && <dl className="mt-6 w-full space-y-4 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-4 text-sm">
        <div className="flex items-start justify-between gap-4">
          <dt className="shrink-0 text-[var(--text-secondary)]">{t("目标套餐")}</dt>
          <dd className="min-w-0 break-words text-right font-medium text-[var(--text-primary)]">{targetName ? t(targetName) : "—"}</dd>
        </div>
        <div className="flex items-start justify-between gap-4">
          <dt className="shrink-0 text-[var(--text-secondary)]">{t("到期时间")}</dt>
          <dd className="text-right tabular-nums text-[var(--text-primary)]">{formatPassDate(pass.expired_time)}</dd>
        </div>
      </dl>}
      {showRecovery && <div className="mt-6 flex w-full flex-col items-center gap-3">
        <Button type="button" variant="outline" className="w-full rounded-lg transition-colors duration-150" disabled={refreshing} aria-busy={refreshing} onClick={onRetry}>
          {refreshing ? t("刷新中...") : t("刷新状态")}
        </Button>
        <a href="mailto:lightvela@tencent.com" className="rounded text-sm text-[var(--text-secondary)] underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">{t("联系支持")}</a>
      </div>}
      {!failed && !showRecovery && pass && <p className="mt-3 text-center text-pretty text-xs leading-5 text-[var(--text-secondary)]">
        {t("套餐信息将在升级完成后更新，到期时间不变。")}
      </p>}
    </div>
  );
}
