import { Loader2 } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/i18n/t";
import type { DeepSeekHarnessProvider } from "@/lib/deepseek-harness-command";

interface ProviderDeleteDialogProps {
  provider: DeepSeekHarnessProvider | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

export const DeepSeekHarnessProviderDeleteDialog = ({
  provider,
  busy,
  error,
  onClose,
  onConfirm,
}: ProviderDeleteDialogProps) => {
  const t = useT();

  return (
    <Dialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        role="alertdialog"
        onPointerDownOutside={(event) => event.preventDefault()}
        className="!rounded-md border border-black/[0.08] bg-white p-5 shadow-xl md:w-[28rem]"
      >
        <DialogHeader className="mb-5">
          <DialogTitle>
            {provider ? t("删除 {{provider}}？", { provider: provider.displayName }) : t("删除模型供应商？")}
          </DialogTitle>
          <DialogDescription>
            {t("删除后将移除当前模型供应商配置；由 LightVela 写入的 API 密钥也会一并移除。环境变量中的密钥不会被删除。")}
          </DialogDescription>
        </DialogHeader>
        {error ? <p role="alert" className="mb-4 text-sm text-red-600">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <button
              type="button"
              disabled={busy}
              className="inline-flex h-9 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm font-semibold text-black/65 hover:bg-black/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20 disabled:opacity-40"
            >
              {t("取消")}
            </button>
          </DialogClose>
          <button
            type="button"
            disabled={busy || provider === null}
            aria-label={provider
              ? t("确认删除 {{provider}}", { provider: provider.displayName })
              : t("确认删除")}
            onClick={onConfirm}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:opacity-40"
          >
            {busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
            {busy ? t("删除中...") : t("删除")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
