import { Trash2 } from "lucide-react";
import { type RefObject, useRef } from "react";
import { AgentState, AgentTooltip, agentButtonClassName } from "@/components/agents";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  headingRef?: RefObject<HTMLHeadingElement | null>;
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
  headingRef,
}: ConfiguredProviderListProps) => {
  const t = useT();
  const editButtons = useRef(new Map<DeepSeekHarnessProviderID, HTMLButtonElement>());

  return (
    <div>
      <h3 ref={headingRef} tabIndex={-1} className="rounded-sm text-sm font-semibold text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4">{t("已配置模型供应商")}</h3>
      {providers.length > 0 ? (
        <ul aria-label={t("已配置模型供应商")} className="mt-3 overflow-hidden rounded-md border border-black/[0.08]">
          {providers.map((provider, index) => (
            <li key={provider.id} className={index > 0 ? "border-t border-black/[0.07]" : undefined}>
              <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="break-words text-sm font-semibold text-[var(--text-primary)]">{provider.displayName}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-[#178a43]">
                    <span className="size-2 rounded-full bg-[#19a15f]" aria-hidden="true" />
                    {t("已配置")}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost"
                    ref={(element) => { if (element) editButtons.current.set(provider.id, element); else editButtons.current.delete(provider.id); }}
                    type="button"
                    aria-label={t("编辑 {{provider}}", { provider: provider.displayName })}
                    disabled={!provider.writable || savingId !== null}
                    onClick={() => onToggleEdit(provider)}
                    className={agentButtonClassName}
                  >
                    {t("编辑")}
                  </Button>
                  <AgentTooltip triggerMode="control" content={t("删除 {{provider}}", { provider: provider.displayName })}><Button variant="ghost"
                    type="button"
                    aria-label={t("删除 {{provider}}", { provider: provider.displayName })}
                    disabled={deleting || savingId !== null}
                    onClick={() => onDelete(provider)}
                    className={cn(agentButtonClassName, "size-9 px-0 text-[var(--text-secondary)] hover:bg-red-50 hover:text-red-600")}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button></AgentTooltip>
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
                    onCancel={() => {
                      onCancelEdit();
                      editButtons.current.get(provider.id)?.focus();
                    }}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <AgentState kind="empty" title={t("还没有已配置的模型供应商")} className="mt-3 border-dashed" />
      )}
    </div>
  );
};
