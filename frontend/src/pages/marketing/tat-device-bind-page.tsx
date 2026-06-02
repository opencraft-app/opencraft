import { CheckCircle2, Laptop, Link2, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useRepositories } from "@/contexts/repository-context";
import { useSession } from "@/contexts/session-context";
import { useT } from "@/i18n/t";

const DEFAULT_CALLBACK_URL = "http://127.0.0.1:17631/lightvela/callback";

const readCallbackURL = () => {
  if (typeof window === "undefined") {
    return DEFAULT_CALLBACK_URL;
  }
  const value = new URLSearchParams(window.location.search).get("callback")?.trim();
  return value || DEFAULT_CALLBACK_URL;
};

export const TATDeviceBindPage = () => {
  const t = useT();
  const repositories = useRepositories();
  const { session } = useSession();
  const callbackUrl = useMemo(readCallbackURL, []);
  const [state, setState] = useState<"idle" | "submitting" | "ready" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const handleBind = async () => {
    setState("submitting");
    setMessage(null);
    try {
      const result = await repositories.auth.createTatDeviceBind({
        callbackUrl,
        deviceName: "TAT Mac Guide",
      });
      setState("ready");
        setMessage(t("TAT 注册码已生成，正在回到 TAT Mac Guide。"));
      window.location.assign(result.redirectUrl);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : t("设备绑定失败，请稍后重试。"));
    }
  };

  const disabled = state === "submitting" || state === "ready";

  return (
    <main className="landing-page min-h-dvh bg-[var(--lw-bg)] px-4 py-10 text-[var(--lw-fg)]">
      <section className="mx-auto flex min-h-[calc(100dvh-5rem)] w-full max-w-3xl items-center">
        <div
          className="w-full overflow-hidden rounded-[2rem] border bg-white/85 shadow-[0_32px_100px_-64px_rgba(23,23,23,0.34)]"
          style={{ borderColor: "var(--lw-border)" }}
        >
          <div className="border-b px-6 py-5 sm:px-8" style={{ borderColor: "var(--lw-border)" }}>
            <div className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold" style={{ borderColor: "var(--lw-border)", color: "var(--lw-fg-secondary)" }}>
              <ShieldCheck className="size-4" />
              {t("TAT 设备绑定")}
            </div>
            <h1 className="mt-5 text-3xl font-semibold sm:text-4xl">{t("绑定这台 Mac")}</h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 sm:text-base" style={{ color: "var(--lw-fg-secondary)" }}>
                {t("确认后，LightVela 会生成仅可注册一台设备的 TAT 注册码，并通过本机回跳地址交给 TAT Mac Guide 完成后续注册。")}
            </p>
          </div>

          <div className="grid gap-4 px-6 py-6 sm:grid-cols-2 sm:px-8">
            <div className="rounded-3xl border p-5" style={{ borderColor: "var(--lw-border)", background: "var(--lw-bg-secondary)" }}>
              <Laptop className="size-5" style={{ color: "var(--lw-accent)" }} />
              <h2 className="mt-4 text-base font-semibold">{t("当前账号")}</h2>
              <p className="mt-2 text-sm leading-6" style={{ color: "var(--lw-fg-secondary)" }}>
                {session.user?.name ?? t("LightVela 用户")}
              </p>
            </div>
            <div className="rounded-3xl border p-5" style={{ borderColor: "var(--lw-border)", background: "var(--lw-bg-secondary)" }}>
              <Link2 className="size-5" style={{ color: "var(--lw-accent)" }} />
              <h2 className="mt-4 text-base font-semibold">{t("本机回跳")}</h2>
              <p className="mt-2 break-all font-mono text-xs leading-6" style={{ color: "var(--lw-fg-secondary)" }}>
                {callbackUrl}
              </p>
            </div>
          </div>

          <div className="border-t px-6 py-5 sm:px-8" style={{ borderColor: "var(--lw-border)" }}>
            {message ? (
              <p className="mb-4 flex items-center gap-2 text-sm" style={{ color: state === "error" ? "var(--danger)" : "var(--lw-fg-secondary)" }}>
                {state === "ready" ? <CheckCircle2 className="size-4 text-emerald-500" /> : null}
                {message}
              </p>
            ) : null}
            <Button onClick={() => void handleBind()} disabled={disabled} className="h-11 px-6">
              {state === "submitting" ? t("正在生成 TAT 注册码...") : t("确认绑定")}
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
};
