import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "@/i18n/t";

interface AuthDialogFrameProps {
  ariaLabel: string;
  children: ReactNode;
  onClose: () => void;
  open: boolean;
}

export function AuthDialogFrame({ ariaLabel, children, onClose, open }: AuthDialogFrameProps) {
  const t = useT();
  const [mounted, setMounted] = useState(false);
  const [viewport, setViewport] = useState<{ top: number; height: number } | null>(null);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) return;
    const visual = window.visualViewport;
    const measure = () => setViewport(visual ? { top: visual.offsetTop, height: visual.height } : null);
    measure();
    visual?.addEventListener("resize", measure);
    visual?.addEventListener("scroll", measure);
    return () => {
      visual?.removeEventListener("resize", measure);
      visual?.removeEventListener("scroll", measure);
    };
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 py-4 backdrop-blur-sm"
          style={viewport ? { top: viewport.top, height: viewport.height, bottom: "auto" } : undefined}
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.96 }}
            transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            className="relative mx-4 flex max-h-full min-w-0 w-full max-w-[412px] flex-col overflow-y-auto overscroll-contain bg-white shadow-2xl"
            style={{ borderRadius: 12 }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={onClose}
              className="absolute right-1 top-1 z-10 flex h-11 w-11 items-center justify-center rounded transition-colors hover:bg-[rgba(0,0,0,0.05)]"
              style={{ color: "rgba(0,0,0,0.5)" }}
              aria-label={t("关闭")}
            >
              <X className="h-5 w-5" />
            </button>
            {children}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
