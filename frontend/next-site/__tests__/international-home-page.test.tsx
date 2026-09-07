import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { shouldUseInternationalV2Home } from "@next-site/international-home-routing";

const publicRoot = path.resolve(process.cwd(), "public");
const homeRoot = path.join(publicRoot, "lightvela-intl-home");
const fragmentPath = path.join(homeRoot, "index-fragment.html");
const stylesheetPath = path.join(homeRoot, "style.css");
const runtimePath = path.join(homeRoot, "runtime.js");
const domesticHomeScope = String.raw`#lightvela-intl-home\[data-locale="zh-CN"\]`;
const publishedInternationalLocales = ["en-US", "zh-SG", "zh-Hant", "id-ID", "es", "ja-JP", "ko-KR"] as const;
const generatedFragmentNames = [
  "index-fragment.html",
  "index-fragment.en-US.html",
  "index-fragment.zh-CN.html",
  "index-fragment.zh-SG.html",
  "index-fragment.zh-Hant.html",
  "index-fragment.id-ID.html",
  "index-fragment.es.html",
  "index-fragment.ja-JP.html",
  "index-fragment.ko-KR.html",
] as const;

const requiredInternalRoutes = [
  "/",
  "/about",
  "/agents",
  "/agents/automations",
  "/agents/files",
  "/agents/labs/deepseek-harness",
  "/agents/websites/",
  "/changelog",
  "/docs/configuration/channel-discord",
  "/docs/configuration/channel-telegram",
  "/docs/configuration/channel-whatsapp",
  "/docs/overview",
  "/docs/compare/lightvela-vs-chatgpt",
  "/docs/compare/lightvela-vs-genspark",
  "/docs/compare/lightvela-vs-hostinger",
  "/docs/compare/lightvela-vs-localhost-ai-agent",
  "/docs/compare/lightvela-vs-manus",
  "/open-source-licenses",
  "/privacy-policy",
  "/subscribe",
  "/terms-of-service",
] as const;

const requiredExternalRoutes = [
  "https://chat.whatsapp.com/KLF9OvdAj4sDdojG20JA9b",
  "https://discord.gg/Myh58xEMe2",
  "https://www.youtube.com/@TencentLightVela",
  "https://x.com/agentlightvela",
] as const;

function readFragment(): string {
  return readFileSync(fragmentPath, "utf8");
}

function readLocaleFragment(locale: (typeof publishedInternationalLocales)[number]): string {
  return readFileSync(path.join(homeRoot, `index-fragment.${locale}.html`), "utf8");
}

function parseFragment(): Document {
  return new DOMParser().parseFromString(readFragment(), "text/html");
}

function domesticHeroRule(selectorPattern: string, declarationPattern: string): RegExp {
  const scopedSelectorPattern = selectorPattern.replace(
    /\\\.hero__frame/g,
    `${domesticHomeScope} \\.hero__frame`,
  );
  return new RegExp(`${scopedSelectorPattern}\\s*\\{[^}]*${declarationPattern}`, "s");
}

describe("international v2 homepage selection", () => {
  it("uses the new homepage for published global homepage locales only", () => {
    for (const locale of publishedInternationalLocales) {
      expect(shouldUseInternationalV2Home(true, locale)).toBe(true);
    }
    expect(shouldUseInternationalV2Home(false, "en-US")).toBe(false);
    expect(shouldUseInternationalV2Home(true, "zh-CN")).toBe(false);
  });

  it("uses the adapted zh-CN v2 homepage for the domestic root page", () => {
    expect(shouldUseInternationalV2Home(false, "zh-CN")).toBe(true);
  });
});

