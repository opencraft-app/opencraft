import { cn } from "../../lib/utils";

export const Badge = ({
  children,
  tone = "muted",
  className,
}: {
  children: React.ReactNode;
  tone?: "muted" | "success" | "warning" | "danger";
  className?: string;
}) => {
  const toneClass =
    tone === "success"
      ? "bg-[color-mix(in_oklab,var(--success)_20%,white)] text-[color-mix(in_oklab,var(--success)_65%,black)] border-[color-mix(in_oklab,var(--success)_40%,white)]"
      : tone === "warning"
        ? "bg-[color-mix(in_oklab,var(--warning)_18%,white)] text-[color-mix(in_oklab,var(--warning)_72%,black)] border-[color-mix(in_oklab,var(--warning)_38%,white)]"
        : tone === "danger"
          ? "bg-[color-mix(in_oklab,var(--danger)_16%,white)] text-[color-mix(in_oklab,var(--danger)_68%,black)] border-[color-mix(in_oklab,var(--danger)_36%,white)]"
          : "bg-[var(--muted)] text-[var(--text-secondary)] border-[var(--border-light)]";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-[0.14em] uppercase",
        toneClass,
        className,
      )}
    >
      {children}
    </span>
  );
};
