import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertValidDate,
  checkManifest,
  createLastUpdatedResolver,
  listDocSourceFiles,
  loadManifest,
  manifestFromGit,
  setDates,
  syncManifest,
} from './docs-last-updated.mjs';

const frontendRoot = join(import.meta.dirname, '..');
const tempRoots: string[] = [];

/**
 * 造一个只有 `src/content/docs` 的假 frontend 根目录。
 * `listDocSourceFiles` 支持传 root，正好可以不碰真实仓库。
 */
function makeDocsRoot(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'docs-last-updated-'));
  tempRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function makeManifest(entries: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'docs-manifest-'));
  tempRoots.push(root);
  const path = join(root, 'last-updated.json');
  writeFileSync(path, JSON.stringify(entries, null, 2));
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('assertValidDate', () => {
  it('接受 YYYY-MM-DD', async () => {
    expect(assertValidDate('a.md', '2026-08-20', '2026-08-20')).toBe('2026-08-20');
  });

  it('拒绝未来日期（假的新鲜度信号比没有更糟）', async () => {
    expect(() => assertValidDate('a.md', '2026-08-21', '2026-08-20')).toThrow(/future date/);
  });

  it('拒绝非法格式，包括带时间的 ISO 串', async () => {
    for (const bad of ['2026-8-20', '20260820', '2026-08-20T00:00:00Z', '', 'today']) {
      expect(() => assertValidDate('a.md', bad, '2026-08-20')).toThrow(/invalid date/);
    }
  });
});

describe('listDocSourceFiles', () => {
  it('递归收集 .md，忽略其它扩展名，返回相对路径且排序稳定', async () => {
    const root = makeDocsRoot({
      'src/content/docs/b.md': '# b',
      'src/content/docs/a.md': '# a',
      'src/content/docs/nested/c.md': '# c',
      'src/content/docs/images/x.webp': 'binary',
      'src/content/docs/last-updated.json': '{}',
    });

    expect(listDocSourceFiles({ root })).toEqual([
      'src/content/docs/a.md',
      'src/content/docs/b.md',
      'src/content/docs/nested/c.md',
    ]);
  });
});

describe('syncManifest', () => {
  it('补齐新文档用 today，且绝不改动已有日期', async () => {
    const manifestPath = makeManifest({ 'src/content/docs/old.md': '2026-07-01' });

    const result = syncManifest({
      manifestPath,
      files: ['src/content/docs/old.md', 'src/content/docs/new.md'],
      today: '2026-08-20',
      log: vi.fn(),
    });

    expect(result.added).toEqual(['src/content/docs/new.md']);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual({
      // 已有日期原样保留 —— 日期是人写的，脚本无权改
      'src/content/docs/old.md': '2026-07-01',
      'src/content/docs/new.md': '2026-08-20',
    });
  });

  it('清理磁盘上已不存在的幽灵条目', async () => {
    const manifestPath = makeManifest({
      'src/content/docs/kept.md': '2026-07-01',
      'src/content/docs/deleted.md': '2026-07-01',
    });

    const result = syncManifest({
      manifestPath,
      files: ['src/content/docs/kept.md'],
      today: '2026-08-20',
      log: vi.fn(),
    });

    expect(result.removed).toEqual(['src/content/docs/deleted.md']);
    expect(Object.keys(JSON.parse(readFileSync(manifestPath, 'utf8')))).toEqual([
      'src/content/docs/kept.md',
    ]);
  });

  it('清单缺条目时 resolver 返回 undefined（调用方决定回退，不编造日期）', async () => {
    const manifestPath = makeManifest({ 'src/content/docs/a.md': '2026-08-20' });
    const resolver = createLastUpdatedResolver({ manifestPath });

    expect(resolver('src/content/docs/missing.md')).toBeUndefined();
  });

  it('resolver 读到非法日期时立刻抛错，不把脏数据带进产物', async () => {
    const manifestPath = makeManifest({ 'src/content/docs/a.md': '2026/08/20' });
    const resolver = createLastUpdatedResolver({ manifestPath });

    expect(() => resolver('src/content/docs/a.md')).toThrow(/invalid date/);
  });
});

