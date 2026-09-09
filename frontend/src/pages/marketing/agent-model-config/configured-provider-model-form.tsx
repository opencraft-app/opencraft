"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/i18n/t";
import { toast } from "@/lib/toast";
import type { HermesConfiguredModel, HermesConnectionProbeResult, ModelProviderOption } from "./model-config-client";
import type { useModelConfig } from "./use-model-config";
import { MODEL_SELECT_CONTENT_CLASS, ModelCompoundActionContent, modelCompoundClasses } from "./model-form-controls";

export function ConfiguredProviderModelForm({ anchor, savedModels, provider, controller, isGlobalRegion, onCancel, onSaved, onDirtyChange, onSelectInteraction, onConnectionResult }: {
  anchor: HermesConfiguredModel;
  savedModels: HermesConfiguredModel[];
  provider?: ModelProviderOption;
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
  // Keep the original connection identity until this draft is closed.
  const [savedAnchor] = useState(anchor);
  const [modelId, setModelId] = useState("");
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [manual, setManual] = useState(false);
  const probeStarted = useRef(false);
  const formRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    formRef.current?.querySelector<HTMLElement>('input, button[role="combobox"]')?.focus({ preventScroll: true });
    return () => { mounted.current = false; };
  }, []);
  const shownError = useRef<string | null>(null);
  const busy = controller.operation !== null;
  const loading = controller.operation === "configured-probe";
  const saving = controller.operation === "append";
  const checking = controller.operation === "configured-connectivity-probe";
  const duplicate = savedModels.some((model) => model.id.trim().toLowerCase() === modelId.trim().toLowerCase());
  const options = provider?.catalogModels ?? discovered.map((value) => ({ id: value, name: value }));

  useEffect(() => {
    if (!["configured-probe", "configured-connectivity-probe", "append"].includes(controller.operationErrorOperation ?? "") || !controller.operationError) return;
    const error = controller.operationError;
    if (shownError.current === error) return;
    shownError.current = error;
    const message = error === "provider_changed" ? t("服务商配置已变化，请刷新后重试")
      : error === "provider_ambiguous" ? t("该服务商存在多份连接配置，请重新配置后添加模型")
      : error === "credential_unavailable" ? t("该服务商凭据暂不可用，请在下方重新配置")
      : error === "credential_rejected" ? t("获取失败，请检查该服务商的 API Key 或访问权限")
      : error === "discovery_unsupported" ? t("该服务商暂不支持获取模型列表，请手动填写模型 ID")
      : error === "discovery_timeout" ? t("获取模型超时，请稍后重试")
      : error === "provider_unsupported" ? t("当前智能体版本不支持此配置，请升级后重试")
      : error === "save_failed" ? t("添加失败，原配置已保留")
      : error === "rollback_failed" ? t("配置恢复失败，请刷新核对当前模型配置")
      : error === "save_unknown" ? t("未能确认保存结果，请刷新后查看")
      : error === "configuration_busy" ? t("模型配置正在更新，请稍后重试")
      : error === "invalid_model" ? t("请输入有效的模型 ID")
      : controller.operationErrorOperation === "configured-probe" ? t("获取模型失败，可手动填写模型 ID")
      : controller.operationErrorOperation === "configured-connectivity-probe" ? t("模型可用性检测未通过")
      : t("未能确认保存结果，请刷新后查看");
    if (controller.operationErrorOperation === "configured-connectivity-probe") {
      onConnectionResult({ success: false, provider: savedAnchor.providerKey, model: modelId, baseUrl: savedAnchor.baseUrl, errorMessage: message });
    } else {
      if (controller.operationErrorOperation === "configured-probe") setManual(true);
      toast.error(message);
    }
  }, [controller.operationError, controller.operationErrorOperation, t, modelId, savedAnchor, onConnectionResult]);

  const changeModel = (value: string) => {
    setModelId(value);
    onDirtyChange(!!value.trim());
  };
  const probe = async () => {
    shownError.current = null;
    const result = await controller.probe({ anchor: savedAnchor });
    if (!mounted.current || !result) return;
    if (!result.succeeded) {
      setManual(true);
      toast.error(t("获取模型失败，可手动填写模型 ID"));
      return;
    }
    setDiscovered(result.models);
    setManual(!result.models.length);
    if (result.models.length) toast.success(t("已获取可用模型"));
    else toast.error(t("未获取到可用模型，可手动填写模型 ID"));
  };
  useEffect(() => {
    if (provider || probeStarted.current) return;
    probeStarted.current = true;
    void probe();
  }, [provider, controller.probe, savedAnchor]);
  const check = async () => {
    if (!modelId.trim() || busy) return;
    shownError.current = null;
    const result = await controller.testConnection({ anchor: savedAnchor, modelId: modelId.trim() });
    if (mounted.current && result) onConnectionResult(result);
  };
  const save = async () => {
    if (!modelId.trim() || duplicate || busy) return;
    shownError.current = null;
    const result = await controller.append(savedAnchor, modelId.trim());
    if (!mounted.current || !result) return;
    toast.success(t("模型已添加"));
    onSaved();
  };

  return (
    <div ref={formRef} className="flex min-w-0 flex-wrap items-start gap-3" role="group" aria-label={t("添加模型")}>
      <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
        <label htmlFor={id} className="sr-only">{t("模型")}</label>
        <div className={compound.control}>
        {!manual ? (
          <Select value={modelId} onValueChange={(value) => {
            if (value === "__manual-model-input__") {
              setManual(true);
              changeModel("");
              requestAnimationFrame(() => document.getElementById(id)?.focus({ preventScroll: true }));
            }
            else changeModel(value);
          }} disabled={busy || !options.length}>
            <SelectTrigger id={id} className={`${compound.field} w-full flex-1`} onPointerDownCapture={onSelectInteraction} onKeyDownCapture={onSelectInteraction}><SelectValue placeholder={loading ? t("获取中") : t("请选择模型")} /></SelectTrigger>
            <SelectContent position="popper" className={MODEL_SELECT_CONTENT_CLASS}>
              {options.map((option) => {
                const saved = savedModels.some((model) => model.id.trim().toLowerCase() === option.id.trim().toLowerCase());
                return <SelectItem key={option.id} value={option.id} disabled={saved}>{option.name}{saved ? ` (${t("已添加")})` : ""}</SelectItem>;
              })}
              {!provider ? <SelectItem value="__manual-model-input__">{t("输入模型 ID")}</SelectItem> : null}
            </SelectContent>
          </Select>
        ) : (
          <>
            <Input id={id} value={modelId} onChange={(event) => changeModel(event.target.value)} list={`${id}-models`} placeholder={t("输入模型 ID")} disabled={busy} maxLength={512} className={compound.field} />
            <datalist id={`${id}-models`}>{options.map((option) => <option key={option.id} value={option.id} />)}</datalist>
          </>
        )}
          <Button variant="outline" type="button" disabled={busy || !modelId.trim()} onClick={() => void check()} className={compound.action}>
            <ModelCompoundActionContent idleLabel={t("检测模型状态")} loadingLabel={t("检测中...")} loading={checking} />
          </Button>
        </div>
        {duplicate ? <p className="mt-2 text-sm text-red-600" role="status">{t("该模型已添加")}</p> : null}
        {provider && !options.length ? <p className="mt-2 text-sm text-black/50">{t("暂无可用模型")}</p> : null}
      </div>
        <div className="flex h-12 shrink-0 items-center gap-2">
          <Button type="button" size="sm" disabled={busy || !modelId.trim() || duplicate} onClick={() => void save()} className="rounded-md text-xs font-normal">
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}{t("保存")}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={saving} onClick={onCancel} className="rounded-md text-xs font-normal">{t("取消")}</Button>
        </div>
    </div>
  );
}
