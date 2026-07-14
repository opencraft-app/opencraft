import { AlertTriangle, Check, ChevronDown, CircleHelp, Loader2, Search } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { useT } from "@/i18n/t";
import { AGENT_SECTION_PATH_BY_ID } from "@/lib/agent-routes";
import {
  formatInstalledSkillDisplayName,
  matchesInstalledSkillSearch,
  type InstalledSkillLoadState,
} from "@/lib/hermes-skills-client";

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

export function AutomationSkillBindingSummary({
  value,
  loadState,
}: AutomationSkillBindingSummaryProps) {
  const t = useT();
  if (!value) return <span>{t("不调用 Skill")}</span>;

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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedName = value ? getSkillLabel(value) : t("不调用 Skill");
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

  return (
    <div className="mt-4">
      <label className="block text-sm font-medium text-black/80">
        {t("调用 Skill")}
        <span className="ml-1 text-xs font-normal text-black/40">{t("（可选）")}</span>
      </label>
      <div className="relative mt-1.5">
        <button
          type="button"
          aria-label={t("调用 Skill")}
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
          className="flex w-full items-center justify-between gap-3 rounded-lg border border-black/10 bg-white px-3 py-2 text-left text-sm text-black/85 transition hover:border-black/20 focus:border-black/30 focus:outline-none"
        >
          <span className="min-w-0 truncate">{selectedName}</span>
          <span className="flex shrink-0 items-center gap-2">
            {selectedUnavailable && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700">
                {t("不可用")}
              </span>
            )}
            {selectedUnknown && loadState.status === "error" && (
              <span className="text-xs text-black/40">{t("暂无法确认")}</span>
            )}
            <ChevronDown className={`h-4 w-4 text-black/40 transition ${open ? "rotate-180" : ""}`} />
          </span>
        </button>

        {open && (
          <div className="absolute z-40 mt-1.5 w-full overflow-hidden rounded-lg border border-black/10 bg-white shadow-xl">
            <div className="border-b border-black/[0.06] p-2">
              <label className="flex items-center gap-2 rounded-md bg-black/[0.035] px-2.5 py-2">
                <Search className="h-4 w-4 shrink-0 text-black/35" />
                <input
                  type="search"
                  aria-label={t("搜索已安装 Skill")}
                  placeholder={t("搜索已安装 Skill")}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-sm text-black/85 placeholder:text-black/35 focus:outline-none"
                  autoFocus
                />
              </label>
            </div>

            <div id={listboxId} role="listbox" aria-label={t("已安装 Skill")} className="max-h-64 overflow-y-auto p-1.5">
              <button
                type="button"
                role="option"
                aria-selected={!value}
                onClick={() => choose("")}
                className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm text-black/75 transition hover:bg-black/[0.04]"
              >
                <span>{t("不调用 Skill")}</span>
                {!value && <Check className="h-4 w-4 text-black/70" />}
              </button>

              {showSelectedFallback && (
                <button
                  type="button"
                  role="option"
                  aria-selected="true"
                  onClick={() => choose(value)}
                  className="flex w-full items-center justify-between gap-3 rounded-md bg-amber-500/[0.06] px-2.5 py-2 text-left"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-black/80">{selectedName}</span>
                    <span className="block truncate font-mono text-xs text-black/40">{value}</span>
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
                    onClick={() => choose(slug)}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left transition hover:bg-black/[0.04]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-black/80">{displayName}</span>
                      <span className="block truncate font-mono text-xs text-black/40">{slug}</span>
                    </span>
                    {value === slug && <Check className="h-4 w-4 shrink-0 text-black/70" />}
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
      <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-5 text-black/40">
        <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{t("自动任务在非交互环境中运行，请确认该 Skill 支持无人值守执行")}</span>
      </p>
    </div>
  );
}
