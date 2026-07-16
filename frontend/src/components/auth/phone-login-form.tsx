import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRepositories } from "@/contexts/repository-context";
import { useSession } from "@/contexts/session-context";

const PHONE_PATTERN = /^1\d{10}$/;

interface PhoneLoginFormProps {
  beforeAction?: () => boolean;
  onSignedIn?: () => void;
}

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export const PhoneLoginForm = ({ beforeAction, onSignedIn }: PhoneLoginFormProps) => {
  const repositories = useRepositories();
  const { signInWithCode } = useSession();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const validatePhone = () => {
    if (PHONE_PATTERN.test(phone)) return true;
    setError("请输入正确的中国大陆手机号。");
    return false;
  };

  const handleSendCode = async () => {
    if (beforeAction && !beforeAction()) return;
    if (!validatePhone() || sending || cooldown > 0) return;
    setSending(true);
    setError(null);
    try {
      const result = await repositories.auth.sendSmsCode({ phone });
      setCooldown(Math.max(1, result.cooldownSeconds));
    } catch (sendError) {
      setError(errorMessage(sendError, "验证码发送失败，请稍后重试。"));
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (beforeAction && !beforeAction()) return;
    if (!validatePhone()) return;
    if (!/^\d{4,8}$/.test(code)) {
      setError("请输入正确的短信验证码。");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await signInWithCode({ phone, code });
      onSignedIn?.();
    } catch (submitError) {
      setError(errorMessage(submitError, "登录失败，请检查验证码后重试。"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="space-y-3" onSubmit={handleSubmit}>
      <label className="block space-y-1.5 text-sm font-medium text-[var(--lw-fg)]">
        <span>手机号</span>
        <Input
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          value={phone}
          maxLength={11}
          placeholder="请输入手机号"
          onChange={(event) => setPhone(event.target.value.replace(/\D/g, ""))}
        />
      </label>
      <label className="block space-y-1.5 text-sm font-medium text-[var(--lw-fg)]">
        <span>短信验证码</span>
        <div className="flex gap-2">
          <Input
            className="min-w-0 flex-1"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            maxLength={8}
            placeholder="请输入验证码"
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
          />
          <Button
            type="button"
            variant="outline"
            className="h-11 shrink-0 rounded-md px-4"
            disabled={sending || cooldown > 0}
            onClick={() => void handleSendCode()}
          >
            {sending ? "发送中" : cooldown > 0 ? `${cooldown}s` : "获取验证码"}
          </Button>
        </div>
      </label>
      {error ? <p role="alert" className="text-sm text-[var(--danger)]">{error}</p> : null}
      <Button type="submit" className="h-11 w-full" disabled={submitting}>
        {submitting ? "登录中..." : "登录"}
      </Button>
    </form>
  );
};
