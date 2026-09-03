import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Sitemap 契约测试。
 *
 * 背景：国内站 `lightvela.com` 只有一种语言（zh-CN），裸路径即唯一正式 URL。
 * 历史实现存在两个真实缺陷，本测试用于防回归：
 *
 * 1. 国内站 sitemap 会输出 `/zh-cn/*` 一整套重复条目，与 self-canonical（裸路径）矛盾；
 * 2. `.filter((slug) => !globalBuild || slug.length > 0)` 条件写反 —— `!globalBuild`
 *    在国内站恒为 true，导致国内站**从未**排除 `/docs/`（该 URL 返回 200，
 *    正文与 `/docs/overview/` 相同，canonical 指向 `/docs/overview/`）。
 */

// manifest 是构建期生成产物（国内站只含 zh-cn，国际站含 6 个 locale），
// 这里固定为全量 locale，以便同一份 mock 同时验证两个 region 的分支。
const MOCK_LOCALES = ['en-us', 'zh-cn', 'zh-sg', 'zh-hant', 'id-id', 'es'] as const;
const MOCK_SLUGS = [[], ['overview'], ['plans']] as const;
/** 每篇文档一个不同日期，用来验证 lastmod 是**逐 URL**取值，而不是全站同一个时间。 */
const MOCK_LAST_UPDATED: Record<string, string> = {
  '': '2026-08-01',
  overview: '2026-08-01',
  plans: '2026-07-15',
};

vi.mock('@next-site/docs-route-manifest', () => ({
  DOCS_ROUTE_LOCALES: MOCK_LOCALES,
  DOCS_ROUTE_SLUGS: Object.fromEntries(
    MOCK_LOCALES.map((locale) => [
      locale,
      // 空 slug 代表 `/docs/`，它是重复 URL（canonical 指向 overview），不应进 sitemap
      MOCK_SLUGS.map((slug) => [...slug]),
    ]),
  ),
  docsLastUpdated: (_locale: string, slug: readonly string[] = []) => MOCK_LAST_UPDATED[slug.join('/')],
}));

async function sitemapForRegion(region: 'cn' | 'global') {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_REGION', region);
  vi.stubEnv('VITE_REGION', region);
  for (const key of [
    'NEXT_PUBLIC_SITE_URL',
    'SITE_URL',
    'NEXT_PUBLIC_CN_SITE_URL',
    'CN_SITE_URL',
    'NEXT_PUBLIC_GLOBAL_SITE_URL',
    'NEXT_PUBLIC_INTL_SITE_URL',
    'GLOBAL_SITE_URL',
    'INTL_SITE_URL',
  ]) {
    vi.stubEnv(key, '');
  }

  const { GET } = await import('../route.next');
  const xml = await new Response(GET().body).text();
  // 用 flatMap + ?? [] 过滤掉可能的 undefined 捕获组，
  // 让返回类型收窄为 string[] —— 项目开了 noUncheckedIndexedAccess，
  // 直接 map(match => match[1]) 会得到 (string | undefined)[]，
  // 下游每处断言都要加非空断言，反而把类型噪音扩散出去。
  return {
    xml,
    locs: [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].flatMap((match) => match[1] ?? []),
    hreflangs: [...xml.matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)].flatMap((match) =>
      match[1] !== undefined && match[2] !== undefined
        ? [{ hreflang: match[1], href: match[2] }]
        : [],
    ),
    /** 每个 <url> 块里的 loc → lastmod（缺 lastmod 时为 undefined）。 */
    lastmodByLoc: Object.fromEntries(
      [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/g)].flatMap(
        (match) => (match[1] !== undefined ? [[match[1], match[2]] as const] : []),
      ),
    ) as Record<string, string | undefined>,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('sitemap.xml — 国内站（cn）', () => {
  it('只输出 lightvela.com 的裸路径，绝不输出 /zh-cn/ 前缀条目', async () => {
    const { locs } = await sitemapForRegion('cn');

    expect(locs.every((loc) => loc.startsWith('https://lightvela.com/'))).toBe(true);
    expect(locs.filter((loc) => loc.includes('/zh-cn/'))).toEqual([]);
  });

  it('收录全部公共页与文档页，且不含重复的 /docs/', async () => {
    const { locs } = await sitemapForRegion('cn');

    expect(locs).toEqual([
      'https://lightvela.com/',
      'https://lightvela.com/about/',
      'https://lightvela.com/changelog/',
      'https://lightvela.com/privacy-policy/',
      'https://lightvela.com/terms-of-service/',
      'https://lightvela.com/cookie-policy/',
      'https://lightvela.com/open-source-licenses/',
      'https://lightvela.com/docs/overview/',
      'https://lightvela.com/docs/plans/',
    ]);
    expect(locs).not.toContain('https://lightvela.com/docs/');
  });

  it('hreflang="zh-CN" 指向 lightvela.com 裸路径（不是需 301 的 /zh-cn/）', async () => {
    const { hreflangs } = await sitemapForRegion('cn');
    const zhCn = hreflangs.filter((entry) => entry.hreflang === 'zh-CN');

    expect(zhCn.length).toBeGreaterThan(0);
    expect(zhCn.every((entry) => !entry.href.includes('/zh-cn/'))).toBe(true);
    expect(zhCn.map((entry) => entry.href)).toContain('https://lightvela.com/docs/overview/');
  });
});

