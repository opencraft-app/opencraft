// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { useRef, type ReactNode } from "react";
import { ArrowLeft, LayoutGrid, List, Search } from "lucide-react";
import { AgentTooltip } from "../../components/agents/index";
import { Button } from "../../components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { cn } from "../../lib/utils";

export interface ExpertToolbarViewProps {
  query: string;
  placeholder: string;
  onQueryChange: (value: string) => void;
  onQueryCommit: (value: string) => void;
  view: "list" | "grid";
  viewLabels: { list: string; grid: string };
  onViewChange: (view: "list" | "grid") => void;
}
export function ExpertToolbarView({ query, placeholder, onQueryChange, onQueryCommit, view, viewLabels, onViewChange }: ExpertToolbarViewProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center">
    <div className="lv-agent-search-box">
      <Search className="lv-agent-search-box-icon" aria-hidden="true" />
      <input ref={inputRef} value={query} aria-label={placeholder} placeholder={placeholder}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        onBlur={(event) => onQueryCommit(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { onQueryCommit(event.currentTarget.value); inputRef.current?.blur(); } }}
        className="lv-skills-search-input lv-agent-search-box-input" />
    </div>
    <div className="flex w-max items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-white p-0.5">
      {(["list", "grid"] as const).map((value) => {
        const Icon = value === "list" ? List : LayoutGrid;
        return <AgentTooltip key={value} content={viewLabels[value]} triggerMode="control">
          <Button variant="ghost" type="button" aria-label={viewLabels[value]} aria-pressed={view === value}
            onClick={() => onViewChange(value)}
            className={cn("lv-agent-view-toggle-btn size-9 rounded-md p-0 shadow-none transition-none hover:translate-y-0", view === value ? "bg-black/[0.06] text-black/90" : "text-black/50")}>
            <Icon className="size-4" aria-hidden="true" />
          </Button>
        </AgentTooltip>;
      })}
    </div>
  </div>;
}

export interface SkillPackageDetailLayoutProps {
  title: string;
  backLabel: string;
  onBack: () => void;
  profile: ReactNode;
  metadata: ReactNode;
  description: string;
  action: ReactNode;
  children: ReactNode;
}

export function ExpertPackageCardView({ displayName, summary, role, profile, action, onOpen, variant }: {
  displayName: string;
  summary: string;
  role: string;
  profile: ReactNode;
  action: ReactNode;
  onOpen: () => void;
  variant: "list" | "grid";
}) {
  return <article className={cn("group flex min-w-0 items-stretch gap-3 bg-white", variant === "grid" ? "rounded-md border border-[var(--border-subtle)] px-3.5 py-3" : "px-4 py-4")}>
    <AgentTooltip content={summary} triggerMode="control">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-3 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
        {profile}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold leading-5 text-black/90">{displayName}</span>
          <span className="mt-0.5 block truncate text-[11px] font-medium leading-4 text-black/50">{role}</span>
          <span className="mt-1 line-clamp-2 text-pretty text-xs leading-5 text-black/50">{summary}</span>
        </span>
      </button>
    </AgentTooltip>
    <div className="shrink-0 self-center">{action}</div>
  </article>;
}

export function SkillPackageModulesView({ modules, value, onValueChange, children }: {
  modules: ReadonlyArray<{ slug: string; label: string }>;
  value: string;
  onValueChange: (slug: string) => void;
  children: ReactNode;
}) {
  return <Tabs value={value} onValueChange={onValueChange} className="min-w-0 space-y-5">
    <TabsList className="h-auto max-w-full justify-start overflow-x-auto rounded-md border border-[var(--border-subtle)] bg-white p-1">
      {modules.map((module) => <TabsTrigger key={module.slug} value={module.slug} className="max-w-64 rounded-sm shadow-none">
        <span className="truncate">{module.label}</span>
      </TabsTrigger>)}
    </TabsList>
    <TabsContent value={value} className="mt-0 min-w-0">{children}</TabsContent>
  </Tabs>;
}
export function SkillPackageDetailLayout({ title, backLabel, onBack, profile, metadata, description, action, children }: SkillPackageDetailLayoutProps) {
  return <div className="agents-ui min-w-0 space-y-6">
    <Button variant="ghost" onClick={onBack} className="h-auto max-w-full justify-start gap-2 whitespace-normal rounded-md px-0 text-left shadow-none transition-none hover:translate-y-0">
      <ArrowLeft className="size-4 shrink-0" aria-hidden="true" /><span>{backLabel}</span>
    </Button>
    <div className="rounded-md border border-[var(--border-subtle)] bg-white p-5">
      <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          {profile}
          <div className="min-w-0">
            <h2 className="text-balance text-xl font-semibold text-black/95">{title}</h2>
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 text-sm text-black/55">{metadata}</div>
            <p className="mt-3 text-pretty text-sm leading-6 text-black/60">{description}</p>
          </div>
        </div>
        {action}
      </div>
    </div>
    {children}
  </div>;
}
