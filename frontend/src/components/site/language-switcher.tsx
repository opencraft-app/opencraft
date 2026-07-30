/**
 * 语言 / 站点切换器
 * ──────────────────────────────────────────────────────────────
 * - 通过 `setLocale()` 切换语言，react-i18next 会自动驱动 rerender
 * - 选择结果由 `setLocale()` 内部持久化到 localStorage('lw-locale')
 * - 样式与 Navbar 登录/CTA 按钮的 [36px 高 + 100px 圆角] 体系保持一致
 *
 * 两种形态：
 *   <LanguageSwitcher />           —— 桌面：下拉菜单（🌐 EN ▾）
 *   <LanguageSwitcher variant="inline" /> —— 移动：两个按钮平铺（中文 | English）
 *
 * `reloadAfterSwitch`（可选，默认 false）：
 *   切换后强制刷新当前页面。仅在使用 `@tencent/tea-sdk-lightclaw`
 *   的页面（目前仅 settings）启用——SDK 依赖的 tea-app i18n 是
 *   init-once 设计，运行时无法切换 lng，必须重新加载页面。
 */

import { Check, ChevronDown, Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { setLocale } from "@/i18n";
import type { PublicSiteLocale } from "@/lib/public-site-navigation";
import { shouldLocalizePublicPath, stripPublicSiteLocalePrefix } from "@/lib/public-site-routing";
import { isGlobal, switchLocaleInPath } from "@/lib/region";

export type LanguageSwitcherVariant = "dropdown" | "inline";
export type LanguageSwitcherNavigate = (targetUrl: string) => void;

type I18nLocale = "zh-CN" | "en-US" | "zh-Hant";

type Option = {
  value: PublicSiteLocale;
  /** 触发按钮上显示的短标（如 "EN" / "中"） */
  short: string;
  /** 下拉项 / 平铺按钮上显示的完整名称 */
  label: string;
};

const EN_OPTION: Option = { value: "en-US", short: "EN", label: "Intl - English" };
const ZH_CN_OPTION: Option = { value: "zh-CN", short: "中", label: "Intl - 中文" };
const ZH_SG_OPTION: Option = { value: "zh-SG", short: "简", label: "Intl - 简体中文" };
const ZH_HANT_OPTION: Option = { value: "zh-Hant", short: "繁", label: "Intl - 繁體中文" };
const CHINA_SITE_URL = "https://lightvela.com";
const INTL_SITE_URL = "https://lightvela.ai";

function chineseOption(): Option {
  return isGlobal ? ZH_SG_OPTION : ZH_CN_OPTION;
}

function currentOption(lang: string | undefined): Option {
  if (lang === "zh-Hant") return ZH_HANT_OPTION;
  if (lang?.startsWith("zh")) return chineseOption();
  return EN_OPTION;
}

/**
 * 下拉菜单里每个语言项的显示名。
 * 需明确区分「简体中文 / 繁體中文 / English」，不能笼统显示为「中文」，
 * 否则国际站同时存在简体（zh-SG/zh-CN）与繁体（zh-Hant）时用户无法分辨。
 */
function dropdownOptionLabel(opt: Option): string {
  const sitePrefix = isGlobal ? "International Site - " : "国际站 - ";
  const name =
    opt.value === "en-US"
      ? "English"
      : opt.value === "zh-Hant"
        ? "繁體中文"
        : "简体中文";
  return sitePrefix + name;
}

function languageFromPublicLocale(locale: PublicSiteLocale | undefined): PublicSiteLocale | undefined {
  if (!locale) return undefined;
  return locale;
}

function i18nLocaleForPublicLocale(locale: PublicSiteLocale): I18nLocale {
  if (locale === "zh-Hant") return "zh-Hant";
  return locale.startsWith("zh") ? "zh-CN" : "en-US";
}

/**
 * 切换语言并按需刷新页面。
 *
 * 使用 SDK 的页面（settings）依赖 tea-app i18n，而 tea-app i18n 是
 * init-once 设计——运行时改 `window.VERSION` 或重新调 `i18n.init()`
 * 都不会重新渲染已挂载的 SDK 组件。reload 是当前唯一可靠的切换路径。
 *
 * URL 路径前缀切换（仅国际站 SEO 页面）：
 *   - reloadAfterSwitch=true：直接走 location.assign，让浏览器原生跳过去并刷新，
 *     SDK 区域的 tea-app i18n 也会跟随 reload 切换。
 *   - reloadAfterSwitch=false：用 react-router 的 navigate 替换历史，让
 *     useLocation / useNavigate / ScrollRestoration 等所有 router 消费者
 *     都能感知到 pathname 变化。**不能用 window.history.replaceState**——
 *     直接改 history 会让 react-router 的 location 状态停在旧 pathname。
 */
function applyLocaleChange(
  value: PublicSiteLocale,
  reloadAfterSwitch: boolean,
  navigateTo?: LanguageSwitcherNavigate,
): void {
  setLocale(i18nLocaleForPublicLocale(value));

  if (typeof window === "undefined") return;

  /* 国际站 SEO 页面（/docs、/about、/privacy-policy 等）按规则切换 URL
     语言前缀；非 SEO 页面（/agents、/auth 等）以及国内站，URL 不变。
     switchLocaleInPath 内部已自动处理 isGlobal 与白名单判断。 */
  const target = switchLocaleInPath(window.location.pathname, value);
  const targetUrl = target + window.location.search + window.location.hash;

  if (reloadAfterSwitch) {
    if (target !== window.location.pathname) {
      window.location.assign(targetUrl); // 跳到带新前缀的 URL 并 reload
    } else {
      window.location.reload();
    }
    return;
  }

  if (target !== window.location.pathname) {
    if (navigateTo) {
      navigateTo(targetUrl);
      return;
    }
    window.location.assign(targetUrl);
  }
}

function chinaSiteLabel(activeLocale: PublicSiteLocale): string {
  return activeLocale.startsWith("zh") ? "中国站" : "China Site";
}

function openChinaSite(): void {
  if (typeof window === "undefined") return;
  window.open(CHINA_SITE_URL, "_blank", "noopener,noreferrer");
}

function intlSiteUrlForLocale(value: PublicSiteLocale): string {
  if (typeof window === "undefined") return INTL_SITE_URL;

  const barePath = stripPublicSiteLocalePrefix(window.location.pathname || "/");
  const targetPath = value.startsWith("zh") && shouldLocalizePublicPath(barePath)
    ? (barePath === "/" ? "/zh-sg/" : `/zh-sg${barePath}`)
    : barePath;

  return `${INTL_SITE_URL}${targetPath}${window.location.search}${window.location.hash}`;
}

function applyIntlChoice(
  value: PublicSiteLocale,
  reloadAfterSwitch: boolean,
  navigateTo?: LanguageSwitcherNavigate,
): void {
  if (isGlobal) {
    applyLocaleChange(value, reloadAfterSwitch, navigateTo);
    return;
  }

  if (typeof window === "undefined") return;
  window.open(intlSiteUrlForLocale(value), "_blank", "noopener,noreferrer");
}

/**
 * 下拉菜单形态（桌面端用）
 */
function DropdownSwitcher({
  activeLocale,
  navigateTo,
  reloadAfterSwitch,
}: {
  activeLocale?: PublicSiteLocale;
  navigateTo?: LanguageSwitcherNavigate;
  reloadAfterSwitch: boolean;
}) {
  const { i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const active = currentOption(activeLocale ?? i18n.language);
  const options = [EN_OPTION, chineseOption(), ZH_HANT_OPTION] as const;

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

  const handlePick = (value: PublicSiteLocale) => {
    setOpen(false);
    if (!isGlobal || value !== active.value) applyIntlChoice(value, reloadAfterSwitch, navigateTo);
  };

  const chinaSiteOption = (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={!isGlobal}
        onClick={() => {
          setOpen(false);
          openChinaSite();
        }}
        className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-sm transition-colors hover:bg-black/5 ${
          !isGlobal ? "font-semibold text-black/90" : "font-normal text-black/80"
        }`}
      >
        <span>{isGlobal ? "中国站" : chinaSiteLabel(active.value)}</span>
        {!isGlobal && <Check className="h-[14px] w-[14px]" />}
      </button>
    </li>
  );

  const orderedOptions = isGlobal ? options : [ZH_CN_OPTION, EN_OPTION] as const;

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
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-max min-w-[168px] overflow-hidden rounded-xl border border-black/5 bg-white shadow-[0_8px_24px_rgba(0,0,0,0.08)] py-1"
        >
          {!isGlobal && chinaSiteOption}
          {orderedOptions.map((opt) => {
            const selected = isGlobal && opt.value === active.value;
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
                  <span>{dropdownOptionLabel(opt)}</span>
                  {selected && <Check className="h-[14px] w-[14px]" />}
                </button>
              </li>
            );
          })}
          {isGlobal && <li aria-hidden="true" className="my-1 border-t border-black/10" />}
          {isGlobal && chinaSiteOption}
        </ul>
      )}
    </div>
  );
}

/**
 * 平铺形态（移动端菜单内用）
 */
function InlineSwitcher({
  activeLocale,
  navigateTo,
  reloadAfterSwitch,
}: {
  activeLocale?: PublicSiteLocale;
  navigateTo?: LanguageSwitcherNavigate;
  reloadAfterSwitch: boolean;
}) {
  const { i18n } = useTranslation();
  const active = currentOption(activeLocale ?? i18n.language);
  const options = [EN_OPTION, chineseOption(), ZH_HANT_OPTION] as const;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {options.map((opt) => {
          const selected = isGlobal && opt.value === active.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                if (!selected) applyIntlChoice(opt.value, reloadAfterSwitch, navigateTo);
              }}
              className={`inline-flex h-[32px] items-center justify-center rounded-[100px] px-3 text-[13px] transition-colors ${
                selected
                  ? "bg-black/90 text-white font-semibold"
                  : "border border-[#E6E9EF] bg-[#F5F5F5] text-black/80 hover:bg-black/5"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <div className="h-px bg-black/10" />
      <button
        type="button"
        onClick={openChinaSite}
        className={`inline-flex h-[32px] w-fit items-center justify-center rounded-[100px] px-3 text-[13px] transition-colors ${
          !isGlobal
            ? "bg-black/90 text-white font-semibold"
            : "border border-[#E6E9EF] bg-[#F5F5F5] text-black/80 hover:bg-black/5"
        }`}
      >
        {chinaSiteLabel(active.value)}
      </button>
    </div>
  );
}

export function LanguageSwitcher({
  activeLocale,
  navigateTo,
  variant = "dropdown",
  reloadAfterSwitch = false,
}: {
  activeLocale?: PublicSiteLocale;
  navigateTo?: LanguageSwitcherNavigate;
  variant?: LanguageSwitcherVariant;
  /**
   * 切换后是否强制刷新页面。
   * 在使用 @tencent/tea-sdk-lightclaw 的页面（目前仅 /agents）
   * 必须传 `true`，否则 SDK 区域的 tea-app i18n 不会跟随切换。
   */
  reloadAfterSwitch?: boolean;
}) {
  const routeLocale = languageFromPublicLocale(activeLocale);

  return variant === "inline"
    ? <InlineSwitcher activeLocale={routeLocale} navigateTo={navigateTo} reloadAfterSwitch={reloadAfterSwitch} />
    : <DropdownSwitcher activeLocale={routeLocale} navigateTo={navigateTo} reloadAfterSwitch={reloadAfterSwitch} />;
}
