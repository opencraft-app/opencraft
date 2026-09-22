// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { AlertTriangle, Check, ChevronDown, CircleHelp, Loader2, Search, X } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { AgentTooltip } from "../../components/agents/index";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { useT } from "../../i18n/t";
import { AGENT_SECTION_PATH_BY_ID } from "../../lib/agent-routes";
import {
  formatInstalledSkillDisplayName,
  matchesInstalledSkillSearch,
  type InstalledSkillLoadState,
} from "../../lib/hermes-skills-client";
import { isGlobal } from "../../lib/region";

export interface AutomationSkillPickerProps {
  value: string[];
  loadState: InstalledSkillLoadState;
  onChange: (slugs: string[]) => void;
  onRetry: () => void;
}

export interface AutomationSkillBindingSummaryProps {
  value: string[];
  loadState: InstalledSkillLoadState;
}

function getSkillLabel(slug: string): string {
  return formatInstalledSkillDisplayName(slug) || slug;
}

export function AutomationSkillBindingSummary({
  value,
  loadState,
}: AutomationSkillBindingSummaryProps) {
  const t = useT();
  if (value.length === 0) return <span>{t("未配置")}</span>;

  return (
    <span className="inline-flex max-w-full flex-col items-end gap-1.5">
      {value.map((slug) => {
        const available = loadState.status === "ready" && loadState.slugs.includes(slug);
        const statusLabel = loadState.status === "ready"
          ? available ? null : t("不可用")
          : loadState.status === "error"
            ? t("暂无法确认")
            : t("状态确认中");
        return (
          <span key={slug} className="inline-flex max-w-full flex-col items-end">
            <span className="inline-flex max-w-full items-center gap-1.5">
              <span className="truncate">{getSkillLabel(slug)}</span>
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
            <span className="break-all font-mono text-xs text-black/40">{slug}</span>
          </span>
        );
      })}
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
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filteredSlugs = useMemo(
    () => loadState.slugs.filter((slug) => matchesInstalledSkillSearch(slug, getSkillLabel(slug), query)),
    [loadState.slugs, query],
  );
  const selectedFallbacks = useMemo(
    () => value.filter((slug) => (
      !loadState.slugs.includes(slug)
      && matchesInstalledSkillSearch(slug, getSkillLabel(slug), query)
    )),
    [loadState.slugs, query, value],
  );

  const choose = (slug: string) => {
    const selected = value.includes(slug);
    if (selected && isGlobal) {
      onChange(value);
      return;
    }
    onChange(selected ? value.filter((item) => item !== slug) : [...value, slug]);
    setQuery("");
  };

  const removeSelection = (slug: string) => {
    onChange(value.filter((item) => item !== slug));
  };

  const changeOpen = (next: boolean) => { setOpen(next); if (!next) setQuery(""); };

  return (
    <div className="mt-4">
      <div className="flex items-center gap-1 text-sm font-medium text-black/80">
        <span>{t("调用技能")}</span>
        <AgentTooltip triggerMode="control" content={t("在此处选择技能后，Agent 会在执行任务前加载该技能，相比仅在任务说明中通过提示词要求调用技能更加稳定。")}>
          <button type="button" aria-label={t("为什么选择调用技能更稳定")}
            className="inline-flex size-6 items-center justify-center rounded-md text-black/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
            <CircleHelp className="size-3.5" aria-hidden="true" />
          </button>
        </AgentTooltip>
        <span className="text-xs font-normal text-black/40">{t("（可选）")}</span>
      </div>
      <Popover open={open} onOpenChange={changeOpen}>
      <PopoverAnchor asChild>
      <div className="relative mt-1.5">
        <div className="flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-black/10 bg-white p-1.5 pl-2 transition focus-within:border-black/30 hover:border-black/20">
          {value.map((slug) => {
            const displayName = getSkillLabel(slug);
            const unavailable = loadState.status === "ready" && !loadState.slugs.includes(slug);
            return (
              <span
                key={slug}
                className={`inline-flex max-w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${
                  unavailable
                    ? "bg-[var(--automation-skill-unavailable-bg)] text-[var(--automation-skill-unavailable-text)]"
                    : "bg-[var(--automation-skill-chip-bg)] text-[var(--automation-skill-chip-text)]"
                }`}
              >
                <span className="max-w-40 truncate">{displayName}</span>
                {unavailable && <span className="text-[10px] font-normal">{t("不可用")}</span>}
                <button type="button" aria-label={`${t("移除技能")} ${displayName}`}
                  onClick={() => removeSelection(slug)} className="-mr-1 inline-flex size-4 shrink-0 items-center justify-center rounded focus-visible:ring-2">
                  <X className="size-3" aria-hidden="true" />
                </button>
              </span>
            );
          })}
          <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("调用技能")}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listboxId : undefined}
            className={`flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left text-sm focus:outline-none ${
              value.length > 0 ? "text-black/55" : "text-black/35"
            }`}
          >
            <span className={`truncate ${value.length > 0 ? "text-black/55" : "text-black/35"}`}>
              {value.length > 0 ? t("继续添加技能") : t("选择你希望 Agent 稳定调用的技能")}
            </span>
            <ChevronDown className={`size-4 shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
          </button>
          </PopoverTrigger>
        </div>
      </div>
      </PopoverAnchor>
      {open && <PopoverContent align="start" side="top" sideOffset={6} collisionPadding={16}
        data-testid="automation-skill-picker-popup" aria-label={t("调用技能")}
        className="agents-ui z-[250] max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] min-w-[min(320px,calc(100vw-32px))] max-w-[calc(100vw-32px)] overflow-hidden rounded-md p-0"
        onOpenAutoFocus={(event) => { event.preventDefault(); searchRef.current?.focus(); }}>
            <div className="border-b border-black/[0.06] p-1.5">
              <label className="flex items-center gap-2 rounded-md bg-black/[0.035] px-2.5 py-1.5">
                <Search className="h-4 w-4 shrink-0 text-black/35" />
                <input
                  ref={searchRef}
                  type="search"
                  aria-label={t("搜索已安装的技能")}
                  placeholder={t("搜索已安装的技能")}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-sm text-black/85 placeholder:text-black/35 focus:outline-none"
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      document.getElementById(listboxId)?.querySelector<HTMLElement>('[role="option"]')?.focus();
                    }
                  }}
                />
              </label>
            </div>

            <div id={listboxId} role="listbox" aria-multiselectable="true" aria-label={t("已安装 Skill")}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const options = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
                const index = options.indexOf(document.activeElement as HTMLElement);
                options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
              }} className="max-h-48 overflow-y-auto p-1">
              {selectedFallbacks.map((slug) => (
                <button
                  key={slug}
                  type="button"
                  role="option"
                  aria-selected="true"
                  onClick={() => choose(slug)}
                  className="flex w-full items-center justify-between gap-3 rounded-md bg-amber-500/[0.06] px-2.5 py-1.5 text-left"
                >
                  <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
                    <span className="truncate text-sm font-medium text-black/80">{getSkillLabel(slug)}</span>
                    <span className="truncate font-mono text-xs text-black/40">{slug}</span>
                  </span>
                  <span className="shrink-0 text-xs font-medium text-amber-700">
                    {loadState.status === "ready" ? t("不可用") : t("暂无法确认")}
                  </span>
                </button>
              ))}

              {filteredSlugs.map((slug) => {
                const displayName = getSkillLabel(slug);
                const selected = value.includes(slug);
                return (
                  <button
                    key={slug}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => choose(slug)}
                    className={`${isGlobal ? "" : "group/option "}flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left transition hover:bg-black/[0.04]${isGlobal ? "" : " focus:outline-none focus-visible:bg-black/[0.04]"}`}
                  >
                    <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
                      <span className="truncate text-sm font-medium text-black/80">{displayName}</span>
                      <span className="truncate font-mono text-xs text-black/40">{slug}</span>
                    </span>
                    {selected && (isGlobal ? (
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

              {loadState.status === "ready" && loadState.slugs.length > 0 && filteredSlugs.length === 0 && selectedFallbacks.length === 0 && (
                <div className="px-2.5 py-3 text-sm text-black/45">{t("没有匹配的 Skill")}</div>
              )}
            </div>
        </PopoverContent>}
      </Popover>
    </div>
  );
}
