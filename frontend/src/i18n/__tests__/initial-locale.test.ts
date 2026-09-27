import { afterEach, describe, expect, it, vi } from "vitest";

async function loadI18n(
  region: "cn" | "global",
  pathname: string,
  previewLocales?: string,
) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_REGION", region);
  if (previewLocales) {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_PREVIEW_LOCALES", previewLocales);
  }
  window.history.replaceState(null, "", pathname);
  return import("@/i18n");
}

afterEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("i18n initial locale", () => {
  it("keeps the global bare root in English when localStorage has stale Chinese", async () => {
    window.localStorage.setItem("lw-locale", "zh-CN");

    const { default: i18n } = await loadI18n("global", "/");

    expect(i18n.language).toBe("en-US");
    const { hadSavedLocaleBeforeInitialPage } = await import("@/i18n");
    expect(hadSavedLocaleBeforeInitialPage).toBe(true);
  });

  it("captures a first visit before persisting the bare home's default English", async () => {
    const { default: i18n, hadSavedLocaleBeforeInitialPage } = await loadI18n("global", "/");

    expect(hadSavedLocaleBeforeInitialPage).toBe(false);
    expect(i18n.language).toBe("en-US");
    expect(window.localStorage.getItem("lw-locale")).toBe("en-US");
  });

  /**
   * 回归防护：裸 `/subscribe`（无语言前缀）代表默认英文版本——`journeyHref`/
   * `publicSiteHref` 生成的英文 CTA 链接正是这个裸路径。此前只有根路径 `/`
   * 有「忽略陈旧 localStorage」的保护，`/subscribe` 等同样受 URL 本地化管理
   * 的公开页面没有，导致从首页（强制英文）点 CTA 跳到 /subscribe 后，
   * 页面又读到陈旧的 zh-CN localStorage，语言从英文跳回简体中文。
   */
  it("keeps the global bare /subscribe in English when localStorage has stale Chinese", async () => {
    window.localStorage.setItem("lw-locale", "zh-CN");

    const { default: i18n } = await loadI18n("global", "/subscribe");

    expect(i18n.language).toBe("en-US");
  });

  it("keeps other bare public localized routes in English when localStorage has stale Chinese", async () => {
    window.localStorage.setItem("lw-locale", "zh-CN");

    const { default: i18n } = await loadI18n("global", "/docs/overview");

    expect(i18n.language).toBe("en-US");
  });

  /**
   * 回归防护（英文用户进 /agents 控制台显示中文）：英文是默认语、走裸 URL，
   * initialLocaleFromPath 恒为空。此前只把「带前缀」的语言意图写入 lw-locale，
   * 裸英文页从不写，导致存储里残留的旧中文值会顺延到 /agents 等无 URL 语言信号的
   * 控制台，把英文用户的控制台顶成中文。裸英文公开页必须把 en-US 落到 lw-locale，
   * 覆盖残留值，保证跨路径（公开页 → 控制台）语言连续。
   */
  it("persists en-US for a bare English public page, overwriting stale Chinese", async () => {
    window.localStorage.setItem("lw-locale", "zh-CN");

    const { default: i18n } = await loadI18n("global", "/subscribe");

    expect(i18n.language).toBe("en-US");
    expect(window.localStorage.getItem("lw-locale")).toBe("en-US");
  });

  it("keeps the console in English after arriving from a bare English page", async () => {
    // 用户在裸英文公开页（残留中文被覆盖为 en-US）
    window.localStorage.setItem("lw-locale", "zh-CN");
    await loadI18n("global", "/");
    expect(window.localStorage.getItem("lw-locale")).toBe("en-US");

    // 随后跳进无 URL 语言信号的 /agents 控制台：应读到 en-US 而非残留中文
    const { default: consoleI18n } = await loadI18n("global", "/agents");
    expect(consoleI18n.language).toBe("en-US");
  });

  it("does not persist a locale for bare console routes themselves", async () => {
    // /agents 不是「表达语言意图」的页面，不应由它写 lw-locale（它是消费方）
    window.localStorage.clear();

    await loadI18n("global", "/agents");

    expect(window.localStorage.getItem("lw-locale")).toBeNull();
  });

  it("keeps explicit global Chinese routes in Chinese", async () => {
    window.localStorage.setItem("lw-locale", "en-US");

    const { default: i18n } = await loadI18n("global", "/zh-sg/");

    expect(i18n.language).toBe("zh-CN");
  });

  it("keeps explicit global Indonesian routes in Indonesian", async () => {
    window.localStorage.setItem("lw-locale", "en-US");

    const { default: i18n } = await loadI18n("global", "/id-id/");

    expect(i18n.language).toBe("id-ID");
  });

  it("keeps explicit global Spanish routes in Spanish and persists the locale", async () => {
    window.localStorage.setItem("lw-locale", "en-US");

    const { default: i18n } = await loadI18n("global", "/es/subscribe");

    expect(i18n.language).toBe("es");
    expect(window.localStorage.getItem("lw-locale")).toBe("es");
  });

  it("keeps the published Japanese dictionary out of the bare-root bundle and loads it on demand", async () => {
    const { default: i18n, ensureLocaleDictionary } = await loadI18n("global", "/");

    expect(i18n.hasResourceBundle("ja-JP", "translation")).toBe(false);
    await ensureLocaleDictionary("ja-JP");
    expect(i18n.hasResourceBundle("ja-JP", "translation")).toBe(true);
    expect(Object.values(i18n.getResourceBundle("ja-JP", "translation") as Record<string, string>).join(""))
      .toMatch(/[ぁ-んァ-ヶ]/);
  });

  it("loads and persists Japanese from the published URL", async () => {
    const { default: i18n } = await loadI18n("global", "/ja-jp/");

    expect(i18n.language).toBe("ja-JP");
    expect(i18n.hasResourceBundle("ja-JP", "translation")).toBe(true);
    expect(window.localStorage.getItem("lw-locale")).toBe("ja-JP");
  });

  it("loads and persists Japanese from an explicit local preview URL", async () => {
    const { default: i18n } = await loadI18n("global", "/ja-jp/", "ja-JP");

    expect(i18n.language).toBe("ja-JP");
    expect(i18n.hasResourceBundle("ja-JP", "translation")).toBe(true);
    expect(window.localStorage.getItem("lw-locale")).toBe("ja-JP");
  });

  it("restores the published Japanese localStorage override", async () => {
    window.localStorage.setItem("lw-locale", "ja-JP");

    const { default: i18n } = await loadI18n("global", "/agents");

    expect(i18n.language).toBe("ja-JP");
    expect(i18n.hasResourceBundle("ja-JP", "translation")).toBe(true);
  });

  it("switches to published Japanese through the public setter", async () => {
    const { default: i18n, setLocale } = await loadI18n("global", "/agents");

    setLocale("ja-JP");

    await vi.waitFor(() => expect(i18n.language).toBe("ja-JP"));
    expect(window.localStorage.getItem("lw-locale")).toBe("ja-JP");
  });

  /* 韩语与日语同为懒加载字典，走完全相同的持久化 / 恢复路径。这里对韩语单独实锤，
     确保「韩语公开页 → 控制台」链路语言连续（issue #73 多语言红线）。 */
  it("loads and persists Korean from the published URL", async () => {
    const { default: i18n } = await loadI18n("global", "/ko-kr/");

    expect(i18n.language).toBe("ko-KR");
    expect(i18n.hasResourceBundle("ko-KR", "translation")).toBe(true);
    expect(window.localStorage.getItem("lw-locale")).toBe("ko-KR");
  });

  it("restores Korean from the localStorage override on the console route", async () => {
    // 模拟：用户在 /ko-kr/subscribe 已把 lw-locale 写成 ko-KR，随后跳无 URL 语言信号的 /agents
    window.localStorage.setItem("lw-locale", "ko-KR");

    const { default: i18n } = await loadI18n("global", "/agents");

    expect(i18n.language).toBe("ko-KR");
    // 懒加载的韩语字典应已加载，且内容含韩文谚文（U+AC00–U+D7A3）
    expect(i18n.hasResourceBundle("ko-KR", "translation")).toBe(true);
    expect(Object.values(i18n.getResourceBundle("ko-KR", "translation") as Record<string, string>).join(""))
      .toMatch(/[\uAC00-\uD7A3]/);
  });

  it("keeps the domestic site in Chinese when localStorage has stale English", async () => {
    window.localStorage.setItem("lw-locale", "en-US");

    const { default: i18n } = await loadI18n("cn", "/");

    expect(i18n.language).toBe("zh-CN");
  });

  /**
   * 控制台等路径（/agents、/auth）刻意不做 URL 本地化，只能依赖 localStorage
   * 延续语言。因此从带语言前缀的公开页进入时，必须把该语言持久化下来，
   * 否则「从 /id-id/ 跳到 /agents」会回退成英文。
   */
  it("persists the locale resolved from an explicit URL prefix", async () => {
    window.localStorage.clear();

    const { default: i18n } = await loadI18n("global", "/id-id/subscribe");

    expect(i18n.language).toBe("id-ID");
    expect(window.localStorage.getItem("lw-locale")).toBe("id-ID");
  });

  it("keeps non-localized console routes in the persisted locale", async () => {
    window.localStorage.setItem("lw-locale", "id-ID");

    const { default: i18n } = await loadI18n("global", "/agents");

    expect(i18n.language).toBe("id-ID");
  });
});

