import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { AgentSectionHeader } from "@/components/domain/agent-section-header";
import { AgentConfirmDialog, AgentSection, AgentState, AgentTooltip, agentButtonClassName } from "@/components/agents";
import { CommonSettingRowView } from "./agent-common-settings-views";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/t";
import { AGENT_SECTION_PATH_BY_ID } from "@/lib/agent-routes";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { BotRepository } from "@/repositories/types";
import {
  fetchHermesCommonSettingsSnapshot,
  getHermesCommonSettingKeysForGroup,
  isHermesCommonSettingAtResetTarget,
  requiresHermesCommonSettingGatewayRestart,
  validateHermesCommonSetting,
  type HermesApprovalMode,
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

type LoadSettings = (
  bots: BotRepository,
  botId: string,
  profileId?: string,
) => Promise<HermesCommonSettingsSnapshot>;
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
  profileId?: string;
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
  kind: "switch" | "number" | "select";
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
  approvalMode: null,
  destructiveSlashConfirm: null,
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
  profileId = "main",
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
  const [pendingApprovalMode, setPendingApprovalMode] = useState<HermesApprovalMode | null>(null);
  const [pendingResetGroup, setPendingResetGroup] = useState<HermesCommonSettingGroup | null>(null);
  const [resettingGroup, setResettingGroup] = useState<HermesCommonSettingGroup | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState(emptyFeedback);
  const requestIdRef = useRef(0);
  const saveInFlightRef = useRef<HermesCommonSettingKey | null>(null);
  const resetInFlightRef = useRef(false);
  const approvalTriggerRef = useRef<HTMLButtonElement>(null);

  const settingGroups: SettingGroup[] = [
    {
      id: "security",
      title: t("安全"),
      description: t("管理 Agent 的命令审批与会话操作确认方式。"),
      settings: [
        {
          key: "approvalMode",
          label: t("审批模式"),
          description: t("设置 Agent 执行高风险操作时的审批方式。"),
          kind: "select",
        },
        {
          key: "destructiveSlashConfirm",
          label: t("会话操作确认"),
          description: t("新建会话，或清空、撤销、删除会话内容前，先向你确认。"),
          kind: "switch",
        },
      ],
    },
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
    setPendingApprovalMode(null);
    setPendingResetGroup(null);
    setResettingGroup(null);
    setFeedback(emptyFeedback());
    if (botStatus !== "running") {
      setLoading(false);
      return;
    }
    try {
      const next = await loadSettings(bots, botId, profileId);
      if (requestIdRef.current !== requestId) return;
      setSnapshot(next);
      setDrafts(numericDrafts(next));
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [botId, botStatus, bots, loadSettings, profileId]);

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
      const result = await saveSetting({ bots, botId, profileId, key, value, getGatewayRestartCommand });
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
          ? !requiresHermesCommonSettingGatewayRestart(key)
            ? t("配置已保存，但回读验证失败，请刷新确认。")
            : t("配置已保存，但重启或回读验证失败，请刷新确认。")
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
    if (change.key === "destructiveSlashConfirm") {
      return change.nextValue
        ? t("开启后，新建会话，或清空、撤销、删除会话内容前，将先向你确认。")
        : t("关闭后，新建会话，或清空、撤销、删除会话内容时将直接执行。");
    }
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

  const changeApprovalMode = (nextValue: string) => {
    if (!snapshot || nextValue === snapshot.values.approvalMode) return;
    const validation = validateHermesCommonSetting("approvalMode", nextValue);
    if (!validation.ok || typeof validation.value !== "string") return;
    if (validation.value === "off") {
      setPendingApprovalMode(validation.value);
      return;
    }
    void commit("approvalMode", validation.value);
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
        profileId,
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
    <section className="agents-ui min-w-0">
      <AgentSectionHeader
        title={t("高级设置")}
        description={null}
        actions={(
          <AgentTooltip content={t("刷新")} triggerMode="control">
          <Button variant="ghost"
            type="button"
            onClick={() => void refresh()}
            disabled={loading || agentStopped}
            className="inline-flex h-8 w-8 p-0 shrink-0 cursor-pointer items-center justify-center text-black/35 transition hover:text-black/80 disabled:cursor-not-allowed disabled:text-black/20"
            aria-label={t("刷新")}
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
          </AgentTooltip>
        )}
      />
      {agentStopped && <AgentState kind="empty" className="mt-5" title={t("Agent 未运行，启动后才能查看和修改设置。")} />}
      {!agentStopped && loading && <AgentState kind="loading" className="mt-5" title={t("正在加载设置…")} />}
      {!agentStopped && !loading && loadError && (
        <AgentState kind="error" className="mt-5" title={t("读取配置失败：{{detail}}", { detail: loadError })}
          action={<Button type="button" variant="outline" className={agentButtonClassName} onClick={() => void refresh()}><RefreshCw className="size-4" aria-hidden="true" />{t("重试")}</Button>} />
      )}
      {!agentStopped && !loading && snapshot && (
        <div className="mt-5 flex flex-col gap-4">
          {settingGroups.map((group) => {
            const groupAlreadyDefault = getHermesCommonSettingKeysForGroup(group.id)
              .every((key) => isHermesCommonSettingAtResetTarget(key, snapshot));

            return (
              <AgentSection key={group.id} data-testid="common-setting-group" headingLevel={3}
                title={group.title} description={group.description}
                actions={<Button type="button" size="sm" variant="outline" className={agentButtonClassName}
                  disabled={allControlsDisabled || editingKey !== null || groupAlreadyDefault}
                  onClick={() => setPendingResetGroup(group.id)}>
                  {resettingGroup === group.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}{t("恢复默认")}
                </Button>}>
                <div className="mt-2">
                {group.settings.map((setting) => {
                  const unsupported = snapshot.unsupportedKeys.includes(setting.key);
                  const compressionDisabled = !unsupported && setting.kind === "number" && !snapshot.values.autoCompression;
                  const disabled = allControlsDisabled || unsupported || compressionDisabled;
                  const fieldFeedback = feedback[setting.key];
                  const editing = editingKey === setting.key;
                  const numberChanged = drafts[setting.key] !== String(snapshot.values[setting.key]);
                  return <CommonSettingRowView key={setting.key} setting={setting} value={snapshot.values[setting.key]}
                    draft={drafts[setting.key] ?? ""} disabled={disabled} unsupported={unsupported} compressionDisabled={compressionDisabled}
                    editing={editing} numberChanged={numberChanged} saving={savingKey === setting.key} editDisabled={disabled || editingKey !== null}
                    error={fieldFeedback?.message} selectTriggerRef={approvalTriggerRef}
                    labels={{ unsupported: t("当前 Agent 版本不支持"), viewContent: t("查看内容"), smart: t("智能审批"), manual: t("始终询问"), off: t("关闭审批"), save: t("保存"), cancel: t("取消"), edit: t("编辑"), saving: t("保存中…"), compressionDisabled: t("开启自动压缩后可修改") }}
                    onSwitchChange={(nextValue) => setPendingSwitchChange({ key: setting.key, label: setting.label, nextValue })}
                    onSelectChange={changeApprovalMode}
                    onDraftChange={(value) => { setDrafts((current) => ({ ...current, [setting.key]: value })); setFieldFeedback(setting.key, null); }}
                    onNumberKeyDown={(event) => onNumberKeyDown(event, setting.key)}
                    onSave={() => void commitNumber(setting.key)} onCancel={() => cancelNumberEdit(setting.key)}
                    onEdit={() => {
                      setDrafts((current) => ({ ...current, [setting.key]: String(snapshot.values[setting.key]) }));
                      setFieldFeedback(setting.key, null); setEditingKey(setting.key);
                    }} />;
                })}
                </div>
              </AgentSection>
            );
          })}
        </div>
      )}
      <AgentConfirmDialog open={pendingSwitchChange !== null}
        onOpenChange={(open) => { if (!open) setPendingSwitchChange(null); }}
        title={pendingSwitchChange?.nextValue ? t("确认开启「{{setting}}」？", { setting: pendingSwitchChange.label }) : t("确认关闭「{{setting}}」？", { setting: pendingSwitchChange?.label ?? "" })}
        description={pendingSwitchChange ? switchConfirmationDescription(pendingSwitchChange) : ""}
        cancelLabel={t("取消")} confirmLabel={pendingSwitchChange?.nextValue ? t("确认开启") : t("确认关闭")}
        confirmVariant={pendingSwitchChange?.key === "destructiveSlashConfirm" && !pendingSwitchChange.nextValue ? "destructive" : "default"}
        onConfirm={confirmSwitchChange} />
      <AgentConfirmDialog open={pendingApprovalMode === "off"} returnFocusRef={approvalTriggerRef}
        onOpenChange={(open) => { if (!open) setPendingApprovalMode(null); }}
        title={t("确认关闭命令审批？")}
        description={t("关闭后，Agent 执行高风险操作时将不再请求你的批准。请仅在可信环境中使用。")}
        cancelLabel={t("取消")} confirmLabel={t("确认关闭")}
        onConfirm={() => { setPendingApprovalMode(null); void commit("approvalMode", "off"); }} />
      <AgentConfirmDialog open={!!pendingResetGroup && !!pendingResetGroupTitle}
        onOpenChange={(open) => { if (!open) setPendingResetGroup(null); }}
        title={t("确认恢复「{{group}}」设置？", { group: pendingResetGroupTitle ?? "" })}
        description={pendingResetGroup === "security"
          ? t("恢复后审批模式将变为「关闭审批」，会话操作确认将关闭。")
          : t("将重置「{{group}}」分组下的自定义配置，重新恢复为 Hermes Agent 默认值。", { group: pendingResetGroupTitle ?? "" })}
        cancelLabel={t("取消")} confirmLabel={t("确认恢复")} onConfirm={() => void confirmResetGroup()} />
    </section>
  );
}
