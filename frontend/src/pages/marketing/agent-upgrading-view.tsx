import { motion, useInView, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { useRepositories } from "@/contexts/repository-context";
import type { Pass } from "@/domain/types";
import { useT } from "@/i18n/t";
import { assetUrl } from "@/lib/asset-url";
import { formatPassDate } from "@/lib/pass-renewal";

/** Reuses the creation screen's coffee artwork while keeping the Pass visible. */
export function AgentUpgradingView({ pass, failed = false }: { pass: Pass; failed?: boolean }) {
  const t = useT();
  const { plans: { getModifyCheckout, listBundles } } = useRepositories();
  const targetKey = JSON.stringify([pass.user_id, pass.pass_id]);
  const [target, setTarget] = useState<{ key: string; name: string } | null>(null);
  const targetName = target?.key === targetKey ? target.name : null;
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const reduceMotion = useReducedMotion();
  const animate = inView && !reduceMotion && !failed;

  useEffect(() => {
    let cancelled = false;
    let retry: number | undefined;
    const loadTarget = async () => {
      try {
        // The modifying Pass still describes the old plan. Resolve display metadata
        // from its upgrade order; this must not affect payment/delivery checks.
        const [result, bundles] = await Promise.all([getModifyCheckout(pass.pass_id), listBundles()]);
        if (cancelled) return;
        const name = bundles.find(bundle => bundle.bundle_id === result.checkout?.target_bundle_id)?.bundle_name;
        if (name) {
          setTarget({ key: targetKey, name });
          return;
        }
      } catch { /* Keep the target unknown and retry without blocking upgrade progress. */ }
      if (!cancelled) retry = window.setTimeout(() => { void loadTarget(); }, 3000);
    };
    void loadTarget();
    return () => { cancelled = true; window.clearTimeout(retry); };
  }, [getModifyCheckout, listBundles, pass.pass_id, targetKey]);

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
          {failed ? t("套餐升级失败") : t("正在为 Hermes Agent 升级套餐")}
        </h2>
        <p className="mt-2 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
          {failed ? t("订单已关闭或失败，请联系支持确认后再操作。") : t("套餐升级中，完成后将自动展示 Agent。")}
        </p>
      </div>
      <dl className="mt-6 w-full space-y-4 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-4 text-sm">
        <div className="flex items-start justify-between gap-4">
          <dt className="shrink-0 text-[var(--text-secondary)]">{t("目标套餐")}</dt>
          <dd className="min-w-0 break-words text-right font-medium text-[var(--text-primary)]">{targetName ? t(targetName) : "—"}</dd>
        </div>
        <div className="flex items-start justify-between gap-4">
          <dt className="shrink-0 text-[var(--text-secondary)]">{t("到期时间")}</dt>
          <dd className="text-right tabular-nums text-[var(--text-primary)]">{formatPassDate(pass.expired_time)}</dd>
        </div>
      </dl>
      {!failed && <p className="mt-3 text-center text-pretty text-xs leading-5 text-[var(--text-secondary)]">
        {t("套餐信息将在升级完成后更新，到期时间不变。")}
      </p>}
    </div>
  );
}
