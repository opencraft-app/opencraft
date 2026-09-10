// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
"use client";

import { Loader2, RotateCw } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Badge } from "../../../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { useT } from "../../../i18n/t";
import { toast } from "../../../lib/toast";
import type { HermesConfiguredModel, HermesConnectionProbeResult } from "./model-config-client";
import type { useModelConfig } from "./use-model-config";
import { MODEL_SELECT_CONTENT_CLASS, ModelCompoundActionContent, modelCompoundClasses } from "./model-form-controls";

export function ConfiguredProviderModelForm({ anchor, savedModels, controller, isGlobalRegion, onCancel, onSaved, onDirtyChange, onSelectInteraction, onConnectionResult }: {
  anchor: HermesConfiguredModel;
  savedModels: HermesConfiguredModel[];
  controller: ReturnType<typeof useModelConfig>;
  isGlobalRegion: boolean;
  onCancel: () => void;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSelectInteraction: () => void;
  onConnectionResult: (result: HermesConnectionProbeResult) => void;
}) {
  const t = useT();
  const id = useId();
  const compound = modelCompoundClasses(isGlobalRegion);
  // 父组件按 Agent 与连接身份设置 key，草稿期间固定原始连接用于实例端校验。
  const [savedAnchor] = useState(anchor);
  const [modelId, setModelId] = useState("");
  const [discovered, setDiscovered] = useState<string[]>([]);
  const probeStarted = useRef(false);
  const mounted = useRef(true);
  const requestRevision = useRef(0);
  const ownedOperation = useRef<string | null>(null);
  const dismissToast = useRef<(() => void) | undefined>(undefined);
  const clearToast = useCallback(() => {
    dismissToast.current?.();
    dismissToast.current = undefined;
  }, []);
  const notify = useCallback((kind: "success" | "error", message: string) => {
    clearToast();
    dismissToast.current = toast[kind](message);
  }, [clearToast]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestRevision.current += 1;
      ownedOperation.current = null;
      probeStarted.current = false;
      controller.cancelProbe();
      clearToast();
    };
  }, [controller.cancelProbe, clearToast]);
  const shownError = useRef<string | null>(null);
  const busy = controller.operation !== null;
  const loading = controller.operation === "configured-probe";
  const saving = controller.operation === "append";
  const checking = controller.operation === "configured-connectivity-probe";
  const duplicate = savedModels.some((model) => model.id.trim() === modelId.trim());
  const options = useMemo(() => discovered.map((value) => ({ id: value, name: value })), [discovered]);
  const selectionAvailable = discovered.includes(modelId);

  useEffect(() => {
    if (!["configured-probe", "configured-connectivity-probe", "append"].includes(controller.operationErrorOperation ?? "") || !controller.operationError) return;
    if (controller.operationErrorOperation !== ownedOperation.current) return;
    const error = controller.operationError;
    if (shownError.current === error) return;
    shownError.current = error;
    const message = error === "provider_changed" ? t("服务商配置已变化，请刷新后重试")
      : error === "provider_ambiguous" ? t("该服务商存在多份连接配置，请重新配置后添加模型")
      : error === "credential_unavailable" ? t("该服务商凭据暂不可用，请在下方重新配置")
      : error === "credential_rejected" ? t("获取失败，请检查该服务商的 API Key 或访问权限")
      : error === "discovery_unsupported" ? t("暂无可用模型")
      : error === "discovery_timeout" ? t("获取模型超时，请稍后重试")
      : error === "provider_unsupported" ? t("当前智能体版本不支持此配置，请升级后重试")
      : error === "save_failed" ? t("添加失败，原配置已保留")
      : error === "rollback_failed" ? t("配置恢复失败，请刷新核对当前模型配置")
      : error === "save_unknown" ? t("未能确认保存结果，请刷新后查看")
      : error === "configuration_busy" ? t("模型配置正在更新，请稍后重试")
      : error === "invalid_model" ? t("请选择模型")
      : controller.operationErrorOperation === "configured-probe" ? t("未获取到可用模型，请检查API Key是否正确或有效")
      : controller.operationErrorOperation === "configured-connectivity-probe" ? t("模型可用性检测未通过")
      : t("未能确认保存结果，请刷新后查看");
    if (controller.operationErrorOperation === "configured-connectivity-probe") {
      onConnectionResult({ success: false, provider: savedAnchor.providerKey, model: modelId, baseUrl: savedAnchor.baseUrl, errorMessage: message });
    } else {
      notify("error", message);
    }
  }, [controller.operationError, controller.operationErrorOperation, t, modelId, savedAnchor, onConnectionResult, notify]);

  const changeModel = (value: string) => {
    setModelId(value);
    onDirtyChange(!!value.trim());
  };
  const probe = async () => {
    const revision = ++requestRevision.current;
    ownedOperation.current = "configured-probe";
    clearToast();
    shownError.current = null;
    const result = await controller.probe({ anchor: savedAnchor });
    if (!mounted.current || revision !== requestRevision.current || !result) return;
    if (!result.succeeded) {
      notify("error", t("未获取到可用模型，请检查API Key是否正确或有效"));
      return;
    }
    setDiscovered(result.models);
    if (result.models.length) notify("success", t("已获取可用模型"));
    else notify("error", t("未获取到可用模型，请检查API Key是否正确或有效"));
  };
  useEffect(() => {
    if (probeStarted.current) return;
    probeStarted.current = true;
    void probe();
  }, [controller.probe, savedAnchor]);
  const check = async () => {
    if (!selectionAvailable || busy) return;
    const revision = ++requestRevision.current;
    ownedOperation.current = "configured-connectivity-probe";
    clearToast();
    shownError.current = null;
    const result = await controller.testConnection({ anchor: savedAnchor, modelId: modelId.trim() });
    if (mounted.current && revision === requestRevision.current && result) onConnectionResult(result);
  };
  const save = async () => {
    if (!selectionAvailable || duplicate || busy) return;
    const revision = ++requestRevision.current;
    ownedOperation.current = "append";
    clearToast();
    shownError.current = null;
    const result = await controller.append(savedAnchor, modelId.trim());
    if (!mounted.current || revision !== requestRevision.current || !result) return;
    toast.success(t("模型已添加"));
    onSaved();
  };

  return (
    <div className="flex min-w-0 flex-wrap items-start gap-3" role="group" aria-label={t("添加模型")}>
      <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
        <label htmlFor={id} className="sr-only">{t("模型")}</label>
        <div className={compound.control}>
          <Select value={modelId} onValueChange={changeModel} disabled={busy || !options.length}>
            <SelectTrigger id={id} className={`${compound.field} w-full flex-1`} onPointerDownCapture={onSelectInteraction} onKeyDownCapture={onSelectInteraction}><SelectValue placeholder={loading ? t("获取中") : options.length ? t("请选择模型") : t("暂无可用模型")} /></SelectTrigger>
            <SelectContent position="popper" className={MODEL_SELECT_CONTENT_CLASS}>
              {options.map((option) => {
                const saved = savedModels.some((model) => model.id.trim() === option.id.trim());
                return (
                  <SelectItem key={option.id} value={option.id} textValue={option.name} disabled={saved} className="data-[disabled]:cursor-not-allowed data-[disabled]:text-[var(--text-tertiary)] [&>span:last-child]:min-w-0 [&>span:last-child]:flex-1">
                    <span className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span className="min-w-0 break-all">{option.name}</span>
                      {saved ? <Badge variant="neutral" className="shrink-0 border border-[var(--border-subtle)]">{t("已添加")}</Badge> : null}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Button variant="outline" type="button" disabled={busy || !selectionAvailable} onClick={() => void check()} className={compound.action}>
            <ModelCompoundActionContent idleLabel={t("检测模型状态")} loadingLabel={t("检测中...")} loading={checking} />
          </Button>
        </div>
        {!loading && !options.length ? (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void probe()} className="mt-2 rounded-md text-xs font-normal">
            <RotateCw className="size-3.5" aria-hidden="true" />{t("获取可用模型")}
          </Button>
        ) : null}
        {duplicate ? <p className="mt-2 text-sm text-red-600" role="status">{t("该模型已添加")}</p> : null}
      </div>
        <div className="flex h-12 shrink-0 items-center gap-2">
          <Button type="button" size="sm" disabled={busy || !selectionAvailable || duplicate} onClick={() => void save()} className="rounded-md text-xs font-normal">
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}{t("保存")}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={saving} onClick={onCancel} className="rounded-md text-xs font-normal">{t("取消")}</Button>
        </div>
    </div>
  );
}