describe("international v2 homepage artifact", () => {
  it("keeps the domestic zh-CN homepage fragment on domestic routes and channels", () => {
    const html = readFileSync(path.join(homeRoot, "index-fragment.zh-CN.html"), "utf8");
    const document = new DOMParser().parseFromString(html, "text/html");
    const hrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"), (anchor) =>
      anchor.getAttribute("href") ?? "",
    );
    const tabLabels = Array.from(document.querySelectorAll(".hero__tabs label"), (label) =>
      label.textContent?.trim() ?? "",
    );
    const footerText = document.querySelector(".foot")?.textContent ?? "";
    const footerColumns = Array.from(document.querySelectorAll(".foot__links-grid h3"), (heading) => ({
      heading: heading.textContent?.trim() ?? "",
      links: Array.from(
        heading.closest("div")?.querySelectorAll("a") ?? [],
        (anchor) => anchor.textContent?.trim() ?? "",
      ),
    }));
    const brand = document.querySelector(".foot__brand");
    const wechatPanelText = document.querySelector("#panel-wa")?.textContent ?? "";
    const qqPanelText = document.querySelector("#panel-qq")?.textContent ?? "";
    const wecomPanelText = document.querySelector("#panel-tg")?.textContent ?? "";
    const dingtalkPanelText = document.querySelector("#panel-dc")?.textContent ?? "";
    const feishuPanelText = document.querySelector("#panel-sl")?.textContent ?? "";
    const heroDemoMarkup = document.querySelector(".hero__stage")?.outerHTML ?? "";
    const css = readFileSync(stylesheetPath, "utf8");
    const domesticHomepageMarkupAndStyles = `${html}\n${css}`;

    expect(hrefs).toContain("/");
    expect(hrefs).toContain("/subscribe");
    expect(hrefs).toContain("/docs/overview");
    expect(hrefs).toContain("/docs/core-concepts");
    expect(hrefs).toContain("https://privacy.qq.com/document/preview/a955b796edc34796b6e81d4f4df006f3");
    expect(hrefs).toContain("https://cloud.tencent.com/document/product/301/48034");
    expect(hrefs).toContain("https://wj.qq.com/s2/27184784/6d06/");
    expect(hrefs).toContain("https://beian.miit.gov.cn/#/Integrated/index");
    expect(hrefs.every((href) => !href.startsWith("/zh-cn"))).toBe(true);
    expect(document.querySelector(".hero__cta .btn-dark")?.textContent).toContain("免费试用");
    expect(document.querySelector(".hero__cta .btn-dark")?.getAttribute("href")).toBe("/subscribe");
    expect(document.querySelector("[data-domestic-home-hero-cta-label]")?.textContent).toBe("免费试用");
    expect(tabLabels).toEqual(["微信", "QQ", "企业微信", "钉钉", "飞书"]);
    expect(document.querySelector(".wcard__thumb--1 img")?.getAttribute("alt")).toBe(
      "微信、企业微信、钉钉、飞书、QQ 等当前支持的平台",
    );
    expect(document.querySelector("#panel-wa .native--wa")).not.toBeNull();
    expect(document.querySelector("#panel-qq .native--qq")).not.toBeNull();
    expect(document.querySelector("#panel-tg .native--wecom")).not.toBeNull();
    expect(document.querySelector("#panel-dc .dc--dingtalk")).not.toBeNull();
    expect(document.querySelector("#panel-sl .dc--feishu")).not.toBeNull();
    expect(document.querySelectorAll(".hero__frame .native__rail, .hero__frame .dc__rail")).toHaveLength(0);
    expect(document.querySelector("#panel-wa .native__side-head")).toBeNull();
    expect(document.querySelector("#panel-qq .native__side-head")).toBeNull();
    expect(document.querySelector("#panel-wa .native__filters")).toBeNull();
    expect(document.querySelector("#panel-wa .native__side-searchbar")?.textContent).toContain("搜索");
    expect(document.querySelector("#panel-qq .native__side-searchbar")?.textContent).toContain("搜索");
    expect(document.querySelector("#panel-tg .native__side-searchbar")?.textContent).toContain("搜索");
    expect(document.querySelector("#panel-wa .native__side-add")?.getAttribute("aria-label")).toBe("新建");
    expect(document.querySelector("#panel-qq .native__side-add")?.getAttribute("aria-label")).toBe("新建");
    expect(document.querySelector("#panel-tg .native__side-add")?.getAttribute("aria-label")).toBe("新建");
    expect(document.querySelector("#panel-tg .native__search--top")).toBeNull();
    expect(document.querySelectorAll(".hero__frame .dc__members")).toHaveLength(0);
    for (const panelId of ["panel-wa", "panel-qq", "panel-tg"]) {
      expect(document.querySelector(`#${panelId} .bub--me`)).not.toBeNull();
    }
    for (const panelId of ["panel-dc", "panel-sl"]) {
      expect(document.querySelector(`#${panelId} .dc__msg--me`)).not.toBeNull();
    }
    expect(document.querySelector("#panel-dc .dingtalk__titlebar")?.textContent).toContain("学习");
    expect(document.querySelector("#panel-dc .dingtalk__search")?.textContent).toContain("搜索");
    expect(css).not.toContain("#0d83f2");
    expect(css).toMatch(
      domesticHeroRule(
        String.raw`\.hero__frame #panel-dc \.dingtalk__titlebar`,
        String.raw`background:\s*var\(--paper-3\)`,
      ),
    );
    expect(css).toMatch(
      domesticHeroRule(
        String.raw`\.hero__frame #panel-wa \.native__side,\s*\.hero__frame #panel-tg \.native__side`,
        String.raw`width:\s*184px`,
      ),
    );
    expect(css).toMatch(
      domesticHeroRule(String.raw`\.hero__frame #panel-qq \.native__side`, String.raw`width:\s*152px`),
    );
    expect(css).toMatch(
      domesticHeroRule(
        String.raw`\.hero__frame #panel-wa \.native__side,\s*\.hero__frame #panel-tg \.native__side`,
        String.raw`background:\s*#f9f9fa`,
      ),
    );
    expect(css).toMatch(
      domesticHeroRule(
        String.raw`\.hero__frame #panel-qq \.native__side`,
        String.raw`background:\s*#f6f6f7`,
      ),
    );
    expect(css).toMatch(
      domesticHeroRule(String.raw`\.hero__frame #panel-qq \.native__head`, String.raw`height:\s*46px`),
    );
    expect(css).toMatch(
      domesticHeroRule(
        String.raw`\.hero__frame #panel-wa \.native__thread,\s*\.hero__frame #panel-qq \.native__thread`,
        String.raw`margin:\s*0`,
      ),
    );
    expect(css).toMatch(
      domesticHeroRule(
        String.raw`\.hero__frame #panel-wa \.native__thread,\s*\.hero__frame #panel-qq \.native__thread`,
        String.raw`padding:\s*0`,
      ),
    );
    expect(css).not.toMatch(/#panel-qq \.native__thread\s*\{[^}]*margin-left:\s*clamp/s);
    expect(css).not.toMatch(/#panel-wa \.native__thread\s*\{[^}]*padding-left:\s*clamp/s);
    expect(css).toMatch(
      domesticHeroRule(String.raw`\.hero__frame #panel-dc \.dingtalk__titlebar`, String.raw`height:\s*24px`),
    );
    expect(css).toMatch(
      domesticHeroRule(
        String.raw`\.hero__frame #panel-dc \.dingtalk__app`,
        String.raw`color:\s*var\(--ink-60\)`,
      ),
    );
    expect(css).toMatch(
      domesticHeroRule(
        String.raw`\.hero__frame #panel-dc \.dingtalk__search`,
        String.raw`color:\s*var\(--ink-35\)`,
      ),
    );
    expect(css).toMatch(
      domesticHeroRule(String.raw`\.hero__frame #panel-sl \.dc__side-ws b`, String.raw`font-size:\s*12px`),
    );
    expect(document.querySelector("#panel-sl .dc__side-ws")?.textContent?.trim()).toBe("消息");
    expect(wechatPanelText).toContain("纳斯达克热门板块速览");
    expect(qqPanelText).toContain("QQ IM 助手");
    expect(qqPanelText).toContain("周五夜间竞技赛提醒");
    expect(qqPanelText).toContain("那开赛前再提醒我们一次");
    expect(document.querySelector('#panel-qq .bub--me p[data-full-html="那开赛前再提醒我们一次。"]')).not.toBeNull();
    expect(css).toMatch(
      domesticHeroRule(String.raw`\.hero__frame #panel-wa \.bub--me`, String.raw`justify-content:\s*flex-end`),
    );
    expect(css).toMatch(
      domesticHeroRule(String.raw`\.hero__frame #panel-qq \.bub--me`, String.raw`justify-content:\s*flex-end`),
    );
    expect(css).toMatch(
      domesticHeroRule(String.raw`\.hero__frame #panel-tg \.bub--me`, String.raw`justify-content:\s*flex-end`),
    );
    expect(css).toMatch(
      domesticHeroRule(
        String.raw`\.hero__frame #panel-dc \.dc__msg--me,\s*\.hero__frame #panel-sl \.dc__msg--me`,
        String.raw`justify-content:\s*flex-end`,
      ),
    );
    expect(wecomPanelText).toContain("@LightVela 翻一下最近一周的讨论");
    expect(wecomPanelText).toContain("最卡的是定价页文案");
    expect(dingtalkPanelText).toContain("订单和服务异常");
    expect(dingtalkPanelText).toContain("订单延迟正在扩大");
    expect(dingtalkPanelText).toContain("print-queue-error.log");
    expect(dingtalkPanelText).toContain("先通知店员用 Windows 打印");
    expect(dingtalkPanelText).toContain("已通知门店");
    expect(dingtalkPanelText).toContain("我会每 15 分钟复查一次");
    expect(dingtalkPanelText).not.toContain("定价页改版纪要");
    expect(css).toMatch(
      domesticHeroRule(
        String.raw`\.hero__frame #panel-dc \.dc__msg--me > div,\s*\.hero__frame #panel-dc \.dc__msg--me > div > p`,
        String.raw`color:\s*#202124 !important`,
      ),
    );
    expect(feishuPanelText).toContain("DSH 已经在隔离分支复现");
    expect(qqPanelText).not.toContain("Discord");
    expect(wecomPanelText).not.toContain("Telegram");
    expect(dingtalkPanelText).not.toContain("Discord");
    expect(feishuPanelText).not.toContain("Slack");
    expect(css).not.toContain("Domestic hero channel skins");
    expect(domesticHomepageMarkupAndStyles).not.toMatch(
      /#(?:2f7dff|1677ff|3370ff|155bd4|1f5bd8|1d4fd7|d8edff|dfeaff|e8f2ff|f5f1ff|f7f4ff)/i,
    );
    expect(domesticHomepageMarkupAndStyles).not.toContain("rgba(106, 79, 222, 0.1)");
    expect(heroDemoMarkup).not.toMatch(/#(?:25d366|21a366|00a884|d1f4cc|e7f5ee|f0f7f4)/i);
    expect(css).toMatch(
      domesticHeroRule(
        String.raw`\.hero__frame \.native__head \.peer \.av-c,\s*\.hero__frame \.chat-row \.av-c,\s*\.hero__frame \.bub > \.av-c,\s*\.hero__frame \.dc__msg > \.av-c,\s*\.hero__frame \.dc__me`,
        String.raw`display:\s*none`,
      ),
    );
    expect(css).toMatch(
      domesticHeroRule(
        String.raw`\.hero__frame \.bub__box,\s*\.hero__frame \.dc__msg > div`,
        String.raw`background:\s*#fff`,
      ),
    );
    expect(css).toMatch(
      domesticHeroRule(
        String.raw`\.hero__frame \.bub--me \.bub__box,\s*\.hero__frame \.dc__msg--me > div`,
        String.raw`background:\s*#f7f7f8`,
      ),
    );
    expect(css).toMatch(
      domesticHeroRule(
        String.raw`\.hero__frame \.bub--ai \.bub__name,\s*\.hero__frame \.dc__bot b,\s*\.hero__frame \.hero-live-reply-name`,
        String.raw`color:\s*var\(--brand\)`,
      ),
    );
    expect(css).not.toContain(".hero__frame .av-c {\n  display: flex !important;");
    expect(brand?.querySelector<HTMLImageElement>("img")?.getAttribute("src")).toBe("/lightvela-logo.svg");
    expect(brand?.textContent).toContain("Copyright © 2026 LightVela 版权所有 · 腾讯轻量云出品");
    expect(brand?.textContent).toContain("京ICP备11018762号-1137");
    expect(brand?.querySelector<HTMLAnchorElement>(".foot__icp")?.getAttribute("href")).toBe(
      "https://beian.miit.gov.cn/#/Integrated/index",
    );
    expect(footerColumns).toEqual([
      {
        heading: "产品",
        links: [
          "免费试用",
          "产品定价",
          "接入微信指引",
          "接入飞书指引",
          "接入 QQ 指引",
          "接入企微指引",
          "接入钉钉指引",
        ],
      },
      {
        heading: "对比",
        links: ["与本地部署对比", "与 Manus 对比", "与 AI Chatbot 对比"],
      },
      {
        heading: "社区",
        links: ["加入交流群"],
      },
      {
        heading: "公司",
        links: ["关于我们", "帮助与反馈", "隐私政策", "服务条款"],
      },
    ]);
    expect(
      document
        .querySelector<HTMLAnchorElement>('.foot__links-grid a[href="/docs/compare/lightvela-vs-ai-chatbot"]')
        ?.textContent?.trim(),
    ).toBe("与 AI Chatbot 对比");
    expect(document.querySelector(".foot__bottom")).toBeNull();
    expect(footerText).not.toContain("Copyright © 2026 LightVela 版权所有，腾讯轻量云出品");
    expect(document.querySelector<HTMLAnchorElement>(".foot__icp")?.textContent).toBe("京ICP备11018762号-1137");
    expect(css).toMatch(
      /#lightvela-intl-home \.foot--domestic \.foot__links\s*\{[^}]*max-width:\s*min\(1380px,\s*calc\(100vw - 96px\)\)/s,
    );
    expect(css).toMatch(
      /#lightvela-intl-home \.foot--domestic \.foot__brand\s*\{[^}]*gap:\s*12px/s,
    );
    expect(css).toMatch(
      /#lightvela-intl-home \.foot--domestic \.foot__brand-link img\s*\{[^}]*width:\s*112px/s,
    );
    expect(css).toMatch(
      /#lightvela-intl-home \.foot--domestic \.foot__brand-copy\s*\{[^}]*max-width:\s*320px[^}]*font-size:\s*12px[^}]*line-height:\s*1\.7[^}]*color:\s*rgba\(23,\s*21,\s*26,\s*0\.42\)/s,
    );
    expect(css).toMatch(
      /#lightvela-intl-home \.foot--domestic \.foot__brand-copy \.foot__icp\s*\{[^}]*display:\s*inline-block[^}]*margin-top:\s*6px[^}]*font:\s*inherit[^}]*color:\s*inherit/s,
    );
    expect(css).toMatch(
      /#lightvela-intl-home \.foot--domestic \.foot__links h3\s*\{[^}]*font-size:\s*14px/s,
    );
    expect(css).toMatch(
      /#lightvela-intl-home \.foot--domestic \.foot__links a\s*\{[^}]*font-size:\s*14px/s,
    );
    expect(footerText).not.toContain("Discord");
    expect(footerText).not.toContain("WhatsApp");
    expect(footerText).not.toContain("X / Twitter");
    expect(footerText).not.toContain("YouTube");
    expect(footerText).not.toContain("博客");
    expect(footerText).not.toContain("Hostinger");
    expect(footerText).not.toContain("Genspark");
    expect(footerText).not.toContain("开源声明");
    expect(footerText).not.toContain("相关产品");
  });

  it("scopes domestic IM chrome overrides away from published international fragments", () => {
    const css = readFileSync(stylesheetPath, "utf8");
    const globalDocument = new DOMParser().parseFromString(readLocaleFragment("en-US"), "text/html");

    expect(globalDocument.querySelector("#lightvela-intl-home")?.getAttribute("data-locale")).toBe("en-US");
    expect(globalDocument.querySelector(".hero__frame .native__rail")).not.toBeNull();
    expect(globalDocument.querySelector(".hero__frame .dc__rail")).not.toBeNull();
    expect(css).toMatch(
      new RegExp(
        `${domesticHomeScope} \\.hero__frame \\.native__rail,\\s*` +
          `${domesticHomeScope} \\.hero__frame \\.dc__rail\\s*\\{[^}]*display:\\s*none`,
        "s",
      ),
    );
    expect(css).toMatch(
      new RegExp(
        `${domesticHomeScope} \\.hero__frame \\.native__head \\.peer \\.av-c,\\s*` +
          `${domesticHomeScope} \\.hero__frame \\.chat-row \\.av-c,\\s*` +
          `${domesticHomeScope} \\.hero__frame \\.bub > \\.av-c,\\s*` +
          `${domesticHomeScope} \\.hero__frame \\.dc__msg > \\.av-c,\\s*` +
          `${domesticHomeScope} \\.hero__frame \\.dc__me\\s*\\{[^}]*display:\\s*none`,
        "s",
      ),
    );
    expect(css).not.toMatch(
      /(?:^|\n)\.hero__frame \.native__rail,\s*\.hero__frame \.dc__rail\s*\{[^}]*display:\s*none/s,
    );
    expect(css).not.toMatch(
      /(?:^|\n)\.hero__frame \.native__head \.peer \.av-c,\s*\.hero__frame \.chat-row \.av-c,\s*\.hero__frame \.bub > \.av-c,\s*\.hero__frame \.dc__msg > \.av-c,\s*\.hero__frame \.dc__me\s*\{[^}]*display:\s*none/s,
    );
  });

  it("contains a script-free fragment with only resolved links and resources", () => {
    const html = readFragment();
    const document = parseFragment();

    expect(document.querySelector("script")).toBeNull();
    expect(html).not.toMatch(/href=["']#["']/);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/(?:href|src)=["'][^"']+\.html(?:[?#][^"']*)?["']/i);
    expect(html).not.toMatch(/(?:src|poster)=["']assets\//);

    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
    expect(anchors.length).toBeGreaterThan(20);
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") ?? "";
      expect(href.startsWith("/") || href.startsWith("https://")).toBe(true);
      if (href.startsWith("https://")) {
        expect(anchor.getAttribute("target")).toBe("_blank");
        expect(anchor.getAttribute("rel")?.split(/\s+/)).toContain("noreferrer");
      }
    }
  });

  it("keeps generated avatar and scene-button fixes in the homepage importer", () => {
    const importer = readFileSync(
      path.join(process.cwd(), "scripts/import-international-homepage.mjs"),
      "utf8",
    );

    expect(importer).toContain("optimizeInternationalHomeVoiceAvatars(targetRoot)");
    expect(importer).toContain("initializeInternationalHomeFragmentAccessibility(targetRoot)");
    expect(importer).toContain("btn.setAttribute('aria-pressed', i === active ? 'true' : 'false');");
    expect(importer).toContain("btn.addEventListener('click', activate);");
    expect(importer).toContain("btn.addEventListener('keydown', activateFromKeyboard);");
    expect(importer).toContain("Unable to add accessible activation to homepage scene buttons");
    expect(importer).toContain("Your AI companion—always on, always evolving with you.");
    expect(importer).not.toContain("Your AI companion, always here, always evolving with you");
  });

  it("connects the approved homepage navigation to production destinations", () => {
    const hrefs = Array.from(parseFragment().querySelectorAll<HTMLAnchorElement>("a[href]"), (anchor) =>
      anchor.getAttribute("href"),
    );

    for (const href of requiredInternalRoutes) expect(hrefs).toContain(href);
    for (const href of requiredExternalRoutes) expect(hrefs).toContain(href);
  });

  it("ships localized fragments for each published international homepage locale", () => {
    const expectedCopy = {
      "en-US": "Your AI companion—always on, always evolving with you.",
      "zh-SG": "越用越懂你，长期在线的 AI 伙伴",
      "zh-Hant": "越用越懂你，長期在線的 AI 夥伴",
      "id-ID": "Semakin sering dipakai, semakin memahami kamu, mitra AI yang selalu aktif",
      es: "Cuanto más lo uses, mejor te entenderá, tu compañero de IA siempre en línea",
      "ja-JP": "使うほどあなたを理解する、ずっとオンラインのAIパートナー",
      "ko-KR": "쓸수록 나를 더 잘 이해하는, 늘 온라인인 AI 파트너",
    } as const;
    const expectedAlwaysOnCopy = {
      "en-US": "I stay available 24/7 in the cloud, so you never need to leave your computer running. Whenever you correct me, I turn your feedback into a new rule and apply it next time.",
      "zh-SG": "云端 7×24 小时在线",
      "zh-Hant": "雲端 7×24 小時在線",
      "id-ID": "di cloud dan tersedia 24/7",
      es: "en la nube y estoy disponible 24/7",
      "ja-JP": "クラウドで24時間365日稼働する",
      "ko-KR": "클라우드에서 24시간 연중무휴로 실행",
    } as const;
    const expectedCardAssets = {
      "en-US": ["wcard-apps-en.png", "wcard-folder-en.webp", "wcard-hub-v3-en.webp"],
      "zh-SG": ["wcard-apps-zh-Hans.png", "wcard-folder-zh-Hans.webp", "wcard-hub-v3-zh-Hans.webp"],
      "zh-Hant": ["wcard-apps-zh-Hant.png", "wcard-folder-zh-Hant.webp", "wcard-hub-v3-zh-Hant.webp"],
      "id-ID": ["wcard-apps-id.png", "wcard-folder-id.webp", "wcard-hub-v3-id.webp"],
      es: ["wcard-apps-es.png", "wcard-folder-es.webp", "wcard-hub-v3-es.webp"],
      "ja-JP": ["wcard-apps-ja.png", "wcard-folder-ja.webp", "wcard-hub-v3-ja.webp"],
      "ko-KR": ["wcard-apps-ko.png", "wcard-folder-ko.webp", "wcard-hub-v3-ko.webp"],
    } as const;
    const expectedProductPanelAssets = {
      "en-US": ["automation-templates-panel-en.png", "workbench-panel-en.png"],
      "zh-SG": ["automation-screenshot.png", "workbench-screenshot.png"],
      "zh-Hant": ["automation-screenshot.png", "workbench-screenshot.png"],
      "id-ID": ["automation-templates-panel-id.png", "workbench-panel-id.png"],
      es: ["automation-templates-panel-es.png", "workbench-panel-es.png"],
      "ja-JP": ["automation-templates-panel-ja.png", "workbench-panel-ja.png"],
      "ko-KR": ["automation-templates-panel-ko.png", "workbench-panel-ko.png"],
    } as const;
    const expectedNavLabels = {
      "en-US": ["Home", "Pricing", "Changelog", "Docs", "About"],
      "zh-SG": ["首页", "定价", "更新日志", "文档", "关于我们"],
      "zh-Hant": ["首頁", "定價", "更新日誌", "文檔", "關於我們"],
      "id-ID": ["Beranda", "Harga", "Catatan Rilis", "Dokumentasi", "Tentang"],
      es: ["Inicio", "Precios", "Novedades", "Documentación", "Acerca de"],
      "ja-JP": ["ホーム", "料金", "更新履歴", "ドキュメント", "会社概要"],
      "ko-KR": ["홈", "요금", "업데이트 내역", "문서", "회사 소개"],
    } as const;

    for (const locale of publishedInternationalLocales) {
      const localizedPath = path.join(homeRoot, `index-fragment.${locale}.html`);
      expect(existsSync(localizedPath), `missing ${locale} fragment`).toBe(true);
      const html = readFileSync(localizedPath, "utf8");
      const document = new DOMParser().parseFromString(html, "text/html");
      expect(document.querySelector("#lightvela-intl-home")?.getAttribute("data-locale")).toBe(locale);
      expect(document.querySelector(".nav__brand b"), `${locale} duplicate brand label`).toBeNull();
      expect(html).toContain(expectedCopy[locale]);
      expect(document.body.textContent).toContain(expectedAlwaysOnCopy[locale]);
      expect(
        Array.from(document.querySelectorAll(".nav__links a"), (anchor) => anchor.textContent?.trim()),
      ).toEqual(expectedNavLabels[locale]);
      const navLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>(".nav__links a"));
      expect(navLinks[0]?.getAttribute("aria-current"), `${locale} homepage nav current`).toBe("page");
      expect(navLinks.slice(1).every((anchor) => !anchor.hasAttribute("aria-current")), `${locale} secondary nav current`).toBe(true);
      for (const assetName of expectedCardAssets[locale]) {
        expect(html).toContain(`/lightvela-intl-home/assets/${assetName}`);
        expect(existsSync(path.join(homeRoot, "assets", assetName)), `missing ${assetName}`).toBe(true);
      }
      for (const assetName of expectedProductPanelAssets[locale]) {
        expect(html).toContain(`/lightvela-intl-home/assets/${assetName}`);
        expect(existsSync(path.join(homeRoot, "assets", assetName)), `missing ${assetName}`).toBe(true);
      }
    }
  });

  it("keeps the user voice marquee visible as a full two-row section", () => {
    const document = parseFragment();
    const css = readFileSync(stylesheetPath, "utf8");

    expect(document.querySelectorAll(".voice .mrow")).toHaveLength(2);
    expect(document.querySelectorAll(".voice .tcard").length).toBeGreaterThanOrEqual(20);
    expect(css).toMatch(/#lightvela-intl-home \.voice\s*\{[^}]*padding:\s*96px 0 104px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.voice \.marquee__rows\s*\{[^}]*min-height:\s*420px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.voice \.tcard\s*\{[^}]*width:\s*260px;[^}]*min-height:\s*116px;/s);
  });

  it("activates all 18 native scene buttons by click as well as hover", () => {
    const englishDocument = new DOMParser().parseFromString(
      readLocaleFragment("en-US"),
      "text/html",
    );
    const publishedButtons = Array.from(
      englishDocument.querySelectorAll<HTMLButtonElement>(".scene__sub"),
    );
    expect(publishedButtons).toHaveLength(18);
    expect(
      publishedButtons.every(
        (button) => button.tagName === "BUTTON" && button.getAttribute("type") === "button",
      ),
    ).toBe(true);
    document.body.innerHTML = [
      '<div class="scene" id="scene-1">',
      '<button class="scene__sub on" type="button">First scene</button>',
      '<button class="scene__sub" type="button">Second scene</button>',
      '<div class="scene-chat"><div class="native__thread"></div></div>',
      '<div class="scene-chat"><div class="native__thread"></div></div>',
      "</div>",
    ].join("");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    window.eval(readFileSync(runtimePath, "utf8"));

    const buttons = document.querySelectorAll<HTMLButtonElement>(".scene__sub");
    const chats = document.querySelectorAll<HTMLElement>(".scene-chat");
    buttons[1].click();

    expect(buttons[0].classList.contains("on")).toBe(false);
    expect(buttons[1].classList.contains("on")).toBe(true);
    expect(buttons[0].getAttribute("aria-pressed")).toBe("false");
    expect(buttons[1].getAttribute("aria-pressed")).toBe("true");
    expect(chats[0].style.display).toBe("none");
    expect(chats[1].style.display).toBe("");

    buttons[0].dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(buttons[0].classList.contains("on")).toBe(true);
    buttons[1].dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " " }));
    expect(buttons[1].classList.contains("on")).toBe(true);
    document.body.replaceChildren();
  });

  it("publishes the initial pressed state in every generated locale fragment", () => {
    for (const fragmentName of generatedFragmentNames) {
      const document = new DOMParser().parseFromString(
        readFileSync(path.join(homeRoot, fragmentName), "utf8"),
        "text/html",
      );
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".scene__sub"),
      );

      expect(buttons, fragmentName).toHaveLength(18);
      expect(
        buttons.every((button) => button.hasAttribute("aria-pressed")),
        fragmentName,
      ).toBe(true);
      expect(
        buttons.filter((button) => button.getAttribute("aria-pressed") === "true"),
        fragmentName,
      ).toHaveLength(6);
    }
  });

  it("keeps international homepage demos localized", () => {
    const bannedEnglishDemoCopy = [
      "We just finished the pricing-page meeting. Can you sort the notes and tasks?",
      "Show me the automation templates. I want to set up the common ones.",
      "Turn PDFs, contracts, notes, and links into searchable memory",
      "Watch news, releases, price changes, and filings in the background",
      "Put family calendars, tasks, school events, and chores in one place",
      "LightVela significantly enhances my work mobility",
      "Preparing for Computer Science and tech certifications",
      "It keeps my class notes, coding practice, and exam reviews in one rhythm",
      "Log this receipt and tell me whether this month is over budget.",
      "Nasdaq Sector Brief - Aug 27, 2026 Close",
      "Market tone: tech-led, very narrow breadth",
      "Leading themes",
      "Note: airlines, healthcare, banks, and China ADRs weakened.",
    ];
    const expectedLocalizedCopy = {
      "id-ID": [
        "Kami baru selesai rapat halaman pricing. Bisa rapikan catatan dan tugasnya?",
        "Tampilkan template automations. Saya ingin mengatur yang umum.",
        "Ubah PDF, kontrak, catatan, dan tautan menjadi memori yang bisa dicari",
      ],
      es: [
        "Acabamos la reunión de la página de precios. ¿Puedes ordenar notas y tareas?",
        "Muéstrame las plantillas de automatización. Quiero configurar las comunes.",
        "Convierte PDF, contratos, notas y enlaces en memoria consultable",
      ],
      "ja-JP": [
        "料金ページの会議が終わりました。メモとタスクを整理できますか？",
        "自動化テンプレートを見せて。よく使うものを設定したい。",
        "PDF、契約書、メモ、リンクを検索できる記憶に変換",
      ],
      "ko-KR": [
        "요금 페이지 회의가 막 끝났어. 메모와 작업을 정리해 줄래?",
        "자동화 템플릿을 보여줘. 자주 쓰는 것을 설정하고 싶어.",
        "PDF, 계약서, 메모, 링크를 검색 가능한 기억으로 변환",
      ],
    } as const;

    for (const [locale, expectedCopies] of Object.entries(expectedLocalizedCopy)) {
      const html = readFileSync(path.join(homeRoot, `index-fragment.${locale}.html`), "utf8");
      if (locale === "id-ID" || locale === "es") {
        expect(html).not.toMatch(/[\u4e00-\u9fff]/);
      }
      if (locale === "id-ID") expect(html).not.toContain("Hari ini at");
      if (locale === "es") expect(html).not.toContain("Hoy at");
      for (const copy of bannedEnglishDemoCopy) expect(html).not.toContain(copy);
      for (const copy of expectedCopies) expect(html).toContain(copy);
    }
  });

  it("localizes public links inside non-English homepage fragments", () => {
    const expectedPrefixes = {
      "zh-SG": "/zh-sg",
      "zh-Hant": "/zh-hant",
      "id-ID": "/id-id",
      es: "/es",
      "ja-JP": "/ja-jp",
      "ko-KR": "/ko-kr",
    } as const;

    for (const [locale, prefix] of Object.entries(expectedPrefixes)) {
      const html = readFileSync(path.join(homeRoot, `index-fragment.${locale}.html`), "utf8");
      const document = new DOMParser().parseFromString(html, "text/html");
      const hrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>(".nav__links a, .foot a"), (anchor) =>
        anchor.getAttribute("href"),
      );

      expect(hrefs).toContain(prefix);
      expect(hrefs).toContain(`${prefix}/subscribe`);
      expect(hrefs).toContain(`${prefix}/docs/overview`);
      expect(hrefs).toContain(`${prefix}/about`);
      expect(hrefs).toContain("/agents");
    }
  });

  it("reserves the header actions for the production auth island", () => {
    const document = parseFragment();
    const actions = document.querySelector(".nav__actions");

    expect(actions?.querySelector("#international-home-header-actions")).not.toBeNull();
    expect(actions?.textContent).not.toContain("CN");
    expect(actions?.textContent).not.toContain("Early Access");
  });

  it("uses the transparent production wordmark and the plain global top bar", () => {
    const document = parseFragment();
    const headerLogo = document.querySelector<HTMLImageElement>(".nav__brand img");
    const navLabels = Array.from(document.querySelectorAll(".nav__links a"), (anchor) => anchor.textContent?.trim());
    const css = readFileSync(stylesheetPath, "utf8");

    expect(headerLogo?.getAttribute("src")).toBe("/lightvela-logo.svg");
    expect(document.querySelector(".nav__brand b")).toBeNull();
    expect(navLabels).toEqual(["Home", "Pricing", "Changelog", "Docs", "About"]);
    expect(css).toMatch(
      /#lightvela-intl-home \.nav\s*\{[^}]*padding:\s*0;[^}]*background:\s*#fff !important;[^}]*border-bottom:\s*1px solid rgba\(32,\s*27,\s*46,\s*0\.08\) !important;[^}]*box-shadow:\s*none !important;/s,
    );
    expect(css).toMatch(
      /#lightvela-intl-home \.nav__inner\s*\{[^}]*max-width:\s*min\(1440px,\s*calc\(100vw - 48px\)\);[^}]*min-height:\s*64px;[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;/s,
    );
    expect(css).toMatch(
      /\.international-home-header-actions-layer\s*\{[^}]*top:\s*14px;[^}]*right:\s*max\(24px,\s*calc\(\(100% - 1440px\) \/ 2\)\);/s,
    );
  });

  it("offsets the fixed homepage header while the announcement is visible", () => {
    const css = readFileSync(stylesheetPath, "utf8");

    expect(css).toMatch(
      /body\.lw-has-announcement #lightvela-intl-home \.nav\s*\{[^}]*top:\s*36px;/s,
    );
    expect(css).toMatch(
      /body\.lw-has-announcement \.international-home-header-actions-layer\s*\{[^}]*top:\s*50px;/s,
    );
    expect(css).toMatch(
      /@media \(max-width:\s*1099px\)[\s\S]*body\.lw-has-announcement \.international-home-header-actions-layer\s*\{[^}]*top:\s*48px;/s,
    );
  });

  it("preserves the remote hero channel panels", () => {
    const html = readFragment();
    const document = parseFragment();

    expect(document.querySelector(".chat-row__badge")?.textContent).toBe("2");
    expect(html).toContain("Hermes Agent: Nasdaq sector brief is ready");
    expect(html).toContain("<h4>Nasdaq Brief Assistant</h4>");
    expect(html).toContain("@LightVela ask DSH to fix Hermes");
    expect(html).toContain("Friday Night Arena reminder");
    expect(html).toContain("What if I registered but have not been assigned a team?");
    expect(html).toContain("At 7:30 PM Friday");
    expect(html).toContain("read the last week of messages");
    expect(html).toContain("Rank them by renewal risk first.");
    expect(html).not.toContain("@LightVela are you ready? Help me start my AI companion.");
    expect(html).not.toContain("Create your AI companion in Workbench first.");
    expect(html).not.toContain("Slack, WhatsApp, Telegram, and Discord can all become places");
    expect(html).not.toContain("Nasdaq Brief</b>");
    expect(html).not.toContain("<h4>Nasdaq Brief</h4>");
  });

  it("preserves the remote four channel panels in zh-SG", () => {
    const html = readLocaleFragment("zh-SG");

    expect(html).toContain("周五夜间竞技赛提醒：裂隙对决社区赛周五 20:00 GMT+8 开始。");
    expect(html).toContain("这次比赛换算到我的时区是几点开始？");
    expect(html).toContain("今晚进团前我需要先做什么？");
    expect(html).toContain("已安排。周五 19:30");
    expect(html).toContain("@LightVela 翻一下最近一周的讨论，先说现在最卡哪一步。");
    expect(html).toContain("以后客户回访别按每天一家排，先看续费风险。");
    expect(html).not.toContain("@LightVela 我们在设置团队工作区，第一步是什么？");
    expect(html).not.toContain("创建完成后，你能加入这个 Discord 服务器吗？");

    for (const locale of ["ja-JP", "ko-KR"] as const) {
      const localizedHtml = readLocaleFragment(locale);
      expect(localizedHtml).not.toContain("When does the tournament start in my time zone?");
      expect(localizedHtml).not.toContain("What if I registered but have not been assigned a team?");
      expect(localizedHtml).not.toContain("Keep it small. Check provider sync and the session-end hook first.");
      expect(localizedHtml).not.toContain("Next time, do not split customer follow-ups by day.");
    }
  });

  it("preserves the existing localized footer layout", () => {
    const document = parseFragment();
    const footer = document.querySelector("footer.foot");
    const css = readFileSync(stylesheetPath, "utf8");

    expect(footer?.querySelector<HTMLImageElement>(".foot__brand img")?.getAttribute("src")).toBe("/lightvela-logo.svg");
    expect(footer?.querySelector(".foot__title em.foot__signature")?.textContent).toBe("Hermes Agent");
    expect(footer?.querySelector(".foot__title")?.textContent).toContain("Hand your ideas to Hermes Agent,");
    expect(footer?.querySelector(".foot__title")?.textContent).toContain("keep them moving in the cloud.");
    expect(footer?.querySelector(".foot__cta a")?.textContent).toContain("My AI companion");
    expect(footer?.querySelector(".foot__cta a span")).not.toBeNull();
    expect(footer?.querySelectorAll(".foot__links-grid > div")).toHaveLength(6);
    expect(footer?.querySelectorAll(".foot__brand-copy")).toHaveLength(0);
    expect(Array.from(footer?.querySelectorAll(".foot__links-grid h3") ?? [], (heading) => heading.textContent)).toEqual([
      "Product",
      "Compare",
      "Community",
      "Company",
      "Related products",
    ]);
    expect(footer?.querySelectorAll(".foot__links-grid ul")).toHaveLength(5);
    expect(footer?.querySelectorAll(".foot__links-grid li")).toHaveLength(21);
    expect(
      Array.from(footer?.querySelectorAll<HTMLAnchorElement>(".foot__links-grid > div:nth-child(4) a") ?? [], (anchor) =>
        anchor.textContent,
      ),
    ).toEqual(["X / Twitter", "Discord", "WhatsApp", "YouTube"]);
    expect(
      Array.from(footer?.querySelectorAll<HTMLAnchorElement>(".foot__links-grid > div:last-child a") ?? [], (anchor) => [
        anchor.textContent,
        anchor.getAttribute("href"),
      ]),
    ).toEqual([
      ["Tencent EdgeOne", "https://edgeone.ai/"],
      ["Tencent CloudBase", "https://tcb.cloud.tencent.com/en/?from=lightvela"],
    ]);
    expect(footer?.querySelector(".foot__links-grid > div:nth-child(2) a")?.textContent).toBe("Blog");
    expect(footer?.querySelector(".foot__links-grid > div:nth-child(2) a")?.getAttribute("href")).toBe("/blog");
    expect(footer?.textContent).toContain("14-day free trial");
    expect(footer?.textContent).toContain("Compare with self-hosting");
    expect(footer?.textContent).not.toContain("Comparison");
    expect(footer?.textContent).not.toContain("LightVela keeps your personal AI companion online in the cloud.");
    expect(footer?.textContent).not.toContain("Create it once, connect your channels, and let it keep learning how you work.");
    expect(footer?.querySelector(".foot__copyright")?.textContent).toContain(
      "© 2026 LightVela. All rights reserved. Built by Tencent Lighthouse.",
    );
    expect(footer?.textContent).not.toContain("Thank you Hermes for the technical support provided to LightVela.");
    expect(footer?.textContent).not.toContain("Ready to set off with you at any time.");
    expect(footer?.textContent).not.toContain("My AI partners");
    expect(css).toMatch(/#lightvela-intl-home \.cta\s*\{[^}]*padding-bottom:\s*80px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.cta__stage\.sr\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*none;[^}]*transition:\s*none;/s);
    expect(css).toMatch(/#lightvela-intl-home \.foot\s*\{[^}]*padding-top:\s*48px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.foot__top\s*\{[^}]*min-height:\s*184px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.foot__links\s*\{[^}]*max-width:\s*min\(1380px,\s*calc\(100vw - 96px\)\);[^}]*margin:\s*96px auto 0;/s);
    expect(css).toMatch(/#lightvela-intl-home \.foot__links-grid\s*\{[^}]*grid-template-columns:\s*minmax\(300px,\s*360px\) minmax\(250px,\s*280px\) minmax\(150px,\s*168px\) minmax\(140px,\s*158px\) minmax\(140px,\s*158px\) minmax\(220px,\s*250px\);/s);
    expect(css).toMatch(/#lightvela-intl-home \.foot__cta a\s*\{[^}]*width:\s*fit-content;[^}]*height:\s*46px;[^}]*padding:\s*0 50px 0 24px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.foot__title,[\s\S]*font-family:\s*"STXingkai"/);
  });

  it("emphasizes the always-on card phrases across homepage locales", () => {
    const expectedBoldPhrases = {
      "en-US": ["available 24/7 in the cloud", "turn your feedback into a new rule"],
      "zh-SG": ["云端 7×24 小时在线", "新规则，下次直接按你的习惯做"],
      "zh-Hant": ["雲端 7×24 小時在線", "新規則，下次直接按你的習慣做"],
      "id-ID": ["di cloud dan tersedia 24/7", "sebagai aturan baru dan mengikuti preferensi Anda berikutnya"],
      es: ["en la nube y estoy disponible 24/7", "como una regla para la próxima vez"],
      "ja-JP": ["クラウドで24時間365日稼働する", "新しいルールとして保存し、次回はあなたの好みに沿って動きます"],
      "ko-KR": ["클라우드에서 24시간 연중무휴로 실행", "새 규칙으로 저장하고 다음에는 그 선호에 맞춰 움직입니다"],
    } as const;

    for (const locale of publishedInternationalLocales) {
      const html = readFileSync(path.join(homeRoot, `index-fragment.${locale}.html`), "utf8");
      for (const phrase of expectedBoldPhrases[locale]) {
        expect(html).toContain(`<b>${phrase}</b>`);
      }
    }
  });

  it("keeps the imported reset inside the international homepage root", () => {
    const css = readFileSync(stylesheetPath, "utf8");

    expect(css).toContain(":where(#lightvela-intl-home *::before)");
    expect(css).toContain(":where(#lightvela-intl-home button)");
    expect(css).not.toContain("#lightvela-intl-home *:not(");
    expect(css).not.toMatch(/(^|\n):root\s*\{/);
    expect(css).not.toMatch(/(^|\n)body\s*\{/);
    expect(css).not.toMatch(/(^|\n)\*\s*,\s*\n\*::before/);
    expect(css).toMatch(/\.international-home-header-actions-layer\s*\{[^}]*position:\s*fixed;/s);
  });

  it("uses the approved companion roles in every localized hero rotator", () => {
    const expectedWordsByFragment = {
      "index-fragment.html": ["work partner", "developer buddy", "life concierge", "financial assistant", "plan executor", "creative companion", "content manager"],
      "index-fragment.en-US.html": ["work partner", "developer buddy", "life concierge", "financial assistant", "plan executor", "creative companion", "content manager"],
      "index-fragment.zh-CN.html": ["工作搭档", "开发搭子", "生活管家", "理财助理", "计划执行官", "创意同行者", "自媒体运营官"],
      "index-fragment.zh-SG.html": ["工作搭档", "开发搭子", "生活管家", "理财助理", "计划执行官", "创意同行者", "自媒体运营官"],
      "index-fragment.zh-Hant.html": ["工作夥伴", "開發夥伴", "生活管家", "理財助理", "計畫執行官", "創意同行者", "自媒體營運官"],
      "index-fragment.id-ID.html": ["rekan kerja", "teman pengembang", "pengelola hidup", "asisten keuangan", "pelaksana rencana", "rekan kreatif", "manajer konten"],
      "index-fragment.es.html": ["compañero de trabajo", "compañero de desarrollo", "gestor personal", "asistente financiero", "ejecutor de planes", "compañero creativo", "gestor de contenido"],
      "index-fragment.ja-JP.html": ["仕事の相棒", "開発仲間", "暮らしのコンシェルジュ", "資産管理アシスタント", "計画実行役", "クリエイティブパートナー", "コンテンツマネージャー"],
      "index-fragment.ko-KR.html": ["업무 파트너", "개발 동료", "생활 매니저", "재무 어시스턴트", "계획 실행자", "창의적 동반자", "콘텐츠 매니저"],
    } as const;

    for (const [fragmentName, expectedWords] of Object.entries(expectedWordsByFragment)) {
      const html = readFileSync(path.join(homeRoot, fragmentName), "utf8");
      const document = new DOMParser().parseFromString(html, "text/html");
      const root = document.querySelector("#lightvela-intl-home");
      const words = JSON.parse(root?.getAttribute("data-rotator-words") ?? "[]") as unknown;

      expect(words).toEqual(expectedWords);
      expect(document.querySelector("#hero-rotator")?.textContent).toBe(expectedWords[0]);
    }

    expect(readFileSync(runtimePath, "utf8")).toContain(
      "if (!words.length) words = ['work partner', 'developer buddy', 'life concierge', 'financial assistant', 'plan executor', 'creative companion', 'content manager'];",
    );
  });

  it("keeps the remote animated headline and the plain eyebrow exception", () => {
    const css = readFileSync(stylesheetPath, "utf8");
    const runtime = readFileSync(runtimePath, "utf8");
    const heroChat = readFileSync(path.join(homeRoot, "hero-chat.js"), "utf8");
    const editorialSelector = "#lightvela-intl-home:is([data-locale^='en'], [data-locale^='id'], [data-locale='es'], [data-locale^='ja'], [data-locale^='ko'])";
    const escapedEditorialSelector = editorialSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const editorialHeroRules = Array.from(
      css.matchAll(new RegExp(`${escapedEditorialSelector} \\.hero__line--main\\s*\\{([^}]*)\\}`, "g")),
      (match) => match[1],
    );

    expect(css).toMatch(/\.hero__line--main\s*\{[^}]*font-size:\s*50px;[^}]*font-weight:\s*500;[^}]*white-space:\s*normal;/s);
    expect(css).toMatch(/#lightvela-intl-home \.nav__links a\s*\{[^}]*font-weight:\s*400;/s);
    expect(css).toMatch(/#lightvela-intl-home \.nav__links a\[aria-current='page'\]\s*\{[^}]*font-weight:\s*600;/s);
    expect(editorialHeroRules.some((rule) => (
      rule.includes("font-family: var(--font-cover-en);")
      && rule.includes("max-width: min(1180px, calc(100vw - 120px));")
      && rule.includes("font-size: 36px;")
      && rule.includes("font-weight: 600;")
      && rule.includes("line-height: 1.2;")
    ))).toBe(true);
    expect(css).toMatch(/\.hero__line--dynamic\s*\{[^}]*display:\s*inline-flex;[^}]*font-style:\s*italic;[^}]*line-height:\s*1\.32;/s);
    expect(css).toMatch(
      /#lightvela-intl-home\[data-locale='zh-CN'\] \.hero__line--dynamic\s*\{[^}]*width:\s*17\.25em;[^}]*max-width:\s*92vw;[^}]*justify-content:\s*flex-start;/s,
    );
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.hero__line--main\s*\{[^}]*font-size:\s*30px;/);
    expect(editorialHeroRules.some((rule) => rule.includes("font-size: 24px;"))).toBe(true);
    expect(css).toMatch(/#lightvela-intl-home \.hero__eyebrow\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;/s);
    expect(css).toMatch(/\.hero__line--main \.hero__char,[\s\S]*animation:\s*hero-char-in 0\.5s/);
    expect(css).toMatch(/\.hero__cta\s*\{[^}]*animation:\s*hero-in 0\.7s/s);
    expect(css).not.toMatch(/\.hero__stage \.hero__frame,[\s\S]*animation:\s*none !important;/);
    expect(runtime).not.toContain("word.className = 'hero__word'");
    expect(runtime).not.toContain("document.createTextNode(part)");
    expect(runtime).toContain("text[i] === ' ' ? '\\u00a0'");
    expect(runtime).toContain("dataset?.rotatorWords");
    expect(runtime).toContain("el.classList.add('is-changing')");
    expect(runtime).toContain("el.classList.remove('is-changing')");
    expect(runtime).toContain("rotatorVisible = entry.isIntersecting");
    expect(css).toMatch(/@keyframes hero-rotator-in\s*\{[\s\S]*opacity:\s*0;[\s\S]*translateY\(6px\)[\s\S]*opacity:\s*1;[\s\S]*transform:\s*none;/);
    expect(css).toMatch(/\.hero__rotator\.is-changing\s*\{[^}]*animation:\s*hero-rotator-in 180ms ease-out;/s);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.hero__rotator\.is-changing\s*\{[^}]*animation:\s*none;/);
    expect(runtime).toContain("btn.addEventListener('mouseenter'");
    expect(runtime).toContain("fadeInThread(thread)");
    expect(runtime).toContain("b.style.transitionDelay = (i * FADE_STEP) + 'ms'");
    expect(runtime).toContain("document.querySelectorAll('.plays__tabs label[for]')");
    expect(runtime).toContain("label.addEventListener('mouseenter'");
    expect(runtime).toContain("if (input && !input.checked) input.click()");
    expect(css).toMatch(/\.scene-chat\s*\{[^}]*animation:\s*scene-chat-in 0\.2s/s);
    expect(heroChat).toContain("function getCopies(message)");
    expect(heroChat).toContain("scrollToBottom(panel)");
    expect(heroChat).toContain("activeReplayPanel = panel");
    expect(heroChat).toContain("function nextMessage()");
    expect(heroChat).toContain("message.classList.contains('dc__bot')");
    expect(heroChat).toContain("typeCopy(copies[copyIndex], run");
    expect(heroChat).toContain("message.classList.remove('is-in', 'is-typing', 'is-done')");
    expect(heroChat).toContain("link.href = '/agents'");
    expect(heroChat).toContain("pricingLink.href = pricingHref");
    expect(heroChat).toContain("Your AI companion is waiting to start. Create it in Workbench.");
  });

  it("uses the remote editorial font for English marketing headings", () => {
    const css = readFileSync(stylesheetPath, "utf8");
    const editorialSelector = "#lightvela-intl-home:is([data-locale^='en'], [data-locale^='id'], [data-locale='es'], [data-locale^='ja'], [data-locale^='ko'])";

    expect(css).toMatch(/\.hero__title\s*\{[^}]*font-family:\s*var\(--font-hero\);/s);
    expect(css).toContain(`${editorialSelector} .hero__line--main`);
    expect(css).toContain(`${editorialSelector} .about__head .k`);
    expect(css).toContain(`${editorialSelector} .scenes__title`);
    expect(css).toContain(`${editorialSelector} .cta__title`);
    expect(editorialSelector).not.toContain("data-locale^='zh'");
    expect(css).toMatch(/#lightvela-intl-home \.foot__title,[\s\S]*font-family:\s*"STXingkai"/);
  });

  it("keeps long Indonesian desktop headings on one line", () => {
    const css = readFileSync(stylesheetPath, "utf8");

    expect(css).toMatch(/@media \(min-width: 1024px\)[\s\S]*#lightvela-intl-home:is\(\[data-locale\^='id'\], \[data-locale='es'\]\) \.hero__line--main\s*\{[^}]*max-width:\s*min\(1680px, calc\(100vw - 64px\)\);[^}]*white-space:\s*nowrap;/);
    expect(css).toMatch(/#lightvela-intl-home\[data-locale\^='id'\] \.about__head\s*\{[^}]*max-width:\s*min\(1200px, calc\(100vw - 64px\)\);/);
    expect(css).toMatch(/#lightvela-intl-home\[data-locale\^='id'\] \.about__head \.k\s*\{[^}]*white-space:\s*nowrap;/);
    expect(css).toMatch(/@media \(min-width: 1280px\) and \(max-width: 1439px\)[\s\S]*font-size:\s*32px;/);
  });

  it("localizes the revised free-trial CTA in every non-English locale", () => {
    const expectedCtaCopy = {
      "zh-SG": ["免费体验，无需信用卡", "LightVela免费体验 14 天", "AI Token 套餐免费体验 7 天"],
      "zh-Hant": ["免費體驗，無需信用卡", "LightVela免費體驗 14 天", "AI Token 套餐免費體驗 7 天"],
      "id-ID": ["Coba gratis, tanpa kartu kredit", "Coba LightVela gratis selama 14 hari.", "Coba paket AI Token gratis selama 7 hari."],
      es: ["Pruébalo gratis, sin tarjeta de crédito", "Prueba LightVela gratis durante 14 días.", "Prueba un plan de tokens de IA gratis durante 7 días."],
      "ja-JP": ["クレジットカード不要で無料体験", "LightVelaを14日間無料でお試しいただけます。", "AI Tokenプランを7日間無料でお試しいただけます。"],
      "ko-KR": ["신용카드 없이 무료로 체험하세요", "LightVela를 14일 동안 무료로 사용해 보세요.", "AI Token 플랜을 7일 동안 무료로 사용해 보세요."],
    } as const;

    for (const [locale, phrases] of Object.entries(expectedCtaCopy)) {
      const html = readFileSync(path.join(homeRoot, `index-fragment.${locale}.html`), "utf8");
      for (const phrase of phrases) expect(html).toContain(phrase);
      expect(html).not.toContain("Try it free, no credit card required");
      expect(html).not.toContain("Try LightVela free for 14 days.");
      expect(html).not.toContain("Try an AI token plan free for 3 days.");
    }
  });

  it("keeps domestic trial copy distinct while international AI token trial lasts seven days", () => {
    const defaultHtml = readFragment();
    const englishHtml = readLocaleFragment("en-US");
    const domesticHtml = readFileSync(path.join(homeRoot, "index-fragment.zh-CN.html"), "utf8");

    for (const html of [defaultHtml, englishHtml]) {
      expect(html).toContain("Try LightVela free for 14 days.");
      expect(html).toContain("Try an AI token plan free for 7 days.");
      expect(html).not.toContain("Try an AI token plan free for 3 days.");
    }

    const domesticDocument = new DOMParser().parseFromString(domesticHtml, "text/html");
    expect(domesticDocument.querySelector(".cta__title")?.textContent?.trim()).toBe("免费体验，10秒极速开通");
    expect(Array.from(domesticDocument.querySelectorAll(".cta__copy li"), (item) => item.textContent?.trim())).toEqual([
      "LightVela免费体验 14 天",
      "AI Token 套餐免费体验 3 天",
    ]);
    expect(domesticHtml).not.toContain("AI Token 套餐免费体验 7 天");
  });

  it("positions the onboarding relationship as an AI companion across locales", () => {
    const expectedCompanionTitles = {
      "index-fragment.html": "Then I become your AI companion",
      "index-fragment.en-US.html": "Then I become your AI companion",
      "index-fragment.zh-CN.html": "然后逐渐成为你的 AI 伙伴",
      "index-fragment.zh-SG.html": "然后逐渐成为你的 AI 伙伴",
      "index-fragment.zh-Hant.html": "然後逐漸成為你的 AI 夥伴",
      "index-fragment.id-ID.html": "Lalu saya menjadi pendamping AI Anda",
      "index-fragment.es.html": "Luego me convierto en tu compañero de IA",
      "index-fragment.ja-JP.html": "その後、あなたのAIコンパニオンになります",
      "index-fragment.ko-KR.html": "그다음에는 당신의 AI 컴패니언이 됩니다",
    } as const;

    for (const [fragmentName, title] of Object.entries(expectedCompanionTitles)) {
      const html = readFileSync(path.join(homeRoot, fragmentName), "utf8");
      expect(html).toContain(`<h4>${title}</h4>`);
      expect(html).not.toMatch(/best working partner|partner kerja terbaik|partner de trabajo|最高の仕事パートナー|최고의 업무 파트너|最佳拍档|最佳拍檔/);
    }
  });

  it("uses SEO-friendly homepage heading levels in every localized fragment", () => {
    const expectedHeadings = {
      "index-fragment.html": {
        h1: "LightVela · AI companion in the cloud",
        h2: ["From first hello to trusted companion", "How to Get Started", "Try it free, no credit card required"],
      },
      "index-fragment.en-US.html": {
        h1: "LightVela · AI companion in the cloud",
        h2: ["From first hello to trusted companion", "How to Get Started", "Try it free, no credit card required"],
      },
      "index-fragment.zh-CN.html": {
        h1: "LightVela · 云端 Hermes Agent",
        h2: ["从认识，到成为你的伙伴", "如何拥有？", "免费体验，10秒极速开通"],
      },
      "index-fragment.zh-SG.html": {
        h1: "LightVela · 云端 Hermes Agent",
        h2: ["从认识，到成为你的伙伴", "如何拥有？", "免费体验，无需信用卡"],
      },
      "index-fragment.zh-Hant.html": {
        h1: "LightVela · 雲端 Hermes Agent",
        h2: ["從認識，到成為你的夥伴", "如何擁有？", "免費體驗，無需信用卡"],
      },
      "index-fragment.id-ID.html": {
        h1: "LightVela · pendamping AI di cloud",
        h2: ["Dari sapaan pertama hingga pendamping tepercaya", "Cara Memulai", "Coba gratis, tanpa kartu kredit"],
      },
      "index-fragment.es.html": {
        h1: "LightVela · compañero de IA en la nube",
        h2: ["Del primer hola a un compañero de confianza", "Cómo empezar", "Pruébalo gratis, sin tarjeta de crédito"],
      },
      "index-fragment.ja-JP.html": {
        h1: "LightVela · クラウドのAIパートナー",
        h2: ["最初の挨拶から、信頼できるパートナーへ", "始め方", "クレジットカード不要で無料体験"],
      },
      "index-fragment.ko-KR.html": {
        h1: "LightVela · 클라우드의 AI 파트너",
        h2: ["첫 인사에서 믿을 수 있는 파트너까지", "시작 방법", "신용카드 없이 무료로 체험하세요"],
      },
    } as const;

    for (const [fragmentName, headings] of Object.entries(expectedHeadings)) {
      const html = readFileSync(path.join(homeRoot, fragmentName), "utf8");
      const document = new DOMParser().parseFromString(html, "text/html");
      const h1s = Array.from(document.querySelectorAll("h1"));
      const h2s = Array.from(document.querySelectorAll("h2"), (heading) => heading.textContent?.trim());

      expect(h1s, fragmentName).toHaveLength(1);
      expect(h1s[0]?.classList.contains("hero__title"), fragmentName).toBe(true);
      expect(h1s[0]?.querySelector(".sr-only")?.textContent?.trim(), fragmentName).toBe(headings.h1);
      const eyebrow = document.querySelector(".hero__eyebrow");
      expect(eyebrow?.tagName, fragmentName).toBe("DIV");
      expect(eyebrow?.getAttribute("aria-label"), fragmentName).toBe(headings.h1);
      expect(eyebrow?.textContent?.trim(), fragmentName).toBe(headings.h1);
      for (const heading of headings.h2) {
        expect(h2s, `${fragmentName} h2`).toContain(heading);
      }
    }
  });

  it("localizes owned product UI labels by locale while preserving brand names", () => {
    const expectedProductTabLabels = {
      "en-US": ["Automations", "Workbench", "DeepSeek Harness"],
      "zh-CN": ["自动任务", "工作台", "DeepSeek Harness"],
      "zh-SG": ["自动任务", "工作台", "DeepSeek Harness"],
      "zh-Hant": ["自動任務", "工作臺", "DeepSeek Harness"],
      "id-ID": ["Otomatisasi", "Ruang kerja", "DeepSeek Harness"],
      es: ["Automatizaciones", "Área de trabajo", "DeepSeek Harness"],
      "ja-JP": ["自動タスク", "ワークベンチ", "DeepSeek Harness"],
      "ko-KR": ["자동 작업", "워크벤치", "DeepSeek Harness"],
    } as const;

    const expectedCtaLabels = {
      "en-US": "My AI Companion",
      "zh-CN": "我的智能体伙伴",
      "zh-SG": "我的智能体伙伴",
      "zh-Hant": "我的智能體夥伴",
      "id-ID": "Pendamping AI saya",
      es: "Mi compañero de IA",
      "ja-JP": "私のAIパートナー",
      "ko-KR": "내 AI 파트너",
    } as const;

    for (const locale of publishedInternationalLocales) {
      const html = readFileSync(path.join(homeRoot, `index-fragment.${locale}.html`), "utf8");
      for (const label of expectedProductTabLabels[locale]) {
        expect(html).toContain(`<span>${label}</span>`);
      }
      const document = new DOMParser().parseFromString(html, "text/html");
      expect(document.querySelector(".hero__cta .btn-dark")?.textContent).toContain(expectedCtaLabels[locale]);
      expect(html).toContain("play__new-badge");
      expect(html).not.toContain("Separate runtime");
      expect(html).not.toContain("独立运行时");
      expect(html).not.toContain("專屬 WebUI");
      expect(html).not.toContain("Runtime terpisah");
      expect(html).not.toContain("Runtime separado");
      expect(html).not.toContain("独立ランタイム");
      expect(html).not.toContain("독립 런타임");
      expect(html).not.toContain("foot__brand-copy");
      expect(html).not.toContain("<span>Creation / 作品</span>");
    }

    const deepSeekCopy = {
      "en-US": ["One-click Deploy DeepSeek Harness", "Ready out of the box, always online in the cloud.", "Secure WebUI access"],
      "zh-SG": ["一键部署 DeepSeek Harness", "开箱即用，常驻云端。", "安全 WebUI"],
      "zh-Hant": ["一鍵部署 DeepSeek Harness", "開箱即用，常駐雲端。", "安全 WebUI"],
      "id-ID": ["Deploy DeepSeek Harness sekali klik", "Siap pakai, selalu online di cloud.", "Akses WebUI aman"],
      es: ["Despliega DeepSeek Harness con un clic", "Listo para usar y siempre online en la nube.", "Acceso WebUI seguro"],
      "ja-JP": ["DeepSeek Harnessをワンクリックでデプロイ", "すぐに使えて、クラウドで常時オンライン。", "安全な WebUI"],
      "ko-KR": ["DeepSeek Harness 원클릭 배포", "바로 사용할 수 있고 클라우드에서 항상 온라인입니다.", "안전한 WebUI"],
    } as const;
    const deepSeekVisuals = {
      "en-US": "/lightvela-intl-home/assets/deepseek-harness-en-us.webp?v=20260904-harness-sharp",
      "zh-CN": "/lightvela-intl-home/assets/deepseek-harness-zh-cn.webp?v=20260904-harness-sharp",
      "zh-SG": "/lightvela-intl-home/assets/deepseek-harness-zh-sg.webp?v=20260904-harness-sharp",
      "zh-Hant": "/lightvela-intl-home/assets/deepseek-harness-zh-hant.webp?v=20260904-harness-sharp",
      "id-ID": "/lightvela-intl-home/assets/deepseek-harness-id-id.webp?v=20260904-harness-sharp",
      es: "/lightvela-intl-home/assets/deepseek-harness-es.webp?v=20260904-harness-sharp",
      "ja-JP": "/lightvela-intl-home/assets/deepseek-harness-ja-jp.webp?v=20260904-harness-sharp",
      "ko-KR": "/lightvela-intl-home/assets/deepseek-harness-ko-kr.webp?v=20260904-harness-sharp",
    } as const;

    for (const locale of publishedInternationalLocales) {
      const html = readFileSync(path.join(homeRoot, `index-fragment.${locale}.html`), "utf8");
      for (const copy of deepSeekCopy[locale]) expect(html).toContain(copy);
      const document = new DOMParser().parseFromString(html, "text/html");
      expect(document.querySelectorAll("#play-4 .play__list li")).toHaveLength(4);
      const harnessImage = document.querySelector<HTMLImageElement>("#play-4 .play__screen--harness .harness-visual-img");
      expect(harnessImage?.getAttribute("src")).toBe(deepSeekVisuals[locale]);
      expect(harnessImage?.getAttribute("loading")).toBe("lazy");
      expect(harnessImage?.hasAttribute("fetchpriority")).toBe(false);
      expect(harnessImage?.getAttribute("decoding")).toBe("async");
    }

    const simplifiedHtml = readFileSync(path.join(homeRoot, "index-fragment.zh-SG.html"), "utf8");
    const traditionalHtml = readFileSync(path.join(homeRoot, "index-fragment.zh-Hant.html"), "utf8");
    expect(simplifiedHtml).not.toMatch(/AI companion|Workbench|Pricing/);
    expect(simplifiedHtml).toContain("我的智能体伙伴");
    expect(simplifiedHtml).toContain("打开 DeepSeek Harness");
    expect(traditionalHtml).not.toMatch(/AI companion|Workbench|Pricing|工作台|创建|购买/);
    expect(traditionalHtml).toContain("我的智能體夥伴");
    expect(traditionalHtml).toContain("打開 DeepSeek Harness");
    expect(simplifiedHtml).toContain(">文档</a>");
    expect(simplifiedHtml).not.toContain(">产品文档</a>");
    expect(traditionalHtml).toContain(">文檔</a>");
    expect(traditionalHtml).not.toContain(">產品文檔</a>");
  });

  it("ships every referenced homepage asset", () => {
    const html = readFragment();
    const css = readFileSync(stylesheetPath, "utf8");
    const scriptNames = ["runtime.js", "hero-chat.js", "scene-wheel.js"];
    const assetReferences = new Set<string>();

    for (const source of [html, css]) {
      for (const match of source.matchAll(/(?:\/lightvela-intl-home\/)?assets\/[^"')\s]+/g)) {
        assetReferences.add(match[0].replace(/^\/lightvela-intl-home\//, "").split(/[?#]/)[0]);
      }
    }

    expect(assetReferences.size).toBeGreaterThan(10);
    for (const reference of assetReferences) {
      expect(existsSync(path.join(homeRoot, reference)), `missing ${reference}`).toBe(true);
    }
    for (const scriptName of scriptNames) {
      expect(existsSync(path.join(homeRoot, scriptName)), `missing ${scriptName}`).toBe(true);
    }
  });

  it("keeps homepage image payloads and loading hints performance-friendly", () => {
    const fragments = ["index-fragment.html", ...publishedInternationalLocales.map((locale) => `index-fragment.${locale}.html`)];
    const optimizedAssetNames = [
      "mock-grocery-receipt",
      "telegram-chat-bg",
      "whatsapp-chat-bg",
      "wcard-folder",
      "wcard-hub-v3",
    ];
    const css = readFileSync(stylesheetPath, "utf8");

    for (const assetName of optimizedAssetNames) {
      expect(css, `${assetName} should not be referenced as png in css`).not.toContain(`${assetName}.png`);
      expect(css, `${assetName} should use webp in css when referenced there`).not.toMatch(
        new RegExp(`${assetName}[^"')\\s]*\\.png`),
      );
    }

    for (const fragmentName of fragments) {
      const html = readFileSync(path.join(homeRoot, fragmentName), "utf8");
      const document = new DOMParser().parseFromString(html, "text/html");
      const images = Array.from(document.querySelectorAll<HTMLImageElement>("img"));

      expect(images.length, `${fragmentName} should render homepage imagery`).toBeGreaterThan(20);

      for (const image of images) {
        expect(image.getAttribute("decoding"), `${fragmentName} ${image.getAttribute("src")}`).toBe("async");
      }

      const brandLogo = document.querySelector<HTMLImageElement>(".nav__brand img");
      expect(brandLogo?.getAttribute("loading"), `${fragmentName} logo loading`).toBe("eager");
      expect(brandLogo?.getAttribute("fetchpriority"), `${fragmentName} logo priority`).toBe("high");

      const belowFoldImages = document.querySelectorAll<HTMLImageElement>(
        ".wcard img, .scenes img, .scene img, .plays img, .harness img, .voice img, .foot__brand img",
      );
      expect(belowFoldImages.length, `${fragmentName} below-fold images`).toBeGreaterThan(10);
      for (const image of Array.from(belowFoldImages)) {
        expect(image.getAttribute("loading"), `${fragmentName} ${image.getAttribute("src")}`).toBe("lazy");
      }

      const harnessImage = document.querySelector<HTMLImageElement>(".harness-visual-img");
      expect(harnessImage?.getAttribute("loading"), `${fragmentName} harness loading`).toBe("lazy");
      expect(harnessImage?.hasAttribute("fetchpriority"), `${fragmentName} harness priority`).toBe(false);

      for (const assetName of optimizedAssetNames) {
        expect(html, `${fragmentName} should not reference unoptimized ${assetName} png`).not.toMatch(
          new RegExp(`${assetName}[^"']*\\.png`),
        );
      }
    }
  });

  it("keeps the international homepage compact and touch-friendly on phones", () => {
    const css = readFileSync(stylesheetPath, "utf8");
    const runtime = readFileSync(runtimePath, "utf8");

    expect(css).toContain("@media (max-width: 640px)");
    expect(runtime).toContain("window.matchMedia('(max-width: 640px), (prefers-reduced-motion: reduce)').matches");
    expect(runtime).toContain("if (!shouldKeepNaturalText && main) next = splitChars(main, next);");
    expect(runtime).toContain("document.querySelectorAll('.about__cards .wcard')");
    expect(runtime).toContain("var phoneMedia = window.matchMedia('(max-width: 640px)');");
    expect(runtime).toContain("return phoneMedia.matches;");
    expect(runtime).toContain("strip.addEventListener('scroll', function () {");
    expect(runtime).toContain("card.classList.toggle('is-mobile-active', i === index);");
    expect(runtime).toContain("btn.addEventListener('click', activate);");
    expect(runtime).toContain("if (!isPhone()) return;");
    expect(runtime).toContain("touchRegion.addEventListener('touchstart', function (event) {");
    expect(runtime).toContain("var nextIndex = dx < 0 ? active + 1 : active - 1;");
    expect(runtime).toContain("stage.addEventListener('touchstart', function (event) {");
    expect(runtime).toContain("var next = dx < 0 ? current + 1 : current - 1;");
    expect(css).toMatch(/#lightvela-intl-home \.hero\s*\{[^}]*padding:\s*104px 16px 0;/s);
    expect(css).toMatch(/#lightvela-intl-home \.hero__tabs label\s*\{[^}]*min-height:\s*38px;[^}]*font-size:\s*12px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.hero__tabs label img\s*\{[^}]*width:\s*15px;[^}]*height:\s*15px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.hero__line--main\s*\{[^}]*font-size:\s*clamp\(28px, 8\.4vw, 34px\);/s);
    expect(css).toMatch(/#lightvela-intl-home \.hero__line--dynamic\s*\{[^}]*font-size:\s*clamp\(18px, 5\.2vw, 22px\);/s);
    expect(css).toMatch(/#lightvela-intl-home \.hero__frame\s*\{[^}]*min-width:\s*0;[^}]*border-radius:\s*18px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.about,\s*#lightvela-intl-home \.scenes,\s*#lightvela-intl-home \.deploy\s*\{[^}]*padding-left:\s*16px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.about__head \.k,\s*#lightvela-intl-home \.scenes__title,\s*#lightvela-intl-home \.deploy__lead\s*\{[^}]*font-size:\s*clamp\(22px, 6vw, 28px\);/s);
    expect(css).toMatch(/#lightvela-intl-home \.about__head::after\s*\{[^}]*content:\s*'Swipe left or right to switch cards';/s);
    expect(css).toMatch(
      /\.soul-strip__cap--secondary\s*\{[^}]*box-sizing:\s*border-box;[^}]*padding-inline:\s*18px;[^}]*overflow:\s*hidden;/s,
    );
    expect(css).toMatch(
      /\.soul-strip__cap--secondary > \.soul-strip__copy\s*\{[^}]*flex:\s*1 1 auto;[^}]*overflow:\s*hidden;/s,
    );
    expect(css).toMatch(/\.soul-strip__cap--secondary > \.soul-strip__icons\s*\{[^}]*flex:\s*0 0 auto;/s);
    expect(css).toMatch(
      /#lightvela-intl-home \.soul-strip\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);[^}]*height:\s*auto;/s,
    );
    expect(css).toMatch(/#lightvela-intl-home \.soul-strip::before,\s*#lightvela-intl-home \.soul-strip::after\s*\{[^}]*display:\s*none;/s);
    expect(css).toMatch(
      /#lightvela-intl-home \.soul-strip__icons,\s*#lightvela-intl-home \.soul-strip__icons--soul\s*\{[^}]*display:\s*none;/s,
    );
    expect(css).toMatch(
      /#lightvela-intl-home \.soul-strip__half > \.soul-strip__cap:not\(\.soul-strip__cap--secondary\) \.soul-strip__icons,\s*#lightvela-intl-home \.soul-strip__half > \.soul-strip__cap:not\(\.soul-strip__cap--secondary\) \.soul-strip__icons--soul\s*\{[^}]*display:\s*inline-flex;/s,
    );
    expect(css).toMatch(
      /#lightvela-intl-home \.soul-strip__half > \.soul-strip__cap:not\(\.soul-strip__cap--secondary\) > i,\s*#lightvela-intl-home \.soul-strip__half > \.soul-strip__cap:not\(\.soul-strip__cap--secondary\) > b\s*\{[^}]*display:\s*none;/s,
    );
    expect(css).toMatch(/#lightvela-intl-home \.about__cards\s*\{[^}]*display:\s*flex;[^}]*scroll-snap-type:\s*x mandatory;/s);
    expect(css).toMatch(/#lightvela-intl-home \.wcard\s*\{[^}]*flex:\s*0 0 min\(72vw, 282px\);[^}]*scroll-snap-align:\s*center;/s);
    expect(css).toMatch(/#lightvela-intl-home \.wcard__thumb\s*\{[^}]*display:\s*block;[^}]*height:\s*86px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.wcard__list\s*\{[^}]*max-height:\s*0;[^}]*opacity:\s*0;/s);
    expect(css).toMatch(/#lightvela-intl-home \.wcard\.is-mobile-active \.wcard__list,\s*#lightvela-intl-home \.wcard:active \.wcard__list\s*\{[^}]*max-height:\s*140px;[^}]*opacity:\s*1;/s);
    expect(css).toMatch(/#lightvela-intl-home \.hero__frame \.dc__rail,\s*#lightvela-intl-home \.hero__frame \.dc__side,\s*#lightvela-intl-home \.hero__frame \.dc__members\s*\{[^}]*display:\s*none;/s);
    expect(css).toMatch(/#lightvela-intl-home \.scenes__tabs\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/s);
    expect(css).toMatch(/#lightvela-intl-home \.scenes__tabs label\s*\{[^}]*min-height:\s*36px;[^}]*font-size:\s*10\.5px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.plays__tabs\s*\{[^}]*justify-content:\s*flex-start;[^}]*overflow-x:\s*auto;/s);
    expect(css).not.toContain("Swipe left or right to switch scenes");
    expect(css).not.toContain("左右滑动切换场景");
    expect(css).toMatch(/#lightvela-intl-home \.scene__subs\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/s);
    expect(css).toMatch(/#lightvela-intl-home \.scene__sub\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;[^}]*min-height:\s*40px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.scene__sub b::before\s*\{[^}]*display:\s*none;/s);
    expect(css).toMatch(/#lightvela-intl-home \.scene__chats\s*\{[^}]*display:\s*block;/s);
    expect(css).toMatch(/#lightvela-intl-home \.scene-chat\s*\{[^}]*display:\s*flex;[^}]*aspect-ratio:\s*auto;/s);
    expect(css).toMatch(/#lightvela-intl-home \.track__badge\s*\{[^}]*width:\s*50px;[^}]*height:\s*50px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.track__ic\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.track__body h3\s*\{[^}]*font-size:\s*15\.5px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.play\s*\{[^}]*padding:\s*20px 14px;[^}]*border-radius:\s*12px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.play__screen\s*\{[^}]*min-height:\s*120px;[^}]*max-height:\s*220px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.harness-visual-img\s*\{[^}]*min-height:\s*132px;[^}]*max-height:\s*196px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.voice\s*\{[^}]*padding:\s*56px 0 64px;/s);
    expect(css).toMatch(/#lightvela-intl-home \.hero__line--main \.hero__char,\s*#lightvela-intl-home \.hero__line--dynamic \.hero__char,\s*#lightvela-intl-home \.hero__line--dynamic \.hero__rotator-wrap\s*\{[^}]*animation:\s*none;[^}]*filter:\s*none;/s);
    expect(css).toMatch(/#lightvela-intl-home \.hero__line--main \.hero__char,\s*#lightvela-intl-home \.hero__line--dynamic \.hero__char\s*\{[^}]*display:\s*inline;[^}]*white-space:\s*normal;/s);
    expect(css).toMatch(/#lightvela-intl-home \.cta__grid > div:first-child\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) max-content;/s);
    expect(css).toMatch(/#lightvela-intl-home \.cta__title\s*\{[^}]*font-size:\s*clamp\(24px, 6\.6vw, 30px\);/s);
    expect(css).toMatch(/#lightvela-intl-home \.cta__acts\s*\{[^}]*grid-column:\s*2;[^}]*align-self:\s*end;/s);
    expect(css).toMatch(/#lightvela-intl-home \.foot__title\s*\{[^}]*font-size:\s*clamp\(25px, 8\.4vw, 36px\);/s);
    expect(css).toMatch(/#lightvela-intl-home \.foot__links-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s);
    expect(css).toMatch(/#lightvela-intl-home \.foot__links-grid > div:nth-child\(2\) a\s*\{[^}]*white-space:\s*normal;/s);
  });
});
