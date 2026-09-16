import { type ReactNode, useId, useRef } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { AgentSection, AgentState, AgentTooltip } from "@/components/agents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export interface MemoryLimitCardViewProps {
  title: string; description: string; used: number; limit: number; percent: number;
  editing: boolean; draft: string; min: number; max: number; saving: boolean; disabled: boolean; valid: boolean;
  helperMessage: string; helperTone: string; hasError: boolean;
  labels: { chars: string; usage: string; edit: string; save: string; saving: string; cancel: string };
  onEdit: () => void; onDraftChange: (value: string) => void; onBlur: () => void;
  onSave: () => void; onCancel: () => void;
}
export function MemoryLimitCardView({ title, description, used, limit, percent, editing, draft, min, max, saving, disabled, valid, helperMessage, helperTone, hasError, labels, onEdit, onDraftChange, onBlur, onSave, onCancel }: MemoryLimitCardViewProps) {
  const titleId = useId();
  const descriptionId = useId();
  const helperId = useId();
  const restoreEditFocus = useRef(false);
  const cancel = () => { restoreEditFocus.current = true; onCancel(); };
  return <section aria-labelledby={titleId} className="min-w-0 rounded-md border border-[var(--border-subtle)] bg-white p-4">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 id={titleId} className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
        <p id={descriptionId} className="mt-1 max-w-lg text-pretty text-xs leading-5 text-[var(--text-secondary)]">{description}</p>
      </div>
      <span className="shrink-0 rounded-sm bg-[var(--surface-muted)] px-2 py-1 text-xs tabular-nums">{percent}%</span>
    </div>
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <span className="text-2xl font-semibold tabular-nums">{used}</span>
      <span className="text-sm text-[var(--text-secondary)]">/</span>
      {editing ? <Input autoFocus type="number" aria-label={title} aria-describedby={`${descriptionId} ${helperId}`}
        aria-invalid={!valid || hasError} min={min} max={max} step={1} value={draft} disabled={disabled}
        onBlur={onBlur} onWheel={(event) => event.currentTarget.blur()}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "Escape") { event.preventDefault(); cancel(); }
          if (event.key === "Enter" && valid) { event.preventDefault(); onSave(); }
        }}
        className="h-9 w-28 rounded-md tabular-nums" /> : <span className="text-sm tabular-nums text-[var(--text-secondary)]">{limit}</span>}
      <span className="text-sm text-[var(--text-secondary)]">{labels.chars}</span>
      {!editing && <span className="text-xs text-[var(--text-secondary)]">{labels.usage}</span>}
      {!editing ? <Button variant="outline" size="sm" disabled={disabled}
        ref={(node) => { if (node && restoreEditFocus.current) { restoreEditFocus.current = false; node.focus({ preventScroll: true }); } }}
        onClick={() => { restoreEditFocus.current = false; onEdit(); }} className="h-8 rounded-md shadow-none transition-none hover:translate-y-0">{labels.edit}</Button> : <>
        <Button size="sm" disabled={disabled || !valid} onClick={onSave} className="h-8 rounded-md shadow-none transition-none hover:translate-y-0">
          {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}{saving ? labels.saving : labels.save}
        </Button>
        <Button variant="outline" size="sm" disabled={disabled} onClick={cancel} className="h-8 rounded-md shadow-none transition-none hover:translate-y-0">{labels.cancel}</Button>
      </>}
    </div>
    {editing && <p id={helperId} role={hasError ? "alert" : undefined} className={cn("mt-3 text-pretty text-xs leading-5", helperTone)}>{helperMessage}</p>}
    <div role="progressbar" aria-labelledby={titleId} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} className="mt-3 h-1.5 overflow-hidden rounded-sm bg-[var(--surface-muted)]">
      <div className="h-full bg-[var(--text-primary)]" style={{ width: `${percent}%` }} />
    </div>
  </section>;
}

export interface MemoryEntryTab {
  value: "memory" | "user"; label: string; entries: string[]; emptyText: string;
}
export interface MemoryPanelViewProps {
  title: string; description: string; refreshLabel: string; loadingLabel: string;
  loading: boolean; hasSnapshot: boolean; error: string | null; fallbackMessage?: string;
  activeTab: "memory" | "user"; tabs: MemoryEntryTab[]; cards: ReactNode;
  onTabChange: (value: "memory" | "user") => void; onRefresh: () => void;
}
export function MemoryPanelView({ title, description, refreshLabel, loadingLabel, loading, hasSnapshot, error, fallbackMessage, activeTab, tabs, cards, onTabChange, onRefresh }: MemoryPanelViewProps) {
  return <AgentSection title={title} description={description} className="agents-ui border-0 bg-transparent p-0 shadow-none sm:p-0"
    contentClassName="space-y-4"
    actions={<AgentTooltip content={refreshLabel} triggerMode="control"><Button variant="outline" size="sm" aria-label={refreshLabel} onClick={onRefresh} disabled={loading}
      className="size-8 rounded-md p-0 shadow-none transition-none hover:translate-y-0"><RefreshCw className={cn("size-4", loading && "animate-spin")} aria-hidden="true" /></Button></AgentTooltip>}>
    {error && <AgentState kind="error" title={error} />}
    {loading && !hasSnapshot && <AgentState kind="loading" title={loadingLabel} />}
    {hasSnapshot && <>
      <div className="grid gap-3 md:grid-cols-2">{cards}</div>
      {fallbackMessage && <p className="text-xs text-[var(--text-secondary)]">{fallbackMessage}</p>}
      <Tabs value={activeTab} onValueChange={(value) => { if (value === "memory" || value === "user") onTabChange(value); }}>
        <TabsList className="mb-3 h-auto max-w-full flex-wrap rounded-md p-1">
          {tabs.map((tab) => <TabsTrigger key={tab.value} value={tab.value} className="rounded-sm">{tab.label}</TabsTrigger>)}
        </TabsList>
        {tabs.map((tab) => <TabsContent key={tab.value} value={tab.value} className="mt-0 min-w-0">
          <MemoryEntriesView entries={tab.entries} emptyText={tab.emptyText} />
        </TabsContent>)}
      </Tabs>
    </>}
  </AgentSection>;
}

export function MemoryEntriesView({ entries, emptyText }: { entries: string[]; emptyText: string }) {
  if (!entries.length) return <AgentState kind="empty" title={emptyText} />;
  return <div className="space-y-2">{entries.map((entry, index) => <div key={`${index}-${entry.slice(0, 24)}`} className="min-w-0 rounded-md border border-[var(--border-subtle)] bg-white p-3 text-sm leading-6 text-[var(--text-secondary)]">
    <p className="whitespace-pre-wrap break-words text-pretty">{entry}</p>
  </div>)}</div>;
}
