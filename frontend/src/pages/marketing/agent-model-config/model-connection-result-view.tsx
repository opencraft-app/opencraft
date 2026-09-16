"use client";
import { useRef } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { agentButtonClassName, agentPortalClassName } from "@/components/agents";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface ModelConnectionResultViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  success: boolean;
  title: string;
  description: string;
  closeLabel: string;
  dismissLabel: string;
  rows: Array<{ label: string; value: string | number; error?: boolean }>;
}
export function ModelConnectionResultView({ open, onOpenChange, success, title, description, closeLabel, dismissLabel, rows }: ModelConnectionResultViewProps) {
  const trigger = useRef<HTMLElement | null>(null);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent portalClassName={agentPortalClassName} closeLabel={dismissLabel}
      className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-md md:rounded-md"
      onOpenAutoFocus={() => { trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={(event) => { if (trigger.current?.isConnected) { event.preventDefault(); trigger.current.focus(); } }}>
      <DialogHeader className="mb-5">
        <DialogTitle className="flex items-center gap-2">
          {success ? <CheckCircle2 className="size-5 text-emerald-600" aria-hidden="true" /> : <XCircle className="size-5 text-red-600" aria-hidden="true" />}
          {title}
        </DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <dl className="grid gap-3 rounded-md border border-black/[0.06] bg-black/[0.02] p-4 text-sm">
        {rows.map((row) => <div key={row.label} className="grid min-w-0 gap-1 sm:grid-cols-[6rem_minmax(0,1fr)]">
          <dt className="text-black/45">{row.label}</dt>
          <dd className={row.error ? "break-words text-red-700" : "break-all text-black/75"}>{row.value}</dd>
        </div>)}
      </dl>
      <div className="flex justify-end pt-2"><DialogClose asChild><Button type="button" className={agentButtonClassName}>{closeLabel}</Button></DialogClose></div>
    </DialogContent>
  </Dialog>;
}
