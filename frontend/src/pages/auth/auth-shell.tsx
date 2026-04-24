import type { PropsWithChildren, ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { GrammarPanel } from "@/components/site/homepage-grammar";
import { cn } from "@/lib/utils";

interface AuthShellProps extends PropsWithChildren {
  title: string;
  subtitle: string;
  aside?: ReactNode;
  showShowcase?: boolean;
}

export const AuthShell = ({ title, subtitle, aside, children, showShowcase = false }: AuthShellProps) => {
  return (
    <div className="landing-page min-h-[calc(100dvh-4rem)]" style={{ background: "var(--lw-bg)", color: "var(--lw-fg)" }}>
      <div
        className={
          showShowcase
            ? "mx-auto grid min-h-[calc(100dvh-4rem)] w-full max-w-[var(--lw-max-content)] items-center gap-8 px-4 py-6 sm:px-6 sm:py-10 lg:grid-cols-[minmax(0,1fr)_420px]"
            : "mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-[var(--lw-max-content)] items-center px-4 py-6 sm:px-6 sm:py-10"
        }
      >
      {showShowcase ? (
        <section className="hidden space-y-6 lg:flex lg:flex-col lg:justify-center">
          <div className="space-y-4">
            <div className="inline-flex w-fit rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ borderColor: "var(--lw-border)", background: "rgba(255,255,255,0.78)", color: "var(--lw-fg-tertiary)" }}>
              Unified entry
            </div>
            <div className="space-y-3">
              <h2 className="max-w-xl text-5xl font-semibold tracking-[-0.06em]">
                从首页的气质进入控制台，而不是换一套产品。
              </h2>
              <p className="max-w-lg text-base leading-8" style={{ color: "var(--lw-fg-secondary)" }}>
                第一次 QQ 或微信授权都会自动创建账号。之后每次回来，仍然沿着同样的编辑式节奏进入 LightVela 的工作面。
              </p>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <GrammarPanel tone="muted" className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--lw-fg-tertiary)" }}>
                Entry rhythm
              </p>
              <p className="text-lg font-semibold tracking-[-0.04em]">一次授权，长期复用</p>
              <p className="text-sm leading-7" style={{ color: "var(--lw-fg-secondary)" }}>
                不再区分登录和注册两条视觉路线，入口只做一件事：把人送进产品。
              </p>
            </GrammarPanel>
            <GrammarPanel className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--lw-fg-tertiary)" }}>
                Expected next step
              </p>
              <p className="text-lg font-semibold tracking-[-0.04em]">选择计划，然后进入工作台</p>
              <p className="text-sm leading-7" style={{ color: "var(--lw-fg-secondary)" }}>
                认证页像一张首页延长出来的欢迎页，而不是一张孤零零的表单卡。
              </p>
            </GrammarPanel>
          </div>
        </section>
      ) : null}

      <div
        className={cn(
          "w-full rounded-[2rem] border p-5 sm:p-7",
          showShowcase ? "lg:min-h-[34rem]" : "mx-auto max-w-xl",
        )}
        style={{ borderColor: "var(--lw-border)", background: "rgba(255,255,255,0.84)", boxShadow: "0 24px 80px -58px rgba(23,23,23,0.28)" }}
      >
        {aside ? <div className="mb-5">{aside}</div> : null}
        <div className="space-y-3 px-1">
          <div className="inline-flex w-fit rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ borderColor: "var(--lw-border)", background: "var(--lw-bg-secondary)", color: "var(--lw-fg-tertiary)" }}>
            Operator access
          </div>
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-[-0.05em] sm:text-[2.6rem]" style={{ color: "var(--lw-fg)" }}>
              {title}
            </h1>
            <p className="max-w-lg text-sm leading-7 sm:text-base" style={{ color: "var(--lw-fg-secondary)" }}>{subtitle}</p>
          </div>
        </div>
        <div className="space-y-5 px-1 pt-6">
          {children}
          <Link to="/" className="inline-flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--lw-accent)" }}>
            返回 LightVela 首页
            <ArrowRight className="size-4" />
          </Link>
        </div>
      </div>
      </div>
    </div>
  );
};
