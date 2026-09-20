import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { AlertTriangle, Ban, Check, RotateCcw, Trash2, X } from "lucide-react";
import { AgentTooltip } from "@/components/agents";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
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
  variant?: "default" | "notice";
}
export function PersonaDialogView({ open = true, title, description, closeLabel, onClose, closeDisabled, hideHeader, children, className, style, returnFocusRef, variant = "default" }: PersonaDialogViewProps) {
  const trigger = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  return <Dialog open={open} onOpenChange={(next) => { if (!next && !closeDisabled) onClose(); }}>
    <DialogContent portalClassName="agents-ui" showCloseButton={false} style={style}
      aria-describedby={description ? descriptionId : undefined}
      overlayClassName="bg-black/50"
      className={cn("bottom-auto top-1/2 flex max-h-[80dvh] -translate-y-1/2 flex-col overflow-hidden rounded-2xl bg-white p-0 md:w-[min(768px,calc(100vw-32px))]", className)}
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
      <div className={hideHeader ? "sr-only" : variant === "notice" ? "mb-2.5 shrink-0 pr-8" : "shrink-0 border-b border-black/5 px-6 py-4 pr-16"}>
        <DialogTitle ref={titleRef} tabIndex={-1} className="flex items-center gap-1.5 text-balance text-base font-semibold">{variant === "notice" && <Check className="size-4 text-black/55" aria-hidden="true" />}{title}</DialogTitle>
        {description && <DialogDescription id={descriptionId} asChild><div className="mt-2 text-pretty text-sm leading-6">{description}</div></DialogDescription>}
      </div>
      <Button ref={closeRef} type="button" variant="ghost" onClick={onClose} disabled={closeDisabled} aria-label={closeLabel}
        className="absolute right-4 top-3 z-20 size-8 rounded-full bg-transparent p-0 text-black/55 shadow-none transition-colors hover:translate-y-0 hover:bg-black/[0.05] hover:text-black/85">
        <X className="size-4" aria-hidden="true" />
      </Button>
      <div className={cn("min-h-0 flex-1 overflow-y-auto", !hideHeader && variant === "default" && "px-6 py-4")}>{children}</div>
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
  return <PersonaDialogView title={title} closeLabel={closeLabel} onClose={onClose} returnFocusRef={returnFocusRef} variant="notice" className="rounded-[1.5rem] p-6 shadow-2xl md:w-96">
    <p className="py-2.5 text-pretty text-[13px] leading-relaxed text-black/55">
      {message.split(/(\/new|\/approve)/g).map((part, index) => part === "/new" || part === "/approve" ? <strong key={index} className="font-semibold text-blue-600">{part}</strong> : <span key={index}>{part}</span>)}
    </p>
    <div className="flex justify-center"><Button className="h-auto rounded-full bg-black/90 px-5 py-2 text-sm font-medium text-white shadow-none hover:translate-y-0 hover:opacity-90" onClick={onClose}>{buttonLabel}</Button></div>
  </PersonaDialogView>;
}

