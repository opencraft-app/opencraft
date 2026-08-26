import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BASE_PAGE_EXTENSIONS,
  INTL_ONLY_PAGE_EXTENSIONS,
  isGlobalRegion,
  resolvePageExtensions,
} from '../next-site/page-extensions.mjs';

/**
 * 「仅国际站页面」的路由约定契约测试。
 *
 * ── 这条测试为什么存在 ──────────────────────────────────
 * 国内站只有 zh-CN 一种语言，裸路径即正式 URL，所以 `[lang]` 段一个参数都不需要。
 * 最初的实现是让 `generateStaticParams()` 返回空数组，本地 dev / tsc / vitest
 * 全部通过 —— 但 `next build` 直接失败：
 *
 *   Error: Page "/[lang]/about" is missing "generateStaticParams()"
 *          so it cannot be used with "output: export" config.
 *
 * 即 Next 在 `output: 'export'` 下把「返回空数组」等同于「没有这个函数」，
 * 空数组**不是**合法的「不生成任何路径」表达。
 *
 * 这个错误只在真实 `next build` 时出现（dev 不做静态导出），
 * 所以它绕过了本地全部检查，直到 MR 流水线才暴露。修复方式是用 Next 官方的
 * `pageExtensions` 按 region 排除文件：`[lang]` 下的页面用 `.intl.tsx` 后缀，
 * 只有国际站的 pageExtensions 包含它。
 *
 * 下面的断言锁定这套约定，任一环节被破坏都能在本地被拦住，
 * 不必再等 CI 跑两次完整构建（约 4 分钟）才发现。
 */

const frontendRoot = join(import.meta.dirname, '..');
const siteDir = join(frontendRoot, 'src/app/(site)');
const langRouteDir = join(siteDir, '[lang]');

/** 递归列出目录下的文件（返回相对 dir 的路径）。 */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full).map((child) => join(entry.name, child));
    return [entry.name];
  });
}

/** `[lang]` 下的页面对应的路由（相对 `[lang]`，根页面记为 ''）。 */
function langRoutes(): string[] {
  return listFiles(langRouteDir)
    .filter((file) => file.endsWith('page.intl.tsx'))
    .map((file) => file.replace(/\/?page\.intl\.tsx$/, ''))
    .sort();
}

/** 裸路径下的页面对应的路由（不含 `[lang]`，根页面记为 ''）。 */
function bareRoutes(): string[] {
  return listFiles(siteDir)
    .filter((file) => file.endsWith('page.next.tsx') && !file.startsWith('[lang]'))
    .map((file) => file.replace(/\/?page\.next\.tsx$/, ''))
    .sort();
}

describe('resolvePageExtensions', () => {
  it('国内站不识别 .intl.tsx，[lang] 段因此不存在', async () => {
    const extensions = resolvePageExtensions({ NEXT_PUBLIC_REGION: 'cn' });

    expect(extensions).toEqual(['next.tsx', 'next.ts']);
    expect(extensions).not.toContain('intl.tsx');
  });

  it('国际站识别 .intl.tsx，保留 zh-sg / zh-hant / id-id 三种语言版本', async () => {
    expect(resolvePageExtensions({ NEXT_PUBLIC_REGION: 'global' })).toEqual([
      'next.tsx',
      'next.ts',
      'intl.tsx',
      'intl.ts',
    ]);
    // VITE_REGION 是另一条等价入口（构建脚本两个都设）
    expect(resolvePageExtensions({ VITE_REGION: 'global' })).toContain('intl.tsx');
  });

  it('region 缺失或非法时按国内站处理，不会意外放行 .intl.tsx', async () => {
    for (const env of [{}, { NEXT_PUBLIC_REGION: '' }, { NEXT_PUBLIC_REGION: 'GLOBAL' }]) {
      expect(resolvePageExtensions(env)).not.toContain('intl.tsx');
      expect(isGlobalRegion(env)).toBe(false);
    }
  });

  it('两站都仍识别 .next.tsx（裸路径页面靠它，不能被误删）', async () => {
    for (const region of ['cn', 'global']) {
      const extensions = resolvePageExtensions({ NEXT_PUBLIC_REGION: region });
      for (const base of BASE_PAGE_EXTENSIONS) expect(extensions).toContain(base);
    }
  });

  it('返回新数组，调用方改动不会污染共享常量', async () => {
    const first = resolvePageExtensions({ NEXT_PUBLIC_REGION: 'global' });
    first.push('mutated.tsx');

    expect(resolvePageExtensions({ NEXT_PUBLIC_REGION: 'global' })).not.toContain('mutated.tsx');
    expect([...INTL_ONLY_PAGE_EXTENSIONS]).toEqual(['intl.tsx', 'intl.ts']);
  });
});

