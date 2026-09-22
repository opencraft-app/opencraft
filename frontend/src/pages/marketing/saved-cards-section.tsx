import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { CreditCard, LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";

import { useRepositories } from "@/contexts/repository-context";
import { useT } from "@/i18n/t";
import { useAppSearchParams } from "@/lib/app-navigation";
import { RepositoryError } from "@/repositories/http-repositories";
import type {
  PaymentMethod,
  PaymentMethodLanguageCode,
  PaymentMethodList,
} from "@/repositories/types";

const PENDING_SIGN_ORDER_KEY = "lightvela-payment-method-sign-order-v1";
/** 回跳后等待后端同步签约结果的轮询窗口。计时起点必须是「回跳时刻」而不是「跳转时刻」：
 *  用户在 hosted page 填卡通常 20–60 秒，远超本窗口，若在跳转前就把 deadline 存下来，
 *  回跳时必然已过期，轮询会一次都不执行。 */
const SIGN_ORDER_SYNC_WINDOW_MS = 5_000;
const SIGN_ORDER_POLL_INTERVAL_MS = 750;
/** 丢弃过于陈旧的 pending：用户中途放弃绑卡（未走 cancel 回跳）时记录会留在 sessionStorage，
 *  下次成功回跳若读到它，会拿旧 contractCode 去比对新卡而一直提示「仍在同步」。 */
const PENDING_SIGN_ORDER_MAX_AGE_MS = 30 * 60_000;

type PendingSignOrder = {
  contractCode: string;
  /** 跳转到 hosted page 的时刻，仅用于丢弃陈旧记录，不参与轮询窗口计算 */
  startedAt: number;
};

type Notice = {
  tone: "error" | "info" | "success";
  text: string;
};

type SavedCardsSectionProps = {
  navigateToHostedPage?: (url: string) => void;
};

const defaultNavigateToHostedPage = (url: string): void => {
  window.location.assign(url);
};

const currentPaymentLanguage = (): PaymentMethodLanguageCode => {
  const language = typeof document === "undefined" ? "en" : document.documentElement.lang.toLowerCase();
  if (language === "zh-hant" || language.startsWith("zh-hk") || language.startsWith("zh-tw")) return "hk";
  return language.startsWith("zh") ? "zh" : "en";
};

export const isAllowedPaymentRedirect = (value: string): boolean => {
  try {
    const redirect = new URL(value);
    return redirect.protocol === "https:"
      && (
        redirect.hostname === "card.harvestsharp.com"
        || redirect.hostname === "centauriglobal.com"
        || redirect.hostname.endsWith(".centauriglobal.com")
      );
  } catch {
    return false;
  }
};

const readPendingSignOrder = (): PendingSignOrder | null => {
  try {
    const raw = window.sessionStorage.getItem(PENDING_SIGN_ORDER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingSignOrder>;
    if (typeof parsed.contractCode !== "string" || !parsed.contractCode.trim()) return null;
    /* startedAt 缺失/非法时不丢弃记录：contractCode 才是比对签约结果的关键，
       此处退化为「不做陈旧判定」，按本次回跳处理。 */
    const startedAt =
      typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt)
        ? parsed.startedAt
        : Date.now();
    if (Date.now() - startedAt > PENDING_SIGN_ORDER_MAX_AGE_MS) {
      clearPendingSignOrder();
      return null;
    }
    return { contractCode: parsed.contractCode, startedAt };
  } catch {
    return null;
  }
};

const writePendingSignOrder = (pending: PendingSignOrder): void => {
  try {
    window.sessionStorage.setItem(PENDING_SIGN_ORDER_KEY, JSON.stringify(pending));
  } catch {
    // The callback still refreshes once when sessionStorage is unavailable.
  }
};

const clearPendingSignOrder = (): void => {
  try {
    window.sessionStorage.removeItem(PENDING_SIGN_ORDER_KEY);
  } catch {
    // Ignore storage restrictions; the callback query is still consumed.
  }
};

const paymentMethodTypeLabel = (method: PaymentMethod, t: (text: string) => string): string => (
  method.type === "CREDIT_CARD" ? t("信用卡") : method.type
);

const mutationErrorMessage = (
  error: unknown,
  t: (text: string, options?: Record<string, unknown>) => string,
): string => {
  if (error instanceof RepositoryError) {
    if (error.code === "default_payment_method_cannot_delete") {
      return t("默认卡不能解绑，请先设置其他默认卡。");
    }
    if (error.status === 429) {
      return error.retryAfterSeconds
        ? t("操作过于频繁，请在 {{seconds}} 秒后重试。", { seconds: error.retryAfterSeconds })
        : t("操作过于频繁，请稍后重试。");
    }
  }
  return t("支付卡操作失败，请稍后重试。");
};

export const SavedCardsSection = ({
  navigateToHostedPage = defaultNavigateToHostedPage,
}: SavedCardsSectionProps = {}): ReactElement | null => {
  const t = useT();
  const { auth } = useRepositories();
  const [searchParams, setSearchParams] = useAppSearchParams();
  const [initialSearch] = useState(() => searchParams.toString());
  const [callbackResult] = useState<"cancelled" | "success" | null>(() => {
    const value = searchParams.get("payment-method");
    return value === "cancelled" || value === "success" ? value : null;
  });

  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUnavailable, setIsUnavailable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<PaymentMethod | null>(null);
  const pendingSignOrderRef = useRef<PendingSignOrder | null>(null);
  const isMountedRef = useRef(true);
  const listRequestIdRef = useRef(0);

  const {
    createPaymentMethodSignOrder,
    deletePaymentMethod,
    listPaymentMethods,
    setDefaultPaymentMethod,
  } = auth;

  const loadMethods = useCallback(async (showLoading = true): Promise<PaymentMethodList> => {
    const requestId = ++listRequestIdRef.current;
    if (showLoading && isMountedRef.current) setIsLoading(true);
    if (isMountedRef.current) setLoadError(null);
    try {
      const result = await listPaymentMethods();
      if (isMountedRef.current && requestId === listRequestIdRef.current) {
        setMethods(result.items);
        setIsUnavailable(false);
      }
      return result;
    } catch (error) {
      if (isMountedRef.current && requestId === listRequestIdRef.current) {
        if (error instanceof RepositoryError
          && error.status === 503
          && error.code === "payment_methods_unavailable") {
          setIsUnavailable(true);
        } else {
          setLoadError(t("支付卡加载失败，请稍后重试。"));
        }
      }
      throw error;
    } finally {
      if (isMountedRef.current && requestId === listRequestIdRef.current) setIsLoading(false);
    }
  }, [listPaymentMethods, t]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!callbackResult) return;
    const next = new URLSearchParams(initialSearch);
    next.delete("payment-method");
    setSearchParams(next, { replace: true });
  }, [callbackResult, initialSearch, setSearchParams]);

  useEffect(() => {
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const syncReturnedSignOrder = async (
      pending: PendingSignOrder | null,
      showLoading: boolean,
      /** 轮询截止时刻，由回跳时（首次调用处）计算并在递归中透传 */
      deadlineAt: number,
    ): Promise<void> => {
      try {
        const result = await loadMethods(showLoading);
        if (stopped) return;
        if (!pending) {
          setNotice({ tone: "info", text: t("签约结果已刷新。") });
          return;
        }
        if (result.items.some((method) => method.contractCode === pending.contractCode)) {
          pendingSignOrderRef.current = null;
          clearPendingSignOrder();
          setNotice({ tone: "success", text: t("支付卡已绑定。") });
          return;
        }
        if (Date.now() >= deadlineAt) {
          setNotice({ tone: "info", text: t("签约结果仍在同步，请稍后重新加载。") });
          return;
        }
        setNotice({ tone: "info", text: t("正在同步支付卡…") });
        pollTimer = setTimeout(() => {
          void syncReturnedSignOrder(pending, false, deadlineAt);
        }, Math.min(SIGN_ORDER_POLL_INTERVAL_MS, deadlineAt - Date.now()));
      } catch {
        if (!stopped && !isUnavailable) {
          setNotice({ tone: "error", text: t("签约结果刷新失败，请重新加载。") });
        }
      }
    };

    if (callbackResult === "cancelled") {
      clearPendingSignOrder();
      setNotice({ tone: "info", text: t("已取消添加支付卡。") });
      void loadMethods().catch(() => undefined);
    } else if (callbackResult === "success") {
      const pending = readPendingSignOrder();
      pendingSignOrderRef.current = pending;
      setNotice({ tone: "info", text: t("正在同步支付卡…") });
      /* deadline 在这里（回跳时刻）才计算，保证轮询窗口真实可用 */
      void syncReturnedSignOrder(pending, true, Date.now() + SIGN_ORDER_SYNC_WINDOW_MS);
    } else {
      void loadMethods().catch(() => undefined);
    }

    return () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [callbackResult, loadMethods, t]);

  const handleReload = async (): Promise<void> => {
    setActionError(null);
    try {
      const result = await loadMethods();
      const pending = pendingSignOrderRef.current;
      if (pending && result.items.some((method) => method.contractCode === pending.contractCode)) {
        pendingSignOrderRef.current = null;
        clearPendingSignOrder();
        setNotice({ tone: "success", text: t("支付卡已绑定。") });
      }
    } catch {
      // loadMethods owns the visible error state.
    }
  };

  const handleAdd = async (): Promise<void> => {
    setBusyKey("create");
    setActionError(null);
    try {
      const result = await createPaymentMethodSignOrder(currentPaymentLanguage());
      if (!isAllowedPaymentRedirect(result.redirectUrl)) {
        setActionError(t("签约页面地址无效，请稍后重试。"));
        return;
      }
      writePendingSignOrder({
        contractCode: result.contractCode,
        startedAt: Date.now(),
      });
      navigateToHostedPage(result.redirectUrl);
    } catch (error) {
      setActionError(mutationErrorMessage(error, t));
    } finally {
      if (isMountedRef.current) setBusyKey(null);
    }
  };

  const runMutation = async (
    key: string,
    operation: () => Promise<void>,
    successText: string,
  ): Promise<void> => {
    setBusyKey(key);
    setActionError(null);
    try {
      await operation();
      await loadMethods(false);
      setNotice({ tone: "success", text: successText });
    } catch (error) {
      setActionError(mutationErrorMessage(error, t));
    } finally {
      if (isMountedRef.current) setBusyKey(null);
    }
  };

  if (isUnavailable) return null;

  return (
    <section className="overflow-hidden rounded-2xl border border-[#E6E9EF] bg-white">
      <div className="flex items-center justify-between border-b border-[#E6E9EF] px-5 py-5 md:px-8 md:py-7">
        <div>
          <h3 className="text-[18px] font-medium leading-7 text-black/90 md:text-[20px]">
            {t("支付方式")}
          </h3>
          <p className="mt-1 text-sm text-black/50">
            {t("支付卡由腾讯支付页面安全管理，LightVela 不保存完整卡号。")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={busyKey !== null}
          className="inline-flex min-h-10 items-center gap-2 rounded-md px-3 text-sm font-semibold text-[var(--lw-accent)] transition-colors hover:bg-black/[0.03] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busyKey === "create" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {t("添加支付卡")}
        </button>
      </div>

      <div className="min-h-36 px-5 py-6 md:px-8 md:py-7">
        {notice && (
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={notice.tone === "error"
              ? "mb-5 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700"
              : notice.tone === "success"
                ? "mb-5 rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-700"
                : "mb-5 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-700"}
          >
            {notice.text}
          </div>
        )}

        {actionError && (
          <div role="alert" className="mb-5 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
            {actionError}
          </div>
        )}

        {isLoading ? (
          <div className="flex min-h-24 items-center justify-center gap-2 text-sm text-black/45">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            {t("正在加载签约卡…")}
          </div>
        ) : loadError ? (
          <div className="flex min-h-24 flex-col items-center justify-center gap-3 text-center">
            <p role="alert" className="text-sm text-red-700">{loadError}</p>
            <button
              type="button"
              onClick={() => void handleReload()}
              className="inline-flex items-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm font-medium text-black/70 hover:bg-black/[0.03]"
            >
              <RefreshCw className="h-4 w-4" />
              {t("重新加载")}
            </button>
          </div>
        ) : methods.length === 0 ? (
          <div className="flex min-h-24 flex-col items-center justify-center gap-2 text-center">
            <CreditCard className="h-6 w-6 text-black/25" />
            <p className="text-sm text-black/50">{t("还没有绑定支付卡")}</p>
          </div>
        ) : (
          <div className="divide-y divide-black/[0.06]">
            {methods.map((method) => {
              const isBusy = busyKey === method.contractCode;
              return (
                <div key={method.contractCode} className="flex min-h-20 flex-col justify-between gap-4 py-4 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-black/[0.04] text-black/55">
                      <CreditCard className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-black/85">{method.maskedNumber}</span>
                        {method.isDefault && (
                          <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                            {t("默认卡")}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate text-sm text-black/45">
                        {paymentMethodTypeLabel(method, t)} · {method.payerName || t("持卡人信息未提供")}
                      </p>
                    </div>
                  </div>
                  {!method.isDefault && (
                    <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                      <button
                        type="button"
                        disabled={busyKey !== null}
                        onClick={() => void runMutation(
                          method.contractCode,
                          () => setDefaultPaymentMethod(method.contractCode),
                          t("默认支付卡已更新。"),
                        )}
                        className="rounded-md px-3 py-2 text-sm font-medium text-black/65 hover:bg-black/[0.04] disabled:opacity-50"
                      >
                        {isBusy ? t("处理中…") : t("设为默认卡")}
                      </button>
                      <button
                        type="button"
                        disabled={busyKey !== null}
                        onClick={() => setConfirmRemove(method)}
                        className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                      >
                        <Trash2 className="h-4 w-4" />
                        {t("解绑支付卡")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {confirmRemove && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/45 px-4" onClick={() => setConfirmRemove(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("解绑支付卡")}
            className="w-full max-w-md rounded-lg bg-white p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-black/90">{t("解绑支付卡")}</h3>
            <p className="mt-3 text-sm leading-6 text-black/60">
              {t("确认解绑 {{number}} 吗？解绑后该卡将无法继续用于支付。", {
                number: confirmRemove.maskedNumber,
              })}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmRemove(null)}
                className="rounded-md border border-black/10 px-4 py-2 text-sm font-medium text-black/70 hover:bg-black/[0.03]"
              >
                {t("取消")}
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = confirmRemove;
                  setConfirmRemove(null);
                  void runMutation(
                    target.contractCode,
                    () => deletePaymentMethod(target.contractCode),
                    t("支付卡已解绑。"),
                  );
                }}
                className="rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800"
              >
                {t("确认解绑")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default SavedCardsSection;