describe('setDates', () => {
  it('把指定文档批量设为同一日期（用于「本批已复核」）', async () => {
    const manifestPath = makeManifest({
      'src/content/docs/a.md': '2026-07-01',
      'src/content/docs/b.md': '2026-07-02',
    });

    const result = setDates({
      paths: ['src/content/docs/a.md', 'src/content/docs/b.md'],
      date: '2026-08-20',
      manifestPath,
      log: vi.fn(),
    });

    expect(result.changed).toBe(2);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual({
      'src/content/docs/a.md': '2026-08-20',
      'src/content/docs/b.md': '2026-08-20',
    });
  });

  it('拒绝给清单里不存在的路径设日期（避免写出幽灵条目）', async () => {
    const manifestPath = makeManifest({ 'src/content/docs/a.md': '2026-07-01' });

    expect(() =>
      setDates({ paths: ['src/content/docs/ghost.md'], date: '2026-08-20', manifestPath, log: vi.fn() }),
    ).toThrow(/not in manifest/);
  });

  it('拒绝未来日期', async () => {
    const manifestPath = makeManifest({ 'src/content/docs/a.md': '2026-07-01' });

    expect(() =>
      setDates({ paths: [], date: '2099-01-01', manifestPath, log: vi.fn() }),
    ).toThrow(/future date/);
  });
});

describe('checkManifest（真实仓库）', () => {
  /**
   * 这条是真正有价值的回归防线：清单必须与磁盘上的 204 篇文档一一对应。
   * 缺条目 → 页面没有「最后更新于」、sitemap 没有 lastmod；
   * 多条目 → 幽灵数据。两者都不该进主干。
   */
  it('当前仓库的清单与磁盘一一对应', async () => {
    expect(() => checkManifest({ log: vi.fn() })).not.toThrow();
  });

  it('默认检查项不依赖 git 历史（浅克隆的 CI 上同样可靠）', async () => {
    // 用注入点验证真实行为：checkBirthDates 关闭时，git 查询函数一次都不该被调用。
    // 不用 vi.spyOn(childProcess) —— ESM 的 module namespace 不可配置，
    // 会抛 "Cannot redefine property: execFileSync"。
    const gitFirstCommit = vi.fn(() => '2020-01-01');
    const isShallow = vi.fn(() => false);

    checkManifest({ isShallow, gitFirstCommit, log: vi.fn() });

    expect(gitFirstCommit).not.toHaveBeenCalled();
    expect(isShallow).not.toHaveBeenCalled();
  });

  it('--strict 能抓出「日期早于文件诞生日」这类手写错误', async () => {
    // 纯文件系统校验抓不到写错年月 / 复制粘贴串行，这条补上这个缺口。
    // 用假的 gitFirstCommit：真实调用要为 204 篇各跑一次 git log（约 10 秒，会超时）。
    const manifest = loadManifest();
    const target = 'src/content/docs/configuration/channel-wecom.md';
    expect(manifest[target]).toBeDefined();

    const manifestPath = makeManifest({ ...manifest, [target]: '2025-01-01' });
    const options = {
      manifestPath,
      isShallow: () => false,
      gitFirstCommit: (path: string) => (path === target ? '2026-04-27' : undefined),
      log: vi.fn(),
    };

    expect(() => checkManifest({ ...options, checkBirthDates: true })).toThrow(/predates first commit/);
    // 裸 --check 放行（它不查 git），这正是 --strict 存在的理由
    expect(() => checkManifest(options)).not.toThrow();
  });

  it('浅克隆时 --strict 自动降级，不产出误报', async () => {
    // 浅克隆下 gitFirstCommitDate 会返回 boundary 日期，据此判定「日期早于诞生日」
    // 会造成大批假问题。所以浅克隆时这项检查必须整体跳过。
    const manifest = loadManifest();
    const manifestPath = makeManifest({ ...manifest, 'src/content/docs/plans.md': '2025-01-01' });
    const gitFirstCommit = vi.fn(() => '2026-08-01');

    expect(() =>
      checkManifest({ manifestPath, checkBirthDates: true, isShallow: () => true, gitFirstCommit, log: vi.fn() }),
    ).not.toThrow();
    expect(gitFirstCommit).not.toHaveBeenCalled();
  });
});

