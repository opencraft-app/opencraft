import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/i18n/t";

interface DeepSeekHarnessRepairDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export const DeepSeekHarnessRepairDialog = ({
  open,
  onOpenChange,
  onConfirm,
}: DeepSeekHarnessRepairDialogProps) => {
  const t = useT();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        role="alertdialog"
        className="!rounded-md border border-black/[0.08] bg-white p-5 shadow-xl md:w-[30rem]"
      >
        <DialogHeader className="mb-5">
          <DialogTitle>{t("修复 DeepSeek Harness")}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3 text-pretty text-sm leading-6 text-black/55">
              <p>{t("修复将重新安装 DeepSeek Harness 运行环境，并在完成后重启服务。修复期间 WebUI 暂时不可用。")}</p>
              <p>{t("模型配置、DSH 设置与存储数据将会被保留；WebUI 插件环境会重新安装，您自行安装的插件及相关自定义文件将被移除。")}</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <button
              type="button"
              className="inline-flex h-9 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm font-semibold text-black/65 hover:bg-black/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20"
            >
              {t("取消")}
            </button>
          </DialogClose>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex h-9 items-center justify-center rounded-md bg-black px-4 text-sm font-semibold text-white hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/30 focus-visible:ring-offset-2"
          >
            {t("修复")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
