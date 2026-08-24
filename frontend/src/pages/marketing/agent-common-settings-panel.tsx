import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, Loader2, Pencil, RefreshCw, X } from "lucide-react";

import { AgentSectionHeader } from "@/components/domain/agent-section-header";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/i18n/t";
import { AGENT_SECTION_PATH_BY_ID } from "@/lib/agent-routes";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { BotRepository } from "@/repositories/types";
import {
  fetchHermesCommonSettingsSnapshot,
  getHermesCommonSettingKeysForGroup,
  validateHermesCommonSetting,
  type HermesCommonSettingGroup,
  type HermesCommonSettingKey,
  type HermesCommonSettingValue,
  type HermesCommonSettingsSnapshot,
} from "@/pages/marketing/agent-common-settings";
import {
  resetHermesCommonSettingsGroup,
  type HermesCommonSettingsResetResult,
  type ResetHermesCommonSettingsGroupOptions,
} from "@/pages/marketing/agent-common-settings-reset";
import {
  saveHermesCommonSetting,
  type HermesCommonSettingSaveResult,
  type SaveHermesCommonSettingOptions,
} from "@/pages/marketing/agent-common-settings-save";

type LoadSettings = (bots: BotRepository, botId: string) => Promise<HermesCommonSettingsSnapshot>;
type SaveSetting = (options: SaveHermesCommonSettingOptions) => Promise<HermesCommonSettingSaveResult>;
type ResetSettings = (options: ResetHermesCommonSettingsGroupOptions) => Promise<HermesCommonSettingsResetResult>;
type FieldFeedback = { kind: "error"; message: string } | null;
type PendingSwitchChange = {
  key: HermesCommonSettingKey;
  label: string;
  nextValue: boolean;
};

interface AgentCommonSettingsPanelProps {
  botId: string;
  botStatus: string;
  bots: BotRepository;
  getGatewayRestartCommand: () => Promise<string>;
  loadSettings?: LoadSettings;
  saveSetting?: SaveSetting;
  resetSettings?: ResetSettings;
}

interface SettingCopy {
  key: HermesCommonSettingKey;
  label: string;
  description: string;
  descriptionHref?: string;
  kind: "switch" | "number";
  step?: string;
  min?: string;
  max?: string;
}

interface SettingGroup {
  id: HermesCommonSettingGroup;
  title: string;
  description: string;
  settings: SettingCopy[];
}

const emptyFeedback = (): Record<HermesCommonSettingKey, FieldFeedback> => ({
  persistentMemory: null,
  userProfile: null,
  autoCompression: null,
  compressionThreshold: null,
  compressionTarget: null,
  protectedRecentMessages: null,
});

const numericDrafts = (snapshot: HermesCommonSettingsSnapshot) => ({
  compressionThreshold: String(snapshot.values.compressionThreshold),
  compressionTarget: String(snapshot.values.compressionTarget),
  protectedRecentMessages: String(snapshot.values.protectedRecentMessages),
});

const isNumericKey = (key: HermesCommonSettingKey): boolean =>
  key === "compressionThreshold" || key === "compressionTarget" || key === "protectedRecentMessages";

