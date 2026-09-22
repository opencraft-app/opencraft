import { useEffect, useRef, useState, type ReactNode } from "react";
import { BrainCircuit, Bot, ChevronDown, ChevronRight, Globe, LayoutDashboard, LogOut, MessageSquare, User } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
const agentPortalClassName = "lv-sidebar-account-surface";

export type SidebarCreditSummary =
  | { state: "ready"; label: string; total: number; used: number; usedPercent: number }
  | { state: "loading" | "error" | "none" | "idle"; label: string };
export interface SidebarUserMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  email?: string;
  avatarSrc: string;
  planLabel: string;
  status?: { text: string; tone: "warning" | "danger" | "neutral" };
  credit: SidebarCreditSummary;
  upgrade?: { href: string; label: string };
  entries: readonly { id: string; kind: "agent" | "account" | "model" | "workbench" | "feedback"; href: string; label: string; external?: boolean }[];
  labels: { trigger: string; menu: string; logout: string; language: string };
  languageContent?: ReactNode;
  onSignOut: () => void;
}

const icons = { agent: Bot, account: User, model: BrainCircuit, workbench: LayoutDashboard, feedback: MessageSquare };

function SidebarLanguagePopover({ label, children }: { label: string; children: ReactNode }) {
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
      className={`${agentPortalClassName} lv-sidebar-user-menu lv-sidebar-user-language w-52 rounded-md bg-white p-0 shadow-lg`}>{children}</PopoverContent>
  </Popover>;
}

/** Presentation only; account identity, requests, routes and localization belong to the controller. */
export function SidebarUserMenu({ open, onOpenChange, name, email, avatarSrc, planLabel, status, credit, upgrade, entries, labels, languageContent, onSignOut }: SidebarUserMenuProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const close = () => onOpenChange(false);
  return <div className="lv-agent-account-menu">
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" className="lv-agent-account-trigger" aria-label={labels.trigger}>
          <img src={avatarSrc} alt="" className="size-9 shrink-0 rounded-full border border-[var(--border-subtle)] object-cover" />
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-sm font-semibold text-[var(--text-primary)]">{name}</span>
            <span className="block truncate text-xs text-[var(--text-secondary)]">{planLabel}</span>
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-[var(--text-tertiary)]" style={{ transform: open ? undefined : "rotate(180deg)" }} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label={labels.menu} side="top" align="start" sideOffset={8} collisionPadding={8}
        onOpenAutoFocus={(event) => { event.preventDefault(); headingRef.current?.focus(); }}
        className={`${agentPortalClassName} lv-sidebar-user-menu w-72 rounded-md bg-white p-1 shadow-lg`}>
        <div className="space-y-1 border-b border-[var(--border-subtle)] px-3 py-3">
          <h2 ref={headingRef} tabIndex={-1} className="truncate text-sm font-semibold text-[var(--text-primary)] outline-none">{name}</h2>
          {email && <p className="truncate text-xs text-[var(--text-secondary)]">{email}</p>}
          <p className="truncate text-xs text-[var(--text-secondary)]">{planLabel}</p>
          {status && <p data-tone={status.tone} className="lv-sidebar-user-menu-status text-xs" role="status">{status.text}</p>}
        </div>
        <div className="space-y-2 border-b border-[var(--border-subtle)] px-3 py-3">
          {credit.state === "ready" ? <>
            <div className="flex items-center justify-between gap-2 text-xs text-[var(--text-secondary)]">
              <span>{credit.label}</span>
              <span className="text-xs tabular-nums">{credit.used.toLocaleString()} / {credit.total.toLocaleString()}</span>
            </div>
            <Progress value={credit.usedPercent} aria-label={credit.label}
              aria-valuetext={`${credit.used.toLocaleString()} / ${credit.total.toLocaleString()}`} />
          </> : <p role={credit.state === "error" ? "alert" : "status"} className="text-xs text-[var(--text-secondary)]">{credit.label}</p>}
          {upgrade && <a href={upgrade.href} onClick={close} className="lv-sidebar-user-menu-upgrade">{upgrade.label}<ChevronRight className="size-4" aria-hidden="true" /></a>}
        </div>
        <div className="py-1">
          {entries.map((entry) => {
            const Icon = icons[entry.kind];
            return <a key={entry.id} href={entry.href} target={entry.external ? "_blank" : undefined} rel={entry.external ? "noopener noreferrer" : undefined}
              onClick={close} className="lv-sidebar-user-menu-item"><Icon className="size-4 shrink-0" aria-hidden="true" /><span>{entry.label}</span></a>;
          })}
          {languageContent && <SidebarLanguagePopover label={labels.language}>{languageContent}</SidebarLanguagePopover>}
        </div>
        <div className="border-t border-[var(--border-subtle)] pt-1">
          <button type="button" className="lv-sidebar-user-menu-item w-full" onClick={() => { close(); onSignOut(); }}><LogOut className="size-4 shrink-0" aria-hidden="true" /><span>{labels.logout}</span></button>
        </div>
      </PopoverContent>
    </Popover>
  </div>;
}