describe('清单是唯一真源：生成产物必须与它一致', () => {
  /**
   * CR 提出的风险：`DOCS_LAST_UPDATED`（在 `next-site/docs-route-manifest.ts`）
   * 看起来像第二份手工数据，一旦与 `last-updated.json` 漂移，
   * sitemap 的 `<lastmod>` 就会错，而原有测试只校验 JSON↔磁盘，拦不住。
   *
   * 澄清：它**是** `sync-fumadocs-content.mjs:1301` 的生成产物，不是手工拷贝。
   * 但 CR 的担忧成立 —— 缺一道「产物与真源一致」的校验：
   * 有人手改产物、或改完 JSON 忘了跑 sync，都不会被发现。
   * 下面两条就是补这个缺口。
   */
  const contentRoot = join(frontendRoot, '.fumadocs-content/docs');

  function walkMdx(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walkMdx(full);
      return entry.name.endsWith('.mdx') ? [full] : [];
    });
  }

  it('每个产物页面的 last_updated 都等于真源里对应源文件的日期', async () => {
    if (!existsSync(contentRoot)) {
      throw new Error('缺少 .fumadocs-content 产物，请先跑 node scripts/sync-fumadocs-content.mjs');
    }
    const manifest = loadManifest();
    const offenders: string[] = [];

    for (const file of walkMdx(contentRoot)) {
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
      const sourcePath = /^source_path:\s*"?([^"\n]+)"?$/m.exec(frontmatter)?.[1]?.trim();
      const lastUpdated = /^last_updated:\s*"?([\d-]+)"?$/m.exec(frontmatter)?.[1]?.trim();
      if (!sourcePath) continue;

      const expected = manifest[sourcePath];
      if (expected === undefined) {
        offenders.push(`${file.slice(contentRoot.length + 1)}: source_path 不在真源里 (${sourcePath})`);
      } else if (lastUpdated !== expected) {
        offenders.push(
          `${file.slice(contentRoot.length + 1)}: 产物 ${lastUpdated ?? '(缺)'} ≠ 真源 ${expected}`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('DOCS_LAST_UPDATED 里出现的每个日期都来自真源，无凭空数据', async () => {
    const source = readFileSync(join(frontendRoot, 'next-site/docs-route-manifest.ts'), 'utf8');
    // 产物声明形如：
    //   export const DOCS_LAST_UPDATED: Record<DocsRouteLocale, Record<string, string | undefined>> = {...};
    const block = /export const DOCS_LAST_UPDATED[^=]*=\s*(\{[\s\S]*?\n\});/.exec(source)?.[1];
    expect(block).toBeDefined();

    const byLocale = JSON.parse(block!) as Record<string, Record<string, string>>;
    const allowed = new Set(Object.values(loadManifest()));
    const offenders: string[] = [];

    for (const [locale, entries] of Object.entries(byLocale)) {
      for (const [slug, date] of Object.entries(entries)) {
        if (!allowed.has(date)) offenders.push(`${locale}/${slug || '(root)'}: ${date} 不在真源日期集合内`);
      }
    }

    expect(offenders).toEqual([]);
    // 日期必须有区分度：全站同一天对 Google 是「模板批量生成」信号
    expect(allowed.size).toBeGreaterThanOrEqual(3);
  });
});

describe('--from-git 不得进构建链', () => {
  /**
   * `--from-git` 在浅克隆下会给几乎每篇文档都产出「接近构建日」的假日期
   * （CI 用 fetchDepth: 50）。它只能本地跑。
   */
  it('package.json 的构建 / dev 脚本只用裸 --check', async () => {
    const scripts = JSON.parse(readFileSync(join(frontendRoot, 'package.json'), 'utf8')).scripts as Record<
      string,
      string
    >;
    const offenders = Object.entries(scripts)
      .filter(([, command]) => command.includes('docs-last-updated.mjs'))
      .filter(([, command]) => command.includes('--from-git') || command.includes('--set-all'))
      .map(([name]) => name);

    expect(offenders).toEqual([]);
  });

  it('浅克隆时 --from-git 直接报错，而不是产出假日期', async () => {
    const gitLastModified = vi.fn(() => '2026-08-01');

    expect(() =>
      manifestFromGit({ isShallow: () => true, gitLastModified, log: vi.fn() }),
    ).toThrow(/shallow clone/);
    // 必须在跑任何 git 查询之前就拒绝
    expect(gitLastModified).not.toHaveBeenCalled();
  });

  it('完整克隆时逐篇取 git 日期，未提交改动的文档才用 today', async () => {
    const manifestPath = makeManifest({});
    const result = manifestFromGit({
      manifestPath,
      files: ['src/content/docs/a.md', 'src/content/docs/b.md', 'src/content/docs/new.md'],
      touched: ['src/content/docs/b.md'],
      today: '2026-08-21',
      isShallow: () => false,
      gitLastModified: (path: string) =>
        path === 'src/content/docs/a.md' ? '2026-08-03' : undefined,
      log: vi.fn(),
    });

    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual({
      // git 里有记录 → 用真实日期
      'src/content/docs/a.md': '2026-08-03',
      // 工作区已改但未提交 → git 查到的是旧日期，用 today 才准
      'src/content/docs/b.md': '2026-08-21',
      // 还没进版本库 → 只能算今天
      'src/content/docs/new.md': '2026-08-21',
    });
    expect(result.fromGit).toBe(1);
    expect(result.missing).toEqual(['src/content/docs/new.md']);
  });
});

