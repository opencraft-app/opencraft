import { Loader2, MessageCircle, Monitor, QrCode, X } from "lucide-react";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "@/i18n/t";
import { AGENT_SECTION_PATH_BY_ID } from "@/lib/agent-routes";
import type { ScenarioTaskField, ScenarioTaskPack } from "./scenario-packs";
import {
  buildScenarioTaskDraft,
  normalizeScenarioDeliverTarget,
  type ScenarioDeliveryTarget,
  type ScenarioTaskDraft,
} from "./scenario-task-builder";

export function ScenarioInstallModal({
  pack,
  submitting,
  initialValues,
  initialDeliver,
  enabledChannels,
  channelStatus,
  onClose,
  onRunOnce,
  onEnableDirect,
}: {
  pack: ScenarioTaskPack;
  submitting: boolean;
  initialValues?: Record<string, string>;
  initialDeliver?: string;
  enabledChannels: Set<string> | null;
  channelStatus: "loading" | "ready";
  onClose: () => void;
  onRunOnce: (draft: ScenarioTaskDraft) => void;
  onEnableDirect: (draft: ScenarioTaskDraft) => void;
}) {
  const t = useT();
  const [values, setValues] = useState<Record<string, string>>(() => {
    const entries = pack.fields.map((field) => [field.key, initialValues?.[field.key] ?? field.defaultValue]);
    return Object.fromEntries(entries);
  });
  const [deliverTarget, setDeliverTarget] = useState<ScenarioDeliveryTarget>(() => normalizeScenarioDeliverTarget(initialDeliver ?? "local"));
  const draft = useMemo(() => buildScenarioTaskDraft({ pack, values, deliver: deliverTarget }), [deliverTarget, pack, values]);

  const updateValue = (key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 px-4 py-3" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="relative max-h-[calc(100vh-24px)] w-full max-w-[680px] overflow-y-auto rounded-lg bg-white p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-black/[0.04] hover:text-black/80"
          aria-label={t("关闭")}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mb-5 pr-8">
          <p className="text-xs font-medium text-black/42">{t("场景任务")}</p>
          <h2 className="mt-1 text-lg font-semibold text-black/90">{t("设置场景任务")}</h2>
          <p className="mt-1 text-sm leading-6 text-black/55">{pack.name} · {pack.description}</p>
        </div>

        <div className="grid gap-4">
          <section className="rounded-md border border-black/[0.08] bg-white p-4">
            <h3 className="text-sm font-semibold text-black/85">{t("目标信息")}</h3>
            <div className="mt-3 grid gap-3">
              {pack.fields.map((field) => (
                <ScenarioFieldControl
                  key={field.key}
                  field={field}
                  value={values[field.key] ?? field.defaultValue}
                  onChange={(value) => updateValue(field.key, value)}
                />
              ))}
            </div>
          </section>

          <section className="rounded-md border border-black/[0.08] bg-white p-4">
            <h3 className="text-sm font-semibold text-black/85">{t("执行与回传")}</h3>
            <ScenarioDeliverPicker
              value={deliverTarget}
              enabledChannels={enabledChannels}
              channelStatus={channelStatus}
              onChange={setDeliverTarget}
            />
            <dl className="mt-3 grid gap-2 text-sm">
              <SummaryRow label={t("试跑方式")} value={t("一次性 Cron，约 2 分钟后执行")} />
              <SummaryRow label={t("常态频率")} value={pack.defaultFrequencyLabel} />
              <SummaryRow label={t("回传方式")} value={draft.generatedDeliverLabel} />
              <SummaryRow label={t("任务名称")} value={draft.generatedName} />
            </dl>
            {pack.safetyNote && (
              <p className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs leading-5 text-[#8A5A00]">
                {pack.safetyNote}
              </p>
            )}
          </section>

          <section className="rounded-md border border-black/[0.08] bg-white p-4">
            <h3 className="text-sm font-semibold text-black/85">{t("试跑摘要")}</h3>
            <p className="mt-2 line-clamp-5 whitespace-pre-line text-xs leading-5 text-black/55">{draft.generatedPrompt}</p>
          </section>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
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
            onClick={() => onEnableDirect(draft)}
            disabled={submitting}
            className="inline-flex h-9 items-center justify-center rounded-md border border-black/[0.08] bg-white px-4 text-sm font-semibold text-black/75 transition hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("直接添加为自动任务")}
          </button>
          <button
            type="button"
            onClick={() => onRunOnce(draft)}
            disabled={submitting}
            className="inline-flex h-9 min-w-[112px] items-center justify-center gap-2 rounded-md bg-black px-4 text-sm font-semibold text-white transition hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("先跑一次")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ScenarioDeliverPicker({
  value,
  enabledChannels,
  channelStatus,
  onChange,
}: {
  value: ScenarioDeliveryTarget;
  enabledChannels: Set<string> | null;
  channelStatus: "loading" | "ready";
  onChange: (value: ScenarioDeliveryTarget) => void;
}) {
  const t = useT();
  const options: Array<{
    key: ScenarioDeliveryTarget;
    label: string;
    description: string;
    Icon: typeof Monitor;
  }> = [
    {
      key: "local",
      label: t("网页 / 最近执行"),
      description: t("不主动推送，在自动任务页查看结果"),
      Icon: Monitor,
    },
    {
      key: "weixin",
      label: t("微信"),
      description: t("复用已扫码接入的微信个人号"),
      Icon: MessageCircle,
    },
    {
      key: "qqbot",
      label: "QQ",
      description: t("复用已扫码接入的 QQ 机器人"),
      Icon: MessageCircle,
    },
  ];

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-black/45">{t("结果回传")}</p>
        {channelStatus === "loading" ? (
          <span className="inline-flex items-center gap-1 text-xs text-black/40">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("读取通道状态中")}
          </span>
        ) : (
          <a
            href={AGENT_SECTION_PATH_BY_ID.channel}
            className="inline-flex items-center gap-1 text-xs font-medium text-black/55 underline decoration-black/25 underline-offset-4 transition hover:text-black"
          >
            <QrCode className="h-3.5 w-3.5" />
            {t("去通道扫码接入")}
          </a>
        )}
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {options.map(({ key, label, description, Icon }) => {
          const connected = key === "local" || enabledChannels?.has(key) === true;
          const disabled = key !== "local" && (channelStatus === "loading" || !connected);
          const active = value === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => {
                if (!disabled) onChange(key);
              }}
              disabled={disabled}
              className={
                "flex min-h-[76px] items-start gap-2 rounded-md border px-3 py-2.5 text-left transition " +
                (active
                  ? "border-black bg-black text-white"
                  : "border-black/[0.08] bg-white text-black/70 hover:bg-black/[0.035]") +
                (disabled ? " cursor-not-allowed opacity-45 hover:bg-white" : "")
              }
              aria-pressed={active}
            >
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${active ? "text-white" : "text-black/45"}`} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{label}</span>
                <span className={`mt-0.5 block text-[11px] leading-4 ${active ? "text-white/70" : "text-black/42"}`}>
                  {disabled ? t("未扫码接入") : description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs leading-5 text-black/42">
        {t("微信和 QQ 仅支持已扫码接入的通道；未接入时先去通道页完成扫码。")}
      </p>
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

  if (field.type === "textarea") {
    return (
      <label className="block">
        <span className="text-sm font-medium text-black/75">{field.label}</span>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value.slice(0, 180))}
          rows={3}
          placeholder={field.placeholder}
          className="mt-1.5 w-full resize-none rounded-md border border-black/10 bg-white px-3 py-2 text-sm leading-5 placeholder:text-black/35 focus:border-black/30 focus:outline-none"
        />
      </label>
    );
  }

  if (field.type === "text") {
    return (
      <label className="block">
        <span className="text-sm font-medium text-black/75">{field.label}</span>
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value.slice(0, 120))}
          placeholder={field.placeholder}
          className="mt-1.5 w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm leading-5 placeholder:text-black/35 focus:border-black/30 focus:outline-none"
        />
        {field.helpText && <span className="mt-1 block text-xs text-black/42">{field.helpText}</span>}
      </label>
    );
  }

  const selected = new Set(value.split("/").map((item) => item.trim()).filter(Boolean));
  const toggle = (optionValue: string) => {
    const next = new Set(selected);
    if (field.type === "select") {
      onChange(optionValue);
      return;
    }
    if (next.has(optionValue)) next.delete(optionValue);
    else next.add(optionValue);
    onChange(Array.from(next).join(" / "));
  };

  return (
    <div>
      <span className="text-sm font-medium text-black/75">{field.label}</span>
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

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
      <dt className="text-black/42">{label}</dt>
      <dd className="min-w-0 text-black/76">{value}</dd>
    </div>
  );
}
