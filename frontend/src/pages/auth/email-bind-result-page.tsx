import { Link, useSearchParams } from "react-router-dom";
import { AlertCircle, CheckCircle2, Clock3, ExternalLink, Home, MailCheck, ShieldAlert, XCircle } from "lucide-react";
import { useT } from "@/i18n/t";

type EmailBindStatus = "success" | "expired" | "in_use" | "unavailable" | "invalid" | "failed";

const STATUS_FALLBACK: EmailBindStatus = "failed";

const readStatus = (rawStatus: string | null): EmailBindStatus => {
  switch (rawStatus) {
    case "success":
    case "expired":
    case "in_use":
    case "unavailable":
    case "invalid":
    case "failed":
      return rawStatus;
    default:
      return STATUS_FALLBACK;
  }
};

export const EmailBindResultPage = () => {
  const [searchParams] = useSearchParams();
  const t = useT();
  const status = readStatus(searchParams.get("status"));

  const result = {
    success: {
      icon: <CheckCircle2 className="size-7" />,
      tone: "success",
      title: t("邮箱绑定成功"),
      description: t("你的邮箱已完成验证和绑定。现在可以关闭此页面，回到原来的浏览器或设备继续使用 LightVela。"),
      badge: t("已完成"),
    },
    expired: {
      icon: <Clock3 className="size-7" />,
      tone: "warning",
      title: t("验证链接已过期"),
      description: t("为了保护账号安全，邮箱验证链接有有效期。请回到账号页重新发送一封验证邮件。"),
      badge: t("链接过期"),
    },
    in_use: {
      icon: <ShieldAlert className="size-7" />,
      tone: "warning",
      title: t("该邮箱已被其他账号使用"),
      description: t("这个邮箱已经绑定到另一个 LightVela 账号。请更换邮箱，或联系支持团队确认账号归属。"),
      badge: t("无法绑定"),
    },
    unavailable: {
      icon: <AlertCircle className="size-7" />,
      tone: "neutral",
      title: t("邮箱绑定服务暂未开放"),
      description: t("当前环境暂时无法完成邮箱绑定。请稍后重试，或回到账号页查看最新状态。"),
      badge: t("服务不可用"),
    },
    invalid: {
      icon: <XCircle className="size-7" />,
      tone: "error",
      title: t("验证链接无效"),
      description: t("这个邮箱验证链接无法识别，可能已经被使用或复制不完整。请回到账号页重新发送验证邮件。"),
      badge: t("链接无效"),
    },
    failed: {
      icon: <AlertCircle className="size-7" />,
      tone: "error",
      title: t("邮箱绑定失败"),
      description: t("邮箱验证没有完成。请回到账号页重新发送验证邮件，或稍后再试。"),
      badge: t("未完成"),
    },
  }[status];

  const toneClassName = {
    success: "bg-emerald-50 text-emerald-700 ring-emerald-100",
    warning: "bg-amber-50 text-amber-700 ring-amber-100",
    neutral: "bg-slate-50 text-slate-700 ring-slate-100",
    error: "bg-rose-50 text-rose-700 ring-rose-100",
  }[result.tone];

  return (
    <main className="landing-page min-h-dvh bg-[var(--lw-bg)] px-5 py-8 text-[var(--lw-fg)]">
      <section className="mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-[30rem] flex-col justify-center">
        <div className="rounded-[2rem] border border-[var(--lw-border)] bg-white/90 p-6 shadow-[0_24px_80px_-58px_rgba(23,23,23,0.35)] sm:p-7">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span className="grid size-9 place-items-center rounded-full bg-[var(--lw-bg-secondary)] text-[var(--lw-accent)]">
                <MailCheck className="size-5" />
              </span>
              <span>{t("邮箱验证")}</span>
            </div>
            <span className="rounded-full border border-[var(--lw-border)] bg-[var(--lw-bg-secondary)] px-3 py-1 text-xs font-medium text-[var(--lw-fg-tertiary)]">
              LightVela
            </span>
          </div>

          <div className="mt-8 space-y-5">
            <div className={`grid size-16 place-items-center rounded-2xl ring-1 ${toneClassName}`}>
              {result.icon}
            </div>
            <div className="space-y-3">
              <span className="inline-flex rounded-full bg-[var(--lw-bg-secondary)] px-3 py-1 text-xs font-semibold text-[var(--lw-fg-tertiary)]">
                {result.badge}
              </span>
              <h1 className="text-3xl font-semibold tracking-[-0.05em] sm:text-[2.5rem]">{result.title}</h1>
              <p className="text-sm leading-7 text-[var(--lw-fg-secondary)] sm:text-base">{result.description}</p>
            </div>
          </div>

          <div className="mt-7 space-y-3">
            <button
              type="button"
              onClick={() => window.close()}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--lw-accent)] px-5 text-sm font-semibold text-white transition hover:opacity-90"
            >
              {t("关闭此页面")}
              <ExternalLink className="size-4" />
            </button>
            <Link
              to="/"
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border border-[var(--lw-border)] bg-white px-5 text-sm font-semibold text-[var(--lw-fg)] transition hover:bg-[var(--lw-bg-secondary)]"
            >
              <Home className="size-4" />
              {t("返回首页")}
            </Link>
          </div>

          <p className="mt-5 text-center text-xs leading-6 text-[var(--lw-fg-tertiary)]">
            {t("如果页面没有自动关闭，请直接关闭当前浏览器标签页。")}
          </p>
        </div>
      </section>
    </main>
  );
};