export function PersonaDeleteConfirmView({ title, description, confirmLabel, cancelLabel, onConfirm, onCancel, fallbackFocusRef }: {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const trigger = useRef<HTMLElement | null>(null);
  return <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
    <AlertDialogContent portalClassName="agents-ui" overlayClassName="bg-black/60 backdrop-blur-[8px]"
      className="flex max-w-sm flex-col items-center rounded-[1.75rem] border-black/[0.06] bg-white/[0.98] p-8 shadow-2xl"
      onOpenAutoFocus={() => { trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={(event) => {
        if (trigger.current?.isConnected) {
          event.preventDefault();
          trigger.current.focus();
        } else if (document.activeElement === document.body && fallbackFocusRef.current?.isConnected) {
          event.preventDefault();
          fallbackFocusRef.current.focus({ preventScroll: true });
        }
      }}>
      <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-[#cf3d4c]/[0.08]"><AlertTriangle className="size-6 text-[#cf3d4c]" aria-hidden="true" /></div>
      <AlertDialogTitle className="mb-1.5 text-lg font-bold text-black/90">{title}</AlertDialogTitle>
      <AlertDialogDescription className="mb-6 text-center text-sm leading-relaxed text-black/65">{description}</AlertDialogDescription>
      <div className="flex w-full gap-3">
        <AlertDialogCancel className="h-auto flex-1 rounded-full border-black/[0.08] px-4 py-2.5 text-base font-medium shadow-none">{cancelLabel}</AlertDialogCancel>
        <AlertDialogAction className="h-auto flex-1 rounded-full bg-[#cf3d4c] px-4 py-2.5 text-base font-bold shadow-none hover:bg-[#cf3d4c]/90"
          onClick={(event) => { event.preventDefault(); onConfirm(); }}>{confirmLabel}</AlertDialogAction>
      </div>
    </AlertDialogContent>
  </AlertDialog>;
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
  return <div ref={cardRef} className="group relative rounded-[12px] transition-transform duration-200 motion-safe:hover:-translate-y-1"
    style={{ boxShadow: selected ? "0 0 0 2px #000000, 0 20px 48px rgba(0,0,0,0.08)" : "none" }}>
    <SoulFaceCard soul={soul} size="slot" onInterpret={onPreview} selectionControl={
      <button type="button" onClick={onSelect} aria-pressed={selected} aria-label={labels.select} className="absolute inset-0 rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]" />
    } />
    {applied ? <span aria-label={labels.appliedDescription} className="pointer-events-none absolute left-1.5 top-1.5 rounded-full px-2 py-0.5 text-xs font-medium text-white"
      style={{ backgroundImage: "linear-gradient(135deg, #6B4FE0 0%, #F4B43A 100%)", boxShadow: "0 4px 10px rgba(107,79,224,0.32)" }}>{labels.applied}</span> : <div className="absolute left-1.5 top-1.5"><AgentTooltip content={labels.unapplied}><span className="inline-flex size-5 items-center justify-center rounded-full border border-black/[0.08] bg-white/85 text-black/55 shadow-[0_3px_10px_rgba(0,0,0,0.06)]"><Ban className="size-3.5" aria-hidden="true" /></span></AgentTooltip></div>}
    {selected ? <span className="pointer-events-none absolute right-1.5 top-1.5 inline-flex size-[18px] items-center justify-center rounded-full bg-black text-white" aria-hidden="true"><Check className="size-2.5" strokeWidth={3} /></span> : <div className="absolute right-2 top-2 flex items-center gap-1.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
      <AgentTooltip content={labels.reroll} triggerMode={canReroll ? "control" : "explanation"}><Button type="button" variant="ghost" onClick={onReroll} disabled={!canReroll} aria-label={labels.reroll} className="size-6 rounded-full border border-black/[0.06] bg-white/90 p-0 text-black/65 shadow-[0_2px_6px_rgba(0,0,0,0.08)] transition-none hover:translate-y-0"><RotateCcw className="size-3" aria-hidden="true" /></Button></AgentTooltip>
      <AgentTooltip content={labels.delete} triggerMode="control"><Button type="button" variant="ghost" onClick={onDelete} aria-label={labels.delete} className="size-6 rounded-full border border-red-600/20 bg-white/90 p-0 text-red-600 shadow-[0_2px_6px_rgba(0,0,0,0.08)] transition-none hover:translate-y-0"><Trash2 className="size-3" aria-hidden="true" /></Button></AgentTooltip>
    </div>}
  </div>;
}
export function EmptySoulSlotView({ label, tooltip, onClick }: { label: string; tooltip: string; onClick: () => void }) {
  return <AgentTooltip content={tooltip} triggerMode="control"><button type="button" onClick={onClick} aria-label={label} className="block w-full rounded-[12px] transition-transform duration-200 motion-safe:hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"><CardBack iconClassName="size-9" /></button></AgentTooltip>;
}