/*
 * 全语种矩阵：逐个实测 8 个发布语种，两条链路都覆盖——
 *   A. 从带语言前缀的公开页进入 → i18n.language 与 lw-locale 均为该语种；
 *   B. 从 lw-locale 恢复进入无 URL 语言信号的 /agents 控制台 → 语言仍为该语种，字典已就绪。
 * 对 CJK（简/繁/日/韩）额外断言字典内容含对应脚本字符，证明不是回退到别的语言。
 * zh-SG 是 URL 别名，运行时语言归并到 zh-CN 字典（i18nKey=zh-CN），单独验证归并正确。
 */
describe("i18n every published locale round-trips through the console", () => {
  afterEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  type LocaleCase = {
    label: string;
    urlPath: string;      // 带语言前缀的公开页
    dictKey: string;      // 运行时 i18n.language（= i18nKey）
    /** 该语种字典应命中的脚本正则；拉丁语系不做脚本断言 */
    script?: RegExp;
  };

  // 汉字 U+4E00–U+9FFF；日文假名 U+3040–U+30FF；韩文谚文 U+AC00–U+D7A3
  const CASES: LocaleCase[] = [
    { label: "English",              urlPath: "/en-us/subscribe",   dictKey: "en-US" },
    { label: "简体中文",             urlPath: "/zh-cn/subscribe",   dictKey: "zh-CN",   script: /[\u4E00-\u9FFF]/ },
    { label: "简体(zh-sg 别名)",     urlPath: "/zh-sg/subscribe",   dictKey: "zh-CN",   script: /[\u4E00-\u9FFF]/ },
    { label: "繁體中文",             urlPath: "/zh-hant/subscribe", dictKey: "zh-Hant", script: /[\u4E00-\u9FFF]/ },
    { label: "Bahasa Indonesia",     urlPath: "/id-id/subscribe",   dictKey: "id-ID" },
    { label: "Español",              urlPath: "/es/subscribe",      dictKey: "es" },
    { label: "日本語",               urlPath: "/ja-jp/subscribe",   dictKey: "ja-JP",   script: /[\u3040-\u30FF]/ },
    { label: "한국어",               urlPath: "/ko-kr/subscribe",   dictKey: "ko-KR",   script: /[\uAC00-\uD7A3]/ },
  ];

  it.each(CASES)(
    "A) $label: entering $urlPath resolves the language and persists lw-locale",
    async ({ urlPath, dictKey }) => {
      const { default: i18n } = await loadI18n("global", urlPath);

      expect(i18n.language).toBe(dictKey);
      expect(window.localStorage.getItem("lw-locale")).toBe(dictKey);
      expect(i18n.hasResourceBundle(dictKey, "translation")).toBe(true);
    },
  );

  it.each(CASES)(
    "B) $label: restoring lw-locale=$dictKey keeps /agents console in that language",
    async ({ dictKey, script }) => {
      // 模拟用户先在公开页把语言落盘，再跳无 URL 语言信号的控制台
      window.localStorage.setItem("lw-locale", dictKey);

      const { default: i18n } = await loadI18n("global", "/agents");

      expect(i18n.language).toBe(dictKey);
      expect(i18n.hasResourceBundle(dictKey, "translation")).toBe(true);

      if (script) {
        const dict = i18n.getResourceBundle(dictKey, "translation") as Record<string, string>;
        // 控制台空状态标语（k_40a58d40）应为该语种译文，不是回退语言
        expect(dict["k_40a58d40"]).toBeTruthy();
        expect(Object.values(dict).join("")).toMatch(script);
      }
    },
  );
});
