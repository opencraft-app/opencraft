import { motion } from "framer-motion";
import { Loader2, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRepositories } from "@/contexts/repository-context";
import type { BundleTimeUnit, Pass, PassRenewPrice } from "@/domain/types";
import { getBillingErrorCode, resolveBillingErrorMessage } from "@/lib/billing-error";
import { centsToYuan, formatYuan, getPassStatus, type PassStatus } from "@/lib/billing-flow";
import {
  estimateRenewalExpiry,
  formatPassDate,
  getPassStatusLabel,
  RENEWAL_PERIOD_OPTIONS,
} from "@/lib/pass-renewal";
import { cn } from "@/lib/utils";
import { buildPayPlan } from "@/lib/wx-pay";
import { useT } from "@/i18n/t";
import { RepositoryError } from "@/repositories/http-repositories";

type RenewPassModalProps = {
  pass: Pass;
  onClose: () => void;
  onSuccess: () => void | Promise<void>;
};

type RenewalSelection = {
  period: number;
  time_unit: BundleTimeUnit;
};

const RENEW_STATUS_POLL_INTERVAL_MS = 3_000;
const RENEW_STATUS_POLL_TIMEOUT_MS = 3 * 60 * 1_000;

const PASS_STATUS_BADGE_CLASS_NAME: Record<PassStatus, string> = {
  active: "bg-[rgba(20,122,86,0.08)] text-[#147A56]",
  expired: "bg-black/[0.06] text-black/45",
  isolated: "bg-[rgba(198,123,30,0.12)] text-[#9A5A00]",
  deleted: "bg-black/[0.06] text-black/45",
};

const __markRenewalOptionsForI18n = (t: (zh: string, opts?: Record<string, unknown>) => string): void => {
  void t("月付");
  void t("季付");
  void t("1个月");
  void t("3个月");
};

