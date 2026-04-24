import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { MessageCircleMore, QrCode, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CodeInput } from "@/components/domain/code-input";
import { BrandMark } from "@/components/site/brand-mark";
import { useRepositories } from "@/contexts/repository-context";
import { useSession } from "@/contexts/session-context";

const PHONE_PATTERN = /^1\d{10}$/;

const oauthErrorMessage = (code: string | null) => {
  if (code === "qq_exchange_failed" || code === "qq_identity_failed" || code === "qq_sign_in_failed") {
    return "QQ 登录暂时失败，请稍后重试。";
  }
  if (code === "invite_required") {
    return "首次使用需要先通过邀请码校验。";
  }
  if (code === "qq_state_mismatch") {
    return "登录态已过期，请重新发起 QQ 登录。";
  }
  return null;
};

export const SignInPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const repositories = useRepositories();
  const { sendVerificationCode, session, signInWithCode } = useSession();
  const [inviteCode, setInviteCode] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const qqLoginUrl = repositories.auth.getOAuthStartUrl("qq");
  const oauthError = new URLSearchParams(location.search).get("oauth_error");
  const nextPath = useMemo(() => {
    const from = (location.state as { from?: string } | null)?.from;
    return from && from !== "/" ? from : "/dashboard";
  }, [location.state]);

  useEffect(() => {
    if (!session.verificationCooldownUntil) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setClock(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [session.verificationCooldownUntil]);

  const cooldownLeft = session.verificationCooldownUntil
    ? Math.max(0, Math.ceil((session.verificationCooldownUntil - clock) / 1000))
    : 0;
  const normalizedInviteCode = inviteCode.trim();

  const handleSendCode = async () => {
    setNotice(null);
    setError(null);

    if (!PHONE_PATTERN.test(phone.trim())) {
      setError("请输入正确的手机号。");
      return;
    }

    setSending(true);
    try {
      await sendVerificationCode(phone.trim());
      setNotice("验证码已发送，请留意短信。");
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "验证码发送失败。");
    } finally {
      setSending(false);
    }
  };

  const handleQQLogin = async () => {
    if (!qqLoginUrl) {
      return;
    }

    setNotice(null);
    setError(null);

    try {
      if (normalizedInviteCode) {
        await repositories.auth.prepareInviteCode(normalizedInviteCode);
      }
      window.location.assign(qqLoginUrl);
    } catch (prepareError) {
      setError(prepareError instanceof Error ? prepareError.message : "邀请码校验失败，请稍后重试。");
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice(null);
    setError(null);

    if (!PHONE_PATTERN.test(phone.trim())) {
      setError("请输入正确的手机号。");
      return;
    }

    if (code.trim().length !== 6) {
      setError("请输入 6 位验证码。");
      return;
    }

    setSubmitting(true);
    try {
      await signInWithCode({
        phone: phone.trim(),
        code: code.trim(),
        inviteCode: normalizedInviteCode || undefined,
      });
      navigate(nextPath, { replace: true });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "登录失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="min-h-dvh px-4 py-6 sm:px-6 sm:py-10"
      style={{
        background:
          "radial-gradient(circle at top left, rgba(247, 199, 116, 0.18), transparent 30%), radial-gradient(circle at top right, rgba(138, 180, 248, 0.12), transparent 34%), var(--bg-app)",
      }}
    >
      <div className="mx-auto flex min-h-[calc(100dvh-3rem)] w-full max-w-6xl items-center justify-center">
        <div className="grid w-full gap-6 lg:grid-cols-[minmax(0,1.05fr)_28rem]">
          <section className="hidden rounded-[2rem] border border-[var(--border-subtle)] bg-[color-mix(in_oklab,var(--surface-base)_86%,white)] p-8 shadow-[0_40px_120px_-72px_rgba(15,23,42,0.45)] lg:flex lg:flex-col lg:justify-between">
            <div className="space-y-6">
              <BrandMark to="/" />
              <Badge variant="neutral" className="w-fit">
                Access
              </Badge>
              <div className="space-y-3">
                <h1 className="text-5xl font-semibold tracking-[-0.06em] text-[var(--text-primary)]">
                  Lightclaw 控制台入口
                </h1>
                <p className="max-w-xl text-base leading-8 text-[var(--text-secondary)]">
                  这里不再区分“注册”和“登录”。首次建号会消费一次邀请码，之后手机号验证码和 QQ 授权都走同一入口。
                </p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-[1.5rem] border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-5">
                <MessageCircleMore className="size-5 text-[var(--text-primary)]" />
                <p className="mt-4 text-lg font-semibold text-[var(--text-primary)]">手机号验证码</p>
                <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">首次建号会校验邀请码；已有手机号账号可直接继续登录。</p>
              </div>
              <div className="rounded-[1.5rem] border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-5">
                <QrCode className="size-5 text-[var(--text-primary)]" />
                <p className="mt-4 text-lg font-semibold text-[var(--text-primary)]">QQ 登录</p>
                <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">首次 QQ 授权前建议先填邀请码；已有 QQ 账号可直接继续授权。</p>
              </div>
            </div>
          </section>

          <section className="rounded-[2rem] border border-[var(--border-subtle)] bg-[color-mix(in_oklab,var(--surface-base)_90%,white)] p-5 shadow-[0_40px_120px_-72px_rgba(15,23,42,0.45)] sm:p-7">
            <div className="mb-6 flex items-center justify-between">
              <BrandMark to="/" />
              <Badge variant="neutral">Sign in</Badge>
            </div>

            <div className="space-y-2">
              <h2 className="text-3xl font-semibold tracking-[-0.05em] text-[var(--text-primary)]">进入 Lightclaw</h2>
              <p className="text-sm leading-7 text-[var(--text-secondary)]">
                先准备邀请码，再选择手机号验证码或 QQ 登录。已有账号仍然可以直接登录。
              </p>
            </div>

            <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <Label htmlFor="sign-in-invite-code">邀请码</Label>
                <Input
                  id="sign-in-invite-code"
                  autoComplete="one-time-code"
                  placeholder="首次使用前请输入邀请码"
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value.trim().toUpperCase())}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="sign-in-phone">手机号</Label>
                <Input
                  id="sign-in-phone"
                  inputMode="numeric"
                  autoComplete="tel"
                  placeholder="输入 11 位手机号"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 11))}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="sign-in-code">验证码</Label>
                  <Button type="button" variant="ghost" size="sm" disabled={sending || cooldownLeft > 0} onClick={() => void handleSendCode()}>
                    {sending ? "发送中..." : cooldownLeft > 0 ? `${cooldownLeft}s 后重发` : "发送验证码"}
                  </Button>
                </div>
                <CodeInput value={code} onChange={setCode} />
              </div>

              {notice ? <p className="text-sm text-[var(--success)]">{notice}</p> : null}
              {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
              {oauthErrorMessage(oauthError) ? <p className="text-sm text-[var(--danger)]">{oauthErrorMessage(oauthError)}</p> : null}

              <Button type="submit" className="h-11 w-full" disabled={submitting}>
                {submitting ? "登录中..." : "登录"}
              </Button>
            </form>

            <div className="relative my-5 text-center text-xs text-[var(--text-tertiary)]">
              <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--border-subtle)]" />
              <span className="relative bg-[color-mix(in_oklab,var(--surface-base)_90%,white)] px-3">或继续使用第三方登录</span>
            </div>

            {qqLoginUrl ? (
              <Button type="button" variant="outline" className="h-11 w-full" onClick={() => void handleQQLogin()}>
                使用 QQ 登录
              </Button>
            ) : null}

            <div className="mt-6 flex items-center gap-2 text-sm text-[var(--text-secondary)]">
              <Sparkles className="size-4" />
              <span>邀请码只会在首次建号时消费一次，已有账号不会重复占用邀请码。</span>
            </div>

            <div className="mt-4">
              <Link to="/" className="text-sm font-medium text-[var(--text-primary)] underline underline-offset-4">
                返回首页
              </Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
