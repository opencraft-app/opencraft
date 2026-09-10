// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { Check, ChevronDown, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { useT } from "../../i18n/t";
import type { CronContextCapability, CronJob } from "../../lib/hermes-cron-client";
import { cn } from "../../lib/utils";

export interface AutomationUpstreamPickerProps {
  value: string;
  options: readonly CronJob[];
  state: "loading" | CronContextCapability;
  existingMultipleUpstreams?: readonly CronJob[];
  onChange: (jobId: string) => void;
  onRetry?: () => void;
}

export function AutomationUpstreamPicker({
  value,
  options,
  state,
  existingMultipleUpstreams,
  onChange,
  onRetry,
}: AutomationUpstreamPickerProps) {
  const t = useT();
  const listboxId = useId();
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const selectedJob = options.find((job) => job.id === value);
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return options;
    return options.filter((job) => (
      job.name.toLocaleLowerCase().includes(normalizedQuery)
      || job.id.toLocaleLowerCase().includes(normalizedQuery)
    ));
  }, [options, query]);
  const optionCount = filteredOptions.length;
  const activeOptionId = activeIndex >= 0
    ? `${listboxId}-option-${activeIndex}`
    : undefined;

  const close = (restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const choose = (jobId: string) => {
    onChange(jobId);
    close(true);
  };

  const openPicker = () => {
    setOpen(true);
    setActiveIndex(-1);
  };

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();

    const handlePointerDown = (event: PointerEvent) => {
      if (pickerRef.current?.contains(event.target as Node)) return;
      close();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  if (state === "loading") {
    return <PickerStatus>{t("正在检测上游任务能力...")}</PickerStatus>;
  }

  if (state === "unsupported") {
    return <PickerStatus>{t("当前 Hermes 版本不支持上游任务，请升级后重试。")}</PickerStatus>;
  }

  if (state === "unknown") {
    return (
      <PickerStatus>
        <span>{t("暂时无法确认 Hermes 是否支持上游任务。")}</span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="font-medium text-black/65 underline decoration-black/25 underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            {t("重试")}
          </button>
        )}
      </PickerStatus>
    );
  }

  return (
    <div className="space-y-2">
      {existingMultipleUpstreams && existingMultipleUpstreams.length > 1 && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2 text-pretty text-xs text-amber-800">
          <p className="font-medium">{t("当前任务配置了多个上游，暂不支持在 LightVela 中编辑")}</p>
          <p className="mt-1 break-words text-amber-800/75">
            {existingMultipleUpstreams.map((job) => job.name).join("、")}
          </p>
        </div>
      )}

      <div ref={pickerRef} className="relative">
        <button
          ref={triggerRef}
          type="button"
          role={open ? undefined : "combobox"}
          aria-label={t("上游任务")}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          onClick={() => (open ? close() : openPicker())}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (!open) openPicker();
            }
            if (event.key === "Escape" && open) {
              event.preventDefault();
              close(true);
            }
          }}
          className="flex w-full items-center justify-between gap-3 rounded-md border border-black/10 bg-white py-2 pl-3 pr-11 text-left text-sm text-black/85 hover:border-black/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2"
        >
          <span className={cn("truncate", !selectedJob && "text-black/40")}>
            {selectedJob?.name ?? (value ? t("上游任务已不可用") : t("本任务执行时，将使用上游任务最近的输出作为上下文"))}
          </span>
        </button>

        {value ? (
          <button
            type="button"
            aria-label={t("取消选择")}
            onClick={() => {
              onChange("");
              close();
            }}
            className="group/clear absolute right-0 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-md text-black/40 focus:outline-none focus-visible:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-black/15"
          >
            <ChevronDown className="absolute size-4 transition-opacity duration-150 group-hover/clear:opacity-0 group-focus-visible/clear:opacity-0" aria-hidden="true" />
            <X className="size-4 opacity-0 transition-opacity duration-150 group-hover/clear:opacity-100 group-focus-visible/clear:opacity-100" aria-hidden="true" />
          </button>
        ) : (
          <span className="pointer-events-none absolute right-0 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center text-black/40">
            <ChevronDown className={cn("size-4 transition-transform duration-150", open && "rotate-180")} aria-hidden="true" />
          </span>
        )}

        {open && (
          <div className="absolute z-40 mt-1.5 w-full overflow-hidden rounded-xl border border-black/10 bg-white p-1.5 shadow-xl">
            <label className="flex items-center gap-2 rounded-md bg-black/[0.035] px-2.5 py-1.5">
              <Search className="size-4 shrink-0 text-black/35" aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                role="combobox"
                aria-label={t("搜索上游任务")}
                aria-autocomplete="list"
                aria-expanded="true"
                aria-controls={listboxId}
                aria-activedescendant={activeOptionId}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(-1);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    if (optionCount === 0) return;
                    setActiveIndex((current) => Math.min(current + 1, optionCount - 1));
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    if (optionCount === 0) return;
                    setActiveIndex((current) => Math.max(current - 1, 0));
                  } else if (event.key === "Enter" && activeIndex >= 0) {
                    event.preventDefault();
                    choose(filteredOptions[activeIndex]!.id);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    close(true);
                  }
                }}
                placeholder={t("搜索上游任务")}
                className="min-w-0 flex-1 bg-transparent text-sm text-black/85 placeholder:text-black/35 focus:outline-none"
              />
            </label>

            <div
              id={listboxId}
              role="listbox"
              aria-label={t("可选上游任务")}
              className="mt-1 max-h-52 overflow-y-auto"
            >
              {filteredOptions.map((job, index) => {
                const optionIndex = index;
                return (
                  <UpstreamOption
                    key={job.id}
                    id={`${listboxId}-option-${optionIndex}`}
                    active={activeIndex === optionIndex}
                    selected={value === job.id}
                    onActivate={() => setActiveIndex(optionIndex)}
                    onDeactivate={() => setActiveIndex((current) => current === optionIndex ? -1 : current)}
                    onChoose={() => choose(value === job.id ? "" : job.id)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-black/80">{job.name}</span>
                    </span>
                  </UpstreamOption>
                );
              })}

              {filteredOptions.length === 0 && (
                <p className="px-2.5 py-3 text-pretty text-sm text-black/45">
                  {options.length === 0 ? t("暂无可关联的上游任务") : t("没有匹配的上游任务")}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PickerStatus({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-black/[0.08] bg-black/[0.025] px-3 py-2 text-pretty text-sm text-black/55">
      {children}
    </div>
  );
}

function UpstreamOption({
  id,
  active,
  selected,
  onActivate,
  onDeactivate,
  onChoose,
  children,
}: {
  id: string;
  active: boolean;
  selected: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  onChoose: () => void;
  children: ReactNode;
}) {
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onMouseEnter={onActivate}
      onMouseLeave={onDeactivate}
      onFocus={onActivate}
      onClick={onChoose}
      className={cn(
        "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left hover:bg-black/[0.04] focus:outline-none",
        active && "bg-black/[0.04]",
      )}
    >
      {children}
      {selected && (
        <span className="relative size-4 shrink-0" aria-hidden="true">
          <Check className={cn(
            "absolute inset-0 size-4 text-black/70 transition-opacity duration-150",
            active ? "opacity-0" : "opacity-100",
          )} />
          <X className={cn(
            "absolute inset-0 size-4 text-black/70 transition-opacity duration-150",
            active ? "opacity-100" : "opacity-0",
          )} />
        </span>
      )}
    </button>
  );
}
