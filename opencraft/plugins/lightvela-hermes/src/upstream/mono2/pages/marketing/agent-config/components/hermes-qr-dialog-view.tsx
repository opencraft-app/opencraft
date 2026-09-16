// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
"use client";
import { type RefObject, useRef } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { AgentState, agentButtonClassName, agentPortalClassName } from "../../../../components/agents/index";
import { Button } from "../../../../components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../../components/ui/dialog";
/** info 圆圈图标（蓝色） */
const InfoIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
    <circle cx="12" cy="12" r="11" stroke="#1d67e0" strokeWidth="2" fill="none" />
    <text x="12" y="17" textAnchor="middle" fill="#1d67e0" fontSize="14" fontWeight="600" fontFamily="inherit">
      i
    </text>
  </svg>
);

/** error 圆圈图标（红色） */
const ErrorIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
    <circle cx="12" cy="12" r="11" stroke="#eb1c26" strokeWidth="2" fill="none" />
    <text x="12" y="17" textAnchor="middle" fill="#eb1c26" fontSize="14" fontWeight="600" fontFamily="inherit">
      !
    </text>
  </svg>
);


export interface HermesQrDialogViewProps {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string;
  status: "init" | "loading" | "ready" | "expired" | "failed" | "success";
  qrUrl: string; closeLabel: string; retryLabel: string; loadingLabel: string; onRetry: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}
export function HermesQrDialogView({ open, onOpenChange, title, description, status, qrUrl, closeLabel, retryLabel, loadingLabel, onRetry, returnFocusRef }: HermesQrDialogViewProps) {
  const capturedTrigger = useRef<HTMLElement | null>(null);
  const isError = status === "expired" || status === "failed";
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent portalClassName={agentPortalClassName} closeLabel={closeLabel}
      className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-md md:rounded-md"
      {...(!description ? { "aria-describedby": undefined } : {})}
      onOpenAutoFocus={() => { capturedTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={(event) => {
        const target = returnFocusRef?.current ?? capturedTrigger.current;
        if (target?.isConnected) { event.preventDefault(); target.focus(); }
      }}>
      <DialogHeader className="mb-5">
        <DialogTitle className="flex items-center gap-2"><span aria-hidden="true">{isError ? <ErrorIcon /> : <InfoIcon />}</span>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      {status === "loading" ? <AgentState kind="loading" title={loadingLabel} /> : null}
      {status === "ready" && qrUrl ? <div role="img" aria-label={title} className="flex justify-center py-4 [&_canvas]:max-w-full"><QRCodeCanvas value={qrUrl} size={200} level="L" /></div> : null}
      {isError ? <div className="flex flex-wrap justify-end gap-2">
        <DialogClose asChild><Button type="button" variant="outline" className={agentButtonClassName}>{closeLabel}</Button></DialogClose>
        <Button type="button" className={agentButtonClassName} onClick={onRetry}>{retryLabel}</Button>
      </div> : null}
    </DialogContent>
  </Dialog>;
}
