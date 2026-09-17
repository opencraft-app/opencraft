import { type Ref, useId, useRef } from "react";
import { Copy, KeyRound, Loader2, RefreshCw, X } from "lucide-react";
import { AgentTooltip } from "@/components/agents/agent-tooltip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface WebsiteShareDialogViewProps {
  /** A narrow DOM capability for the controller's native clipboard fallback. */
  contentRef?: Ref<HTMLDivElement>;
  siteName: string;
  publicUrl: string;
  durationDays: number;
  durationOptions: readonly { value: number; label: string }[];
  isSharing: boolean;
  code: string;
  expiresLabel: string;
  loading: boolean;
  copied: boolean;
  error: string | null;
  labels: {
    title: string; close: string; cancel: string; siteName: string; duration: string;
    enable: string; enableHint: string; code: string; reset: string; copy: string;
    copied: string; stop: string; address: string; sharing: string; resetCopyHint: string;
  };
  onDurationChange: (days: number) => void;
  onEnable: () => void;
  onReset: () => void;
  onCopy: () => void;
  onStop: () => void;
  onClose: () => void;
}

/** Presentation only: access requests, plaintext codes and clipboard ownership stay in the controller. */
export function WebsiteShareDialogView({ contentRef, siteName, publicUrl, durationDays, durationOptions, isSharing, code, expiresLabel, loading, copied, error, labels, onDurationChange, onEnable, onReset, onCopy, onStop, onClose }: WebsiteShareDialogViewProps) {
  const openerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const durationId = useId();
  const close = () => { if (!loading) onClose(); };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent
        ref={contentRef}
        portalClassName="agents-ui"
        showCloseButton={false}
        aria-busy={loading}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-md md:w-[420px]"
        onOpenAutoFocus={(event) => {
          openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          event.preventDefault();
          closeRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (openerRef.current?.isConnected) { event.preventDefault(); openerRef.current.focus(); }
        }}
        onEscapeKeyDown={(event) => { if (loading) event.preventDefault(); }}
        onInteractOutside={(event) => { if (loading) event.preventDefault(); }}
      >
        <div className="flex items-start justify-between gap-3">
          <DialogTitle>{labels.title}</DialogTitle>
          <Button ref={closeRef} type="button" variant="ghost" size="sm" className="size-8 shrink-0 rounded-md p-0" aria-label={labels.close} disabled={loading} onClick={close}><X aria-hidden="true" className="size-4" /></Button>
        </div>
        <DialogDescription className="mt-2 break-words">{labels.siteName}：{siteName}</DialogDescription>

        {!isSharing ? (
          <div className="mt-5 space-y-3">
            <label htmlFor={durationId} className="block text-sm font-medium">{labels.duration}</label>
            <Select value={String(durationDays)} onValueChange={(value) => onDurationChange(Number(value))} disabled={loading}>
              <SelectTrigger id={durationId} aria-label={labels.duration} className="h-9 w-full rounded-md"><SelectValue /></SelectTrigger>
              <SelectContent variant="product" className="agents-ui">{durationOptions.map((option) => <SelectItem key={option.value} value={String(option.value)}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-sm leading-6 text-[var(--text-secondary)]">{labels.enableHint}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" className="rounded-md" disabled={loading} onClick={close}>{labels.cancel}</Button>
              <Button type="button" className="rounded-md" disabled={loading} onClick={onEnable}>{loading && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}{labels.enable}</Button>
            </div>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {code ? (
              <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-[var(--text-secondary)]">{labels.code}</p>
                  <AgentTooltip content={labels.reset} triggerMode={loading ? "explanation" : "control"}>
                    <Button type="button" variant="ghost" size="sm" className="size-8 rounded-md p-0" aria-label={labels.reset} disabled={loading} onClick={onReset}><RefreshCw aria-hidden="true" className="size-4" /></Button>
                  </AgentTooltip>
                </div>
                <p className="select-all break-all font-mono text-xl font-semibold">{code}</p>
                {expiresLabel && <p className="mt-2 text-xs text-[var(--text-secondary)]">{expiresLabel}</p>}
              </div>
            ) : (
              <>
                <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-3">
                  <p className="text-xs text-[var(--text-secondary)]">{labels.address}</p>
                  <p className="mt-1 select-all break-all text-sm">{publicUrl}</p>
                </div>
                <p className="text-sm font-medium">{labels.sharing}</p>
                {expiresLabel && <p className="text-xs text-[var(--text-secondary)]">{expiresLabel}</p>}
                <p className="text-sm leading-6 text-[var(--text-secondary)]">{labels.resetCopyHint}</p>
              </>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" className="rounded-md" disabled={loading} onClick={onCopy}>{loading ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : copied ? <KeyRound aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}{copied ? labels.copied : labels.copy}</Button>
              <Button type="button" variant="outline" className="rounded-md" disabled={loading} onClick={onStop}>{labels.stop}</Button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
