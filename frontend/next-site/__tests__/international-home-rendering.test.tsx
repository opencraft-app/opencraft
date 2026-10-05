import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pass } from "@/domain/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const headerAuthMock = vi.hoisted(() => vi.fn(() => null));
const motionMocks = vi.hoisted(() => {
  const dispose = vi.fn();
  return { dispose, mount: vi.fn(() => dispose) };
});
vi.mock('@next-site/international-home-motion', () => ({ mountInternationalHomeMotion: motionMocks.mount }));
const regionMock = vi.hoisted(() => ({ isGlobal: false }));
const sessionMock = vi.hoisted(() => ({ authReady: true, isAuthenticated: false }));
vi.mock("@next-site/public-header-auth-island", () => ({ PublicHeaderAuthIsland: headerAuthMock }));
vi.mock("@/components/site/browser-language-suggestion", async () => {
  const ReactRuntime = await import("react");
  return {
    BrowserLanguageSuggestion: () =>
      ReactRuntime.createElement("div", { "data-testid": "browser-language-suggestion" }),
  };
});
vi.mock("@/components/site/maintenance-announcement-banner", async () => {
  const ReactRuntime = await import("react");
  const { useLocaleOverride } = await import("@/i18n/t");
  return {
    MaintenanceAnnouncementBanner: () =>
      ReactRuntime.createElement(
        "div",
        { "data-testid": "maintenance-announcement-locale" },
        useLocaleOverride(),
      ),
  };
});
vi.mock("@/contexts/session-context", () => ({
  useSession: () => sessionMock,
}));
const openClawMock = vi.hoisted(() => ({
  bots: [] as Array<{ id: string }>,
  isSubscribed: false,
  latestPass: null as Pass | null,
  hasResolvedPasses: true,
  passesLoading: false,
  passesError: false,
  refreshPasses: vi.fn(),
}));
vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => openClawMock,
}));
vi.mock("@/lib/region", () => ({
  DEFAULT_LOCALE: "en-US",
  REGION: "global",
  get isGlobal() {
    return regionMock.isGlobal;
  },
  readLocaleFromPath: () => null,
}));

import { InternationalHomePage } from "@next-site/international-home-page";
import {
  INTERNATIONAL_HOME_ASSET_VERSION,
  INTERNATIONAL_HOME_SCRIPT_SOURCES,
  InternationalHomeRuntime,
} from "@next-site/international-home-runtime";

const frontendRoot = process.cwd();
const domesticHeroMarkup = '<main id="lightvela-intl-home" data-locale="zh-CN"><div class="hero__cta"><a data-domestic-home-hero-cta class="btn-dark" href="/subscribe"><span data-domestic-home-hero-cta-label>免费试用</span></a></div></main>';

beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  regionMock.isGlobal = false;
  motionMocks.mount.mockClear();
  motionMocks.dispose.mockClear();
  sessionMock.authReady = true;
  sessionMock.isAuthenticated = false;
  openClawMock.bots = [];
  openClawMock.isSubscribed = false;
  openClawMock.latestPass = null;
  openClawMock.hasResolvedPasses = true;
  openClawMock.passesLoading = false;
  openClawMock.passesError = false;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("international v2 homepage rendering", () => {
  it("keeps homepage header actions inside their existing right gutter", () => {
    for (const file of ['public/lightvela-intl-home/style.css', 'scripts/import-international-homepage.mjs']) {
      const source = readFileSync(path.join(frontendRoot, file), 'utf8');
      const rule = source.match(/\.international-home-header-actions-layer > div\s*\{([^}]+)\}/)?.[1];
      expect(rule).toMatch(/translate:\s*none\s*!important/);
      expect(source).toContain('right: max(24px, calc((100% - 1440px) / 2));');
    }
  });
  it("preserves the domestic channels and native public routes", () => {
    const document = new DOMParser().parseFromString(readFileSync(path.join(frontendRoot, 'public/lightvela-intl-home/index-fragment.zh-CN.html'), 'utf8'), 'text/html');
    expect(Array.from(document.querySelectorAll('.hero__tabs label'), (label) => label.textContent?.trim())).toEqual(['微信', 'QQ', '企业微信', '钉钉', '飞书']);
    expect(document.querySelector('.nav__links a[href="/subscribe"]')?.textContent).toBe('定价');
    expect(document.querySelector('a[href^="/zh-cn"]')).toBeNull();
    expect(document.querySelector('#panel-qq .native--qq')).not.toBeNull();
    expect(document.querySelector('#panel-tg .native--wecom')).not.toBeNull();
    expect(document.querySelector('#panel-dc .dc--dingtalk')).not.toBeNull();
    expect(document.querySelector('#panel-sl .dc--feishu')).not.toBeNull();
  });
  it("mounts the maintenance announcement with the active homepage locale", () => {
    (globalThis as { React?: typeof React }).React = React;
    render(<InternationalHomeRuntime locale="es" markup="<main />" />);

    expect(screen.getByTestId("maintenance-announcement-locale")).toHaveTextContent("es");
  });
  it("mounts the browser language suggestion only on the default English home", () => {
    regionMock.isGlobal = true;
    const { rerender } = render(<InternationalHomeRuntime locale="en-US" markup="<main />" />);
    expect(screen.getByTestId("browser-language-suggestion")).toBeInTheDocument();

    rerender(<InternationalHomeRuntime locale="zh-SG" markup="<main />" />);
    expect(screen.queryByTestId("browser-language-suggestion")).not.toBeInTheDocument();
  });
  it("server-renders the approved homepage content and stylesheet", () => {
    (globalThis as { React?: typeof React }).React = React;
    const markup = renderToStaticMarkup(<InternationalHomePage locale="en-US" />);

    expect(markup).toContain(`href="/lightvela-intl-home/style.css?v=${INTERNATIONAL_HOME_ASSET_VERSION}"`);
    expect(markup).not.toContain('rel="preload" as="image"');
    expect(markup).toContain('id="lightvela-intl-home"');
    expect(markup).toContain("Your AI companion—always on, always evolving with you.");
    expect(markup).toContain('href="/subscribe"');
  });

  it("server-renders localized homepage fragments", () => {
    (globalThis as { React?: typeof React }).React = React;

    expect(renderToStaticMarkup(<InternationalHomePage locale="zh-SG" />)).toContain(
      "越用越懂你，长期在线的 AI 伙伴",
    );
    expect(renderToStaticMarkup(<InternationalHomePage locale="zh-Hant" />)).toContain(
      "越用越懂你，長期在線的 AI 夥伴",
    );
    expect(renderToStaticMarkup(<InternationalHomePage locale="id-ID" />)).toContain(
      "Semakin sering dipakai, semakin memahami kamu, mitra AI yang selalu aktif",
    );
    expect(renderToStaticMarkup(<InternationalHomePage locale="es" />)).toContain(
      "Cuanto más lo uses, mejor te entenderá, tu compañero de IA siempre en línea",
    );
    expect(renderToStaticMarkup(<InternationalHomePage locale="ja-JP" />)).toContain(
      "使うほどあなたを理解する、ずっとオンラインのAIパートナー",
    );
    expect(renderToStaticMarkup(<InternationalHomePage locale="ko-KR" />)).toContain(
      "쓸수록 나를 더 잘 이해하는, 늘 온라인인 AI 파트너",
    );
    expect(renderToStaticMarkup(<InternationalHomePage locale="zh-SG" />)).toContain(
      'src="/lightvela-intl-home/assets/deepseek-harness-zh-cn.webp?v=20260904-harness-sharp"',
    );
  });

  it("loads only the approved homepage motion scripts", () => {
    expect(INTERNATIONAL_HOME_SCRIPT_SOURCES).toEqual([
      "/lightvela-intl-home/runtime.js",
      "/lightvela-intl-home/hero-chat.js",
      "/lightvela-intl-home/scene-wheel.js",
      "/lightvela-intl-home/assets/feature-motion.js",
    ]);
  });

  it("starts all homepage motion script requests without waiting for earlier scripts", () => {
    render(<InternationalHomeRuntime locale="en-US" markup="<main />" />);

    expect(document.querySelectorAll('script[data-lightvela-intl-home-script]')).toHaveLength(
      INTERNATIONAL_HOME_SCRIPT_SOURCES.length,
    );
  });

  it("rebinds homepage motion scripts when the active locale changes", async () => {
    const { rerender, unmount } = render(
      <InternationalHomeRuntime locale="ko-KR" markup='<main id="locale-ko" />' />,
    );

    await waitFor(() => {
      expect(document.querySelector('script[data-lightvela-intl-home-script]')).toHaveAttribute(
        "data-lightvela-intl-home-locale",
        "ko-KR",
      );
    });
    const koreanScript = document.querySelector('script[data-lightvela-intl-home-script]');

    rerender(<InternationalHomeRuntime locale="zh-Hant" markup='<main id="locale-hant" />' />);

    await waitFor(() => {
      expect(document.querySelector('script[data-lightvela-intl-home-script]')).toHaveAttribute(
        "data-lightvela-intl-home-locale",
        "zh-Hant",
      );
    });
    expect(koreanScript?.isConnected).toBe(false);

    unmount();
    expect(document.querySelectorAll('script[data-lightvela-intl-home-script]')).toHaveLength(0);
  });

  it("rebinds homepage motion scripts when imported markup changes in the same locale", async () => {
    const { rerender } = render(
      <InternationalHomeRuntime locale="zh-CN" markup='<main id="home-before" />' />,
    );
    const initialScript = document.querySelector('script[data-lightvela-intl-home-script]');

    rerender(<InternationalHomeRuntime locale="zh-CN" markup='<main id="home-after" />' />);

    await waitFor(() => {
      expect(document.querySelector("#home-after")).not.toBeNull();
      expect(initialScript?.isConnected).toBe(false);
    });
    expect(document.querySelector('script[data-lightvela-intl-home-script]')).not.toBe(initialScript);
  });

  it("preserves runtime-owned homepage DOM when unrelated state rerenders the wrapper", () => {
    const markup = '<main id="runtime-owned"><span id="hero-rotator">工作搭档</span></main>';
    const { rerender } = render(<InternationalHomeRuntime locale="zh-CN" markup={markup} />);
    const runtimeNode = document.querySelector("#hero-rotator");
    if (runtimeNode) runtimeNode.textContent = "开发搭子";

    rerender(<InternationalHomeRuntime locale="zh-CN" markup={markup} />);

    expect(document.querySelector("#hero-rotator")).toBe(runtimeNode);
    expect(document.querySelector("#hero-rotator")).toHaveTextContent("开发搭子");
  });

  it('mounts motion once, preserves it on unrelated renders and disposes it on locale changes', async () => {
    regionMock.isGlobal = true;
    const markup = '<main id="lightvela-intl-home"><h1>Home</h1></main>';
    const { rerender, unmount } = render(<InternationalHomeRuntime locale="en-US" markup={markup} />);
    await waitFor(() => expect(motionMocks.mount).toHaveBeenCalledTimes(1));
    rerender(<InternationalHomeRuntime locale="en-US" markup={markup} />);
    expect(motionMocks.mount).toHaveBeenCalledTimes(1);
    expect(motionMocks.dispose).not.toHaveBeenCalled();
    rerender(<InternationalHomeRuntime locale="es" markup={markup} />);
    await waitFor(() => expect(motionMocks.mount).toHaveBeenCalledTimes(2));
    expect(motionMocks.dispose).toHaveBeenCalledTimes(1);
    unmount();
    expect(motionMocks.dispose).toHaveBeenCalledTimes(2);
  });

  it('cancels deferred motion loading when the page unmounts before the next frame', async () => {
    regionMock.isGlobal = true;
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.push(callback); return 1; });
    const cancel = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const { unmount } = render(<InternationalHomeRuntime locale="en-US" markup='<main id="lightvela-intl-home" />' />);
    unmount();
    callbacks.forEach((callback) => callback(0));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cancel).toHaveBeenCalled();
    expect(motionMocks.mount).not.toHaveBeenCalled();
  });

  it("mounts the production header actions into the imported navigation", () => {
    const runtimeSource = readFileSync(
      path.join(frontendRoot, "next-site/international-home-runtime.tsx"),
      "utf8",
    );

    expect(runtimeSource).toContain("PublicHeaderAuthIsland");
    expect(runtimeSource).toContain("international-home-header-actions-layer");
    expect(runtimeSource).toContain("locale={locale}");
    expect(runtimeSource).toContain("script.dataset.lightvelaIntlHomeLocale = locale");
    expect(runtimeSource).toContain("script[data-lightvela-intl-home-script]");
    expect(runtimeSource).toContain("}, [locale, markup]);");
    expect(runtimeSource).toContain("loginOnly");
    expect(runtimeSource).toContain("showProductEntry");
    expect(runtimeSource).toContain("promoteFreeTrial");
    expect(runtimeSource).not.toContain("createPortal");
  });

  it("keeps the product entry out of the international homepage header", () => {
    (globalThis as { React?: typeof React }).React = React;
    regionMock.isGlobal = true;
    headerAuthMock.mockClear();

    renderToStaticMarkup(<InternationalHomePage locale="es" />);

    expect(headerAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: "es",
        loginOnly: true,
        promoteFreeTrial: false,
        showLanguageSwitcher: true,
        showProductEntry: false,
      }),
      undefined,
    );
  });

  it("keeps the domestic hero and shared header behavior unchanged", async () => {
    (globalThis as { React?: typeof React }).React = React;
    regionMock.isGlobal = false;
    sessionMock.authReady = true;
    sessionMock.isAuthenticated = false;
    openClawMock.bots = [];
    openClawMock.isSubscribed = false;
    openClawMock.refreshPasses.mockClear();
    headerAuthMock.mockClear();

    render(
      <InternationalHomeRuntime
        locale="zh-CN"
        markup={domesticHeroMarkup}
      />,
    );

    expect(headerAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: "zh-CN",
        loginOnly: true,
        promoteFreeTrial: false,
        showProductEntry: true,
      }),
      undefined,
    );
    await waitFor(() => {
      expect(document.querySelector("[data-domestic-home-hero-cta-label]")).toHaveTextContent("免费试用");
    });
    expect(document.querySelector("[data-domestic-home-hero-cta]")).toHaveAttribute("href", "/subscribe");
  });

  it("keeps the signed-in but unsubscribed hero CTA on the subscribe journey", async () => {
    (globalThis as { React?: typeof React }).React = React;
    regionMock.isGlobal = false;
    sessionMock.authReady = true;
    sessionMock.isAuthenticated = true;
    openClawMock.isSubscribed = false;
    openClawMock.bots = [];

    render(
      <InternationalHomeRuntime
        locale="zh-CN"
        markup={domesticHeroMarkup}
      />,
    );

    // 登录成功后未订阅 → 仍走 /subscribe，文案保持「免费试用」（issue #73 红线）
    await waitFor(() => {
      expect(document.querySelector("[data-domestic-home-hero-cta-label]")).toHaveTextContent("免费试用");
    });
    expect(document.querySelector("[data-domestic-home-hero-cta]")).toHaveAttribute("href", "/subscribe");
  });

  it.each([
    { locale: 'en-US', isolated: false, label: 'My AI Companion' },
    { locale: 'zh-CN', isolated: true, label: '我的智能体伙伴' },
  ] as const)('returns a signed-in account with a lapsed pass to Agents ($locale)', async ({ locale, isolated, label }) => {
    regionMock.isGlobal = locale === 'en-US';
    sessionMock.isAuthenticated = true;
    openClawMock.isSubscribed = false;
    openClawMock.latestPass = {
      pass_id: 'previous', user_id: 'user-1', bundle_id: 'launch', bundle_name: 'Launch',
      created_time: '2020-01-01', expired_time: '2020-02-01',
      isolated_time: isolated ? '2020-02-02' : null,
      credit_total: 0, credit_available: 0,
    };
    const markup = '<main id="lightvela-intl-home"><div class="hero__cta"><a href="/subscribe">Free trial</a></div><div class="cta__acts"><a href="/subscribe">Free trial</a></div><div class="foot__cta"><a href="/subscribe">Free trial</a></div></main>';

    render(<InternationalHomeRuntime locale={locale} markup={markup} />);

    for (const selector of ['.hero__cta a', '.cta__acts a', '.foot__cta a']) {
      await waitFor(() => expect(document.querySelector(selector)).toHaveTextContent(label));
      expect(document.querySelector(selector)).toHaveAttribute('href', '/agents');
    }
  });

  it("sends subscribed visitors from the hero CTA straight to the console", async () => {
    (globalThis as { React?: typeof React }).React = React;
    regionMock.isGlobal = false;
    sessionMock.authReady = true;
    sessionMock.isAuthenticated = true;
    openClawMock.isSubscribed = true;
    openClawMock.bots = [{ id: "bot-1" }];

    render(
      <InternationalHomeRuntime
        locale="zh-CN"
        markup={domesticHeroMarkup}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector("[data-domestic-home-hero-cta-label]")).toHaveTextContent("我的智能体伙伴");
    });
    expect(document.querySelector("[data-domestic-home-hero-cta]")).toHaveAttribute("href", "/agents");
  });

  it.each([
    [false, "zh-CN"], [true, "en-US"], [true, "zh-SG"], [true, "zh-Hant"],
    [true, "id-ID"], [true, "es"], [true, "ja-JP"], [true, "ko-KR"],
  ] as const)("opens first-bot creation from homepage CTAs (global=%s, locale=%s)", async (global, locale) => {
    regionMock.isGlobal = global;
    sessionMock.isAuthenticated = true;
    openClawMock.isSubscribed = true;
    openClawMock.bots = [];
    const markup = '<main id="lightvela-intl-home"><div class="hero__cta"><a class="btn-dark" href="/subscribe">Create</a></div><div class="cta__acts"><a class="btn-dark" href="/subscribe">Create</a></div></main>';

    render(<InternationalHomeRuntime locale={locale} markup={markup} />);

    for (const selector of [".hero__cta a", ".cta__acts a"]) {
      await waitFor(() => expect(document.querySelector(selector)).toHaveAttribute("href", "/agents?create=1"));
    }
  });

  it("sends anonymous CTA clicks straight to the subscribe page (plan A)", async () => {
    (globalThis as { React?: typeof React }).React = React;
    regionMock.isGlobal = false;
    sessionMock.authReady = true;
    sessionMock.isAuthenticated = false;

    render(
      <InternationalHomeRuntime
        locale="zh-CN"
        markup={domesticHeroMarkup}
      />,
    );

    const heroAction = await waitFor(() => {
      const anchor = document.querySelector<HTMLAnchorElement>("[data-domestic-home-hero-cta]");
      expect(anchor).not.toBeNull();
      return anchor as HTMLAnchorElement;
    });
    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    heroAction.dispatchEvent(clickEvent);

    // 方案 A：未登录点 CTA 不再拦截、直接按 href 进 /subscribe 看套餐（点“订阅”才在订阅页引导登录）
    expect(clickEvent.defaultPrevented).toBe(false);
    expect(heroAction).toHaveAttribute("href", "/subscribe");
  });

  // 片段里的官方译文优先于兜底文案表：新增语种 / 官方改译文都不需要改代码（issue #73 多语言红线）
  const localizedHomeMarkup = '<main id="lightvela-intl-home" data-locale="es"><div class="hero__cta"><a class="btn-dark" href="/agents">Mi amigo IA <span class="btn-dark__icon-bubble"><svg class="icon"></svg></span></a></div><div class="cta__acts"><a class="btn-dark" href="/subscribe">Probar gratis <svg class="icon"></svg></a></div></main>';

  it("takes the unsubscribed CTA copy from the localized fragment, not a hardcoded table", async () => {
    (globalThis as { React?: typeof React }).React = React;
    regionMock.isGlobal = false;
    sessionMock.authReady = true;
    sessionMock.isAuthenticated = false;
    openClawMock.isSubscribed = false;
    openClawMock.bots = [];

    render(<InternationalHomeRuntime locale="es" markup={localizedHomeMarkup} />);

    await waitFor(() => {
      expect(document.querySelector(".hero__cta a")).toHaveTextContent("Probar gratis");
    });
    expect(document.querySelector(".hero__cta a")).toHaveAttribute("href", "/subscribe");
    // 兜底表里的 "Empieza gratis" 不应出现，证明用的是片段译文
    expect(document.body.textContent).not.toContain("Empieza gratis");
  });

  it.each([
    { authenticated: false, subscribed: false, label: "免费试用", href: "/subscribe" },
    { authenticated: true, subscribed: false, label: "免费试用", href: "/subscribe" },
    { authenticated: true, subscribed: true, label: "我的智能体伙伴", href: "/agents" },
  ])("keeps the real domestic footer CTA consistent with its journey: $authenticated/$subscribed", async (state) => {
    regionMock.isGlobal = false;
    sessionMock.authReady = true;
    sessionMock.isAuthenticated = state.authenticated;
    openClawMock.isSubscribed = state.subscribed;
    openClawMock.bots = state.subscribed ? [{ id: "bot-1" }] : [];
    const markup = readFileSync(path.join(process.cwd(), "public/lightvela-intl-home/index-fragment.zh-CN.html"), "utf8");
    render(<InternationalHomeRuntime locale="zh-CN" markup={markup} />);
    await waitFor(() => {
      expect(document.querySelector(".foot__cta a")).toHaveTextContent(state.label);
      expect(document.querySelector(".foot__cta a")).toHaveAttribute("href", state.href);
    });
  });

  it("hides static My Agents hero and footer entries until entitlement-based CTA copy is ready", async () => {
    sessionMock.authReady = false;
    const markup = '<main id="lightvela-intl-home"><div class="hero__cta"><a href="/agents">我的智能体伙伴</a></div><div class="foot__cta"><a href="/agents">我的智能体伙伴</a></div></main>';
    const { rerender } = render(<InternationalHomeRuntime locale="zh-CN" markup={markup} />);
    const markupHost = document.querySelector("#lightvela-intl-home")?.parentElement?.parentElement;
    expect(markupHost).toHaveClass("[&_.hero__cta]:invisible", "[&_.foot__cta]:invisible");

    sessionMock.authReady = true;
    rerender(<InternationalHomeRuntime locale="zh-CN" markup={markup} />);
    await waitFor(() => {
      expect(document.querySelector(".foot__cta a")).toHaveTextContent("免费试用");
      expect(document.querySelector(".foot__cta a")).toHaveAttribute("href", "/subscribe");
      expect(document.querySelector(".hero__cta a")).toHaveTextContent("免费试用");
      expect(document.querySelector(".hero__cta a")).toHaveAttribute("href", "/subscribe");
      expect(markupHost).not.toHaveClass("[&_.hero__cta]:invisible", "[&_.foot__cta]:invisible");
    });
  });

  it("keeps the international hero and footer hidden until subscription status is confirmed", async () => {
    sessionMock.authReady = true;
    sessionMock.isAuthenticated = true;
    openClawMock.hasResolvedPasses = false;
    const markup = '<main id="lightvela-intl-home"><div class="hero__cta"><a href="/agents">我的智能体伙伴</a></div><div class="foot__cta"><a href="/agents">我的智能体伙伴</a></div></main>';
    const { rerender } = render(<InternationalHomeRuntime locale="zh-CN" markup={markup} />);
    const markupHost = document.querySelector("#lightvela-intl-home")?.parentElement?.parentElement;
    expect(markupHost).toHaveClass("[&_.hero__cta]:invisible", "[&_.foot__cta]:invisible");

    openClawMock.hasResolvedPasses = true;
    rerender(<InternationalHomeRuntime locale="zh-CN" markup={markup} />);
    await waitFor(() => expect(markupHost).not.toHaveClass("[&_.hero__cta]:invisible"));
    expect(document.querySelector(".hero__cta a")).toHaveTextContent("免费试用");
    expect(document.querySelector(".foot__cta a")).toHaveAttribute("href", "/subscribe");
  });

  it("takes the subscribed CTA copy from the localized fragment as well", async () => {
    (globalThis as { React?: typeof React }).React = React;
    regionMock.isGlobal = false;
    sessionMock.authReady = true;
    sessionMock.isAuthenticated = true;
    openClawMock.isSubscribed = true;
    openClawMock.bots = [{ id: "bot-1" }];

    render(<InternationalHomeRuntime locale="es" markup={localizedHomeMarkup} />);

    await waitFor(() => {
      expect(document.querySelector(".hero__cta a")).toHaveTextContent("Mi amigo IA");
    });
    expect(document.querySelector(".hero__cta a")).toHaveAttribute("href", "/agents");
    expect(document.body.textContent).not.toContain("Mi compañero de IA");
  });

  it("keeps the global zh-CN runtime on the international login-only treatment", () => {
    (globalThis as { React?: typeof React }).React = React;
    regionMock.isGlobal = true;
    headerAuthMock.mockClear();

    renderToStaticMarkup(<InternationalHomeRuntime locale="zh-CN" markup="<main />" />);

    expect(headerAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: "zh-CN",
        loginOnly: true,
        promoteFreeTrial: false,
      }),
      undefined,
    );
  });

  it("keeps the root route on V2 without importing the legacy homepage client barrel", () => {
    const rootRoute = readFileSync(path.join(frontendRoot, "src/app/(site)/page.next.tsx"), "utf8");

    expect(rootRoute).toContain("InternationalHomePage");
    expect(rootRoute).not.toContain("PublicHomePage");
    expect(rootRoute).not.toContain("shouldUseInternationalV2Home");
  });

  it("keeps the localized route fallback for locales that are not on V2", () => {
    const localizedRoute = readFileSync(
      path.join(frontendRoot, "src/app/(site)/[lang]/page.intl.tsx"),
      "utf8",
    );

    expect(localizedRoute).toContain("shouldUseInternationalV2Home");
    expect(localizedRoute).toContain("InternationalHomePage");
    expect(localizedRoute).toContain("PublicHomePage");
  });
});
