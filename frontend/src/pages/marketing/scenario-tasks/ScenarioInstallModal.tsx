import { CheckCircle2, Loader2, MessageCircle, QrCode, RefreshCw, ScanLine } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/i18n/t";
import { execCommand } from "@/lib/hermes-cron-client";
import type { ScenarioTaskField, ScenarioTaskPack } from "./scenario-packs";
import {
  buildScenarioTaskDraft,
  normalizeScenarioDeliverTarget,
  type ScenarioDeliveryTarget,
  type ScenarioTaskDraft,
} from "./scenario-task-builder";

type ScenarioPushDeliveryTarget = Exclude<ScenarioDeliveryTarget, "local">;
type GatewayQrStatus = "creating" | "waiting_qr" | "failed";
type ScenarioInstallStep = "task" | "delivery";

export function ScenarioInstallModal({
  pack,
  botId,
  submitting,
  initialValues,
  initialDeliver,
  enabledChannels,
  channelStatus,
  onRefreshChannels,
  onClose,
  onRunOnce,
  onEnableDirect,
}: {
  pack: ScenarioTaskPack;
  botId: string;
  submitting: boolean;
  initialValues?: Record<string, string>;
  initialDeliver?: string;
  enabledChannels: Set<string> | null;
  channelStatus: "loading" | "ready";
  onRefreshChannels: () => Promise<void>;
  onClose: () => void;
  onRunOnce: (draft: ScenarioTaskDraft) => void;
  onEnableDirect: (draft: ScenarioTaskDraft) => void;
}) {
  const t = useT();
  const [step, setStep] = useState<ScenarioInstallStep>("task");
  const [values, setValues] = useState<Record<string, string>>(() => {
    const entries = pack.fields.map((field) => [field.key, initialValues?.[field.key] ?? field.defaultValue]);
    return Object.fromEntries(entries);
  });
  const [deliverTarget, setDeliverTarget] = useState<ScenarioPushDeliveryTarget>(() => selectInitialPushDeliverTarget(initialDeliver, enabledChannels));
  const draft = useMemo(() => buildScenarioTaskDraft({ pack, values, deliver: deliverTarget }), [deliverTarget, pack, values]);
  const selectedChannelConnected = channelStatus === "ready" && enabledChannels?.has(deliverTarget) === true;
  const actionDisabled = submitting || !selectedChannelConnected;
  const isTaskStep = step === "task";

  useEffect(() => {
    if (channelStatus !== "ready" || !enabledChannels) return;
    setDeliverTarget((current) => {
      if (enabledChannels.has(current)) return current;
      if (enabledChannels.has("weixin")) return "weixin";
      if (enabledChannels.has("qqbot")) return "qqbot";
      return current;
    });
  }, [channelStatus, enabledChannels]);

  const updateValue = (key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && !submitting) onClose();
    }}>
      <DialogContent className="max-h-[calc(100vh-24px)] w-[calc(100vw-2rem)] max-w-[680px] overflow-y-auto rounded-lg bg-white p-6 shadow-2xl md:w-[680px]">
        <DialogHeader className="mb-5 pr-8">
          <p className="text-xs font-medium text-black/42">{t("场景任务")}</p>
          <DialogTitle className="mt-1 text-lg font-semibold text-black/90">{t("设置场景任务")}</DialogTitle>
          <DialogDescription className="mt-1 text-sm leading-6 text-black/55">{pack.name} · {pack.description}</DialogDescription>
        </DialogHeader>

        <ScenarioStepIndicator step={step} onChange={setStep} />

        <div className="mt-4 grid gap-4">
          {isTaskStep ? (
            <>
              <section className="rounded-md border border-black/[0.08] bg-white p-4">
                <h3 className="text-sm font-semibold text-black/85">{t("任务设置")}</h3>
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
                {pack.safetyNote && (
                  <p className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs leading-5 text-[#8A5A00]">
                    {pack.safetyNote}
                  </p>
                )}
              </section>

              <section className="rounded-md border border-black/[0.08] bg-white p-4">
                <h3 className="text-sm font-semibold text-black/85">{t("任务摘要")}</h3>
                <p className="mt-2 line-clamp-6 whitespace-pre-line text-xs leading-5 text-black/55">{draft.generatedPrompt}</p>
              </section>
            </>
          ) : (
            <section className="rounded-md border border-black/[0.08] bg-white p-4">
              <h3 className="text-sm font-semibold text-black/85">{t("执行与回传")}</h3>
              <ScenarioDeliverPicker
                botId={botId}
                value={deliverTarget}
                enabledChannels={enabledChannels}
                channelStatus={channelStatus}
                onRefreshChannels={onRefreshChannels}
                onChange={setDeliverTarget}
              />
              <dl className="mt-3 grid gap-2 text-sm">
                <SummaryRow
                  label={t("试跑方式")}
                  value={(
                    <>
                      {t("一次性执行，")}
                      <strong className="font-semibold text-black/88">{t("下发后立即开始")}</strong>
                    </>
                  )}
                />
                <SummaryRow label={t("常态频率")} value={pack.defaultFrequencyLabel} />
                <SummaryRow label={t("回传方式")} value={draft.generatedDeliverLabel} />
                <SummaryRow label={t("任务名称")} value={draft.generatedName} />
              </dl>
              {!selectedChannelConnected && (
                <p className="mt-3 rounded-md border border-black/[0.08] bg-black/[0.025] px-3 py-2 text-xs leading-5 text-black/55">
                  {t("请先在当前弹窗内连接{{channel}}，连接成功后再试跑或添加自动任务。", { channel: formatScenarioDeliveryTargetLabel(deliverTarget, t) })}
                </p>
              )}
            </section>
          )}
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
          {isTaskStep ? (
            <button
              type="button"
              onClick={() => setStep("delivery")}
              className="inline-flex h-9 min-w-[112px] items-center justify-center rounded-md bg-black px-4 text-sm font-semibold text-white transition hover:bg-black/85"
            >
              {t("下一步")}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setStep("task")}
                disabled={submitting}
                className="inline-flex h-9 items-center justify-center rounded-md border border-black/[0.08] bg-white px-4 text-sm font-semibold text-black/65 transition hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("上一步")}
              </button>
              <button
                type="button"
                onClick={() => onEnableDirect(draft)}
                disabled={actionDisabled}
                className="inline-flex h-9 items-center justify-center rounded-md border border-black/[0.08] bg-white px-4 text-sm font-semibold text-black/75 transition hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("直接添加为自动任务")}
              </button>
              <button
                type="button"
                onClick={() => onRunOnce(draft)}
                disabled={actionDisabled}
                className="inline-flex h-9 min-w-[112px] items-center justify-center gap-2 rounded-md bg-black px-4 text-sm font-semibold text-white transition hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("先跑一次")}
              </button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ScenarioStepIndicator({
  step,
  onChange,
}: {
  step: ScenarioInstallStep;
  onChange: (step: ScenarioInstallStep) => void;
}) {
  const t = useT();
  const steps: Array<{ key: ScenarioInstallStep; index: string; label: string }> = [
    { key: "task", index: "1", label: t("任务本身") },
    { key: "delivery", index: "2", label: t("消息通道") },
  ];

  return (
    <div className="grid grid-cols-2 gap-2" role="tablist" aria-label={t("场景任务配置步骤")}>
      {steps.map((item) => {
        const active = item.key === step;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onChange(item.key)}
            className={
              "flex h-10 items-center gap-2 rounded-md border px-3 text-left text-sm font-semibold transition " +
              (active
                ? "border-black bg-black text-white"
                : "border-black/[0.08] bg-white text-black/58 hover:bg-black/[0.04] hover:text-black/80")
            }
            role="tab"
            aria-selected={active}
            aria-current={active ? "step" : undefined}
          >
            <span
              className={
                "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold " +
                (active ? "bg-white text-black" : "bg-black/[0.06] text-black/55")
              }
            >
              {item.index}
            </span>
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ScenarioDeliverPicker({
  botId,
  value,
  enabledChannels,
  channelStatus,
  onRefreshChannels,
  onChange,
}: {
  botId: string;
  value: ScenarioPushDeliveryTarget;
  enabledChannels: Set<string> | null;
  channelStatus: "loading" | "ready";
  onRefreshChannels: () => Promise<void>;
  onChange: (value: ScenarioPushDeliveryTarget) => void;
}) {
  const t = useT();
  const [connectTarget, setConnectTarget] = useState<ScenarioPushDeliveryTarget | null>(null);
  const options: Array<{
    key: ScenarioPushDeliveryTarget;
    label: string;
    description: string;
    connectLabel: string;
  }> = [
    {
      key: "weixin",
      label: t("微信"),
      description: t("扫码接入微信个人号后，任务结果主动推送到微信"),
      connectLabel: t("连接微信"),
    },
    {
      key: "qqbot",
      label: "QQ",
      description: t("配置 QQ 机器人后，任务结果主动推送到 QQ"),
      connectLabel: t("连接 QQ"),
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
          <button
            type="button"
            onClick={() => void onRefreshChannels()}
            className="inline-flex items-center gap-1 text-xs font-medium text-black/55 underline decoration-black/25 underline-offset-4 transition hover:text-black"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t("刷新通道状态")}
          </button>
        )}
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {options.map(({ key, label, description, connectLabel }) => {
          const connected = enabledChannels?.has(key) === true;
          const statusKnown = channelStatus === "ready" && enabledChannels !== null;
          const active = value === key;
          return (
            <div
              key={key}
              className={
                "rounded-md border transition " +
                (active
                  ? "border-black bg-black text-white"
                  : "border-black/[0.08] bg-white text-black/70 hover:bg-black/[0.035]") +
                (channelStatus === "loading" ? " opacity-60" : "")
              }
            >
              <button
                type="button"
                onClick={() => onChange(key)}
                className="flex min-h-[92px] w-full items-start gap-2 px-3 py-2.5 text-left"
                aria-pressed={active}
              >
                <MessageCircle className={`mt-0.5 h-4 w-4 shrink-0 ${active ? "text-white" : "text-black/45"}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{label}</span>
                  <span className={`mt-0.5 block text-[11px] leading-4 ${active ? "text-white/70" : "text-black/42"}`}>
                    {connected ? description : t("未接入，连接后才能推送")}
                  </span>
                </span>
                {connected && (
                  <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${active ? "text-white" : "text-[#0F8A4B]"}`} />
                )}
              </button>
              {statusKnown && !connected && (
                <div className="px-3 pb-3">
                  <button
                    type="button"
                    onClick={() => setConnectTarget(key)}
                    className={
                      "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-semibold transition " +
                      (active
                        ? "border-white/30 bg-white/10 text-white hover:bg-white/15"
                        : "border-black/[0.08] bg-black/[0.03] text-black/65 hover:bg-black/[0.06]")
                    }
                  >
                    <QrCode className="h-3.5 w-3.5" />
                    {connectLabel}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {connectTarget && (
        <ScenarioChannelConnectDialog
          botId={botId}
          target={connectTarget}
          onClose={() => setConnectTarget(null)}
          onConnected={async (target) => {
            await onRefreshChannels();
            onChange(target);
            setConnectTarget(null);
          }}
        />
      )}
    </div>
  );
}

function ScenarioChannelConnectDialog({
  botId,
  target,
  onClose,
  onConnected,
}: {
  botId: string;
  target: ScenarioPushDeliveryTarget;
  onClose: () => void;
  onConnected: (target: ScenarioPushDeliveryTarget) => Promise<void>;
}) {
  return (
    <GatewayQrConnectDialog
      botId={botId}
      target={target}
      onClose={onClose}
      onConnected={() => onConnected(target)}
    />
  );
}

function GatewayQrConnectDialog({
  botId,
  target,
  onClose,
  onConnected,
}: {
  botId: string;
  target: ScenarioPushDeliveryTarget;
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const t = useT();
  const [status, setStatus] = useState<GatewayQrStatus>("creating");
  const [qrValue, setQrValue] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const command = useMemo(() => buildGatewayQrUrlCommand(target), [target]);
  const channelLabel = formatScenarioDeliveryTargetLabel(target, t);

  const startGatewayQr = useCallback(async () => {
    setStatus("creating");
    setQrValue("");
    setErrorMessage(null);

    try {
      const result = await execCommand(botId, command);
      const output = result.output.trim();
      const parsedQrValue = extractGatewayQrValue(output);
      if (parsedQrValue) {
        setQrValue(parsedQrValue);
        setStatus("waiting_qr");
        return;
      }
      setStatus("waiting_qr");
      setErrorMessage(t("二维码生成完成，但没有解析到二维码链接。请扫码后刷新状态，或重试。"));
    } catch (error) {
      setStatus("failed");
      setErrorMessage(error instanceof Error ? error.message : t("二维码生成失败"));
    }
  }, [botId, command, t]);

  useEffect(() => {
    void startGatewayQr();
  }, [startGatewayQr]);

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open) onClose();
    }}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[360px] rounded-md bg-white p-5 text-center shadow-2xl md:w-[360px]">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-md bg-[#07C160]/10">
          <ScanLine className="h-5 w-5 text-[#07C160]" />
        </div>
        <DialogHeader className="mb-0 space-y-1 text-center">
          <DialogTitle className="text-base font-semibold text-black/90">{t("{{channel}}扫码接入", { channel: channelLabel })}</DialogTitle>
          <DialogDescription className="text-sm font-medium text-[#07C160]">
            {status === "creating" ? t("正在生成二维码") : t("请扫码完成接入")}
          </DialogDescription>
        </DialogHeader>
        <div className="mx-auto mt-4 flex h-52 w-52 items-center justify-center rounded-md border border-black/[0.08] bg-black/[0.025]">
          {qrValue ? (
            <GatewayQrValuePreview value={qrValue} alt={t("{{channel}}接入二维码", { channel: channelLabel })} />
          ) : status === "failed" ? (
            <div className="px-4 text-xs leading-5 text-[#B91C1C]">{errorMessage || t("请重试")}</div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-black/45">
              <Loader2 className="h-7 w-7 animate-spin" />
              <span className="text-xs">{t("正在生成二维码")}</span>
            </div>
          )}
        </div>
        {errorMessage && status !== "failed" && (
          <p className="mt-3 text-xs leading-5 text-[#B91C1C]">{errorMessage}</p>
        )}
        <div className="mt-4 grid gap-2">
          {status === "failed" ? (
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={onClose} className="inline-flex h-9 flex-1 items-center justify-center rounded-md border border-black/[0.08] text-sm font-semibold text-black/65">
                {t("关闭")}
              </button>
              <button type="button" onClick={() => void startGatewayQr()} className="inline-flex h-9 flex-1 items-center justify-center rounded-md bg-black text-sm font-semibold text-white">
                {t("重试")}
              </button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={onClose} className="inline-flex h-9 items-center justify-center rounded-md border border-black/[0.08] text-sm font-semibold text-black/65">
                  {t("取消")}
                </button>
                <button
                  type="button"
                  onClick={() => void startGatewayQr()}
                  disabled={status === "creating"}
                  className="inline-flex h-9 items-center justify-center rounded-md border border-black/[0.08] text-sm font-semibold text-black/65 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("重新生成")}
                </button>
              </div>
              <button
                type="button"
                onClick={() => void onConnected()}
                disabled={status === "creating"}
                className="inline-flex h-9 items-center justify-center rounded-md bg-black text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t("我已扫码，刷新状态")}
              </button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
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

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
      <dt className="text-black/42">{label}</dt>
      <dd className="min-w-0 text-black/76">{value}</dd>
    </div>
  );
}

function selectInitialPushDeliverTarget(initialDeliver: string | undefined, enabledChannels: Set<string> | null): ScenarioPushDeliveryTarget {
  const normalized = normalizeScenarioDeliverTarget(initialDeliver ?? "");
  if (normalized === "weixin" || normalized === "qqbot") return normalized;
  if (enabledChannels?.has("weixin")) return "weixin";
  if (enabledChannels?.has("qqbot")) return "qqbot";
  return "weixin";
}

function formatScenarioDeliveryTargetLabel(target: ScenarioPushDeliveryTarget, t: ReturnType<typeof useT>): string {
  return target === "weixin" ? t("微信") : "QQ";
}

function buildGatewayQrUrlCommand(target: ScenarioPushDeliveryTarget): string {
  const platform = target === "weixin" ? "weixin" : "qqbot";
  return `acli gateway qr-url --platform ${platform} --wait true`;
}

function GatewayQrValuePreview({ value, alt }: { value: string; alt: string }) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [value]);

  if (looksLikeQrImageUrl(value) && !imageFailed) {
    return (
      <img
        src={value}
        alt={alt}
        onError={() => setImageFailed(true)}
        className="h-44 w-44 rounded-md bg-white object-contain"
      />
    );
  }

  return (
    <div className="rounded-md bg-white p-2">
      <QRCodeSVG value={value} size={176} level="M" includeMargin={false} />
    </div>
  );
}

function extractGatewayQrValue(output: string): string {
  const jsonValue = extractGatewayQrValueFromJson(output);
  if (jsonValue) return jsonValue;

  const urlPattern = /(?:https?:\/\/|weixin:\/\/|mqqapi:\/\/|qq:\/\/)[^\s"'<>，。；、)）\]}]+/g;
  const matches = output.match(urlPattern) ?? [];
  return matches.at(-1)?.trim() ?? "";
}

function extractGatewayQrValueFromJson(output: string): string {
  const trimmed = output.trim();
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const found = findGatewayQrValue(parsed);
      if (found) return found;
    } catch {
      // Try the next candidate.
    }
  }
  return "";
}

function findGatewayQrValue(value: unknown): string {
  if (typeof value === "string") {
    return extractGatewayQrValueFromText(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findGatewayQrValue(item);
      if (found) return found;
    }
    return "";
  }
  if (!isRecord(value)) return "";

  for (const key of ["qr_url", "qrUrl", "qrcode_url", "qrCodeUrl", "url", "link"]) {
    const property = value[key];
    if (typeof property === "string") {
      const found = extractGatewayQrValueFromText(property);
      if (found) return found;
    }
  }

  for (const property of Object.values(value)) {
    const found = findGatewayQrValue(property);
    if (found) return found;
  }
  return "";
}

function extractGatewayQrValueFromText(value: string): string {
  const trimmed = value.trim();
  if (/^(https?:\/\/|weixin:\/\/|mqqapi:\/\/|qq:\/\/)/.test(trimmed)) return trimmed;
  const match = trimmed.match(/(?:https?:\/\/|weixin:\/\/|mqqapi:\/\/|qq:\/\/)[^\s"'<>，。；、)）\]}]+/);
  return match?.[0] ?? "";
}

function looksLikeQrImageUrl(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.startsWith("data:image/")
    || /\.(?:png|jpe?g|webp|gif|svg)(?:[?#]|$)/.test(lower)
    || lower.includes("qrcode")
    || lower.includes("/qr/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
