import { KeyRound, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRepositories } from "@/contexts/repository-context";
import { AgentState, agentButtonClassName, agentPanelClassName } from "@/components/agents";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/t";
import {
  DeepSeekHarnessCommandClient,
  type DeepSeekHarnessExecDebugCommand,
  type DeepSeekHarnessProvider,
  type DeepSeekHarnessProviderID,
  type DeepSeekHarnessRegion,
} from "@/lib/deepseek-harness-command";
import { toast } from "@/lib/toast";
import {
  DeepSeekHarnessProviderCredentialForm,
  DeepSeekHarnessProviderSelect,
} from "@/pages/marketing/agent-deepseek-harness-provider-controls";
import { DeepSeekHarnessProviderDeleteDialog } from "@/pages/marketing/agent-deepseek-harness-provider-delete-dialog";
import { DeepSeekHarnessConfiguredProviderList } from "@/pages/marketing/agent-deepseek-harness-configured-provider-list";

interface AgentDeepSeekHarnessModelCardProps {
  botId: string;
  region: DeepSeekHarnessRegion;
  clientFactory?: (
    botId: string,
    execDebugCommand: DeepSeekHarnessExecDebugCommand,
  ) => DeepSeekHarnessCommandClient;
}

const defaultClientFactory = (
  botId: string,
  execDebugCommand: DeepSeekHarnessExecDebugCommand,
) => new DeepSeekHarnessCommandClient(botId, execDebugCommand);

const errorMessage = (error: unknown, fallback: string) => error instanceof Error && error.message
  ? error.message
  : fallback;

