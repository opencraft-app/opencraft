import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const headerAuthMock = vi.hoisted(() => vi.fn(() => null));
vi.mock("@next-site/public-header-auth-island", () => ({ PublicHeaderAuthIsland: headerAuthMock }));

import { InternationalHomePage } from "@next-site/international-home-page";
import {
  INTERNATIONAL_HOME_SCRIPT_SOURCES,
  InternationalHomeRuntime,
} from "@next-site/international-home-runtime";

const frontendRoot = process.cwd();

describe("international v2 homepage rendering", () => {
  it("server-renders the approved homepage content and stylesheet", () => {
    (globalThis as { React?: typeof React }).React = React;
    const markup = renderToStaticMarkup(<InternationalHomePage locale="en-US" />);

    expect(markup).toContain('href="/lightvela-intl-home/style.css?v=20260901-remote-7127eb5-id-headings"');
    expect(markup).toContain('id="lightvela-intl-home"');
    expect(markup).toContain("Your AI companion, always here, always evolving with you");
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
  });

  it("loads only the approved homepage motion scripts", () => {
    expect(INTERNATIONAL_HOME_SCRIPT_SOURCES).toEqual([
      "/lightvela-intl-home/runtime.js",
      "/lightvela-intl-home/hero-chat.js",
      "/lightvela-intl-home/scene-wheel.js",
    ]);
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
    expect(runtimeSource).not.toContain("promoteFreeTrial");
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
        showLanguageSwitcher: true,
      }),
      undefined,
    );
  });

  it("routes both root and localized homepages through the international-only selector", () => {
    const rootRoute = readFileSync(path.join(frontendRoot, "src/app/(site)/page.next.tsx"), "utf8");
    const localizedRoute = readFileSync(
      path.join(frontendRoot, "src/app/(site)/[lang]/page.intl.tsx"),
      "utf8",
    );

    for (const routeSource of [rootRoute, localizedRoute]) {
      expect(routeSource).toContain("shouldUseInternationalV2Home");
      expect(routeSource).toContain("InternationalHomePage");
      expect(routeSource).toContain("PublicHomePage");
    }
  });
});
