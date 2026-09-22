// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
"use client";
import { type ReactNode, type RefObject } from "react";
import { Download, FileText, Loader2 } from "lucide-react";
import { AgentTooltip, agentButtonClassName, agentPanelClassName, agentPortalClassName } from "../../components/agents/index";
import { Button } from "../../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { cn } from "../../lib/utils";

export interface DiagnosticLogViewProps<TValue extends string> {
  title: string; description: string; command: string; output: string; status: "idle" | "loading" | "success" | "error";
  unavailableReason?: string;
  exporting: boolean; since: TValue; options: Array<{ value: TValue; label: string }>;
  labels: { range: string; query: string; querying: string; export: string; empty: string; exportHint: string };
  onSinceChange: (value: TValue) => void; onQuery: () => void; onExport: () => void;
}
export function DiagnosticLogView<TValue extends string>({ title, description, command, output, status, unavailableReason, exporting, since, options, labels, onSinceChange, onQuery, onExport }: DiagnosticLogViewProps<TValue>) {
  const loading = status === "loading";
  const unavailable = Boolean(unavailableReason);
  return <article className={cn(agentPanelClassName, "flex min-h-[360px] w-full min-w-0 max-w-full flex-col p-5")}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex min-w-0 items-center gap-2 text-base font-semibold"><FileText className="size-4 shrink-0" aria-hidden="true" />{title}</h3>
      {!unavailable && <Button type="button" variant="ghost" className={cn(agentButtonClassName, "shrink-0 px-2 text-xs")} disabled={loading || exporting} onClick={onExport}>
        {exporting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}{labels.export}
      </Button>}
    </div>
    <p className="mt-2 text-pretty text-sm text-[var(--text-secondary)]">{description}</p>
    {!unavailable && <div className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md bg-black/[0.035] p-3">
      <code className="min-w-0 flex-1 break-all font-mono text-xs text-black/55">{command}</code>
      <div className="flex min-w-0 items-center gap-2">
        <Select value={since} onValueChange={(value) => onSinceChange(value as TValue)} disabled={loading}>
          <SelectTrigger aria-label={labels.range} className="h-9 w-28 rounded-md bg-white text-sm"><SelectValue /></SelectTrigger>
          <SelectContent variant="product" position="popper" className={cn(agentPortalClassName, "max-h-[var(--radix-select-content-available-height)] max-w-[calc(100vw-2rem)]")}>
            {options.map((option) => <SelectItem key={option.value} value={option.value} className="rounded-sm">{option.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button type="button" className={agentButtonClassName} onClick={onQuery} disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}{labels.query}
        </Button>
      </div>
    </div>}
    <div className="mt-4 min-h-0 min-w-0 flex-1 rounded-md border border-black/[0.06] bg-black/[0.025]">
      {unavailable ? <div className="flex h-full min-h-[190px] items-center justify-center p-5 text-center text-sm text-[var(--text-secondary)]">{unavailableReason}</div> : status === "idle" ? <div className="flex h-full min-h-[190px] flex-col items-center justify-center p-5 text-center text-sm text-[var(--text-secondary)]"><p>{labels.empty}</p><p className="mt-2 text-xs">{labels.exportHint}</p><Button type="button" variant="outline" className={cn(agentButtonClassName, "mt-4")} onClick={onQuery}>{labels.query}</Button></div>
        : <pre tabIndex={0} aria-label={title} aria-busy={loading} className="max-h-60 max-w-full overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-xs leading-5 text-black/70">{loading && !output ? labels.querying : output}</pre>}
    </div>
  </article>;
}
export interface MaintenanceActionCardViewProps {
  icon: ReactNode; title: string; description: string;
  action: { disabled: boolean; loading: boolean; tooltip: string; onExecute: () => void };
  loadingLabel: string; executeLabel: string; consoleLines?: string[]; consoleRef?: RefObject<HTMLPreElement | null>;
}
export function MaintenanceActionCardView({ icon, title, description, action, loadingLabel, executeLabel, consoleLines, consoleRef }: MaintenanceActionCardViewProps) {
  return <article className={cn(agentPanelClassName, "min-w-0 p-4")}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="flex items-center gap-2 text-base font-semibold"><span aria-hidden="true">{icon}</span>{title}</h3>
        <p className="mt-2 text-pretty text-sm leading-6 text-[var(--text-secondary)]">{description}</p>
        {action.disabled && !action.loading ? <p className="mt-2 text-xs text-[var(--text-secondary)]">{action.tooltip}</p> : null}
      </div>
      <AgentTooltip content={action.disabled ? action.tooltip : undefined}>
        <Button type="button" className={agentButtonClassName} onClick={action.onExecute} disabled={action.disabled}>
          {action.loading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}{action.loading ? loadingLabel : executeLabel}
        </Button>
      </AgentTooltip>
    </div>
    {consoleLines?.length ? <pre ref={consoleRef} tabIndex={0} aria-label={title} className="mt-3 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[#111827] p-3 font-mono text-xs leading-5 text-[#d1d5db]">{consoleLines.join("\n")}</pre> : null}
  </article>;
}
