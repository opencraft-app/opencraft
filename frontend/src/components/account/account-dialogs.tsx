import { useEffect, useRef, useState, type ReactNode } from "react";
import { ShieldCheck, Trash2 } from "lucide-react";
import { AgentPageLoadingState } from "@/components/agents/agent-loading-state";
import { AgentState } from "@/components/agents/agent-state";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useT } from "@/i18n/t";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fieldClassName = "h-10 w-full rounded-md border border-[var(--border-subtle)] bg-white px-3 text-sm text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]";

type AccountSubscriptionState = "ready" | "loading" | "error" | "none" | "idle";

export interface AccountPageGateProps {
  authReady: boolean;
  isAuthenticated: boolean;
  isSigningOut: boolean;
  subscriptionState: AccountSubscriptionState;
  passesError: boolean;
  onRetry: () => void;
  loadingTitle: ReactNode;
  errorTitle: ReactNode;
  errorDescription?: ReactNode;
  retryLabel: ReactNode;
  children: ReactNode;
}

export function AccountPageGate({
  authReady,
  isAuthenticated,
  isSigningOut,
  subscriptionState,
  passesError,
  onRetry,
  loadingTitle,
  errorTitle,
  errorDescription,
  retryLabel,
  children,
}: AccountPageGateProps) {
  if (!authReady || isSigningOut || (isAuthenticated && subscriptionState === "loading")) {
    return <AgentPageLoadingState title={loadingTitle} />;
  }

  if (isAuthenticated && (passesError || subscriptionState === "error")) {
    return (
      <AgentState
        kind="error"
        title={errorTitle}
        description={errorDescription}
        action={<Button type="button" variant="outline" size="sm" onClick={onRetry}>{retryLabel}</Button>}
        className="mx-auto max-w-2xl"
      />
    );
  }

  return children;
}

export interface ChangePhoneDialogProps {
  open: boolean;
  currentPhone?: string;
  onOpenChange: (open: boolean) => void;
  onSendCode: (phone: string) => Promise<{ cooldownSeconds?: number }>;
  onSubmit: (input: { phone: string; code: string }) => Promise<void>;
  onSuccess: () => void;
}

