import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRepositories } from "@/contexts/repository-context";
import { useSession } from "@/contexts/session-context";
import { cn } from "@/lib/utils";

const PHONE_PATTERN = /^1\d{10}$/;

interface PhoneLoginFormProps {
  beforeAction?: () => boolean;
  beforeSubmit?: ReactNode;
  variant?: "default" | "modal";
  onSignedIn?: () => void;
}

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

const MODAL_INPUT_CLASS =
  "h-11 rounded-md border-black/[0.08] bg-white px-3.5 font-normal shadow-none placeholder:text-black/35 focus-visible:border-black/[0.12] focus-visible:ring-1 focus-visible:ring-black/[0.08]";
const INVALID_INPUT_CLASS =
  "!border-[color-mix(in_oklab,var(--danger)_60%,transparent)] focus-visible:!border-[color-mix(in_oklab,var(--danger)_75%,transparent)] focus-visible:ring-1 focus-visible:!ring-[color-mix(in_oklab,var(--danger)_18%,transparent)]";
const FIELD_ERROR_CLASS = "mt-1.5 text-xs font-medium leading-5 text-[var(--danger)]";
const INVALID_INPUT_STYLE = { borderColor: "rgba(207, 61, 76, 0.6)" };
const MODAL_OUTLINE_BUTTON_CLASS =
  "h-11 shrink-0 rounded-md border border-black/[0.08] bg-white px-4 text-sm font-semibold text-[var(--text-primary)] shadow-none hover:border-black/15 hover:bg-black/[0.025] focus-visible:ring-[var(--ring)]";
const MODAL_SUBMIT_BUTTON_CLASS =
  "h-11 w-full rounded-full bg-[var(--text-primary)] text-sm font-semibold text-white shadow-none hover:translate-y-0 hover:bg-black/85 focus-visible:ring-[var(--ring)]";

type FieldErrors = {
  phone?: string;
  code?: string;
};

export const PhoneLoginForm = ({ beforeAction, beforeSubmit, variant = "default", onSignedIn }: PhoneLoginFormProps) => {
  const repositories = useRepositories();
  const { signInWithCode } = useSession();
  const phoneInputId = useId();
  const codeInputId = useId();
  const phoneErrorId = `${phoneInputId}-error`;
  const codeErrorId = `${codeInputId}-error`;
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const validatePhone = () => {
    if (PHONE_PATTERN.test(phone)) {
      setFieldErrors((current) => ({ ...current, phone: undefined }));
      return true;
    }
    setFieldErrors((current) => ({
      ...current,
      phone: "请输入正确的中国大陆手机号。",
    }));
    return false;
  };

  const handleSendCode = async () => {
    if (!validatePhone() || sending || cooldown > 0) return;
    if (beforeAction && !beforeAction()) return;
    setSending(true);
    setFieldErrors((current) => ({ ...current, phone: undefined }));
    try {
      const result = await repositories.auth.sendSmsCode({ phone });
      setCooldown(Math.max(1, result.cooldownSeconds));
    } catch (sendError) {
      setFieldErrors((current) => ({
        ...current,
        phone: errorMessage(sendError, "验证码发送失败，请稍后重试。"),
      }));
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const isPhoneValid = validatePhone();
    const isCodeValid = /^\d{4,8}$/.test(code);
    if (!isCodeValid) {
      setFieldErrors((current) => ({
        ...current,
        code: "请输入正确的短信验证码。",
      }));
    } else {
      setFieldErrors((current) => ({ ...current, code: undefined }));
    }
    if (!isPhoneValid || !isCodeValid) {
      return;
    }
    if (beforeAction && !beforeAction()) return;
    setSubmitting(true);
    setFieldErrors({});
    try {
      await signInWithCode({ phone, code });
      onSignedIn?.();
    } catch (submitError) {
      setFieldErrors((current) => ({
        ...current,
        code: errorMessage(submitError, "登录失败，请检查验证码后重试。"),
      }));
    } finally {
      setSubmitting(false);
    }
  };

  const isModal = variant === "modal";
  const fieldClassName = isModal
    ? "block"
    : "block space-y-1.5 text-sm font-medium text-[var(--lw-fg)]";
  const labelClassName = isModal ? "sr-only" : undefined;
  const phoneInputClassName = cn(isModal && MODAL_INPUT_CLASS, fieldErrors.phone && INVALID_INPUT_CLASS);
  const codeInputClassName = cn(isModal && MODAL_INPUT_CLASS, fieldErrors.code && INVALID_INPUT_CLASS);
  const submitDisabled = submitting || phone.length === 0 || code.length === 0;

  return (
    <form className={isModal ? "space-y-4" : "space-y-3"} onSubmit={handleSubmit}>
      <div className={fieldClassName}>
        <label htmlFor={phoneInputId} className={labelClassName}>手机号</label>
        <Input
          id={phoneInputId}
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          value={phone}
          maxLength={11}
          placeholder="请输入手机号"
          className={phoneInputClassName}
          style={fieldErrors.phone ? INVALID_INPUT_STYLE : undefined}
          aria-invalid={Boolean(fieldErrors.phone)}
          aria-describedby={fieldErrors.phone ? phoneErrorId : undefined}
          onChange={(event) => {
            setPhone(event.target.value.replace(/\D/g, ""));
            if (fieldErrors.phone) {
              setFieldErrors((current) => ({ ...current, phone: undefined }));
            }
          }}
        />
        {fieldErrors.phone ? (
          <p id={phoneErrorId} role="alert" className={FIELD_ERROR_CLASS}>
            {fieldErrors.phone}
          </p>
        ) : null}
      </div>
      <div className={fieldClassName}>
        <label htmlFor={codeInputId} className={labelClassName}>短信验证码</label>
        <div className="flex gap-2">
          <Input
            id={codeInputId}
            className={cn("min-w-0 flex-1", codeInputClassName)}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            maxLength={8}
            placeholder="请输入验证码"
            style={fieldErrors.code ? INVALID_INPUT_STYLE : undefined}
            aria-invalid={Boolean(fieldErrors.code)}
            aria-describedby={fieldErrors.code ? codeErrorId : undefined}
            onChange={(event) => {
              setCode(event.target.value.replace(/\D/g, ""));
              if (fieldErrors.code) {
                setFieldErrors((current) => ({ ...current, code: undefined }));
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            className={isModal ? MODAL_OUTLINE_BUTTON_CLASS : "h-11 shrink-0 rounded-md px-4"}
            disabled={sending || cooldown > 0}
            onClick={() => void handleSendCode()}
          >
            {sending ? "发送中" : cooldown > 0 ? `${cooldown}s` : "获取验证码"}
          </Button>
        </div>
        {fieldErrors.code ? (
          <p id={codeErrorId} role="alert" className={FIELD_ERROR_CLASS}>
            {fieldErrors.code}
          </p>
        ) : null}
      </div>
      {beforeSubmit}
      <Button type="submit" className={isModal ? MODAL_SUBMIT_BUTTON_CLASS : "h-11 w-full"} disabled={submitDisabled}>
        {submitting ? "登录中..." : "登录"}
      </Button>
    </form>
  );
};
