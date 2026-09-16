"use client";
import { type MouseEventHandler, type ReactNode, useId } from "react";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ModelActionTooltip } from "./model-action-tooltip";

export interface ModelProviderGroupViewProps {
  name: string;
  contentLabel: string;
  primaryLabel?: string;
  fallbackLabel?: string;
  expanded: boolean;
  keepMounted: boolean;
  toggleDisabled: boolean;
  addDisabled: boolean;
  addLabel: string;
  onToggle: () => void;
  onAdd?: MouseEventHandler<HTMLButtonElement>;
  children: ReactNode;
}
export function ModelProviderGroupView({ name, contentLabel, primaryLabel, fallbackLabel, expanded, keepMounted, toggleDisabled, addDisabled, addLabel, onToggle, onAdd, children }: ModelProviderGroupViewProps) {
  const panelId = useId();
  return <li>
    <div className="flex items-center gap-2 pr-5">
      <button type="button" className="flex min-w-0 flex-1 flex-wrap items-center gap-3 px-5 py-4 text-left hover:bg-black/[0.015] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#2F6BFF] sm:flex-nowrap"
        aria-expanded={expanded} aria-controls={panelId} disabled={toggleDisabled} onClick={onToggle}>
        <ChevronDown className={cn("size-4 shrink-0 text-black/35", !expanded && "-rotate-90")} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-black/85">{name}</span>
        {primaryLabel || fallbackLabel ? <span className="flex w-full shrink-0 flex-row flex-wrap items-center gap-1 sm:w-auto sm:max-w-[60%] sm:justify-end">
          {primaryLabel ? <Badge variant="success" className="justify-end whitespace-normal break-all text-right leading-tight">{primaryLabel}</Badge> : null}
          {fallbackLabel ? <Badge variant="neutral" className="justify-end whitespace-normal break-all border border-[var(--border-subtle)] text-right leading-tight">{fallbackLabel}</Badge> : null}
        </span> : null}
      </button>
      {onAdd ? <Button type="button" variant="outline" size="sm" className="shrink-0 rounded-md text-xs font-normal" disabled={addDisabled} onClick={onAdd}>
        <Plus className="size-3.5" aria-hidden="true" />{addLabel}
      </Button> : null}
    </div>
    {expanded || keepMounted ? <div id={panelId} role="group" aria-label={contentLabel} hidden={!expanded} className="bg-white pl-4 pr-5 sm:pl-10">
      <ul className="divide-y divide-black/[0.06]">{children}</ul>
    </div> : null}
  </li>;
}
export interface ConfiguredModelRowViewProps {
  name: string;
  badge?: string;
  primary: boolean;
  fallback: boolean;
  primaryDisabled: boolean;
  fallbackDisabled: boolean;
  deleteDisabled: boolean;
  primaryLabel: string;
  fallbackLabel: string;
  deleteLabel: string;
  primaryHelp?: string;
  fallbackHelp?: string;
  deleteHelp?: string;
  onPrimary: () => void;
  onFallback: () => void;
  onDelete?: () => void;
}
export function ConfiguredModelRowView(props: ConfiguredModelRowViewProps) {
  return <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <span className="break-all text-sm font-normal text-black/85">{props.name}</span>
      {props.badge ? <Badge variant={props.primary ? "success" : "neutral"} className={cn("text-xs", props.fallback && "border border-[var(--border-subtle)]")}>{props.badge}</Badge> : null}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <ModelActionTooltip content={props.primaryHelp}>
        <Button type="button" size="sm" variant="outline" className="rounded-md text-xs font-normal" disabled={props.primaryDisabled} onClick={props.onPrimary}>{props.primaryLabel}</Button>
      </ModelActionTooltip>
      <ModelActionTooltip content={props.fallbackHelp}>
        <Button type="button" size="sm" variant="outline" className="rounded-md text-xs font-normal" disabled={props.fallbackDisabled} onClick={props.onFallback}>{props.fallbackLabel}</Button>
      </ModelActionTooltip>
      {props.onDelete ? <ModelActionTooltip content={props.deleteHelp}>
        <Button type="button" size="sm" variant="ghost" className="size-8 rounded-md p-0 font-normal enabled:cursor-pointer" aria-label={props.deleteLabel} disabled={props.deleteDisabled} onClick={props.onDelete}>
          <Trash2 className="size-3.5" aria-hidden="true" />
        </Button>
      </ModelActionTooltip> : null}
    </div>
  </li>;
}