export function ChangePhoneDialog({ open, currentPhone, onOpenChange, onSendCode, onSubmit, onSuccess }: ChangePhoneDialogProps) {
  const t = useT();
  useControlledDialogFocusRestore(open);
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [sendingCode, setSendingCode] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedPhone = phone.replace(/[^\d]/g, "").slice(0, 11);
  const canSubmit = /^1\d{10}$/.test(normalizedPhone) && smsCode.trim().length >= 4 && !submitting;

  useEffect(() => {
    if (open) return;
    setPhone("");
    setSmsCode("");
    setSendingCode(false);
    setCooldownSeconds(0);
    setSubmitting(false);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = window.setTimeout(() => setCooldownSeconds((current) => Math.max(0, current - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldownSeconds]);

  const sendPhoneCode = async () => {
    if (!/^1\d{10}$/.test(normalizedPhone) || sendingCode || cooldownSeconds > 0) return;
    setSendingCode(true);
    setError(null);
    try {
      const result = await onSendCode(normalizedPhone);
      setCooldownSeconds(Math.max(1, result.cooldownSeconds || 60));
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("网络异常，请稍后再试。"));
    } finally {
      setSendingCode(false);
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ phone: normalizedPhone, code: smsCode.trim() });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("网络异常，请稍后再试。"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!submitting && !sendingCode) onOpenChange(nextOpen); }}>
      <DialogContent portalClassName="agents-ui" className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-md p-6 md:w-[32rem]" closeLabel={t("关闭")}>
        <DialogHeader className="mb-5">
          <DialogTitle>{currentPhone ? t("修改绑定手机号") : t("绑定安全手机")}</DialogTitle>
          <DialogDescription>
            {currentPhone
              ? t("当前绑定手机号：{{phone}}", { phone: currentPhone })
              : t("验证码通过后会绑定安全手机；同步失败时不会绑定。")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <label className="block space-y-2 text-sm font-medium text-[var(--text-primary)]">
            <span>{currentPhone ? t("新手机号") : t("手机号")}</span>
            <div className="flex gap-2">
              <input type="tel" inputMode="numeric" autoComplete="tel" value={normalizedPhone} onChange={(event) => setPhone(event.target.value)} maxLength={11} placeholder={t("请输入中国大陆手机号")} className={fieldClassName} />
              <Button type="button" variant="outline" disabled={!/^1\d{10}$/.test(normalizedPhone) || sendingCode || cooldownSeconds > 0} onClick={() => void sendPhoneCode()}>
                {sendingCode ? <Spinner size="sm" /> : null}
                {sendingCode ? t("发送中...") : cooldownSeconds > 0 ? t("重新发送 {{seconds}}s").replace("{{seconds}}", String(cooldownSeconds)) : t("获取验证码")}
              </Button>
            </div>
          </label>
          <label className="block space-y-2 text-sm font-medium text-[var(--text-primary)]">
            <span>{t("短信验证码")}</span>
            <input type="text" inputMode="numeric" value={smsCode} onChange={(event) => setSmsCode(event.target.value.replace(/\D/g, "").slice(0, 8))} maxLength={8} placeholder={t("请输入短信验证码")} className={fieldClassName} />
          </label>
          {error ? <p role="alert" className="text-pretty text-sm text-[var(--danger)]">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={submitting || sendingCode} onClick={() => onOpenChange(false)}>{t("取消")}</Button>
            <Button type="button" disabled={!canSubmit} onClick={() => void handleSubmit()}>
              {submitting ? <Spinner size="sm" /> : null}
              {submitting ? t("更新中...") : currentPhone ? t("确认修改") : t("确认绑定")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface BindEmailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (email: string) => Promise<{ cooldownSeconds?: number }>;
}

export function BindEmailDialog({ open, onOpenChange, onSend }: BindEmailDialogProps) {
  const t = useT();
  useControlledDialogFocusRestore(open);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const canSubmit = EMAIL_REGEX.test(email.trim()) && !submitting && cooldownSeconds <= 0;

  useEffect(() => {
    if (open) return;
    setEmail("");
    setSubmitting(false);
    setCooldownSeconds(0);
    setError(null);
    setSent(false);
  }, [open]);

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = window.setTimeout(() => setCooldownSeconds((current) => Math.max(0, current - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldownSeconds]);

  const handleSend = async () => {
    const trimmed = email.trim();
    if (!EMAIL_REGEX.test(trimmed) || submitting || cooldownSeconds > 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await onSend(trimmed);
      setCooldownSeconds(Math.max(1, response.cooldownSeconds ?? 60));
      setSent(true);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("网络异常，请稍后再试。"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!submitting) onOpenChange(nextOpen); }}>
      <DialogContent portalClassName="agents-ui" className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-md p-6 md:w-[32rem]" closeLabel={t("关闭")}>
        <DialogHeader className="mb-5">
          <DialogTitle>{t("绑定邮箱")}</DialogTitle>
          <DialogDescription>{t("绑定邮箱后可用于接收导出完成通知等重要消息。")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <label className="block space-y-2 text-sm font-medium text-[var(--text-primary)]">
            <span>{t("邮箱地址")}</span>
            <input type="email" inputMode="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder={t("请输入邮箱地址")} className={fieldClassName} />
          </label>
          {sent ? (
            <div role="status" className="flex items-start gap-2 rounded-md bg-blue-50 p-3 text-pretty text-sm text-[var(--text-secondary)]">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--lw-accent)]" aria-hidden="true" />
              <span>{t("验证邮件已发送，请前往邮箱点击链接完成验证。")}<br />{t("若未收到，请检查垃圾邮件，或在倒计时结束后重新发送。")}</span>
            </div>
          ) : null}
          {error ? <p role="alert" className="text-pretty text-sm text-[var(--danger)]">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>{t("取消")}</Button>
            <Button type="button" disabled={!canSubmit} onClick={() => void handleSend()}>
              {submitting ? <Spinner size="sm" /> : null}
              {submitting ? t("发送中...") : cooldownSeconds > 0 ? t("重新发送 {{seconds}}s").replace("{{seconds}}", String(cooldownSeconds)) : t("发送验证邮件")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface ControlledAlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submitting: boolean;
  onConfirm: () => void;
}

function useControlledDialogFocusRestore(open: boolean) {
  const wasOpen = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);

  if (open && !wasOpen.current && typeof document !== "undefined") {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  useEffect(() => {
    if (!open && wasOpen.current) {
      returnFocus.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);
}

export function AccountDeleteDialog({ open, onOpenChange, submitting, onConfirm }: ControlledAlertDialogProps) {
  const t = useT();
  useControlledDialogFocusRestore(open);
  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => { if (!submitting) onOpenChange(nextOpen); }}>
      <AlertDialogContent portalClassName="agents-ui">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-full bg-red-50 text-[var(--danger)]">
              <Trash2 className="size-[18px]" aria-hidden="true" />
            </span>
            {t("注销账号")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("注销后，账号内的订阅、订单、Agent 数据将被永久清除且不可恢复。确定要注销账号吗？")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>{t("取消")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={submitting}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {submitting ? <Spinner size="sm" /> : null}
            {submitting ? t("处理中...") : t("确认注销")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface PassDeleteDialogProps extends ControlledAlertDialogProps {
  passName: string;
  polling: boolean;
  error: string | null;
}

export function PassDeleteDialog({
  open,
  onOpenChange,
  passName,
  submitting,
  polling,
  error,
  onConfirm,
}: PassDeleteDialogProps) {
  const t = useT();
  useControlledDialogFocusRestore(open);
  const busy = submitting || polling;
  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => { if (!busy) onOpenChange(nextOpen); }}>
      <AlertDialogContent portalClassName="agents-ui">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-full bg-red-50 text-[var(--danger)]">
              <Trash2 className="size-[18px]" aria-hidden="true" />
            </span>
            {t("销毁套餐")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("销毁套餐 {{name}} 后，该套餐对应的 Agent 资源、积分与订单关联将被清除，且无法恢复。", { name: passName })}
            <span className="mt-2 block text-xs">{t("销毁完成后，您可以重新购买新的套餐。")}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p role="alert" className="text-pretty text-sm text-[var(--danger)]">{error}</p> : null}
        {polling ? (
          <div role="status" aria-busy="true" className="flex items-center gap-3 rounded-md bg-[var(--surface-muted)] p-3 text-sm">
            <Spinner size="sm" />
            {t("正在销毁套餐，请稍候...")}
          </div>
        ) : (
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>{t("取消")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting}
              onClick={(event) => {
                event.preventDefault();
                onConfirm();
              }}
            >
              {submitting ? <Spinner size="sm" /> : null}
              {submitting ? t("处理中...") : t("确认销毁")}
            </AlertDialogAction>
          </AlertDialogFooter>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

const DELETE_POLL_INTERVAL_MS = 3_000;
const DELETE_POLL_TIMEOUT_MS = 2 * 60 * 1_000;

interface PassDeleteDialogControllerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  passId: string;
  passName: string;
  deletePass: (passId: string) => Promise<{ deleted: boolean }>;
  listMyPasses: () => Promise<readonly { pass_id: string; deleted_time?: string | null }[]>;
  onSuccess: () => void;
  resolveError: (error: unknown) => string;
}

export function PassDeleteDialogController({
  open,
  onOpenChange,
  passId,
  passName,
  deletePass,
  listMyPasses,
  onSuccess,
  resolveError,
}: PassDeleteDialogControllerProps) {
  const t = useT();
  const [step, setStep] = useState<"confirm" | "polling">("confirm");
  const [submitting, setSubmitting] = useState(false);
  const [pollStartedAt, setPollStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setStep("confirm");
    setSubmitting(false);
    setPollStartedAt(null);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (step !== "polling" || pollStartedAt == null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - pollStartedAt > DELETE_POLL_TIMEOUT_MS) {
        setError(t("销毁请求已提交，但状态确认超时。请稍后刷新页面查看结果。"));
        setStep("confirm");
        return;
      }
      try {
        const passes = await listMyPasses();
        if (cancelled) return;
        const pass = passes.find((candidate) => candidate.pass_id === passId);
        if (!pass || Boolean(pass.deleted_time)) {
          onSuccess();
          return;
        }
      } catch (pollError) {
        console.warn("[account] poll delete pass status failed", pollError);
      }
      if (!cancelled) timer = setTimeout(tick, DELETE_POLL_INTERVAL_MS);
    };

    timer = setTimeout(tick, DELETE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [listMyPasses, onSuccess, passId, pollStartedAt, step, t]);

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await deletePass(passId);
      if (!result.deleted) {
        setError(t("销毁请求未确认，请稍后重试。"));
        return;
      }
      setPollStartedAt(Date.now());
      setStep("polling");
    } catch (deleteError) {
      console.error("[account] delete pass failed", deleteError);
      setError(resolveError(deleteError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PassDeleteDialog
      open={open}
      onOpenChange={onOpenChange}
      passName={passName}
      submitting={submitting}
      polling={step === "polling"}
      error={error}
      onConfirm={() => void handleConfirm()}
    />
  );
}