export const RenewPassModal = ({ pass, onClose, onSuccess }: RenewPassModalProps) => {
  const t = useT();
  __markRenewalOptionsForI18n(t);
  const { plans } = useRepositories();
  const [selected, setSelected] = useState<RenewalSelection>({
    period: RENEWAL_PERIOD_OPTIONS[0]!.period,
    time_unit: RENEWAL_PERIOD_OPTIONS[0]!.time_unit,
  });
  const [priceInfo, setPriceInfo] = useState<PassRenewPrice | null>(null);
  const [pricing, setPricing] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [step, setStep] = useState<"confirm" | "paying">("confirm");
  const [payContext, setPayContext] = useState<{
    dealNames: string[];
    bridgeUrl: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [checkingPayment, setCheckingPayment] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const startExpiredAtRef = useRef(new Date(pass.expired_time).getTime());
  const paymentCheckInFlightRef = useRef(false);
  const paymentSettledRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const selectedOption = useMemo(
    () => RENEWAL_PERIOD_OPTIONS.find(
      (option) => option.period === selected.period && option.time_unit === selected.time_unit,
    ) ?? RENEWAL_PERIOD_OPTIONS[0]!,
    [selected],
  );
  const passStatus = getPassStatus(pass);
  const estimatedExpiry = estimateRenewalExpiry(pass, selected.period, selected.time_unit);
  const realTotalYuan = priceInfo ? centsToYuan(priceInfo.real_total_cost) : null;
  const originalTotalYuan = priceInfo ? centsToYuan(priceInfo.total_cost) : null;
  const hasDiscount = priceInfo != null && originalTotalYuan != null && realTotalYuan != null
    && originalTotalYuan > realTotalYuan + 0.001;

  useEffect(() => {
    if (step !== "confirm") return;
    let cancelled = false;
    setPricing(true);
    setPriceError(null);
    setSubmitError(null);
    void (async () => {
      try {
        const result = await plans.getRenewPrice(pass.pass_id, selected);
        if (cancelled) return;
        setPriceInfo(result);
      } catch (err) {
        if (cancelled) return;
        setPriceInfo(null);
        setPriceError(resolveBillingErrorMessage(err, t("询价失败，可继续下单或稍后重试。")));
      } finally {
        if (!cancelled) setPricing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pass.pass_id, plans, selected, step, t]);

  const checkRenewalStatus = useCallback(async (showPendingMessage: boolean) => {
    if (paymentSettledRef.current || paymentCheckInFlightRef.current) return false;
    paymentCheckInFlightRef.current = true;
    setCheckingPayment(true);
    try {
      const list = await plans.listMyPasses();
      const updated = list.find((candidate) => candidate.pass_id === pass.pass_id);
      const updatedExpiredAt = updated?.expired_time ? new Date(updated.expired_time).getTime() : NaN;
      const startExpiredAt = Number.isFinite(startExpiredAtRef.current) ? startExpiredAtRef.current : 0;
      if (Number.isFinite(updatedExpiredAt) && updatedExpiredAt > startExpiredAt) {
        paymentSettledRef.current = true;
        await onSuccess();
        return true;
      }
      if (showPendingMessage && mountedRef.current) {
        setSubmitError(t("暂未确认支付结果，请稍后刷新。"));
      }
      return false;
    } catch (err) {
      console.warn("[account] refresh renew status failed", err);
      if (showPendingMessage && mountedRef.current) {
        setSubmitError(resolveBillingErrorMessage(err, t("刷新支付结果失败，请稍后重试。")));
      }
      return false;
    } finally {
      paymentCheckInFlightRef.current = false;
      if (mountedRef.current && !paymentSettledRef.current) {
        setCheckingPayment(false);
      }
    }
  }, [onSuccess, pass.pass_id, plans, t]);

  useEffect(() => {
    if (step !== "paying") return;
    let cancelled = false;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (cancelled) return;
      void (async () => {
        const renewed = await checkRenewalStatus(false);
        if (renewed || Date.now() - startedAt > RENEW_STATUS_POLL_TIMEOUT_MS) {
          window.clearInterval(timer);
        }
      })();
    }, RENEW_STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [checkRenewalStatus, step]);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const order = await plans.createRenewOrder(pass.pass_id, selected);
      const payPlan = buildPayPlan({
        dealName: order.deal_names[0] ?? "",
        authCode: order.auth_code,
        passId: pass.pass_id,
        bundleName: pass.bundle_name,
      });
      setPayContext({ dealNames: order.deal_names, bridgeUrl: payPlan.bridgeUrl });
      setStep("paying");
    } catch (err) {
      const code = getBillingErrorCode(err);
      const fallbackMsg = err instanceof Error ? err.message : t("创建订单失败，请稍后重试。");
      console.error("[account] create renew order failed", err instanceof RepositoryError
        ? { status: err.status, code: err.code, message: err.message }
        : err);
      setSubmitError(`${code ? `[${code}] ` : ""}${resolveBillingErrorMessage(err, fallbackMsg)}`);
    } finally {
      setSubmitting(false);
    }
  }, [pass.bundle_name, pass.pass_id, plans, selected, submitting, t]);

  return (
    <motion.div
      className="fixed inset-0 z-[10000] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
    >
      <motion.div
        className="relative mx-4 w-full max-w-[480px] overflow-hidden bg-white"
        style={{
          borderRadius: 12,
          border: "1px solid #E6E9EF",
          boxShadow: "0px 24px 48px -12px rgba(0, 0, 0, 0.15)",
        }}
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded transition-colors hover:bg-[rgba(0,0,0,0.04)]"
          style={{ color: "rgba(0,0,0,0.5)" }}
          aria-label={t("关闭")}
          type="button"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="px-7 pb-6 pt-7">
          <h3 className="m-0 text-[18px] font-bold tracking-[-0.25px]" style={{ color: "#333" }}>
            {step === "confirm" ? t("续费套餐") : t("微信扫码支付")}
          </h3>
          <p className="text-sm" style={{ margin: "6px 0 20px 0", color: "#999" }}>
            {step === "confirm"
              ? t("为当前套餐延长有效期，支付完成后立即生效。")
              : t("支付完成后页面会自动刷新。")}
          </p>

          {step === "confirm" ? (
            <>
              <div className="mb-5 rounded-[8px] border border-[#E6E9EF] bg-[#F9F8F7] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="m-0 truncate text-sm font-semibold text-[#333]">{pass.bundle_name}</p>
                    <p className="m-0 mt-1 text-xs text-[#999]">
                      {t("当前到期：{{date}}", { date: formatPassDate(pass.expired_time) })}
                    </p>
                  </div>
                  <span className={cn(
                    "inline-flex shrink-0 items-center rounded px-2.5 py-1 text-xs font-bold",
                    PASS_STATUS_BADGE_CLASS_NAME[passStatus],
                  )}>
                    {t(getPassStatusLabel(passStatus))}
                  </span>
                </div>
              </div>

              <div className="mb-5">
                <p className="mb-2 text-sm font-semibold text-[#333]">{t("续费时长")}</p>
                <div className="grid grid-cols-2 gap-2">
                  {RENEWAL_PERIOD_OPTIONS.map((option) => {
                    const active = selectedOption.key === option.key;
                    return (
                      <button
                        key={option.key}
                        type="button"
                        onClick={() => setSelected({ period: option.period, time_unit: option.time_unit })}
                        className={cn(
                          "rounded-[8px] border px-4 py-3 text-left transition-colors",
                          active ? "border-[#202020] bg-[#202020] text-white" : "border-black/10 bg-white text-[#333] hover:bg-black/[0.02]",
                        )}
                      >
                        <span className="block text-sm font-bold">{t(option.label)}</span>
                        <span className={cn("mt-1 block text-xs", active ? "text-white/70" : "text-[#999]")}>
                          {t(option.description)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mb-5 rounded-[8px] border border-[#E6E9EF] p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-[#999]">
                  <span>{t("预计到期")}</span>
                  <span>{formatPassDate(estimatedExpiry.toISOString())}</span>
                </div>
                <div className="flex items-end justify-between gap-3">
                  <span className="text-sm font-semibold text-[#333]">{t("应付金额")}</span>
                  <div className="text-right">
                    {pricing ? (
                      <span className="inline-flex items-center gap-1 text-sm text-[#999]">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {t("正在查询价格...")}
                      </span>
                    ) : realTotalYuan != null ? (
                      <>
                        <p className="m-0 text-xl font-bold tracking-tight text-[var(--lw-accent)]">
                          {formatYuan(realTotalYuan, priceInfo?.currency ?? "CNY")}
                        </p>
                        {hasDiscount && originalTotalYuan != null && (
                          <p className="m-0 text-xs text-[#bbb] line-through">
                            {formatYuan(originalTotalYuan, priceInfo?.currency ?? "CNY")}
                          </p>
                        )}
                      </>
                    ) : (
                      <span className="text-sm text-[#999]">{t("暂无价格")}</span>
                    )}
                  </div>
                </div>
                {priceError && (
                  <p className="m-0 mt-2 text-xs text-[#C67B1E]">{priceError}</p>
                )}
              </div>

              {submitError && (
                <p className="mb-3 text-sm text-[#cf3d4c]">{submitError}</p>
              )}

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={submitting}
                  className="flex-1 rounded-[8px] border border-black/10 px-4 py-2.5 text-sm font-semibold text-[#333] transition-colors hover:bg-black/[0.03] disabled:opacity-50"
                >
                  {t("取消")}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={submitting || pricing}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-[8px] bg-[#202020] px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {submitting ? t("正在创建订单...") : t("确认续费")}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="mb-5 rounded-[8px] border border-[#E6E9EF] p-4">
                <div className="mb-2 flex items-center justify-between gap-3 text-sm">
                  <span className="text-[#999]">{t("续费套餐")}</span>
                  <span className="max-w-[240px] truncate font-semibold text-[#333]">{pass.bundle_name}</span>
                </div>
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-[#999]">{t("续费时长")}</span>
                  <span className="font-semibold text-[#333]">{t(selectedOption.label)} · {t(selectedOption.description)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-[#999]">{t("应付金额")}</span>
                  <span className="font-semibold text-[var(--lw-accent)]">
                    {realTotalYuan != null ? formatYuan(realTotalYuan, priceInfo?.currency ?? "CNY") : t("以实际支付页为准")}
                  </span>
                </div>
              </div>

              <div className="mb-5 flex flex-col items-center gap-3 rounded-[8px] bg-[#F9F8F7] p-4">
                {payContext?.bridgeUrl ? (
                  <QRCodeSVG value={payContext.bridgeUrl} size={180} level="M" includeMargin={false} />
                ) : (
                  <Loader2 className="h-5 w-5 animate-spin text-[var(--lw-accent)]" />
                )}
                <p className="m-0 text-sm text-[#333]">{t("请使用微信扫描二维码完成支付")}</p>
                <p className="m-0 text-xs text-[#999]">{t("支付完成后页面会自动刷新。")}</p>
              </div>

              {submitError && (
                <p className="mb-3 text-sm text-[#cf3d4c]">{submitError}</p>
              )}

              <button
                type="button"
                onClick={() => void checkRenewalStatus(true)}
                disabled={checkingPayment}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-[8px] bg-[#202020] px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              >
                {checkingPayment && <Loader2 className="h-4 w-4 animate-spin" />}
                {checkingPayment ? t("刷新中...") : t("刷新")}
              </button>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
};
