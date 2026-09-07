import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const headerAuthMock = vi.hoisted(() => vi.fn(() => null));
const regionMock = vi.hoisted(() => ({ isGlobal: false }));
const sessionMock = vi.hoisted(() => ({ authReady: true, isAuthenticated: false }));
vi.mock("@next-site/public-header-auth-island", () => ({ PublicHeaderAuthIsland: headerAuthMock }));
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
  INTERNATIONAL_HOME_SCRIPT_SOURCES,
  InternationalHomeRuntime,
} from "@next-site/international-home-runtime";

const frontendRoot = process.cwd();
const domesticHeroMarkup = '<main id="lightvela-intl-home" data-locale="zh-CN"><div class="hero__cta"><a data-domestic-home-hero-cta class="btn-dark" href="/subscribe"><span data-domestic-home-hero-cta-label>免费试用</span></a></div></main>';

beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  regionMock.isGlobal = false;
  sessionMock.authReady = true;
  sessionMock.isAuthenticated = false;
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
  it("server-renders the approved homepage content and stylesheet", () => {
    (globalThis as { React?: typeof React }).React = React;
    const markup = renderToStaticMarkup(<InternationalHomePage locale="en-US" />);

    expect(markup).toContain('href="/lightvela-intl-home/style.css?v=20260907-home-refinements-v13"');
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

  it("passes the active homepage locale into the production header actions", () => {
    (globalThis as { React?: typeof React }).React = React;
    headerAuthMock.mockClear();

    renderToStaticMarkup(<InternationalHomePage locale="es" />);

    expect(headerAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: "es",
        loginOnly: true,
        promoteFreeTrial: false,
        showLanguageSwitcher: true,
        showProductEntry: true,
      }),
      undefined,
    );
  });

  it("keeps domestic free trial in the hero and uses the shared login-only header", async () => {
    (globalThis as { React?: typeof React }).React = React;
    regionMock.isGlobal = false;
    sessionMock.authReady = true;
    sessionMock.isAuthenticated = false;
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

  it("switches the domestic hero action to the signed-in product entry", async () => {
    (globalThis as { React?: typeof React }).React = React;
    regionMock.isGlobal = false;
    sessionMock.authReady = true;
    sessionMock.isAuthenticated = true;

    render(
      <InternationalHomeRuntime
        locale="zh-CN"
        markup={domesticHeroMarkup}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector("[data-domestic-home-hero-cta-label]")).toHaveTextContent("开始使用");
    });
    expect(document.querySelector("[data-domestic-home-hero-cta]")).toHaveAttribute("href", "/agents");
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
