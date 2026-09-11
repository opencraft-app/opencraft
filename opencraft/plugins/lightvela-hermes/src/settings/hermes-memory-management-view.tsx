import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { LightVelaAccountService } from "../account/lightvela-account-service";
import { HermesAgentConsoleHost } from "./hermes-agent-console-host";
import { AgentSectionHeader } from "../upstream/mono2/components/domain/agent-section-header";
import { useT } from "../upstream/mono2/i18n/t";
import { cn } from "../upstream/mono2/lib/utils";
import {
  fetchHermesMemorySnapshot,
  getHermesMemoryLimitBounds,
  getMemoryUsagePercent,
  isHermesMemoryLimitNearUsage,
  splitHermesMemoryEntries,
  validateHermesMemoryLimit,
  type HermesMemoryLimitTarget,
  type HermesMemoryLimitValidation,
  type HermesMemorySnapshot,
} from "../upstream/mono2/pages/marketing/agent-memory";
import {
  canStartHermesMemoryLimitSave,
  saveHermesMemoryLimit as executeHermesMemoryLimitSave,
  isHermesMemoryOperationCurrent,
} from "../upstream/mono2/pages/marketing/agent-memory-save";
import { getHermesScriptCommands } from "../upstream/mono2/pages/marketing/agent-config/scripts-runtime";
import { createWorkbenchRepositories } from "../upstream/workbench-repositories";

type MemoryTabId = "memory" | "user";
type MemoryLoadStatus = "idle" | "loading" | "ready" | "error";

function validationMessage(
  validation: HermesMemoryLimitValidation,
  t: (zh: string, options?: Record<string, unknown>) => string,
) {
  if (validation.ok) return null;
  if (validation.reason === "integer") return t("请输入整数。");
  if (validation.reason === "too_small") return t("最小不能低于 {{min}} 字符。", { min: validation.min });
  if (validation.reason === "too_large") return t("最大不能超过 {{max}} 字符。", { max: validation.max });
  return t("请输入范围在 {{min}}-{{max}} 的数字", { min: validation.min, max: validation.max });
}