describe('[lang] 目录下的页面文件命名', () => {
  it('全部页面用 .intl.tsx 后缀，一个 .next.tsx 都不能有', async () => {
    // 若有人把某个文件改回 page.next.tsx，国内站会重新把它当页面，
    // generateStaticParams 返回空数组 → next build 失败。
    const files = listFiles(langRouteDir);

    expect(files.filter((file) => file.endsWith('page.next.tsx'))).toEqual([]);
    expect(files.filter((file) => file.endsWith('page.intl.tsx'))).toHaveLength(files.length);
  });

  it('generateStaticParams 来自 SEO_PREFIXED_* 常量（默认语言已排除）', async () => {
    const offenders: string[] = [];

    for (const file of listFiles(langRouteDir)) {
      const source = readFileSync(join(langRouteDir, file), 'utf8');
      if (!source.includes('generateStaticParams')) {
        offenders.push(`${file}: 缺 generateStaticParams`);
        continue;
      }
      const usesPrefixedConstant =
        source.includes('SEO_PREFIXED_PUBLIC_URL_LANGS') || source.includes('REGION_DOCS_ROUTE_LOCALES');
      if (!usesPrefixedConstant) {
        offenders.push(`${file}: generateStaticParams 未使用 SEO_PREFIXED_* 常量`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('运行时守卫与 generateStaticParams 同源（防 dev 与导出行为不一致）', async () => {
    const offenders: string[] = [];

    for (const file of listFiles(langRouteDir)) {
      // docs 页有自己的 locale 守卫，只检查公共页
      if (file.includes('docs')) continue;
      const source = readFileSync(join(langRouteDir, file), 'utf8');
      if (source.includes('publicRouteLocaleFromLang(')) {
        offenders.push(`${file}: 仍用 publicRouteLocaleFromLang（含全部 5 种语言，与生成集合不一致）`);
      }
      if (!source.includes('prefixedPublicRouteLocale(')) {
        offenders.push(`${file}: 未使用 prefixedPublicRouteLocale 守卫`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('[lang] 与裸路径的对应关系', () => {
  /**
   * 单向约定：`[lang]` 里的每个页面都必须有对应的裸路径页面。
   *
   * 反向**不要求** —— 裸路径下还有登录后的应用页（account、agents、
   * plans/select、websites 等），它们不是公开营销页，不需要语言前缀版本。
   * 最初写成「两侧数量相等」，实测 16 vs 10，是错误假设。
   */
  it('每个 [lang] 页面都有对应的裸路径页面', async () => {
    const bare = new Set(bareRoutes());
    const missing = langRoutes().filter((route) => !bare.has(route));

    expect(missing).toEqual([]);
  });

  it('公开营销页在两侧都齐全（漏一个就是某语言少一页）', async () => {
    const lang = new Set(langRoutes());
    const publicRoutes = [
      '',
      'about',
      'changelog',
      'cookie-policy',
      'docs/[[...slug]]',
      'open-source-licenses',
      'privacy-policy',
      'subscribe',
      'terms-of-service',
    ];

    expect(langRoutes()).toEqual([...publicRoutes].sort());
    for (const route of publicRoutes) expect(lang.has(route)).toBe(true);
  });

  it('裸路径页面不受影响，仍用 .next.tsx', async () => {
    const bare = bareRoutes();

    for (const route of ['', 'about', 'changelog', 'docs/[[...slug]]', 'subscribe']) {
      expect(bare).toContain(route);
    }
    // 应用页也必须还在（它们只有裸路径版本）
    for (const route of ['account', 'agents', 'websites']) {
      expect(bare).toContain(route);
    }
  });
});

describe('约定的可追溯性', () => {
  it('page-extensions.mjs 里记录了空数组不可用的原因', async () => {
    // 这条不是形式主义：下一个人看到「国内站 pageExtensions 少两项」时，
    // 第一反应大概是「统一成一份不是更简单吗」。原因必须留在代码里。
    const source = readFileSync(join(frontendRoot, 'next-site/page-extensions.mjs'), 'utf8');

    expect(source).toContain('missing "generateStaticParams()"');
    expect(source).toMatch(/output: 'export'/);
  });

  it('[lang] 目录确实存在且非空（防止误删整个国际站语言路由）', async () => {
    expect(statSync(langRouteDir).isDirectory()).toBe(true);
    expect(langRoutes().length).toBeGreaterThanOrEqual(9);
  });
});
