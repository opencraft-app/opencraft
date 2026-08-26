import { KeyRound, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useRepositories } from "@/contexts/repository-context";
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
    if (savingId) return;
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
      className="rounded-md border border-black/[0.08] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.04)] sm:p-6"
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
        <div role="status" className="mt-6 flex min-h-28 items-center gap-2 text-sm text-black/50">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {t("正在加载模型配置")}
        </div>
      ) : loadError ? (
        <div className="mt-6 min-h-28 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <p role="alert">{loadError}</p>
          <button
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
            className="mt-3 inline-flex h-9 items-center justify-center gap-2 rounded-md border border-red-300 bg-white px-3 font-semibold hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {t("重试")}
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          <DeepSeekHarnessConfiguredProviderList
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
