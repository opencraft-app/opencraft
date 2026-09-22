import { Trash2 } from "lucide-react";

import { useT } from "@/i18n/t";
import type {
  DeepSeekHarnessProvider,
  DeepSeekHarnessProviderID,
} from "@/lib/deepseek-harness-command";
import { DeepSeekHarnessProviderCredentialForm } from "@/pages/marketing/agent-deepseek-harness-provider-controls";

interface ConfiguredProviderListProps {
  providers: DeepSeekHarnessProvider[];
  editingId: DeepSeekHarnessProviderID | null;
  savingId: DeepSeekHarnessProviderID | null;
  deleting: boolean;
  onToggleEdit: (provider: DeepSeekHarnessProvider) => void;
  onCancelEdit: () => void;
  onSave: (provider: DeepSeekHarnessProvider, value: string) => void;
  onDelete: (provider: DeepSeekHarnessProvider) => void;
}

export const DeepSeekHarnessConfiguredProviderList = ({
  providers,
  editingId,
  savingId,
  deleting,
  onToggleEdit,
  onCancelEdit,
  onSave,
  onDelete,
}: ConfiguredProviderListProps) => {
  const t = useT();

  return (
    <div>
      <h3 className="text-sm font-semibold text-black/75">{t("已配置模型供应商")}</h3>
      {providers.length > 0 ? (
        <ul aria-label={t("已配置模型供应商")} className="mt-3 overflow-hidden rounded-md border border-black/[0.08]">
          {providers.map((provider, index) => (
            <li key={provider.id} className={index > 0 ? "border-t border-black/[0.07]" : undefined}>
              <div className="flex min-h-16 items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-black/85">{provider.displayName}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-[#178a43]">
                    <span className="size-2 rounded-full bg-[#19a15f]" aria-hidden="true" />
                    {t("已配置")}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    aria-label={t("编辑 {{provider}}", { provider: provider.displayName })}
                    disabled={!provider.writable || savingId !== null}
                    onClick={() => onToggleEdit(provider)}
                    className="inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-semibold text-black/60 hover:bg-black/[0.04] hover:text-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20 disabled:opacity-35"
                  >
                    {t("编辑")}
                  </button>
                  <button
                    type="button"
                    aria-label={t("删除 {{provider}}", { provider: provider.displayName })}
                    disabled={deleting || savingId !== null}
                    onClick={() => onDelete(provider)}
                    className="inline-flex size-9 items-center justify-center rounded-md text-black/40 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:opacity-35"
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
              {editingId === provider.id ? (
                <div className="border-t border-black/[0.07] bg-black/[0.018] p-4">
                  <DeepSeekHarnessProviderCredentialForm
                    key={`edit-${provider.id}`}
                    provider={provider}
                    mode="edit"
                    busy={savingId === provider.id}
                    onSubmit={(value) => onSave(provider, value)}
                    onCancel={onCancelEdit}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-black/[0.1] px-4 py-5 text-sm text-black/45">
          {t("还没有已配置的模型供应商")}
        </p>
      )}
    </div>
  );
};
