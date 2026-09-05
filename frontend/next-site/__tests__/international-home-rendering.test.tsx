import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const headerAuthMock = vi.hoisted(() => vi.fn(() => null));
const regionMock = vi.hoisted(() => ({ isGlobal: false }));
const sessionMock = vi.hoisted(() => ({ authReady: true, isAuthenticated: false }));
vi.mock("@next-site/public-header-auth-island", () => ({ PublicHeaderAuthIsland: headerAuthMock }));
vi.mock("@/contexts/session-context", () => ({
  useSession: () => sessionMock,
}));
vi.mock("@/lib/region", () => ({
  get isGlobal() {
    return regionMock.isGlobal;
  },
}));

import { InternationalHomePage } from "@next-site/international-home-page";
import {
  INTERNATIONAL_HOME_SCRIPT_SOURCES,
  InternationalHomeRuntime,
} from "@next-site/international-home-runtime";

const frontendRoot = process.cwd();
const domesticHeroMarkup = '<main id="lightvela-intl-home" data-locale="zh-CN"><div class="hero__cta"><a data-domestic-home-hero-cta class="btn-dark" href="/subscribe"><span data-domestic-home-hero-cta-label>免费试用</span></a></div></main>';

beforeEach(() => {
  regionMock.isGlobal = false;
  sessionMock.authReady = true;
  sessionMock.isAuthenticated = false;
});

afterEach(() => {
  cleanup();
});

describe("international v2 homepage rendering", () => {
  it("server-renders the approved homepage content and stylesheet", () => {
    (globalThis as { React?: typeof React }).React = React;
    const markup = renderToStaticMarkup(<InternationalHomePage locale="en-US" />);

    expect(markup).toContain('href="/lightvela-intl-home/style.css?v=20260903-home-mobile-fit"');
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
      'src="/lightvela-intl-home/assets/deepseek-harness-zh-sg.webp?v=20260904-harness-sharp"',
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
    expect(runtimeSource).toContain("}, [locale]);");
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

  it("restores the domestic anonymous header and hero free-trial actions", async () => {
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
        loginOnly: false,
        promoteFreeTrial: true,
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
