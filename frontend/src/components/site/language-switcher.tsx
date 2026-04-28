/**
 * 语言切换器（仅国际站使用）
 * ──────────────────────────────────────────────────────────────
 * - 通过 `setLocale()` 切换语言，react-i18next 会自动驱动 rerender
 * - 选择结果由 `setLocale()` 内部持久化到 localStorage('lw-locale')
 * - 样式与 Navbar 登录/CTA 按钮的 [36px 高 + 100px 圆角] 体系保持一致
 *
 * 两种形态：
 *   <LanguageSwitcher />           —— 桌面：下拉菜单（🌐 EN ▾）
 *   <LanguageSwitcher variant="inline" /> —— 移动：两个按钮平铺（中文 | English）
 */

import { Check, ChevronDown, Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { setLocale } from "@/i18n";

type Locale = "zh-CN" | "en-US";

type Option = {
  value: Locale;
  /** 触发按钮上显示的短标（如 "EN" / "中"） */
  short: string;
  /** 下拉项 / 平铺按钮上显示的完整名称 */
  label: string;
};

const EN_OPTION: Option = { value: "en-US", short: "EN", label: "English" };
const ZH_OPTION: Option = { value: "zh-CN", short: "中", label: "中文" };

const OPTIONS: readonly Option[] = [EN_OPTION, ZH_OPTION];

function currentOption(lang: string | undefined): Option {
  if (lang?.startsWith("zh")) return ZH_OPTION;
  return EN_OPTION;
}

/**
 * 下拉菜单形态（桌面端用）
 */
function DropdownSwitcher() {
  const { i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const active = currentOption(i18n.language);

  /* 点击外部关闭下拉 */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const handlePick = (value: Locale) => {
    setOpen(false);
    if (value !== i18n.language) setLocale(value);
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Change language"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center gap-1.5 h-[36px] px-3 bg-[#F5F5F5] text-black/90 rounded-[100px] border border-[#E6E9EF] cursor-pointer shadow-[0_2px_0_rgba(187,187,187,0.05)] hover:bg-black/5 transition-colors font-heading text-sm font-medium whitespace-nowrap"
      >
        <Globe className="h-[14px] w-[14px]" />
        <span>{active.short}</span>
        <ChevronDown
          className={`h-[14px] w-[14px] transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute right-0 top-[calc(100%+6px)] z-50 min-w-[140px] overflow-hidden rounded-xl border border-black/5 bg-white shadow-[0_8px_24px_rgba(0,0,0,0.08)] py-1"
        >
          {OPTIONS.map((opt) => {
            const selected = opt.value === active.value;
            return (
              <li key={opt.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => handlePick(opt.value)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-sm transition-colors hover:bg-black/5 ${
                    selected ? "font-semibold text-black/90" : "font-normal text-black/80"
                  }`}
                >
                  <span>{opt.label}</span>
                  {selected && <Check className="h-[14px] w-[14px]" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * 平铺形态（移动端菜单内用）
 */
function InlineSwitcher() {
  const { i18n } = useTranslation();
  const active = currentOption(i18n.language);

  return (
    <div className="flex items-center gap-2">
      {OPTIONS.map((opt) => {
        const selected = opt.value === active.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => {
              if (!selected) setLocale(opt.value);
            }}
            className={`inline-flex items-center justify-center h-[32px] px-3 rounded-[100px] text-[13px] transition-colors ${
              selected
                ? "bg-black/90 text-white font-semibold"
                : "bg-[#F5F5F5] text-black/80 border border-[#E6E9EF] hover:bg-black/5"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function LanguageSwitcher({ variant = "dropdown" }: { variant?: "dropdown" | "inline" }) {
  return variant === "inline" ? <InlineSwitcher /> : <DropdownSwitcher />;
}
