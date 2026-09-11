// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { CheckCircle2, ChevronDown, ExternalLink, Loader2, MessageCircle, Plus, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { useT } from "../../../i18n/t";
import { AGENT_SECTION_PATH_BY_ID } from "../../../lib/agent-routes";
import type { InstalledSkillLoadState } from "../../../lib/hermes-skills-client";
import { formatScenarioChannelLabel } from "../scenario-task-cron";
import {
  SCENARIO_MULTISELECT_SEPARATOR,
  formatScenarioQuickPrompt,
  formatScenarioQuickPromptSegments,
  isScenarioTaskFieldVisible,
  type ScenarioTaskField,
  type ScenarioTaskPack,
  type ScenarioTriggerType,
} from "./scenario-packs";
import { ScenarioQuickPromptEditor } from "./ScenarioQuickPromptEditor";
import {
  buildScenarioFullPrompt,
  isScenarioFullPrompt,
  supportsScenarioFullPrompt,
  type ScenarioFullPromptIssue,
} from "./scenario-full-prompt";
import {
  buildScenarioTaskDraft,
  formatScenarioTaskDraftFrequency,
  getScenarioTaskValidationIssue,
  type ScenarioTaskDraft,
} from "./scenario-task-builder";

export function ScenarioInstallModal({
  pack,
  botId,
  submitting,
  initialValues,
  initialUserPrompt,
  initialDeliver,
  enabledChannels,
  channelStatus,
  deferDeliverySetup = false,
  onRefreshChannels,
  onClose,
  onRunOnce,
  onEnableDirect,
}: {
  pack: ScenarioTaskPack;
  botId?: string;
  submitting: boolean;
  initialValues?: Record<string, string>;
  initialUserPrompt?: string;
  initialDeliver?: string;
  initialSkill?: string;
  enabledChannels: Set<string> | null;
  channelStatus: "loading" | "ready";
  skillLoadState?: InstalledSkillLoadState;
  deferDeliverySetup?: boolean;
  onRefreshChannels: () => Promise<void>;
  onRefreshSkills?: () => Promise<InstalledSkillLoadState>;
  onClose: () => void;
  onRunOnce: (draft: ScenarioTaskDraft) => void;
  onEnableDirect: (draft: ScenarioTaskDraft) => void;
}) {
  const t = useT();
  const usesFullPrompt = supportsScenarioFullPrompt(pack);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const entries = pack.fields.map((field) => [field.key, initialValues?.[field.key] ?? field.defaultValue]);
    return Object.fromEntries(entries);
  });
  const [editableTaskRequest, setEditableTaskRequest] = useState(() => {
    const initialPrompt = initialUserPrompt?.trim();
    if (initialPrompt) {
      return isScenarioFullPrompt(initialPrompt)
        ? extractScenarioTaskRequest(initialPrompt)
        : initialPrompt;
    }
    return formatScenarioQuickPrompt(pack, Object.fromEntries(
      pack.fields.map((field) => [field.key, initialValues?.[field.key] ?? field.defaultValue]),
    ));
  });
  const [moreSettingsOpen, setMoreSettingsOpen] = useState(false);
  const [deliverTargets, setDeliverTargets] = useState<string[]>(() => selectInitialPushDeliverTargets(initialDeliver, enabledChannels));
  const deliverValue = deliverTargets.join(",");
  const hasInlinePrompt = Boolean(pack.quickPromptTemplate?.length);
  const quickPromptSegments = useMemo(
    () => formatScenarioQuickPromptSegments(pack, values),
    [pack, values],
  );
  const userPrompt = useMemo(
    () => usesFullPrompt
      ? buildScenarioFullPrompt(pack, editableTaskRequest)
      : editableTaskRequest,
    [editableTaskRequest, pack, usesFullPrompt],
  );
  const draft = useMemo(
    () => buildScenarioTaskDraft({ pack, values, deliver: deliverValue, userPrompt, selectedSkill: "" }),
    [deliverValue, pack, userPrompt, values],
  );
  const selectedChannelConnected = deferDeliverySetup
    || (
      channelStatus === "ready"
      && deliverTargets.length > 0
      && deliverTargets.every((target) => enabledChannels?.has(target) === true)
    );
  const validationIssue = useMemo(
    () => usesFullPrompt ? null : getScenarioTaskValidationIssue(pack, values),
    [pack, usesFullPrompt, values],
  );
  const validationMessage = validationIssue
    ? getScenarioTaskValidationMessage(pack, validationIssue, t)
    : usesFullPrompt
      ? getScenarioFullPromptValidationMessage(draft.promptScheduleIssue, t)
      : null;
  const actionDisabled = submitting
    || !selectedChannelConnected
    || Boolean(validationIssue)
    || Boolean(draft.promptScheduleIssue)
    || !userPrompt.trim();
  const isOneShotTask = draft.runMode === "one-shot";
  const triggerType = isOneShotTask ? "schedule" : getScenarioTriggerType(pack);
  const frequencyLabel = formatScenarioTaskDraftFrequency(pack, draft);
  const visibleFields = pack.fields.filter((field) => isScenarioTaskFieldVisible(field, values));
  const inlineFieldKeys = new Set(
    pack.quickPromptTemplate
      ?.filter((part) => part.type === "field")
      .map((part) => part.fieldKey) ?? [],
  );
  const confirmFields = hasInlinePrompt || usesFullPrompt
    ? []
    : visibleFields.filter((field) => field.required || field.quickConfirm);
  const secondaryFields = hasInlinePrompt || usesFullPrompt
    ? visibleFields.filter((field) => !inlineFieldKeys.has(field.key))
    : visibleFields.filter((field) => !field.required && !field.quickConfirm);

  useEffect(() => {
    if (deferDeliverySetup) return;
    if (channelStatus !== "ready" || !enabledChannels) return;
    setDeliverTargets((current) => {
      const available = current.filter((target) => enabledChannels.has(target));
      if (available.length) return available;
      const [firstAvailable] = sortConfiguredScenarioChannels(enabledChannels);
      return firstAvailable ? [firstAvailable] : [];
    });
  }, [channelStatus, deferDeliverySetup, enabledChannels]);

  const updateValue = (key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && !submitting) onClose();
    }}>
      <DialogContent className="max-h-[calc(100vh-24px)] w-[calc(100vw-2rem)] max-w-[640px] overflow-x-hidden overflow-y-auto rounded-lg bg-white p-5 shadow-2xl md:w-[640px] md:p-6">
        <DialogHeader className="mb-4 pr-8">
          <p className="text-xs font-medium text-black/42">{t("20 秒快速启用")}</p>
          <DialogTitle className="mt-1 text-xl font-semibold text-black/90">{pack.name}</DialogTitle>
          <DialogDescription className="mt-1 text-sm leading-6 text-black/55">
            {usesFullPrompt
              ? t("我先帮你写好一版，你只改真实情况。")
              : hasInlinePrompt
              ? t("我先帮你写好一版，红色文字可按需修改。")
              : t("改一句任务要求，确认关键设置即可开始。")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-w-0 gap-3.5">
          {hasInlinePrompt ? (
            <ScenarioQuickPromptEditor
              value={editableTaskRequest}
              onChange={setEditableTaskRequest}
              suggestedSegments={quickPromptSegments}
              footer={!deferDeliverySetup && botId ? (
                <ScenarioDeliverPicker
                  value={deliverTargets}
                  enabledChannels={enabledChannels}
                  channelStatus={channelStatus}
                  onRefreshChannels={onRefreshChannels}
                  onChange={setDeliverTargets}
                />
              ) : undefined}
            />
          ) : (
          <section>
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="scenario-quick-prompt" className="text-sm font-semibold text-black/82">{t("任务要求")}</label>
              <span className="rounded-full bg-[#EEF7F1] px-2 py-0.5 text-[11px] font-medium text-[#237A46]">{t("已有默认值")}</span>
            </div>
            <textarea
              id="scenario-quick-prompt"
              aria-label={t("任务要求")}
              value={editableTaskRequest}
              onChange={(event) => setEditableTaskRequest(event.target.value)}
              rows={2}
              className="mt-1.5 w-full resize-none rounded-md border border-black/10 bg-white px-3 py-2.5 text-sm leading-6 text-black/82 outline-none transition focus:border-black/35"
            />
            <p className="mt-1 text-[11px] text-black/38">{t("可以直接使用，也可以改成你自己的说法。")}</p>
          </section>
          )}

          {confirmFields.length ? (
            <section className="rounded-md border border-[#D9B96E]/35 bg-[#FFFDF7] p-3.5">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold text-black/82">{t("需要确认")}</h3>
                <span className="text-[11px] text-black/40">{t("会影响执行结果")}</span>
              </div>
              <div className="mt-3 grid gap-3">
                {confirmFields.map((field) => (
                  <ScenarioFieldControl
                    key={field.key}
                    field={field}
                    value={values[field.key] ?? field.defaultValue}
                    onChange={(value) => updateValue(field.key, value)}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {validationMessage ? (
            <p role="alert" aria-live="polite" className="text-xs font-medium text-[#B91C1C]">
              {validationMessage}
            </p>
          ) : null}

          {usesFullPrompt && pack.safetyNote ? (
            <p className="rounded-md bg-[#FFF8E8] px-3 py-2 text-xs leading-5 text-[#7A5200]">
              {pack.safetyNote}
            </p>
          ) : null}

          {!hasInlinePrompt && !deferDeliverySetup && botId ? (
            <section className="min-w-0 rounded-md border border-black/[0.08] bg-white p-3.5">
              <ScenarioDeliverPicker
                value={deliverTargets}
                enabledChannels={enabledChannels}
                channelStatus={channelStatus}
                onRefreshChannels={onRefreshChannels}
                onChange={setDeliverTargets}
              />
            </section>
          ) : null}

          {!hasInlinePrompt && !usesFullPrompt ? <section className="overflow-hidden rounded-md border border-black/[0.08] bg-white">
            <button
              type="button"
              aria-expanded={moreSettingsOpen}
              aria-controls="scenario-more-settings"
              onClick={() => setMoreSettingsOpen((open) => !open)}
              className="flex h-11 w-full items-center justify-between gap-3 px-3.5 text-left text-sm font-semibold text-black/68 transition hover:bg-black/[0.025]"
            >
              <span>{t("更多设置")}</span>
              <ChevronDown className={`h-4 w-4 text-black/35 transition ${moreSettingsOpen ? "rotate-180" : ""}`} />
            </button>
            {moreSettingsOpen ? (
              <div id="scenario-more-settings" className="grid gap-4 border-t border-black/[0.06] px-3.5 py-3.5">
                {secondaryFields.length ? (
                  <div className="grid gap-3">
                    {secondaryFields.map((field) => (
                      <ScenarioFieldControl
                        key={field.key}
                        field={field}
                        value={values[field.key] ?? field.defaultValue}
                        onChange={(value) => updateValue(field.key, value)}
                      />
                    ))}
                  </div>
                ) : null}
                {pack.usageGuide?.length ? (
                  <div className="rounded-md bg-black/[0.025] px-3 py-2">
                    <p className="text-xs font-semibold text-black/68">{t("怎么执行")}</p>
                    <ul className="mt-1 grid gap-1 text-xs leading-5 text-black/50">
                      {pack.usageGuide.map((item) => <li key={item}>· {item}</li>)}
                    </ul>
                  </div>
                ) : null}
                <ScenarioSkillSourcePanel pack={pack} />
                <dl className="grid gap-1.5 text-xs">
                  <SummaryRow label={t("执行频率")} value={frequencyLabel} />
                  <SummaryRow label={t("执行方式")} value={getScenarioTriggerLabel(triggerType, t)} />
                  {pack.notificationPolicy === "only-when-needed" ? (
                    <SummaryRow label={t("推送规则")} value={t("满足条件才推送，无变化不打扰。")}/>
                  ) : null}
                </dl>
                {pack.safetyNote ? <p className="text-xs leading-5 text-[#8A5A00]">{pack.safetyNote}</p> : null}
              </div>
            ) : null}
          </section> : null}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-black/[0.06] pt-4">
          <div className="min-w-0 text-xs text-black/46">
            {deferDeliverySetup
              ? t("登录后会继续启用，无需重新填写")
              : selectedChannelConnected
              ? t("发送到 {{channel}}", { channel: draft.generatedDeliverLabel })
              : t("请先配置至少一个通知通道")}
          </div>
          <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="inline-flex h-9 items-center justify-center rounded-md border border-black/[0.08] bg-white px-4 text-sm font-semibold text-black/65 transition hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("取消")}
          </button>
          <button
            type="button"
            onClick={() => {
              if (isOneShotTask) onRunOnce(draft);
              else onEnableDirect(draft);
            }}
            disabled={actionDisabled}
            className="inline-flex h-9 min-w-[112px] items-center justify-center gap-2 rounded-md bg-black px-4 text-sm font-semibold text-white transition hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("立即启用")}
          </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function getScenarioTaskValidationMessage(
  pack: ScenarioTaskPack,
  issue: ReturnType<typeof getScenarioTaskValidationIssue>,
  t: ReturnType<typeof useT>,
): string | null {
  if (!issue) return null;
  const field = pack.fields.find((item) => item.key === issue.fieldKey);
  if (issue.code === "required") {
    return t("请先确认「{{field}}」。", { field: field?.label ?? issue.fieldKey });
  }
  if (issue.code === "invalid-one-shot-time") {
    return t("请输入完整且有效的触发时间，例如 2026-07-20 20:30。");
  }
  if (issue.code === "past-one-shot-time") {
    return pack.id === "flight-departure-once"
      ? t("按路程和提前量倒推出的提醒时间必须晚于当前时间。")
      : t("触发时间必须晚于当前时间。");
  }
  if (issue.code === "invalid-date-range") {
    return t("结束日期不能早于开始日期。");
  }
  if (issue.code === "invalid-time-range") {
    return t("结束时间必须晚于开始时间。");
  }
  if (issue.code === "past-effective-end") {
    return t("疗程结束日期不能早于今天。");
  }
  if (issue.code === "invalid-threshold") {
    return t("阈值必须是大于 0 的数字；涨跌幅填写 1 代表 1%。");
  }
  return t("换出币种和换入币种不能相同。");
}

function getScenarioFullPromptValidationMessage(
  issue: ScenarioFullPromptIssue | null,
  t: ReturnType<typeof useT>,
): string | null {
  if (!issue) return null;
  if (issue === "missing-mode" || issue === "invalid-mode") {
    return t("请在【执行方式】中写“一次性推送”或“长期推送”。");
  }
  if (issue === "past-time") {
    return t("【执行时间】已经过去，请填写未来的日期和时间。");
  }
  return t("请在【执行时间】中写清具体日期或周期，例如“每天 09:00”。");
}

function ScenarioSkillSourcePanel({ pack }: { pack: ScenarioTaskPack }) {
  const t = useT();
  if (!pack.skillSources?.length && !pack.skillIds?.length) return null;

  return (
    <section className="rounded-md border border-black/[0.08] bg-[#F8FAFC] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-black/85">{t("Skill 来源")}</h3>
          <p className="mt-1 text-xs leading-5 text-black/50">
            {pack.skillIds?.length
              ? t("这个模板已预置可复用技能，启用后会按触发条件执行，并把最终消息推送到你选择的通道。")
              : t("这个模板参考了公开 Skill 的工作方法；当前使用 Hermes 自带能力执行，不要求你的 Agent 预先安装该 Skill。")}
          </p>
        </div>
        {pack.skillIds?.length ? (
          <span className="inline-flex rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] font-semibold text-black/45">
            {t("已配置 {{count}} 个 skill", { count: pack.skillIds.length })}
          </span>
        ) : pack.skillSources?.length ? (
          <span className="inline-flex rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] font-semibold text-black/45">
            {t("方法参考")}
          </span>
        ) : null}
      </div>

      {pack.skillSources?.length ? (
        <div className="mt-3 grid gap-2">
          {pack.skillSources.map((source) => (
            <a
              key={source.slug}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="group rounded-md border border-black/[0.06] bg-white px-3 py-2 transition hover:border-black/[0.12] hover:shadow-[0_8px_20px_rgba(15,23,42,0.04)]"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-black/78">{source.name}</p>
                  <p className="mt-0.5 truncate text-[11px] text-black/42">
                    {source.source} · {t("提供方")}：{source.provider}
                  </p>
                </div>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-black/30 transition group-hover:text-black/55" />
              </div>
              <p className="mt-1 text-[11px] leading-5 text-black/48">{source.description}</p>
            </a>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function getScenarioTriggerType(pack: ScenarioTaskPack): ScenarioTriggerType {
  return pack.triggerType ?? (pack.runMode === "one-shot" ? "schedule" : "cron");
}

function getScenarioTriggerLabel(trigger: ScenarioTriggerType, t: ReturnType<typeof useT>): string {
  if (trigger === "schedule") return t("一次性 Schedule");
  if (trigger === "goal") return t("目标推进");
  return t("Cron 定时");
}

function ScenarioDeliverPicker({
  value,
  enabledChannels,
  channelStatus,
  onRefreshChannels,
  onChange,
}: {
  value: string[];
  enabledChannels: Set<string> | null;
  channelStatus: "loading" | "ready";
  onRefreshChannels: () => Promise<void>;
  onChange: (value: string[]) => void;
}) {
  const t = useT();
  const options = sortConfiguredScenarioChannels(enabledChannels);
  const toggleChannel = (channel: string) => {
    onChange(
      value.includes(channel)
        ? value.filter((item) => item !== channel)
        : [...value, channel],
    );
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-black/45">{t("通知方式")}</p>
        <div className="flex items-center gap-3">
          {channelStatus === "loading" ? (
            <span className="inline-flex items-center gap-1 text-xs text-black/40">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("读取中")}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void onRefreshChannels()}
              className="inline-flex items-center gap-1 text-xs text-black/42 transition hover:text-black/70"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("刷新")}
            </button>
          )}
          <a
            href={AGENT_SECTION_PATH_BY_ID.channel}
            className="inline-flex items-center gap-1 text-xs font-medium text-black/58 transition hover:text-black"
          >
            {t("更多通道")}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
      {channelStatus === "ready" && options.length === 0 ? (
        <div className="mt-2 flex items-center justify-between gap-3 rounded-md bg-black/[0.025] px-3 py-2.5">
          <span className="text-xs text-black/46">{t("暂无已配置的通知通道")}</span>
          <a
            href={AGENT_SECTION_PATH_BY_ID.channel}
            className="shrink-0 text-xs font-medium text-black/72"
          >
            {t("去配置")}
          </a>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {options.map((key) => {
          const active = value.includes(key);
          const label = formatScenarioChannelLabel(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggleChannel(key)}
              aria-pressed={active}
              className={
                "inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm transition " +
                (active
                  ? "border-black bg-black text-white"
                  : "border-black/[0.08] bg-white text-black/66 hover:border-black/15 hover:bg-black/[0.025]")
              }
            >
              <MessageCircle className="h-4 w-4 shrink-0" />
              <span>{label}</span>
              {active ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : null}
            </button>
          );
          })}
        </div>
      )}
    </div>
  );
}

function ScenarioFieldControl({
  field,
  value,
  onChange,
}: {
  field: ScenarioTaskField;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();

  if (field.type === "date") {
    return <ScenarioDateFieldControl field={field} value={value} onChange={onChange} />;
  }

  if (field.type === "datetime") {
    return (
      <label className="block">
        <span className="text-sm font-medium text-black/75">{field.label}{field.required ? <span className="ml-1 text-[#B91C1C]">*</span> : null}</span>
        <input
          type="datetime-local"
          aria-label={field.label}
          value={normalizeDateTimeLocalValue(value)}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1.5 h-10 w-full rounded-md border border-black/10 bg-white px-3 text-sm text-black/78 focus:border-black/30 focus:outline-none"
        />
        {field.helpText && <span className="mt-1 block text-xs leading-5 text-black/42">{field.helpText}</span>}
      </label>
    );
  }

  if (field.type === "time") {
    return (
      <label className="block">
        <span className="text-sm font-medium text-black/75">{field.label}{field.required ? <span className="ml-1 text-[#B91C1C]">*</span> : null}</span>
        <input
          type="time"
          aria-label={field.label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1.5 h-10 w-full rounded-md border border-black/10 bg-white px-3 text-sm text-black/78 focus:border-black/30 focus:outline-none"
        />
        {field.helpText && <span className="mt-1 block text-xs leading-5 text-black/42">{field.helpText}</span>}
      </label>
    );
  }

  if (field.type === "times") {
    return <ScenarioTimesFieldControl field={field} value={value} onChange={onChange} />;
  }

  if (field.type === "multi-dropdown") {
    return <ScenarioMultiDropdownFieldControl field={field} value={value} onChange={onChange} />;
  }

  if (field.type === "checkbox") {
    const checked = value === "true";
    return (
      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-black/[0.08] bg-white px-3 py-2.5">
        <input
          type="checkbox"
          aria-label={field.label}
          checked={checked}
          onChange={(event) => onChange(event.target.checked ? "true" : "false")}
          className="mt-0.5 size-4 rounded border-black/20 accent-black"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-black/75">{field.label}</span>
          {field.helpText && <span className="mt-0.5 block text-xs leading-5 text-black/42">{field.helpText}</span>}
        </span>
      </label>
    );
  }

  if (field.type === "textarea") {
    const maxLength = field.maxLength ?? 180;
    return (
      <label className="block">
        <span className="text-sm font-medium text-black/75">{field.label}{field.required ? <span className="ml-1 text-[#B91C1C]">*</span> : null}</span>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value.slice(0, maxLength))}
          rows={field.rows ?? 3}
          placeholder={field.placeholder}
          className="mt-1.5 w-full resize-none rounded-md border border-black/10 bg-white px-3 py-2 text-sm leading-5 placeholder:text-black/35 focus:border-black/30 focus:outline-none"
        />
        {field.helpText && <span className="mt-1 block text-xs text-black/42">{field.helpText}</span>}
      </label>
    );
  }

  if (field.type === "text" || field.type === "number") {
    const maxLength = field.maxLength ?? 120;
    return (
      <label className="block">
        <span className="text-sm font-medium text-black/75">{field.label}{field.required ? <span className="ml-1 text-[#B91C1C]">*</span> : null}</span>
        <input
          type={field.type}
          min={field.min}
          max={field.max}
          step={field.step}
          value={value}
          onChange={(event) => onChange(event.target.value.slice(0, maxLength))}
          placeholder={field.placeholder}
          className="mt-1.5 w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm leading-5 placeholder:text-black/35 focus:border-black/30 focus:outline-none"
        />
        {field.helpText && <span className="mt-1 block text-xs text-black/42">{field.helpText}</span>}
      </label>
    );
  }

  if (field.type === "dropdown") {
    return (
      <label className="block">
        <span className="text-sm font-medium text-black/75">{field.label}{field.required ? <span className="ml-1 text-[#B91C1C]">*</span> : null}</span>
        <select
          aria-label={field.label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1.5 h-10 w-full rounded-md border border-black/10 bg-white px-3 text-sm text-black/78 focus:border-black/30 focus:outline-none"
        >
          {field.placeholder ? <option value="">{field.placeholder}</option> : null}
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        {field.helpText && <span className="mt-1 block text-xs text-black/42">{field.helpText}</span>}
      </label>
    );
  }

  const selected = new Set(splitMultiselectValue(value));
  const toggle = (optionValue: string) => {
    const next = new Set(selected);
    if (field.type === "select") {
      onChange(optionValue);
      return;
    }
    if (next.has(optionValue)) next.delete(optionValue);
    else next.add(optionValue);
    onChange(Array.from(next).join(SCENARIO_MULTISELECT_SEPARATOR));
  };

  return (
    <div>
      <span className="text-sm font-medium text-black/75">{field.label}{field.required ? <span className="ml-1 text-[#B91C1C]">*</span> : null}</span>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {(field.options ?? []).map((option) => {
          const active = field.type === "select" ? value === option.value : selected.has(option.value);
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => toggle(option.value)}
              className={
                "inline-flex h-8 items-center rounded-md border px-3 text-xs font-semibold transition " +
                (active
                  ? "border-black bg-black text-white"
                  : "border-black/[0.08] bg-white text-black/62 hover:bg-black/[0.04] hover:text-black/85")
              }
              aria-pressed={active}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {field.helpText && <span className="mt-1 block text-xs text-black/42">{field.helpText}</span>}
      {field.type === "multiselect" && selected.size === 0 && (
        <button
          type="button"
          onClick={() => onChange(field.defaultValue)}
          className="mt-2 text-xs font-medium text-black/55 underline decoration-black/25 underline-offset-4"
        >
          {t("恢复默认")}
        </button>
      )}
    </div>
  );
}

function ScenarioTimesFieldControl({
  field,
  value,
  onChange,
}: {
  field: ScenarioTaskField;
  value: string;
  onChange: (value: string) => void;
}) {
  const times = splitMultiselectValue(value);
  const maxItems = field.maxItems ?? 3;
  const [slotCount, setSlotCount] = useState(() => Math.max(1, times.length));
  const visibleTimes = Array.from({ length: slotCount }, (_, index) => times[index] ?? "");

  useEffect(() => {
    if (times.length > slotCount) setSlotCount(Math.min(times.length, maxItems));
  }, [maxItems, slotCount, times.length]);

  const updateTime = (index: number, nextValue: string) => {
    const next = [...visibleTimes];
    next[index] = nextValue;
    onChange(next.join(SCENARIO_MULTISELECT_SEPARATOR));
  };

  const removeTime = (index: number) => {
    const remainingTimes = visibleTimes
      .filter((_, itemIndex) => itemIndex !== index)
      .map((time) => time.trim())
      .filter(Boolean);
    const nextTimes = remainingTimes.length > 0 ? remainingTimes : [""];
    setSlotCount(Math.min(maxItems, Math.max(1, nextTimes.length)));
    onChange(nextTimes.join(SCENARIO_MULTISELECT_SEPARATOR));
  };

  const addTime = () => {
    if (visibleTimes.length >= maxItems) return;
    setSlotCount(slotCount + 1);
  };

  return (
    <div>
      <span className="text-sm font-medium text-black/75">{field.label}{field.required ? <span className="ml-1 text-[#B91C1C]">*</span> : null}</span>
      <div className="mt-1.5 grid gap-2">
        {visibleTimes.map((time, index) => (
          <div key={`${index}-${visibleTimes.length}`} className="flex items-center gap-2">
            <input
              type="time"
              aria-label={`${field.label} ${index + 1}`}
              value={time}
              onChange={(event) => updateTime(index, event.target.value)}
              className="h-10 min-w-0 flex-1 rounded-md border border-black/10 bg-white px-3 text-sm text-black/78 focus:border-black/30 focus:outline-none"
            />
            {visibleTimes.length > 1 ? (
              <button
                type="button"
                onClick={() => removeTime(index)}
                aria-label={`删除提醒时间 ${index + 1}`}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-black/[0.08] text-black/45 transition hover:bg-black/[0.04] hover:text-black/75"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {visibleTimes.length < maxItems ? (
        <button
          type="button"
          onClick={addTime}
          aria-label="添加提醒时间"
          className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-md border border-black/[0.08] px-2.5 text-xs font-medium text-black/58 transition hover:bg-black/[0.04] hover:text-black/78"
        >
          <Plus className="h-3.5 w-3.5" />
          添加时间
        </button>
      ) : null}
      {field.helpText && <span className="mt-1 block text-xs leading-5 text-black/42">{field.helpText}</span>}
    </div>
  );
}

function ScenarioDateFieldControl({
  field,
  value,
  onChange,
}: {
  field: ScenarioTaskField;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-black/75">
        {field.label}
        {field.required ? <span className="ml-1 text-[#B91C1C]">*</span> : null}
      </span>
      <input
        type="date"
        aria-label={field.label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5 h-10 w-full rounded-md border border-black/10 bg-white px-3 text-sm text-black/78 focus:border-black/30 focus:outline-none"
      />
      {field.helpText ? <span className="mt-1 block text-xs leading-5 text-black/42">{field.helpText}</span> : null}
    </label>
  );
}

function ScenarioMultiDropdownFieldControl({
  field,
  value,
  onChange,
}: {
  field: ScenarioTaskField;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-black/75">
        {field.label}
        {field.required ? <span className="ml-1 text-[#B91C1C]">*</span> : null}
      </span>
      <input
        type="text"
        aria-label={field.label}
        value={splitMultiselectValue(value).join("、")}
        onChange={(event) => onChange(
          event.target.value
            .split(/[、,，]/)
            .map((item) => item.trim())
            .filter(Boolean)
            .join(SCENARIO_MULTISELECT_SEPARATOR),
        )}
        placeholder={field.placeholder}
        className="mt-1.5 h-10 w-full rounded-md border border-black/10 bg-white px-3 text-sm text-black/78 focus:border-black/30 focus:outline-none"
      />
      {field.helpText ? <span className="mt-1 block text-xs leading-5 text-black/42">{field.helpText}</span> : null}
    </label>
  );
}

function splitMultiselectValue(value: string): string[] {
  return value
    .split(/[|、,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDateTimeLocalValue(value: string): string {
  return value.trim().replace(" ", "T").slice(0, 16);
}

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
      <dt className="text-black/42">{label}</dt>
      <dd className="min-w-0 text-black/76">{value}</dd>
    </div>
  );
}

function selectInitialPushDeliverTargets(
  initialDeliver: string | undefined,
  enabledChannels: Set<string> | null,
): string[] {
  const requested = (initialDeliver ?? "")
    .split(",")
    .map((target) => target.trim())
    .filter(Boolean);
  const configuredRequested = enabledChannels
    ? requested.filter((target) => enabledChannels.has(target))
    : requested;
  if (configuredRequested.length) return [...new Set(configuredRequested)];
  const [firstConfigured] = sortConfiguredScenarioChannels(enabledChannels);
  return firstConfigured ? [firstConfigured] : [];
}

function sortConfiguredScenarioChannels(enabledChannels: Set<string> | null): string[] {
  if (!enabledChannels) return [];
  const preferredOrder = ["weixin", "qqbot", "wecom", "feishu", "telegram", "discord", "slack", "whatsapp"];
  return [...enabledChannels].sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(left);
    const rightIndex = preferredOrder.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
}

function extractScenarioTaskRequest(prompt: string): string {
  const match = /^【任务要求】\s*(.+)$/m.exec(prompt);
  return match?.[1]?.trim() || prompt.trim();
}
