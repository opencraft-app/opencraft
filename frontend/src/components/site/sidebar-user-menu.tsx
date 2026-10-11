import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Bot, ChevronDown, ChevronRight, Files, Globe, LayoutDashboard, LogOut, MessageSquare, User } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
const agentPortalClassName = "lv-sidebar-account-surface";

export type SidebarCreditSummary =
  | { state: "ready"; label: string; total: number; used: number; usedPercent: number }
  | { state: "loading" | "error" | "none" | "idle"; label: string; onRetry?: () => void };
export interface SidebarUserMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  email?: string;
  avatarSrc: string;
  planLabel: string;
  renewalReminder?: { label: string; tooltip: string; actionLabel: string; onRenew?: () => void };
  status?: { text: string; tone: "warning" | "danger" | "neutral" };
  credit: SidebarCreditSummary;
  overview?: { expiresAt: string; remainingCredits: string; botCount: string; invitedFriends?: string; labels: { expiresAt: string; remainingCredits: string; botCount: string; invitedFriends: string } };
  upgrade?: { href: string; label: string };
  entries: readonly { id: string; kind: "agent" | "account" | "files" | "workbench" | "feedback"; href: string; label: string; external?: boolean }[];
  onFilesSelect?: () => void;
  triggerRef?: Ref<HTMLButtonElement>;
  labels: { trigger: string; menu: string; logout: string; language: string };
  languageContent?: ReactNode;
  onSignOut: () => void;
}

const icons = { agent: Bot, account: User, files: Files, workbench: LayoutDashboard, feedback: MessageSquare };

function SidebarLanguagePopover({ label, children, onMouseEnter, onMouseLeave }: { label: string; children: ReactNode; onMouseEnter: () => void; onMouseLeave: () => void }) {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(min-width: 640px)");
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return <Popover>
    <PopoverTrigger asChild><button type="button" className="lv-sidebar-user-menu-item w-full"><Globe className="size-4 shrink-0" aria-hidden="true" /><span className="flex-1 text-left">{label}</span><ChevronRight className="size-3.5" aria-hidden="true" /></button></PopoverTrigger>
    <PopoverContent aria-label={label} data-lv-agent-language-menu="true" side={wide ? "right" : "top"} align="start" sideOffset={8} collisionPadding={8}
      onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
      className={`${agentPortalClassName} lv-sidebar-user-menu lv-sidebar-user-language w-52 rounded-md bg-white p-0 shadow-lg`}>{children}</PopoverContent>
  </Popover>;
}

