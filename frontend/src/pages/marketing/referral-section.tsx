import { Check, Copy, Gift } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useRepositories } from "@/contexts/repository-context";
import { useT } from "@/i18n/t";
import { RepositoryError } from "@/repositories/http-repositories";
import type { ReferralOverview, ReferralStats } from "@/repositories/types";

export const ReferralSection = () => {
  const { auth } = useRepositories();
  const t = useT();
  const [overview, setOverview] = useState<ReferralOverview | null>(null);
  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([auth.issueReferralCode(), auth.getReferralStats()])
      .then(([nextOverview, nextStats]) => {
        if (cancelled) return;
        setOverview(nextOverview);
        setStats(nextStats);
        setVisible(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof RepositoryError && (err.status === 404 || err.code === "campaign_inactive")) {
          setVisible(false);
          return;
        }
        setVisible(true);
        setError(t("邀请返利信息暂时无法加载，请稍后重试。"));
      })
    return () => {
      cancelled = true;
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    };
  }, [auth, t]);

  const copyLink = async () => {
    if (!overview) return;
    await navigator.clipboard.writeText(overview.url);
    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  if (!visible) return null;

  return (
    <section className="overflow-hidden bg-white" style={{ border: "1px solid #E6E9EF", borderRadius: 16 }}>
      <div className="flex items-center gap-3 border-b border-[#E6E9EF] px-5 py-5 md:px-8">
        <Gift className="h-5 w-5" aria-hidden="true" style={{ color: "var(--lw-accent)" }} />
        <div>
          <h3 className="m-0 text-base font-semibold" style={{ color: "rgba(0,0,0,0.9)" }}>{t("邀请返利")}</h3>
          <p className="m-0 mt-1 text-xs" style={{ color: "rgba(0,0,0,0.5)" }}>{t("好友首次开通成功，双方获得积分。")}</p>
        </div>
      </div>
      <div className="px-5 py-5 md:px-8">
        {error ? (
          <p className="m-0 text-sm" role="alert" style={{ color: "#cf3d4c" }}>{error}</p>
        ) : overview && stats ? (
          <div className="space-y-5">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1 rounded-lg border border-[#E6E9EF] bg-[#FAFAFA] px-3 py-2.5">
                <p className="m-0 truncate text-sm" title={overview.url} style={{ color: "rgba(0,0,0,0.78)" }}>{overview.url}</p>
              </div>
              <button
                type="button"
                onClick={() => void copyLink()}
                className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-[#E6E9EF] transition-colors hover:bg-black/[0.03]"
                aria-label={copied ? t("已复制") : t("复制邀请链接")}
                title={copied ? t("已复制") : t("复制邀请链接")}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            <dl className="grid grid-cols-3 gap-4">
              <div><dt className="text-xs" style={{ color: "rgba(0,0,0,0.45)" }}>{t("成功邀请")}</dt><dd className="m-0 mt-1 text-lg font-semibold">{stats.successfulReferrals}</dd></div>
              <div><dt className="text-xs" style={{ color: "rgba(0,0,0,0.45)" }}>{t("已发积分")}</dt><dd className="m-0 mt-1 text-lg font-semibold">{stats.grantedCredits}</dd></div>
              <div><dt className="text-xs" style={{ color: "rgba(0,0,0,0.45)" }}>{t("待发奖励")}</dt><dd className="m-0 mt-1 text-lg font-semibold">{stats.pendingRewards}</dd></div>
            </dl>
          </div>
        ) : null}
      </div>
    </section>
  );
};
