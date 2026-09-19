import type { ReactNode } from "react";
import { AppLink, type AppLinkProps } from "@/lib/app-navigation";
import { cn } from "@/lib/utils";

export const accountCardClass =
  "rounded-md border border-black/[0.08] bg-white shadow-[0_10px_30px_rgba(15,23,42,0.04)]";

export const accountCardHeaderClass = "flex flex-col gap-1 border-b border-black/[0.08] p-5";

export function AccountSectionHeader({
  title,
  description,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(accountCardHeaderClass, className)}>
      <h2 className="text-base font-semibold text-[var(--text-primary)]">{title}</h2>
      {description ? <p className="text-sm text-[var(--text-secondary)]">{description}</p> : null}
    </div>
  );
}

export function AccountInfoRow({
  label,
  value,
  description,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4 py-3", className)}>
      {description ? (
        <div className="min-w-0 shrink-0 basis-1/3">
          <div className="text-sm font-medium text-[var(--text-primary)]">{label}</div>
          <div className="mt-1 text-xs text-[var(--text-secondary)]">{description}</div>
        </div>
      ) : (
        <span className="shrink-0 text-sm font-medium text-[var(--text-primary)]">{label}</span>
      )}
      <div className="min-w-0 break-words text-right text-sm text-[var(--text-primary)]">{value}</div>
    </div>
  );
}

const statusToneClass: Record<"neutral" | "success" | "warning" | "danger", string> = {
  neutral: "bg-black/[0.06] text-black/65",
  success: "bg-emerald-50 text-emerald-700",
  warning: "bg-amber-50 text-amber-700",
  danger: "bg-red-50 text-red-700",
};

export function AccountStatusBadge({
  tone,
  children,
}: {
  tone: "neutral" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  return (
    <span data-tone={tone} className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold", statusToneClass[tone])}>
      {children}
    </span>
  );
}

export function AccountActionLink({ icon, children, className, ...props }: AppLinkProps & { icon?: ReactNode }) {
  return (
    <AppLink
      {...props}
      className={cn(
        "inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--text-primary)] underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2",
        className,
      )}
    >
      {children}
      {icon}
    </AppLink>
  );
}
