import type { RefObject } from "react";
import { AgentConfirmDialog } from "@/components/agents";
import { useT } from "@/i18n/t";

interface DeepSeekHarnessRepairDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /** The newly mounted installation status takes focus after confirmation. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export const DeepSeekHarnessRepairDialog = ({
  open, onOpenChange, onConfirm, returnFocusRef,
}: DeepSeekHarnessRepairDialogProps) => {
  const t = useT();
  return (
    <AgentConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("修复 DeepSeek Harness")}
      description={<div className="space-y-3">
        <p>{t("修复将重新安装 DeepSeek Harness 运行环境，并在完成后重启服务。修复期间 WebUI 暂时不可用。")}</p>
        <p>{t("模型配置、DSH 设置与存储数据将会被保留；WebUI 插件环境会重新安装，您自行安装的插件及相关自定义文件将被移除。")}</p>
      </div>}
      cancelLabel={t("取消")}
      confirmLabel={t("修复")}
      confirmVariant="default"
      onConfirm={onConfirm}
      returnFocusRef={returnFocusRef}
    />
  );
};