/** Presentation only; account identity, requests, routes and localization belong to the controller. */
export function SidebarUserMenu({ open, onOpenChange, name, email, avatarSrc, planLabel, renewalReminder, status, credit, overview, upgrade, entries, onFilesSelect, triggerRef, labels, languageContent, onSignOut }: SidebarUserMenuProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const triggerHoveredRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => {
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  const close = () => { cancelClose(); onOpenChange(false); };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => { closeTimerRef.current = null; onOpenChange(false); }, 180);
  };
  useEffect(() => {
    if (!open) {
      triggerHoveredRef.current = false;
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, [open]);
  useEffect(() => () => {
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
  }, []);
  return <div className="lv-agent-account-menu">
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button ref={triggerRef} type="button" className="lv-agent-account-trigger" aria-label={renewalReminder ? `${labels.trigger} ${renewalReminder.tooltip}` : labels.trigger}
          data-renewal-reminder={renewalReminder ? "true" : undefined}
          onMouseEnter={() => { cancelClose(); triggerHoveredRef.current = true; onOpenChange(true); }}
          onMouseLeave={scheduleClose}
          onClickCapture={(event) => { if (triggerHoveredRef.current) event.stopPropagation(); }}>
          <img src={avatarSrc} alt="" className="size-9 shrink-0 rounded-full border border-[var(--border-subtle)] object-cover" />
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-sm font-semibold text-[var(--text-primary)]">{name}</span>
            <span className={renewalReminder ? "block truncate text-xs text-[#a86108]" : "block truncate text-xs text-[var(--text-secondary)]"} title={renewalReminder?.tooltip}>
              {renewalReminder?.label ?? planLabel}
            </span>
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-[var(--text-tertiary)]" style={{ transform: open ? undefined : "rotate(180deg)" }} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label={labels.menu} side="top" align="start" sideOffset={8} collisionPadding={8}
        onOpenAutoFocus={(event) => { event.preventDefault(); headingRef.current?.focus(); }}
        onMouseEnter={cancelClose} onMouseLeave={scheduleClose}
        className={`${agentPortalClassName} lv-sidebar-user-menu w-72 rounded-md bg-white p-1 shadow-lg`}>
        <div className="space-y-1 border-b border-[var(--border-subtle)] px-3 py-3">
          <h2 ref={headingRef} tabIndex={-1} className="truncate text-sm font-semibold text-[var(--text-primary)] outline-none">{name}</h2>
          {email && <p className="truncate text-xs text-[var(--text-secondary)]">{email}</p>}
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-xs text-[var(--text-secondary)]" title={planLabel}>{planLabel}</p>
            {upgrade && <a href={upgrade.href} onClick={close} className="lv-sidebar-user-menu-upgrade">{upgrade.label}<ChevronRight className="size-3" aria-hidden="true" /></a>}
          </div>
          {status && <p data-tone={status.tone} className="lv-sidebar-user-menu-status text-xs" role="status">{status.text}</p>}
          {renewalReminder && <div className="flex items-center justify-between gap-2 text-xs text-[#a86108]" role="status">
            <span title={renewalReminder.tooltip}>{renewalReminder.tooltip}</span>
            {renewalReminder.onRenew && <button type="button" className="shrink-0 font-semibold underline-offset-2 hover:underline" onClick={() => { close(); renewalReminder.onRenew?.(); }}>{renewalReminder.actionLabel}</button>}
          </div>}
        </div>
        {overview && <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-b border-[var(--border-subtle)] px-3 py-3 text-xs">
          {([
            [overview.labels.expiresAt, overview.expiresAt],
            [overview.labels.remainingCredits, overview.remainingCredits],
            [overview.labels.botCount, overview.botCount],
            ...(overview.invitedFriends === undefined ? [] : [[overview.labels.invitedFriends, overview.invitedFriends]]),
          ] as [string, string][]).map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-[var(--text-secondary)]">{label}</dt><dd className="mt-1 truncate font-semibold tabular-nums text-[var(--text-primary)]" title={value}>{value}</dd></div>)}
        </dl>}
        <div className="space-y-2 border-b border-[var(--border-subtle)] px-3 py-3">
          {credit.state === "ready" ? <>
            <div className="flex items-center justify-between gap-2 text-xs text-[var(--text-secondary)]">
              <span>{credit.label}</span>
              <span className="text-xs tabular-nums">{credit.used.toLocaleString()} / {credit.total.toLocaleString()}</span>
            </div>
            <Progress value={credit.usedPercent} aria-label={credit.label}
              aria-valuetext={`${credit.used.toLocaleString()} / ${credit.total.toLocaleString()}`} />
          </> : credit.onRetry ? <button type="button" className="text-left text-xs font-semibold text-[var(--text-secondary)] underline-offset-2 hover:underline" onClick={credit.onRetry}>{credit.label}</button>
            : <p role={credit.state === "error" ? "alert" : "status"} className="text-xs text-[var(--text-secondary)]">{credit.label}</p>}
        </div>
        <div className="py-1">
          {entries.map((entry) => {
            const Icon = icons[entry.kind];
            if (entry.kind === "files" && onFilesSelect) {
              return <button key={entry.id} type="button" onClick={() => { close(); onFilesSelect(); }}
                className="lv-sidebar-user-menu-item w-full text-left"><Icon className="size-4 shrink-0" aria-hidden="true" /><span>{entry.label}</span></button>;
            }
            return <a key={entry.id} href={entry.href} target={entry.external ? "_blank" : undefined} rel={entry.external ? "noopener noreferrer" : undefined}
              onClick={close} className="lv-sidebar-user-menu-item"><Icon className="size-4 shrink-0" aria-hidden="true" /><span>{entry.label}</span></a>;
          })}
          {languageContent && <SidebarLanguagePopover label={labels.language} onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>{languageContent}</SidebarLanguagePopover>}
        </div>
        <div className="border-t border-[var(--border-subtle)] pt-1">
          <button type="button" className="lv-sidebar-user-menu-item w-full" onClick={() => { close(); onSignOut(); }}><LogOut className="size-4 shrink-0" aria-hidden="true" /><span>{labels.logout}</span></button>
        </div>
      </PopoverContent>
    </Popover>
  </div>;
}
