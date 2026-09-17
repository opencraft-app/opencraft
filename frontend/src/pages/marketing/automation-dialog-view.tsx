import { useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** Presentation only: closing never cancels the host's in-flight work. */
export function AutomationDialogView({ title, closeLabel, onClose, children, badge, className, style, returnFocusRef }: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  badge?: ReactNode;
  className?: string;
  style?: CSSProperties;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent portalClassName="agents-ui" closeLabel={closeLabel} aria-describedby={undefined}
      className={cn("gap-0 max-h-[calc(100dvh-32px)] max-w-[560px] overflow-y-auto rounded-md p-5", className)} style={style}
      onOpenAutoFocus={(event) => {
        openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        event.preventDefault();
        titleRef.current?.focus({ preventScroll: true });
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        // A close may hand off directly to another dialog; do not steal its focus.
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && focused.closest('[role="dialog"], [role="alertdialog"]')) return;
        const target = returnFocusRef?.current?.isConnected ? returnFocusRef.current : openerRef.current;
        target?.focus({ preventScroll: true });
      }}>
      <div className="mb-5 flex shrink-0 flex-wrap items-center gap-2 pr-8">
        <DialogTitle ref={titleRef} tabIndex={-1} className="min-w-0 break-words text-lg outline-none">{title}</DialogTitle>
        {badge}
      </div>
      {children}
    </DialogContent>
  </Dialog>;
}