describe('sitemap.xml — 国际站（global）', () => {
  it('输出 zh-sg / zh-hant / id-id 前缀条目，但 en-US 与 zh-CN 走裸路径', async () => {
    const { locs, xml } = await sitemapForRegion('global');

    expect(locs).toContain('https://lightvela.ai/');
    expect(locs).toContain('https://lightvela.ai/zh-sg/about/');
    expect(locs).toContain('https://lightvela.ai/blog/');
    expect(locs).toContain('https://lightvela.ai/blog/using-hermes-agent-as-a-discord-bot/');
    expect(locs).toContain('https://lightvela.ai/zh-hant/blog/');
    expect(locs).toContain('https://lightvela.ai/zh-hant/blog/using-hermes-agent-as-a-discord-bot/');
    expect(xml).not.toContain('https://lightvela.com/blog/');
    expect(locs).toContain('https://lightvela.ai/zh-hant/docs/plans/');
    expect(locs).toContain('https://lightvela.ai/id-id/docs/overview/');
    // 默认语言不再有第二套前缀 URL
    expect(locs.filter((loc) => loc.includes('/en-us/'))).toEqual([]);
    // 国际站 sitemap 也不应出现国内站域名或 /zh-cn/ 前缀
    expect(locs.filter((loc) => loc.includes('/zh-cn/'))).toEqual([]);
  });

  it('同样排除重复的 /docs/ 空 slug', async () => {
    const { locs } = await sitemapForRegion('global');

    expect(locs.filter((loc) => /\/docs\/$/.test(loc))).toEqual([]);
  });

  it('hreflang="zh-CN" 跨域指向 lightvela.com 裸路径', async () => {
    const { hreflangs } = await sitemapForRegion('global');
    const zhCn = hreflangs.filter((entry) => entry.hreflang === 'zh-CN');

    expect(zhCn.length).toBeGreaterThan(0);
    expect(zhCn.every((entry) => entry.href.startsWith('https://lightvela.com/'))).toBe(true);
    expect(zhCn.every((entry) => !entry.href.includes('/zh-cn/'))).toBe(true);
  });

  it('英文正文 Blog 只声明英文与默认 hreflang，不互指未翻译语言', async () => {
    const { hreflangs } = await sitemapForRegion('global');
    const blogHreflangs = hreflangs.filter((entry) => entry.href.includes('/blog/'));

    expect(blogHreflangs.length).toBeGreaterThan(0);
    expect(blogHreflangs.every((entry) => entry.hreflang === 'x-default' || entry.hreflang === 'en-US')).toBe(true);
  });
});

describe('sitemap.xml — lastmod 语义', () => {
  /**
   * 历史问题：`lastmod` 取构建时间（`NEXT_PUBLIC_BUILD_DATE`），
   * 于是每天重新构建都让全站 lastmod 变化。Google 官方要求 lastmod
   * 必须一致准确，否则整个信号会被忽略。
   */
  it('文档页 lastmod 逐 URL 取内容更新日期，而不是全站同一个时间', async () => {
    const { lastmodByLoc } = await sitemapForRegion('cn');

    expect(lastmodByLoc['https://lightvela.com/docs/overview/']).toBe('2026-08-01');
    expect(lastmodByLoc['https://lightvela.com/docs/plans/']).toBe('2026-07-15');
  });

  it('营销 / 法律页不输出 lastmod（没有可靠的内容更新时间，省略比编造好）', async () => {
    const { lastmodByLoc } = await sitemapForRegion('cn');

    for (const loc of [
      'https://lightvela.com/',
      'https://lightvela.com/about/',
      'https://lightvela.com/changelog/',
      'https://lightvela.com/privacy-policy/',
    ]) {
      expect(lastmodByLoc[loc]).toBeUndefined();
    }
  });

  it('lastmod 一律是纯日期，不含构建时刻（时刻会让每次构建都变）', async () => {
    const { xml } = await sitemapForRegion('global');
    const values = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].flatMap((match) => match[1] ?? []);

    expect(values.length).toBeGreaterThan(0);
    expect(values.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))).toBe(true);
  });

  it('国际站各语言版本沿用同一份内容日期', async () => {
    const { lastmodByLoc } = await sitemapForRegion('global');

    expect(lastmodByLoc['https://lightvela.ai/docs/plans/']).toBe('2026-07-15');
    expect(lastmodByLoc['https://lightvela.ai/zh-sg/docs/plans/']).toBe('2026-07-15');
    expect(lastmodByLoc['https://lightvela.ai/id-id/docs/overview/']).toBe('2026-08-01');
  });
});
