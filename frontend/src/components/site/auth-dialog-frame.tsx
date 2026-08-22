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

  useEffect(() => setMounted(true), []);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
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
            className="relative mx-4 flex w-full max-w-[412px] flex-col overflow-hidden bg-white shadow-2xl"
            style={{ borderRadius: 12 }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={onClose}
              className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-[rgba(0,0,0,0.05)]"
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
