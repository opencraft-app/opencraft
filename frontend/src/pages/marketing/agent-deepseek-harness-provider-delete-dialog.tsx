import { Loader2 } from "lucide-react";
import { type RefObject, useRef } from "react";

import { agentButtonClassName, agentPortalClassName } from "@/components/agents";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useT } from "@/i18n/t";
import type { DeepSeekHarnessProvider } from "@/lib/deepseek-harness-command";

interface ProviderDeleteDialogProps {
  provider: DeepSeekHarnessProvider | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
  /** Used only when successful deletion removes the original button. */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}

export const DeepSeekHarnessProviderDeleteDialog = ({
  provider, busy, error, onClose, onConfirm, fallbackFocusRef,
}: ProviderDeleteDialogProps) => {
  const t = useT();
  const trigger = useRef<HTMLElement | null>(null);

  return (
    <AlertDialog open={provider !== null} onOpenChange={(open) => {
      if (!open && !busy) onClose();
    }}>
      <AlertDialogContent
        portalClassName={agentPortalClassName}
        className="max-w-md p-5"
        onOpenAutoFocus={() => {
          trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          const target = trigger.current?.isConnected ? trigger.current : fallbackFocusRef?.current;
          if (target?.isConnected) { event.preventDefault(); target.focus(); }
        }}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {provider ? t("删除 {{provider}}？", { provider: provider.displayName }) : t("删除模型供应商？")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("删除后将移除当前模型供应商配置；由 LightVela 写入的 API 密钥也会一并移除。环境变量中的密钥不会被删除。")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} className={agentButtonClassName}>{t("取消")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || provider === null}
            aria-label={provider ? t("确认删除 {{provider}}", { provider: provider.displayName }) : t("确认删除")}
            className={agentButtonClassName}
            onClick={(event) => {
              // This controller closes only after deletion and its refresh complete.
              event.preventDefault();
              onConfirm();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
            {busy ? t("删除中...") : t("删除")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