export function AgentCommonSettingsPanel({
  botId,
  botStatus,
  bots,
  getGatewayRestartCommand,
  loadSettings = fetchHermesCommonSettingsSnapshot,
  saveSetting = saveHermesCommonSetting,
  resetSettings = resetHermesCommonSettingsGroup,
}: AgentCommonSettingsPanelProps) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<HermesCommonSettingsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<HermesCommonSettingKey | null>(null);
  const [editingKey, setEditingKey] = useState<HermesCommonSettingKey | null>(null);
  const [pendingSwitchChange, setPendingSwitchChange] = useState<PendingSwitchChange | null>(null);
  const [pendingResetGroup, setPendingResetGroup] = useState<HermesCommonSettingGroup | null>(null);
  const [resettingGroup, setResettingGroup] = useState<HermesCommonSettingGroup | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState(emptyFeedback);
  const requestIdRef = useRef(0);
  const saveInFlightRef = useRef<HermesCommonSettingKey | null>(null);
  const resetInFlightRef = useRef(false);

  const settingGroups: SettingGroup[] = [
    {
      id: "memory",
      title: t("记忆"),
      description: t("管理跨会话保留的长期信息与用户偏好。"),
      settings: [
        { key: "persistentMemory", label: t("长期记忆"), description: t("让 Agent 在会话中读取和更新长期记忆文件 MEMORY.md。"), descriptionHref: AGENT_SECTION_PATH_BY_ID.memory, kind: "switch" },
        { key: "userProfile", label: t("用户画像"), description: t("让 Agent 使用 USER.md 按需记录和更新你的偏好、沟通方式与使用习惯。"), descriptionHref: AGENT_SECTION_PATH_BY_ID.memory, kind: "switch" },
      ],
    },
    {
      id: "context",
      title: t("上下文管理"),
      description: t("管理长对话的上下文处理与压缩设置。"),
      settings: [
        { key: "autoCompression", label: t("自动压缩"), description: t("长对话接近上下文限制时，自动总结较早内容。"), kind: "switch" },
        { key: "compressionThreshold", label: t("压缩触发阈值"), description: t("上下文占用达到该比例时开始压缩，可填写 0 到 1。"), kind: "number", step: "0.05", min: "0", max: "1" },
        { key: "compressionTarget", label: t("压缩保留比例"), description: t("压缩后保留多少近期对话原文；数值越大，保留越多，可填写 0.1 到 0.8。"), kind: "number", step: "0.05", min: "0.1", max: "0.8" },
        { key: "protectedRecentMessages", label: t("保留最近消息"), description: t("无论如何压缩，都完整保留的最近消息数量，最少 1 条。"), kind: "number", step: "1", min: "1" },
      ],
    },
  ];

  const refresh = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setLoadError(null);
    setSnapshot(null);
    setSavingKey(null);
    setEditingKey(null);
    setPendingSwitchChange(null);
    setPendingResetGroup(null);
    setResettingGroup(null);
    setFeedback(emptyFeedback());
    try {
      const next = await loadSettings(bots, botId);
      if (requestIdRef.current !== requestId) return;
      setSnapshot(next);
      setDrafts(numericDrafts(next));
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [botId, bots, loadSettings]);

  useEffect(() => {
    void refresh();
    return () => {
      requestIdRef.current += 1;
      saveInFlightRef.current = null;
      resetInFlightRef.current = false;
    };
  }, [refresh]);

  const setFieldFeedback = (key: HermesCommonSettingKey, next: FieldFeedback) => {
    setFeedback((current) => ({ ...current, [key]: next }));
  };

  const commit = async (key: HermesCommonSettingKey, value: HermesCommonSettingValue): Promise<boolean> => {
    if (!snapshot || saveInFlightRef.current || resetInFlightRef.current || botStatus !== "running" || snapshot.unsupportedKeys.includes(key)) return false;
    saveInFlightRef.current = key;
    setSavingKey(key);
    setFieldFeedback(key, null);
    const requestId = requestIdRef.current;
    let saved = false;
    try {
      const result = await saveSetting({ bots, botId, key, value, getGatewayRestartCommand });
      if (requestIdRef.current !== requestId) return false;
      if (result.status === "success") {
        setSnapshot(result.snapshot);
        if (isNumericKey(key)) {
          setDrafts((current) => ({ ...current, [key]: String(result.snapshot.values[key]) }));
        }
        toast.success(t("已保存"));
        saved = true;
      } else {
        const message = result.status === "partial"
          ? t("配置已保存，但重启或回读验证失败，请刷新确认。")
          : t("保存失败：{{detail}}", { detail: result.error.message });
        setFieldFeedback(key, { kind: "error", message });
      }
    } catch (error) {
      if (requestIdRef.current === requestId) {
        setFieldFeedback(key, { kind: "error", message: t("保存失败：{{detail}}", { detail: error instanceof Error ? error.message : String(error) }) });
      }
    } finally {
      if (requestIdRef.current === requestId) {
        saveInFlightRef.current = null;
        setSavingKey(null);
      }
    }
    return saved;
  };

  const cancelNumberEdit = (key: HermesCommonSettingKey) => {
    if (!snapshot) return;
    setDrafts((current) => ({ ...current, [key]: String(snapshot.values[key]) }));
    setFieldFeedback(key, null);
    setEditingKey(null);
  };

  const commitNumber = async (key: HermesCommonSettingKey) => {
    if (!snapshot) return false;
    const validation = validateHermesCommonSetting(key, drafts[key] ?? "");
    if (!validation.ok) {
      const message = validation.reason === "integer"
        ? t("请输入整数")
        : validation.reason === "range"
          ? t("输入值超出允许范围")
          : t("请输入有效数值");
      setFieldFeedback(key, { kind: "error", message });
      return false;
    }
    if (Object.is(snapshot.values[key], validation.value)) {
      setDrafts((current) => ({ ...current, [key]: String(snapshot.values[key]) }));
      setFieldFeedback(key, null);
      setEditingKey(null);
      return false;
    }
    const saved = await commit(key, validation.value);
    if (saved) setEditingKey(null);
    return saved;
  };

  const onNumberKeyDown = (event: KeyboardEvent<HTMLInputElement>, key: HermesCommonSettingKey) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitNumber(key);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelNumberEdit(key);
    }
  };

  const switchConfirmationDescription = (change: PendingSwitchChange): string => {
    if (change.key === "persistentMemory") {
      return change.nextValue
        ? t("开启后，Agent 将在后续会话中读取和更新 MEMORY.md。")
        : t("关闭后，Agent 将停止读取和更新 MEMORY.md，已有内容不会删除。");
    }
    if (change.key === "userProfile") {
      return change.nextValue
        ? t("开启后，Agent 将使用 USER.md 维护语言、沟通方式和协作偏好。")
        : t("关闭后，Agent 将停止使用 USER.md 维护用户偏好，已有内容不会删除。");
    }
    return change.nextValue
      ? t("开启后，长对话接近上下文限制时会自动总结较早内容，并继续使用已有压缩参数。")
      : t("关闭后，长对话不会自动总结较早内容，可能更快达到上下文限制；已有压缩参数不会删除。");
  };

  const confirmSwitchChange = () => {
    if (!pendingSwitchChange) return;
    const { key, nextValue } = pendingSwitchChange;
    setPendingSwitchChange(null);
    void commit(key, nextValue);
  };

  const confirmResetGroup = async () => {
    if (!pendingResetGroup || !snapshot || saveInFlightRef.current || resetInFlightRef.current || botStatus !== "running") return;
    const group = pendingResetGroup;
    const requestId = requestIdRef.current;
    setPendingResetGroup(null);
    resetInFlightRef.current = true;
    setResettingGroup(group);
    try {
      const result = await resetSettings({
        bots,
        botId,
        group,
        snapshot,
        getGatewayRestartCommand,
      });
      if (requestIdRef.current !== requestId) return;
      if (result.status === "success") {
        setSnapshot(result.snapshot);
        setDrafts(numericDrafts(result.snapshot));
        toast.success(t("已恢复默认"));
      } else if (result.status === "partial") {
        if (result.snapshot) {
          setSnapshot(result.snapshot);
          setDrafts(numericDrafts(result.snapshot));
        }
        toast.error(t("部分配置已恢复，但后续操作失败，请刷新确认。"));
      } else {
        toast.error(t("恢复失败：{{detail}}", { detail: result.error.message }));
      }
    } catch (error) {
      if (requestIdRef.current === requestId) {
        toast.error(t("恢复失败：{{detail}}", { detail: error instanceof Error ? error.message : String(error) }));
      }
    } finally {
      if (requestIdRef.current === requestId) {
        resetInFlightRef.current = false;
        setResettingGroup(null);
      }
    }
  };

  const agentStopped = botStatus !== "running";
  const allControlsDisabled = loading || savingKey !== null || resettingGroup !== null || agentStopped;
  const pendingResetGroupTitle = pendingResetGroup
    ? settingGroups.find((group) => group.id === pendingResetGroup)?.title
    : null;

  return (
    <section className="min-w-0">
      <AgentSectionHeader title={t("常用设置")} description={null} />
      {agentStopped && <p className="mt-5 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800">{t("Agent 未运行，启动后才能修改设置。")}</p>}
      {loading && <div className="flex items-center justify-center py-16 text-sm text-black/45"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{t("正在读取当前配置…")}</div>}
      {!loading && loadError && (
        <div className="mt-6 border-y border-black/[0.08] py-10 text-center">
          <p role="alert" className="text-sm text-red-600">{t("读取配置失败：{{detail}}", { detail: loadError })}</p>
          <button type="button" onClick={() => void refresh()} className="mt-4 inline-flex items-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm hover:bg-black/[0.03]"><RefreshCw className="h-4 w-4" />{t("重试")}</button>
        </div>
      )}
      {!loading && snapshot && (
        <div className="mt-8 flex flex-col gap-10">
          {settingGroups.map((group, groupIndex) => {
            const groupAlreadyDefault = getHermesCommonSettingKeysForGroup(group.id)
              .every((key) => snapshot.defaultedKeys.includes(key));

            return (
              <section
                key={group.id}
                data-testid="common-setting-group"
                className={cn(groupIndex !== 0 && "border-t border-black/[0.08] pt-10")}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-balance text-base font-semibold text-black/90">{group.title}</h3>
                  <button
                    type="button"
                    disabled={allControlsDisabled || editingKey !== null || groupAlreadyDefault}
                    onClick={() => setPendingResetGroup(group.id)}
                    className="inline-flex items-center rounded-md border border-black/10 px-2 py-1 text-[12px] font-medium text-black/70 transition hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20 disabled:cursor-not-allowed disabled:border-black/[0.06] disabled:bg-black/[0.02] disabled:text-black/25"
                  >
                    {resettingGroup === group.id && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                    {t("恢复默认")}
                  </button>
                </div>
                <p className="mt-1 text-pretty text-sm leading-6 text-black/45">{group.description}</p>
                <div className="mt-2">
                {group.settings.map((setting) => {
                  const unsupported = snapshot.unsupportedKeys.includes(setting.key);
                  const compressionDisabled = !unsupported && setting.kind === "number" && !snapshot.values.autoCompression;
                  const disabled = allControlsDisabled || unsupported || compressionDisabled;
                  const fieldFeedback = feedback[setting.key];
                  const editing = editingKey === setting.key;
                  const numberChanged = drafts[setting.key] !== String(snapshot.values[setting.key]);
                  return (
                    <div
                      key={setting.key}
                      data-testid="common-setting-row"
                      className={cn(
                        "grid gap-4 py-6 sm:items-center sm:gap-10",
                        setting.kind === "switch"
                          ? "sm:grid-cols-[minmax(0,1fr)_auto]"
                          : "sm:grid-cols-[minmax(0,1fr)_17rem]",
                      )}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-[15px] font-medium text-black/90">{setting.label}</h4>
                          {unsupported && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">{t("当前 Agent 版本不支持")}</span>}
                        </div>
                        <p className="mt-1 text-pretty text-sm leading-6 text-black/45">
                          {setting.description}
                          {setting.descriptionHref && (
                            <Link
                              href={setting.descriptionHref}
                              className="ml-2 whitespace-nowrap text-[var(--lw-accent)] hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                            >
                              {t("查看内容")}
                            </Link>
                          )}
                        </p>
                      </div>
                      <div className="flex min-w-0 flex-col items-end gap-1.5">
                        {unsupported ? (
                          <span
                            data-testid={`common-setting-unsupported-${setting.key}`}
                            className="inline-flex min-h-6 items-center text-sm text-black/35"
                          >
                            —
                          </span>
                        ) : setting.kind === "switch" ? (
                          <button
                            type="button"
                            role="switch"
                            aria-label={setting.label}
                            aria-checked={Boolean(snapshot.values[setting.key])}
                            disabled={disabled}
                            onClick={() => setPendingSwitchChange({
                              key: setting.key,
                              label: setting.label,
                              nextValue: !Boolean(snapshot.values[setting.key]),
                            })}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${snapshot.values[setting.key] ? "bg-[var(--lw-accent)]" : "bg-black/15"} disabled:cursor-not-allowed disabled:opacity-45`}
                          >
                            <span className={`h-5 w-5 rounded-full bg-white shadow-sm transition ${snapshot.values[setting.key] ? "translate-x-[1.375rem]" : "translate-x-0.5"}`} />
                          </button>
                        ) : editing ? (
                          <div className="flex w-full max-w-[17rem] items-center gap-2">
                            <input
                              type="number"
                              aria-label={setting.label}
                              value={drafts[setting.key] ?? ""}
                              step={setting.step}
                              min={setting.min}
                              max={setting.max}
                              disabled={disabled}
                              onChange={(event) => {
                                setDrafts((current) => ({ ...current, [setting.key]: event.target.value }));
                                setFieldFeedback(setting.key, null);
                              }}
                              onKeyDown={(event) => onNumberKeyDown(event, setting.key)}
                              className="h-10 min-w-0 flex-1 rounded-md border border-black/10 bg-white px-3 text-sm text-black/85 outline-none focus:border-black/30 disabled:cursor-not-allowed disabled:bg-black/[0.03] disabled:text-black/35"
                            />
                            <button
                              type="button"
                              aria-label={`${t("保存")}${setting.label}`}
                              disabled={disabled || !numberChanged}
                              onClick={() => void commitNumber(setting.key)}
                              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--lw-accent)] text-white transition hover:bg-[var(--lw-accent-hover)] disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              {savingKey === setting.key ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                            </button>
                            <button
                              type="button"
                              aria-label={`${t("取消")}${t("编辑")}${setting.label}`}
                              disabled={savingKey === setting.key}
                              onClick={() => cancelNumberEdit(setting.key)}
                              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-black/10 text-black/55 transition hover:bg-black/[0.03] hover:text-black/80 disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              <X className="size-4" />
                            </button>
                          </div>
                        ) : (
                          <div
                            className="group/value relative w-full max-w-[17rem] pt-8"
                          >
                            <div
                              className={cn(
                                "flex h-10 w-full items-center justify-end rounded-md border border-black/10 bg-white px-3",
                                disabled && "bg-black/[0.03]",
                              )}
                            >
                              <span
                                data-testid={`common-setting-value-${setting.key}`}
                                className={cn("text-sm tabular-nums", disabled ? "text-black/35" : "text-black/75")}
                              >
                                {snapshot.values[setting.key]}
                              </span>
                            </div>
                            <button
                              type="button"
                              aria-label={`${t("编辑")}${setting.label}`}
                              disabled={disabled || editingKey !== null}
                              onClick={() => {
                                setDrafts((current) => ({ ...current, [setting.key]: String(snapshot.values[setting.key]) }));
                                setFieldFeedback(setting.key, null);
                                setEditingKey(setting.key);
                              }}
                              className="absolute right-2 top-0 inline-flex size-7 items-center justify-center rounded-md border border-black/10 bg-white text-black/45 opacity-100 shadow-sm transition-opacity hover:text-black/75 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-0 sm:opacity-0 sm:group-hover/value:opacity-100"
                            >
                              <Pencil className="size-3.5" />
                            </button>
                          </div>
                        )}
                        {savingKey === setting.key && <span className="text-xs text-black/45">{t("保存中…")}</span>}
                        {fieldFeedback && <span role="alert" className="text-right text-xs text-red-600">{fieldFeedback.message}</span>}
                        {compressionDisabled && <span className="text-xs text-black/35">{t("开启自动压缩后可修改")}</span>}
                      </div>
                    </div>
                  );
                })}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {pendingSwitchChange && (
        <Dialog open onOpenChange={(open) => {
          if (!open) setPendingSwitchChange(null);
        }}>
          <DialogContent className="w-[calc(100vw-2rem)] max-w-[28rem] rounded-lg bg-white p-6 shadow-2xl md:w-[28rem]">
            <DialogHeader className="mb-5 pr-8">
              <DialogTitle className="text-balance text-lg font-semibold text-black/90">
                {pendingSwitchChange.nextValue
                  ? t("确认开启「{{setting}}」？", { setting: pendingSwitchChange.label })
                  : t("确认关闭「{{setting}}」？", { setting: pendingSwitchChange.label })}
              </DialogTitle>
              <DialogDescription className="mt-1 text-pretty text-sm leading-6 text-black/55">
                {switchConfirmationDescription(pendingSwitchChange)}
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingSwitchChange(null)}
                className="inline-flex h-9 items-center justify-center rounded-md border border-black/[0.08] bg-white px-4 text-sm font-semibold text-black/65 transition hover:bg-black/[0.04]"
              >
                {t("取消")}
              </button>
              <button
                type="button"
                onClick={confirmSwitchChange}
                className="inline-flex h-9 min-w-[104px] items-center justify-center rounded-md bg-[var(--text-primary)] px-4 text-sm font-semibold text-white transition hover:opacity-90"
              >
                {pendingSwitchChange.nextValue ? t("确认开启") : t("确认关闭")}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {pendingResetGroup && pendingResetGroupTitle && (
        <Dialog open onOpenChange={(open) => {
          if (!open) setPendingResetGroup(null);
        }}>
          <DialogContent className="w-[calc(100vw-2rem)] max-w-[28rem] rounded-lg bg-white p-6 shadow-2xl md:w-[28rem]">
            <DialogHeader className="mb-5 pr-8">
              <DialogTitle className="text-balance text-lg font-semibold text-black/90">
                {t("确认恢复「{{group}}」设置？", { group: pendingResetGroupTitle })}
              </DialogTitle>
              <DialogDescription className="mt-1 text-pretty text-sm leading-6 text-black/55">
                {t("将重置「{{group}}」分组下的自定义配置，重新恢复为 Hermes Agent 默认值。", {
                  group: pendingResetGroupTitle,
                })}
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingResetGroup(null)}
                className="inline-flex h-9 items-center justify-center rounded-md border border-black/[0.08] bg-white px-4 text-sm font-semibold text-black/65 transition hover:bg-black/[0.04]"
              >
                {t("取消")}
              </button>
              <button
                type="button"
                onClick={() => void confirmResetGroup()}
                className="inline-flex h-9 min-w-[104px] items-center justify-center rounded-md bg-red-600 px-4 text-sm font-semibold text-white transition hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
              >
                {t("确认恢复")}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