function MemoryLimitCard({ target, title, description, used, limit, saving, disabled, saveError, onSave, onDraftChange }: {
  target: HermesMemoryLimitTarget;
  title: string;
  description: string;
  used: number;
  limit: number;
  saving: boolean;
  disabled: boolean;
  saveError: string | null;
  onSave: (target: HermesMemoryLimitTarget, value: number, existingChars: number) => Promise<boolean>;
  onDraftChange: (target: HermesMemoryLimitTarget) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(limit));
  const [touched, setTouched] = useState(false);
  const percent = getMemoryUsagePercent(used, limit);
  const bounds = getHermesMemoryLimitBounds(target, used);
  const validation = validateHermesMemoryLimit(target, draft, used);
  const error = touched ? validationMessage(validation, t) : null;
  const warn = validation.ok && isHermesMemoryLimitNearUsage(validation.value, used, limit);

  useEffect(() => {
    if (!editing) {
      setDraft(String(limit));
      setTouched(false);
    }
  }, [editing, limit]);

  return (
    <div className="rounded-lg border border-black/[0.06] bg-white p-4 shadow-[0_8px_28px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-black/85">{title}</p>
          <p className="mt-1 max-w-lg text-pretty text-xs leading-relaxed text-black/45">{description}</p>
        </div>
        <span className="shrink-0 rounded-full bg-black/[0.05] px-2 py-1 text-xs font-medium text-black/60">{percent}%</span>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2">
        <span className="text-2xl font-semibold tabular-nums text-black/90">{used}</span>
        <span className="text-sm tabular-nums text-black/45">/</span>
        {editing ? (
          <input
            type="number"
            min={bounds.min}
            max={bounds.max}
            step={1}
            value={draft}
            onBlur={() => setTouched(true)}
            onWheel={(event) => event.currentTarget.blur()}
            onChange={(event) => {
              setDraft(event.target.value);
              setTouched(true);
              onDraftChange(target);
            }}
            disabled={disabled}
            className="h-9 w-28 rounded-md border border-black/[0.10] bg-white px-3 text-sm tabular-nums text-black/85 outline-none transition-colors focus:border-black/30 disabled:cursor-not-allowed disabled:opacity-60"
          />
        ) : <span className="text-sm tabular-nums text-black/45">{limit}</span>}
        <span className="text-sm text-black/45">{t("字符")}</span>
        {!editing ? <span className="text-xs text-black/45">{t("当前占用 / 字符限额")}</span> : null}
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={disabled}
            className="ml-1 inline-flex h-7 items-center rounded-md border border-black/[0.10] bg-white px-2.5 text-xs font-medium text-black/55 transition-colors hover:bg-black/[0.04] hover:text-black/80 disabled:opacity-45"
          >{t("调整限额")}</button>
        ) : (
          <>
            <button
              type="button"
              onClick={async () => {
                setTouched(true);
                if (validation.ok && await onSave(target, validation.value, used)) setEditing(false);
              }}
              disabled={disabled || !validation.ok}
              className="ml-1 inline-flex h-8 items-center gap-1.5 rounded-md bg-black px-3 text-xs font-medium text-white hover:bg-black/85 disabled:opacity-45"
            >{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{saving ? t("保存中...") : t("保存")}</button>
            <button
              type="button"
              onClick={() => { setEditing(false); setDraft(String(limit)); setTouched(false); }}
              disabled={disabled}
              className="inline-flex h-8 items-center rounded-md border border-black/[0.08] bg-white px-3 text-xs font-medium text-black/55 hover:bg-black/[0.04] disabled:opacity-45"
            >{t("取消")}</button>
          </>
        )}
      </div>
      {editing ? (
        <p className={cn("mt-3 text-xs leading-relaxed", error || saveError ? "text-red-600" : warn ? "text-amber-600" : "text-black/40")}>
          {error || saveError || (warn
            ? t("新上限接近当前用量，后续记忆可能无法继续写入或触发自动淘汰。")
            : t("可设置范围：{{min}}-{{max}} 字符。保存后会重启 Hermes Agent 网关，可能短暂中断会话。", bounds))}
        </p>
      ) : null}
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/[0.06]">
        <div className="h-full rounded-full bg-black/80 transition-[width]" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function MemoryEntries({ entries, emptyText }: { entries: string[]; emptyText: string }) {
  if (entries.length === 0) {
    return <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-black/[0.10] bg-black/[0.015] px-6 text-center text-sm text-black/45">{emptyText}</div>;
  }
  return (
    <div className="space-y-2">
      {entries.map((entry, index) => (
        <div key={`${index}-${entry.slice(0, 24)}`} className="min-h-11 rounded-md border border-black/[0.06] bg-white px-3 py-3 text-sm leading-relaxed text-black/75 shadow-[0_1px_2px_rgba(15,23,42,0.02)]">
          <p className="whitespace-pre-wrap break-words text-pretty">{entry}</p>
        </div>
      ))}
    </div>
  );
}

export function HermesMemoryManagementView({ account, botId }: {
  readonly account: LightVelaAccountService;
  readonly botId: string;
}) {
  const t = useT();
  const repositories = createWorkbenchRepositories(account);
  const botStatus = account.getSnapshot().bots.find((bot) => bot.instanceId === botId)?.status ?? "unknown";
  const [status, setStatus] = useState<MemoryLoadStatus>("idle");
  const [snapshot, setSnapshot] = useState<HermesMemorySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<MemoryTabId>("memory");
  const [savingTarget, setSavingTarget] = useState<HermesMemoryLimitTarget | null>(null);
  const [saveError, setSaveError] = useState<{ target: HermesMemoryLimitTarget; message: string } | null>(null);
  const requestIdRef = useRef(0);
  const saveRequestIdRef = useRef(0);
  const saveInFlightRef = useRef<number | null>(null);
  const activeBotRef = useRef(botId);
  activeBotRef.current = botId;

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (botStatus !== "running") {
      setSnapshot(null); setStatus("error"); setError(t("实例运行后才能读取记忆。")); return null;
    }
    setStatus("loading"); setError(null);
    try {
      const next = await fetchHermesMemorySnapshot(repositories.bots, botId);
      if (!isHermesMemoryOperationCurrent({ activeBotId: activeBotRef.current, requestedBotId: botId, latestRequestId: requestIdRef.current, requestId })) return null;
      setSnapshot(next); setStatus("ready"); return next;
    } catch (cause) {
      if (!isHermesMemoryOperationCurrent({ activeBotId: activeBotRef.current, requestedBotId: botId, latestRequestId: requestIdRef.current, requestId })) return null;
      setStatus("error"); setError(t("记忆读取命令执行失败：{{detail}}", { detail: cause instanceof Error ? cause.message : t("未知错误") })); return null;
    }
  }, [botId, botStatus]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (target: HermesMemoryLimitTarget, value: number, existingChars: number) => {
    if (botStatus !== "running") { setSaveError({ target, message: t("实例运行后才能调整记忆上限。") }); return false; }
    if (!canStartHermesMemoryLimitSave(savingTarget) || saveInFlightRef.current !== null) return false;
    const requestId = ++saveRequestIdRef.current;
    saveInFlightRef.current = requestId; setSavingTarget(target); setSaveError(null);
    const current = () => isHermesMemoryOperationCurrent({ activeBotId: activeBotRef.current, requestedBotId: botId, latestRequestId: saveRequestIdRef.current, requestId });
    try {
      const result = await executeHermesMemoryLimitSave({
        bots: repositories.bots,
        botId,
        target,
        value,
        existingChars,
        getGatewayRestartCommand: async () => (await getHermesScriptCommands()).getGatewayRestartCommand(),
      });
      if (!current()) return false;
      if (result.status === "failed") { setSaveError({ target, message: t("记忆上限调整失败：{{detail}}", { detail: result.error.message }) }); return false; }
      if (result.status === "partial") { setSaveError({ target, message: t("配置已保存，但后续步骤失败。请刷新页面确认最新配置；如网关未重启，请到「设置 → 重启网关」手动重启。") }); return false; }
      setSnapshot(result.snapshot); setStatus("ready"); setError(null); return true;
    } finally {
      if (saveInFlightRef.current === requestId) saveInFlightRef.current = null;
      if (current()) setSavingTarget(null);
    }
  }, [botId, botStatus, savingTarget]);

  const memoryEntries = splitHermesMemoryEntries(snapshot?.memoryText ?? "");
  const userEntries = splitHermesMemoryEntries(snapshot?.userText ?? "");
  return (
    <HermesAgentConsoleHost className="space-y-4">
      <AgentSectionHeader
        title={t("持久记忆")}
        description={t("查看当前 Hermes Agent 的持久记忆和用户画像文件")}
        actions={<button type="button" onClick={() => void load()} disabled={status === "loading"} className="inline-flex h-8 w-8 items-center justify-center text-black/35 hover:text-black/80 disabled:text-black/20"><RefreshCw className={cn("h-4 w-4", status === "loading" && "animate-spin")} /></button>}
      />
      {status === "error" ? <div className="rounded-lg border border-red-500/15 bg-red-500/[0.04] px-4 py-3 text-sm text-red-600">{error || t("记忆读取失败，请稍后重试。")}</div> : null}
      {status === "loading" && !snapshot ? <div className="flex min-h-64 items-center justify-center rounded-lg border border-black/[0.06] bg-white text-sm text-black/50"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{t("正在读取记忆...")}</div> : null}
      {snapshot ? <>
        <div className="grid gap-3 md:grid-cols-2">
          <MemoryLimitCard target="memory" title={t("记忆统计")} description={t("MEMORY.md：跨会话长期记忆文件，主要保存项目环境事实、工作约定和经验教训等。")} used={snapshot.memoryChars} limit={snapshot.memoryCharLimit} saving={savingTarget === "memory"} disabled={savingTarget !== null} saveError={saveError?.target === "memory" ? saveError.message : null} onSave={save} onDraftChange={(target) => setSaveError((current) => current?.target === target ? null : current)} />
          <MemoryLimitCard target="user" title={t("用户画像统计")} description={t("USER.md：帮 Agent 长期记住你的偏好、使用习惯和沟通方式。")} used={snapshot.userChars} limit={snapshot.userCharLimit} saving={savingTarget === "user"} disabled={savingTarget !== null} saveError={saveError?.target === "user" ? saveError.message : null} onSave={save} onDraftChange={(target) => setSaveError((current) => current?.target === target ? null : current)} />
        </div>
        <div className="rounded-lg border border-black/[0.06] bg-white p-3 shadow-[0_8px_28px_rgba(15,23,42,0.04)]">
          <div className="mb-3 inline-flex rounded-lg bg-black/[0.04] p-1">
            {([["memory", t("记忆")], ["user", t("用户画像")]] as const).map(([id, label]) => <button key={id} type="button" onClick={() => setTab(id)} className={cn("rounded-lg px-3 py-1.5 text-sm font-medium", tab === id ? "bg-white text-black/90 shadow-sm" : "text-black/50 hover:text-black/80")}>{label}</button>)}
          </div>
          <MemoryEntries entries={tab === "memory" ? memoryEntries : userEntries} emptyText={tab === "memory" ? t("MEMORY.md 文件为空") : t("USER.md 文件为空")} />
        </div>
      </> : null}
    </HermesAgentConsoleHost>
  );
}
