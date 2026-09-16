import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Check, RotateCcw, Trash2, X } from "lucide-react";
import { AgentTooltip } from "@/components/agents";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { SkillHubSoul } from "@/lib/skillhub-api";
import { cn } from "@/lib/utils";
import { CardBack, SoulFaceCard } from "./agent-buddy-cards";

export interface PersonaDialogViewProps {
  open?: boolean;
  title: string;
  description?: ReactNode;
  closeLabel: string;
  onClose: () => void;
  closeDisabled?: boolean;
  hideHeader?: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  returnFocusRef?: RefObject<HTMLElement | null>;
}
export function PersonaDialogView({ open = true, title, description, closeLabel, onClose, closeDisabled, hideHeader, children, className, style, returnFocusRef }: PersonaDialogViewProps) {
  const trigger = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  return <Dialog open={open} onOpenChange={(next) => { if (!next && !closeDisabled) onClose(); }}>
    <DialogContent portalClassName="agents-ui" showCloseButton={false} style={style}
      aria-describedby={description ? descriptionId : undefined}
      className={cn("max-h-[calc(100dvh-32px)] overflow-y-auto rounded-md md:w-[min(720px,calc(100vw-32px))]", className)}
      onOpenAutoFocus={(event) => {
        trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        event.preventDefault();
        (hideHeader ? closeRef.current : titleRef.current)?.focus({ preventScroll: true });
      }}
      onCloseAutoFocus={(event) => {
        const target = returnFocusRef?.current ?? trigger.current;
        if (target?.isConnected) { event.preventDefault(); target.focus(); }
      }}
      onEscapeKeyDown={(event) => { if (closeDisabled) event.preventDefault(); }}
      onInteractOutside={(event) => { if (closeDisabled) event.preventDefault(); }}>
      <div className={hideHeader ? "sr-only" : "mb-5 pr-8"}>
        <DialogTitle ref={titleRef} tabIndex={-1} className="text-balance text-lg font-semibold">{title}</DialogTitle>
        {description && <DialogDescription id={descriptionId} asChild><div className="mt-2 text-pretty text-sm leading-6">{description}</div></DialogDescription>}
      </div>
      <Button ref={closeRef} type="button" variant="ghost" onClick={onClose} disabled={closeDisabled} aria-label={closeLabel}
        className="absolute right-3 top-3 z-20 size-8 rounded-md bg-white/90 p-0 text-black shadow-none transition-none hover:translate-y-0">
        <X className="size-4" aria-hidden="true" />
      </Button>
      {children}
    </DialogContent>
  </Dialog>;
}

/** Scales the existing fixed-coordinate card animation to the available dialog width. */
export function PersonaDrawStageView({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  const stage = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const resize = () => {
      const available = element.getBoundingClientRect().width;
      if (available > 0) setScale(Math.min(1, available / width));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [width]);
  return <div ref={stage} className="w-full" style={{ maxWidth: width, height: height * scale }}>
    <div className="relative origin-top-left" style={{ width, height, transform: `scale(${scale})` }}>{children}</div>
  </div>;
}

export function PersonaInfoView({ title, message, buttonLabel, closeLabel, onClose, returnFocusRef }: { title: string; message: string; buttonLabel: string; closeLabel: string; onClose: () => void; returnFocusRef?: RefObject<HTMLElement | null> }) {
  return <PersonaDialogView title={title} closeLabel={closeLabel} onClose={onClose} returnFocusRef={returnFocusRef} className="md:w-[28rem]">
    <p className="text-pretty text-sm leading-6 text-[var(--text-secondary)]">
      {message.split(/(\/new|\/approve)/g).map((part, index) => part === "/new" || part === "/approve" ? <strong key={index} className="font-semibold text-blue-600">{part}</strong> : <span key={index}>{part}</span>)}
    </p>
    <div className="mt-5 flex justify-end"><Button className="h-9 rounded-md shadow-none transition-none hover:translate-y-0" onClick={onClose}>{buttonLabel}</Button></div>
  </PersonaDialogView>;
}

export interface SoulSlotCardViewProps {
  soul: SkillHubSoul;
  selected: boolean;
  applied: boolean;
  canReroll: boolean;
  labels: { select: string; applied: string; appliedDescription: string; unapplied: string; reroll: string; delete: string; preview: string };
  onSelect: () => void;
  onReroll: () => void;
  onDelete: () => void;
  onPreview: () => void;
  onFocusedRemoval?: () => void;
}
export function SoulSlotCardView({ soul, selected, applied, canReroll, labels, onSelect, onReroll, onDelete, onPreview, onFocusedRemoval }: SoulSlotCardViewProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const removalFocus = useRef(onFocusedRemoval);
  removalFocus.current = onFocusedRemoval;
  useLayoutEffect(() => () => {
    // Read focus before this card's DOM is removed. A user who moved elsewhere
    // during an async deletion keeps their new focus target.
    if (cardRef.current?.contains(document.activeElement)) removalFocus.current?.();
  }, []);
  return <div ref={cardRef} className={cn("relative rounded-lg", selected && "ring-2 ring-black")}>
    <button type="button" onClick={onSelect} aria-pressed={selected} aria-label={labels.select} className="block w-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
      <SoulFaceCard soul={soul} size="slot" />
    </button>
    <button type="button" onClick={onPreview} className="absolute bottom-2 right-2 rounded-sm bg-white/90 px-1 text-[10px] underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">{labels.preview}</button>
    {applied ? <span aria-label={labels.appliedDescription} className="pointer-events-none absolute left-1.5 top-1.5 rounded-sm border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-800">{labels.applied}</span> : <div className="absolute left-1.5 top-1.5"><AgentTooltip content={labels.unapplied}><span className="inline-flex size-5 items-center justify-center rounded-sm border bg-white text-xs text-black/50">—</span></AgentTooltip></div>}
    {selected ? <span className="pointer-events-none absolute right-1.5 top-1.5 rounded-sm bg-black p-0.5 text-white" aria-hidden="true"><Check className="size-3" /></span> : <div className="absolute right-1.5 top-1.5 flex gap-1">
      <AgentTooltip content={labels.reroll} triggerMode={canReroll ? "control" : "explanation"}><Button type="button" variant="ghost" onClick={onReroll} disabled={!canReroll} aria-label={labels.reroll} className="size-7 rounded-md border bg-white p-0 shadow-none transition-none hover:translate-y-0"><RotateCcw className="size-3" aria-hidden="true" /></Button></AgentTooltip>
      <AgentTooltip content={labels.delete} triggerMode="control"><Button type="button" variant="ghost" onClick={onDelete} aria-label={labels.delete} className="size-7 rounded-md border border-red-200 bg-white p-0 text-red-600 shadow-none transition-none hover:translate-y-0"><Trash2 className="size-3" aria-hidden="true" /></Button></AgentTooltip>
    </div>}
  </div>;
}
export function EmptySoulSlotView({ label, tooltip, onClick }: { label: string; tooltip: string; onClick: () => void }) {
  return <AgentTooltip content={tooltip} triggerMode="control"><button type="button" onClick={onClick} aria-label={label} className="block w-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"><CardBack iconClassName="size-9" /></button></AgentTooltip>;
}
