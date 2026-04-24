import type { PropsWithChildren, ReactNode } from "react";
import { cn } from "@/lib/utils";

export const GrammarCanvas = ({ children, className }: PropsWithChildren<{ className?: string }>) => (
  <div
    className={cn(
      "landing-page relative overflow-hidden rounded-[2rem] border",
      className,
    )}
    style={{
      background: "var(--lw-bg)",
      borderColor: "var(--lw-border)",
      boxShadow: "0 24px 80px -56px rgba(23, 23, 23, 0.28)",
      color: "var(--lw-fg)",
      fontFamily: '"Source Sans 3","Noto Sans SC",sans-serif',
    }}
  >
    <div className="lw-bg-dot-grid pointer-events-none absolute inset-0 opacity-40" />
    <div
      className="pointer-events-none absolute inset-x-0 top-0 h-40"
      style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.88), rgba(255,255,255,0))" }}
    />
    <div className="relative z-10">{children}</div>
  </div>
);

export const GrammarHero = ({
  eyebrow,
  title,
  description,
  actions,
  aside,
}: {
  eyebrow: ReactNode;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  aside?: ReactNode;
}) => (
  <section className="grid gap-8 border-b px-6 py-8 sm:px-8 sm:py-10 xl:grid-cols-[1.25fr_0.75fr]" style={{ borderColor: "var(--lw-border)" }}>
    <div className="space-y-6">
      <div className="space-y-3">
        <div>{eyebrow}</div>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-[-0.06em] sm:text-5xl lg:text-[4.4rem]">{title}</h1>
        <div className="max-w-2xl space-y-3 text-base leading-8 sm:text-lg" style={{ color: "var(--lw-fg-secondary)" }}>
          {description}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
    </div>
    {aside ? <div className="xl:pl-6">{aside}</div> : null}
  </section>
);

export const GrammarSection = ({
  index,
  title,
  description,
  children,
}: PropsWithChildren<{ index: string; title: string; description: string }>) => (
  <section className="grid gap-6 border-b px-6 py-8 sm:px-8 sm:py-10 xl:grid-cols-[0.34fr_0.66fr]" style={{ borderColor: "var(--lw-border)" }}>
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--lw-fg-tertiary)" }}>
        {index}
      </p>
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-[-0.05em] sm:text-[2rem]">{title}</h2>
        <p className="max-w-md text-sm leading-7 sm:text-base" style={{ color: "var(--lw-fg-secondary)" }}>
          {description}
        </p>
      </div>
    </div>
    <div>{children}</div>
  </section>
);

export const GrammarPanel = ({
  children,
  className,
  tone = "elevated",
}: PropsWithChildren<{ className?: string; tone?: "elevated" | "muted" | "accent" }>) => {
  const toneClass =
    tone === "accent"
      ? "bg-[var(--lw-accent-light)]"
      : tone === "muted"
        ? "bg-[var(--lw-bg-secondary)]"
        : "bg-[var(--lw-bg-elevated)]";

  return (
    <div
      className={cn(
        "rounded-[1.75rem] border p-5 sm:p-6",
        toneClass,
        className,
      )}
      style={{ borderColor: "var(--lw-border)", boxShadow: "var(--lw-shadow-base)" }}
    >
      {children}
    </div>
  );
};

export const GrammarMiniStat = ({ label, value, note }: { label: string; value: string; note: string }) => (
  <div className="rounded-[1.25rem] border p-4" style={{ borderColor: "var(--lw-border)", background: "rgba(255,255,255,0.72)" }}>
    <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--lw-fg-tertiary)" }}>
      {label}
    </p>
    <p className="mt-2 text-3xl font-semibold tracking-[-0.05em]">{value}</p>
    <p className="mt-2 text-sm leading-6" style={{ color: "var(--lw-fg-secondary)" }}>
      {note}
    </p>
  </div>
);

export const GrammarPageIntro = ({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  className?: string;
}) => (
  <div className={cn("space-y-5", className)}>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-3xl space-y-3">
        {eyebrow ? <div>{eyebrow}</div> : null}
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-[-0.05em] sm:text-[2.7rem]" style={{ color: "var(--lw-fg)" }}>
            {title}
          </h1>
          <div className="max-w-2xl text-sm leading-7 sm:text-base" style={{ color: "var(--lw-fg-secondary)" }}>
            {description}
          </div>
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-3">{actions}</div> : null}
    </div>
  </div>
);

export const GrammarSectionCard = ({
  kicker,
  title,
  description,
  children,
  className,
  tone = "elevated",
}: PropsWithChildren<{
  kicker?: string;
  title: string;
  description?: ReactNode;
  className?: string;
  tone?: "elevated" | "muted" | "accent";
}>) => (
  <GrammarPanel tone={tone} className={cn("space-y-5", className)}>
    <div className="space-y-2">
      {kicker ? (
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--lw-fg-tertiary)" }}>
          {kicker}
        </p>
      ) : null}
      <div className="space-y-2">
        <h2 className="text-xl font-semibold tracking-[-0.04em] sm:text-[1.6rem]" style={{ color: "var(--lw-fg)" }}>
          {title}
        </h2>
        {description ? (
          <div className="text-sm leading-7" style={{ color: "var(--lw-fg-secondary)" }}>
            {description}
          </div>
        ) : null}
      </div>
    </div>
    {children}
  </GrammarPanel>
);
