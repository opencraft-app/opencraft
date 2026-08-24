import { AlertTriangle, Check, ChevronDown, CircleHelp, Loader2, Search, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "@/i18n/t";
import { AGENT_SECTION_PATH_BY_ID } from "@/lib/agent-routes";
import {
  formatInstalledSkillDisplayName,
  matchesInstalledSkillSearch,
  type InstalledSkillLoadState,
} from "@/lib/hermes-skills-client";
import { isGlobal } from "@/lib/region";

export interface AutomationSkillPickerProps {
  value: string;
  loadState: InstalledSkillLoadState;
  onChange: (slug: string) => void;
  onRetry: () => void;
}

export interface AutomationSkillBindingSummaryProps {
  value: string;
  loadState: InstalledSkillLoadState;
}

function getSkillLabel(slug: string): string {
  return formatInstalledSkillDisplayName(slug) || slug;
}

const HELP_TOOLTIP_MAX_WIDTH = 320;
const HELP_TOOLTIP_VIEWPORT_MARGIN = 16;
const HELP_TOOLTIP_GAP = 8;
const HELP_TOOLTIP_CLOSE_DELAY_MS = 120;

export function AutomationSkillBindingSummary({
  value,
  loadState,
}: AutomationSkillBindingSummaryProps) {
  const t = useT();
  if (!value) return <span>{t("未配置")}</span>;

  const available = loadState.status === "ready" && loadState.slugs.includes(value);
  const statusLabel = loadState.status === "ready"
    ? available ? null : t("不可用")
    : loadState.status === "error"
      ? t("暂无法确认")
      : t("状态确认中");

  return (
    <span className="inline-flex max-w-full flex-col items-end">
      <span className="inline-flex max-w-full items-center gap-1.5">
        <span className="truncate">{getSkillLabel(value)}</span>
        {statusLabel && (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
            loadState.status === "ready"
              ? "bg-amber-500/10 text-amber-700"
              : "bg-black/[0.06] text-black/45"
          }`}>
            {statusLabel}
          </span>
        )}
      </span>
      <span className="break-all font-mono text-xs text-black/40">{value}</span>
    </span>
  );
}

export function AutomationSkillPicker({
  value,
  loadState,
  onChange,
  onRetry,
}: AutomationSkillPickerProps) {
  const t = useT();
  const listboxId = useId();
  const helpTooltipId = useId();
  const pickerRef = useRef<HTMLDivElement>(null);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const helpCloseTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [helpTooltipOpen, setHelpTooltipOpen] = useState(false);
  const [helpTooltipPosition, setHelpTooltipPosition] = useState({ left: 0, top: 0 });
  const selectedName = value
    ? getSkillLabel(value)
    : t("选择你希望 Agent 稳定调用的技能");
  const selectedUnavailable = Boolean(
    value && loadState.status === "ready" && !loadState.slugs.includes(value),
  );
  const selectedUnknown = Boolean(
    value && (loadState.status === "idle" || loadState.status === "loading" || loadState.status === "error"),
  );
  const filteredSlugs = useMemo(
    () => loadState.slugs.filter((slug) => matchesInstalledSkillSearch(slug, getSkillLabel(slug), query)),
    [loadState.slugs, query],
  );
  const showSelectedFallback = Boolean(
    value
      && !loadState.slugs.includes(value)
      && matchesInstalledSkillSearch(value, selectedName, query),
  );

  const choose = (slug: string) => {
    onChange(slug);
    setOpen(false);
    setQuery("");
  };

  const clearSelection = () => {
    onChange("");
    setOpen(false);
    setQuery("");
  };

  const clearHelpCloseTimer = useCallback(() => {
    if (helpCloseTimerRef.current === null) return;
    window.clearTimeout(helpCloseTimerRef.current);
    helpCloseTimerRef.current = null;
  }, []);

  const updateHelpTooltipPosition = useCallback(() => {
    const rect = helpButtonRef.current?.getBoundingClientRect();
    if (!rect) return;

    const tooltipWidth = Math.min(
      HELP_TOOLTIP_MAX_WIDTH,
      Math.max(0, window.innerWidth - HELP_TOOLTIP_VIEWPORT_MARGIN * 2),
    );
    const halfWidth = tooltipWidth / 2;
    const centeredLeft = rect.left + rect.width / 2;
    const left = Math.min(
      Math.max(centeredLeft, HELP_TOOLTIP_VIEWPORT_MARGIN + halfWidth),
      window.innerWidth - HELP_TOOLTIP_VIEWPORT_MARGIN - halfWidth,
    );

    setHelpTooltipPosition({
      left,
      top: rect.top - HELP_TOOLTIP_GAP,
    });
  }, []);

  const showHelpTooltip = () => {
    clearHelpCloseTimer();
    updateHelpTooltipPosition();
    setHelpTooltipOpen(true);
  };

  const scheduleHelpTooltipClose = () => {
    clearHelpCloseTimer();
    helpCloseTimerRef.current = window.setTimeout(() => {
      setHelpTooltipOpen(false);
      helpCloseTimerRef.current = null;
    }, HELP_TOOLTIP_CLOSE_DELAY_MS);
  };

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (pickerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setQuery("");
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!helpTooltipOpen) return;

    window.addEventListener("resize", updateHelpTooltipPosition);
    window.addEventListener("scroll", updateHelpTooltipPosition, true);
    return () => {
      window.removeEventListener("resize", updateHelpTooltipPosition);
      window.removeEventListener("scroll", updateHelpTooltipPosition, true);
    };
  }, [helpTooltipOpen, updateHelpTooltipPosition]);

  useEffect(() => () => clearHelpCloseTimer(), [clearHelpCloseTimer]);

  return (
    <div className="mt-4">
      <div className="flex items-center gap-1 text-sm font-medium text-black/80">
        <span>{t("调用技能")}</span>
        <span
          className="relative inline-flex"
          onMouseEnter={showHelpTooltip}
          onMouseLeave={scheduleHelpTooltipClose}
        >
          <button
            ref={helpButtonRef}
            type="button"
            aria-label={t("为什么选择调用技能更稳定")}
            aria-describedby={helpTooltipId}
            onFocus={showHelpTooltip}
            onBlur={scheduleHelpTooltipClose}
            className="inline-flex size-4 items-center justify-center rounded-full text-black/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black/30"
          >
            <CircleHelp className="size-3.5" aria-hidden="true" />
          </button>
        </span>
        {helpTooltipOpen && typeof document !== "undefined" && createPortal(
          <span
            id={helpTooltipId}
            role="tooltip"
            onMouseEnter={showHelpTooltip}
            onMouseLeave={scheduleHelpTooltipClose}
            style={{ left: helpTooltipPosition.left, top: helpTooltipPosition.top }}
            className="pointer-events-auto fixed z-[260] w-80 max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-full select-text rounded-md border border-[var(--border-subtle)] bg-white px-3 py-2 text-pretty text-[11px] font-medium leading-relaxed text-[var(--text-primary)] shadow-[0_8px_24px_rgba(15,23,42,0.12)]"
          >
            {t("在此处选择技能后，Agent 会在执行任务前加载该技能，相比仅在任务说明中通过提示词要求调用技能更加稳定。")}
            <span className="absolute left-1/2 top-full size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-[var(--border-subtle)] bg-white" />
          </span>,
          document.body,
        )}
        <span className="text-xs font-normal text-black/40">{t("（可选）")}</span>
      </div>
      <div ref={pickerRef} className="relative mt-1.5">
        <button
          type="button"
          aria-label={t("调用技能")}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          onClick={() => {
            setOpen((current) => !current);
            if (open) setQuery("");
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            setOpen(false);
            setQuery("");
          }}
          className="flex w-full items-center justify-between gap-3 rounded-md border border-black/10 bg-white py-2 pl-3 pr-11 text-left text-sm text-black/85 transition hover:border-black/20 focus:border-black/30 focus:outline-none"
        >
          <span className={`min-w-0 truncate ${value ? "" : "text-black/35"}`}>{selectedName}</span>
          <span className="flex shrink-0 items-center gap-2">
            {selectedUnavailable && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700">
                {t("不可用")}
              </span>
            )}
            {selectedUnknown && loadState.status === "error" && (
              <span className="text-xs text-black/40">{t("暂无法确认")}</span>
            )}
          </span>
        </button>

        {value ? (
          <button
            type="button"
            aria-label={t("移除已选择的技能")}
            onClick={clearSelection}
            className="group/clear absolute right-0 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-md text-black/40 focus:outline-none focus-visible:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-black/15"
          >
            <ChevronDown className="absolute size-4 transition-opacity duration-150 group-hover/clear:opacity-0 group-focus-visible/clear:opacity-0" />
            <X className="size-4 opacity-0 transition-opacity duration-150 group-hover/clear:opacity-100 group-focus-visible/clear:opacity-100" />
          </button>
        ) : (
          <span className="pointer-events-none absolute right-0 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center text-black/40">
            <ChevronDown className={`size-4 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
          </span>
        )}

        {open && (
          <div className="absolute z-40 mt-1.5 w-full overflow-hidden rounded-lg border border-black/10 bg-white shadow-xl">
            <div className="border-b border-black/[0.06] p-1.5">
              <label className="flex items-center gap-2 rounded-md bg-black/[0.035] px-2.5 py-1.5">
                <Search className="h-4 w-4 shrink-0 text-black/35" />
                <input
                  type="search"
                  aria-label={t("搜索已安装的技能")}
                  placeholder={t("搜索已安装的技能")}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-sm text-black/85 placeholder:text-black/35 focus:outline-none"
                  autoFocus
                />
              </label>
            </div>

            <div id={listboxId} role="listbox" aria-label={t("已安装 Skill")} className="max-h-48 overflow-y-auto p-1">
              {showSelectedFallback && (
                <button
                  type="button"
                  role="option"
                  aria-selected="true"
                  onClick={() => choose(value)}
                  className="flex w-full items-center justify-between gap-3 rounded-md bg-amber-500/[0.06] px-2.5 py-1.5 text-left"
                >
                  <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
                    <span className="truncate text-sm font-medium text-black/80">{selectedName}</span>
                    <span className="truncate font-mono text-xs text-black/40">{value}</span>
                  </span>
                  <span className="shrink-0 text-xs font-medium text-amber-700">
                    {selectedUnavailable ? t("不可用") : t("暂无法确认")}
                  </span>
                </button>
              )}

              {filteredSlugs.map((slug) => {
                const displayName = getSkillLabel(slug);
                return (
                  <button
                    key={slug}
                    type="button"
                    role="option"
                    aria-selected={value === slug}
                    onClick={() => choose(!isGlobal && value === slug ? "" : slug)}
                    className={`${isGlobal ? "" : "group/option "}flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left transition hover:bg-black/[0.04]${isGlobal ? "" : " focus:outline-none focus-visible:bg-black/[0.04]"}`}
                  >
                    <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
                      <span className="truncate text-sm font-medium text-black/80">{displayName}</span>
                      <span className="truncate font-mono text-xs text-black/40">{slug}</span>
                    </span>
                    {value === slug && (isGlobal ? (
                      <Check className="size-4 shrink-0 text-black/70 opacity-100" />
                    ) : (
                      <span className="relative size-4 shrink-0" aria-hidden="true">
                        <Check className="absolute inset-0 size-4 text-black/70 opacity-100 transition-opacity duration-150 group-hover/option:opacity-0 group-focus-visible/option:opacity-0" />
                        <X className="absolute inset-0 size-4 text-black/70 opacity-0 transition-opacity duration-150 group-hover/option:opacity-100 group-focus-visible/option:opacity-100" />
                      </span>
                    ))}
                  </button>
                );
              })}

              {(loadState.status === "idle" || loadState.status === "loading") && (
                <div className="flex items-center gap-2 px-2.5 py-3 text-sm text-black/45">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("加载中...")}
                </div>
              )}

              {loadState.status === "error" && (
                <div className="m-1.5 rounded-md border border-red-500/15 bg-red-500/[0.04] px-3 py-2.5">
                  <div className="flex items-center gap-2 text-sm text-red-700">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    {t("Skill 列表加载失败")}
                  </div>
                  <button
                    type="button"
                    onClick={onRetry}
                    className="mt-2 text-xs font-medium text-black/65 underline decoration-black/25 underline-offset-2"
                  >
                    {t("重试")}
                  </button>
                </div>
              )}

              {loadState.status === "ready" && loadState.slugs.length === 0 && (
                <div className="px-2.5 py-3 text-sm text-black/45">
                  <p>{t("暂无已安装 Skill")}</p>
                  <a
                    href={AGENT_SECTION_PATH_BY_ID.skill}
                    className="mt-1.5 inline-block text-xs font-medium text-black/65 underline decoration-black/25 underline-offset-2"
                  >
                    {t("前往技能管理")}
                  </a>
                </div>
              )}

              {loadState.status === "ready" && loadState.slugs.length > 0 && filteredSlugs.length === 0 && !showSelectedFallback && (
                <div className="px-2.5 py-3 text-sm text-black/45">{t("没有匹配的 Skill")}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