export const AgentDeepSeekHarnessModelCard = ({
  botId,
  region,
  clientFactory = defaultClientFactory,
}: AgentDeepSeekHarnessModelCardProps) => {
  const t = useT();
  const repositories = useRepositories();
  const [providers, setProviders] = useState<DeepSeekHarnessProvider[]>([]);
  const [addProviderId, setAddProviderId] = useState<DeepSeekHarnessProviderID>("deepseek");
  const [editingId, setEditingId] = useState<DeepSeekHarnessProviderID | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeepSeekHarnessProvider | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<DeepSeekHarnessProviderID | null>(null);
  const savingIdRef = useRef<DeepSeekHarnessProviderID | null>(null);
  const configuredHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [addFormVersion, setAddFormVersion] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const client = useMemo(
    () => clientFactory(botId, repositories.bots.execDebugCommand),
    [botId, clientFactory, repositories.bots.execDebugCommand],
  );

  const applyProviders = useCallback((nextProviders: DeepSeekHarnessProvider[]) => {
    setProviders(nextProviders);
    setAddProviderId((current) => (
      nextProviders.some((provider) => provider.id === current)
        ? current
        : nextProviders.find((provider) => provider.id === "deepseek")?.id
          ?? nextProviders[0]?.id
          ?? current
    ));
    setEditingId((current) => (
      current && nextProviders.some((provider) => provider.id === current && provider.configured)
        ? current
        : null
    ));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const nextProviders = await client.listProviders(region);
        if (!cancelled) applyProviders(nextProviders);
      } catch (error) {
        if (!cancelled) {
          setProviders([]);
          setLoadError(errorMessage(error, t("模型配置加载失败，请稍后重试")));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [applyProviders, client, region, reloadKey, t]);

  const configuredProviders = useMemo(
    () => providers.filter((provider) => provider.configured),
    [providers],
  );
  const addProvider = providers.find((provider) => provider.id === addProviderId)
    ?? providers[0];

  const refreshAfterMutation = async (optimistic: DeepSeekHarnessProvider[]) => {
    applyProviders(optimistic);
    try {
      applyProviders(await client.listProviders(region));
    } catch {
      // The fixed command succeeded; retain confirmed local state while a refresh is unavailable.
    }
  };

  const saveProvider = async (
    provider: DeepSeekHarnessProvider,
    rawValue: string,
    mode: "add" | "edit",
  ) => {
    if (savingIdRef.current) return;
    const value = rawValue.trim();
    if (!value && mode === "edit") {
      setEditingId(null);
      toast.success(t("已保留现有 API 密钥"));
      return;
    }
    if (!value) {
      toast.error(t("请输入 API 密钥"));
      return;
    }

    savingIdRef.current = provider.id;
    setSavingId(provider.id);
    try {
      await client.saveProvider(provider.id, value);
      await refreshAfterMutation(providers.map((item) => (
        item.id === provider.id ? { ...item, configured: true } : item
      )));
      setEditingId(null);
      if (mode === "add") setAddFormVersion((version) => version + 1);
      toast.success(t("{{provider}} 配置已保存", { provider: provider.displayName }));
    } catch (error) {
      toast.error(errorMessage(error, t("模型配置保存失败，请稍后重试")));
    } finally {
      savingIdRef.current = null;
      setSavingId(null);
    }
  };

  const removeProvider = async () => {
    if (!pendingDelete || deleting) return;
    const target = pendingDelete;
    setDeleting(true);
    setDeleteError(null);
    try {
      await client.removeProvider(target.id);
      await refreshAfterMutation(providers.map((provider) => (
        provider.id === target.id ? { ...provider, configured: false } : provider
      )));
      setPendingDelete(null);
      toast.success(t("{{provider}} 已删除", { provider: target.displayName }));
    } catch (error) {
      setDeleteError(errorMessage(error, t("模型供应商删除失败，请稍后重试")));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section
      role="region"
      aria-label={t("模型配置")}
      className={cn("agents-ui min-w-0 p-4 sm:p-5", agentPanelClassName)}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-black/[0.04] text-black/70">
          <KeyRound className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold leading-6 text-black/[0.95]">{t("模型配置")}</h2>
          <p className="mt-1 text-sm leading-6 text-black/50">{t("管理已配置模型供应商，或添加新的 API 密钥")}</p>
        </div>
      </div>

      {loading ? (
        <AgentState kind="loading" title={t("正在加载模型配置")} className="mt-5" />
      ) : loadError ? (
        <AgentState kind="error" title={loadError} className="mt-5" action={
          <Button variant="outline"
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
            className={agentButtonClassName}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {t("重试")}
          </Button>
        } />
      ) : (
        <div className="mt-6 space-y-6">
          <DeepSeekHarnessConfiguredProviderList
            headingRef={configuredHeadingRef}
            providers={configuredProviders}
            editingId={editingId}
            savingId={savingId}
            deleting={deleting}
            onToggleEdit={(provider) => {
              setEditingId((current) => current === provider.id ? null : provider.id);
            }}
            onCancelEdit={() => setEditingId(null)}
            onSave={(provider, value) => void saveProvider(provider, value, "edit")}
            onDelete={(provider) => {
              setPendingDelete(provider);
              setDeleteError(null);
            }}
          />

          <div className="border-t border-black/[0.08] pt-5">
            <h3 className="text-sm font-semibold text-black/75">{t("配置模型供应商")}</h3>
            {addProvider ? (
              <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(12rem,0.8fr)_minmax(0,1.5fr)] lg:items-end">
                <DeepSeekHarnessProviderSelect
                  providers={providers}
                  selectedId={addProvider.id}
                  disabled={savingId !== null || deleting}
                  onSelect={(provider) => {
                    setAddProviderId(provider.id);
                  }}
                />
                <DeepSeekHarnessProviderCredentialForm
                  key={`add-${addProvider.id}-${addFormVersion}`}
                  provider={addProvider}
                  mode="add"
                  busy={savingId !== null || deleting}
                  onSubmit={(value) => void saveProvider(addProvider, value, "add")}
                />
              </div>
            ) : (
              <p className="mt-3 text-sm text-black/45">{t("暂无可用模型供应商")}</p>
            )}
          </div>
        </div>
      )}

      <DeepSeekHarnessProviderDeleteDialog
        fallbackFocusRef={configuredHeadingRef}
        provider={pendingDelete}
        busy={deleting}
        error={deleteError}
        onClose={() => {
          setPendingDelete(null);
          setDeleteError(null);
        }}
        onConfirm={() => void removeProvider()}
      />
    </section>
  );
};
