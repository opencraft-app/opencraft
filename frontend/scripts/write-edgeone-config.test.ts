import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildEdgeOneConfig,
  EDGEONE_CONFIG_FILENAME,
  main,
  resolveRegion,
  writeEdgeOneConfig,
} from './write-edgeone-config.mjs';

const tempDirs = [];

function makeOutputDir() {
  const dir = mkdtempSync(join(tmpdir(), 'edgeone-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('buildEdgeOneConfig', () => {
  it('国内站把 /zh-cn/* 一对一 301 到裸路径，且不跳首页', async () => {
    const { redirects } = buildEdgeOneConfig('cn');
    const wildcard = redirects.find((rule) => rule.source === '/zh-cn/*');

    expect(wildcard).toEqual({ source: '/zh-cn/*', destination: '/:splat', statusCode: 301 });
    // 前缀本身才允许落到首页；子路径必须保留
    expect(redirects.filter((rule) => rule.destination === '/').map((rule) => rule.source)).toEqual([
      '/zh-cn',
      '/zh-cn/',
    ]);
  });

  it('两站都把 /docs 根 301 到 /docs/overview/（含尾斜杠两种写法）', async () => {
    for (const region of ['cn', 'global']) {
      const { redirects } = buildEdgeOneConfig(region);
      const docsRules = redirects.filter((rule) => rule.destination === '/docs/overview/');

      expect(docsRules.map((rule) => rule.source)).toEqual(['/docs', '/docs/']);
      expect(docsRules.every((rule) => rule.statusCode === 301)).toBe(true);
    }
  });

  it('国际站不写 /zh-cn/ 死规则', async () => {
    const { redirects } = buildEdgeOneConfig('global');

    expect(redirects.filter((rule) => rule.source.includes('zh-cn'))).toEqual([]);
  });

  it('国际站把 /en-us/* 一对一 301 到裸路径（与国内站 /zh-cn/ 同类收敛）', async () => {
    const { redirects } = buildEdgeOneConfig('global');

    expect(redirects).toContainEqual({ source: '/en-us/*', destination: '/:splat', statusCode: 301 });
    expect(redirects.filter((rule) => rule.destination === '/').map((rule) => rule.source)).toEqual([
      '/en-us',
      '/en-us/',
    ]);
  });

  it('国内站不写 /en-us/ 死规则（国内站从来没有这套路由）', async () => {
    const { redirects } = buildEdgeOneConfig('cn');

    expect(redirects.filter((rule) => rule.source.includes('en-us'))).toEqual([]);
  });

  it('全部规则满足 EdgeOne 语法限制', async () => {
    for (const region of ['cn', 'global']) {
      const { redirects } = buildEdgeOneConfig(region);

      expect(redirects.length).toBeLessThanOrEqual(100);
      for (const rule of redirects) {
        expect(rule.source.startsWith('/')).toBe(true);
        expect((rule.source.match(/\*/g) ?? []).length).toBeLessThanOrEqual(1);
        expect(rule.source.length).toBeLessThanOrEqual(500);
        expect(rule.destination.length).toBeLessThanOrEqual(500);
        // EdgeOne 用 statusCode，没有 Vercel 的 permanent 字段
        expect(rule.statusCode).toBe(301);
        expect(rule).not.toHaveProperty('permanent');
      }
    }
  });

  it('拒绝未知 region，避免静默产出空配置', async () => {
    expect(() => buildEdgeOneConfig('cn-prod')).toThrow(/unsupported region/);
    expect(() => buildEdgeOneConfig('')).toThrow(/unsupported region/);
  });
});

describe('writeEdgeOneConfig', () => {
  it('把 edgeone.json 写到构建产物根目录', async () => {
    const outputDir = makeOutputDir();
    const { target } = writeEdgeOneConfig({ region: 'cn', outputDir });

    expect(target).toBe(join(outputDir, EDGEONE_CONFIG_FILENAME));
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    expect(parsed.redirects).toContainEqual({
      source: '/zh-cn/*',
      destination: '/:splat',
      statusCode: 301,
    });
    // 只写 redirects：buildCommand / outputDirectory 等字段会干扰「直传产物」发布模式
    expect(Object.keys(parsed)).toEqual(['redirects']);
  });
});

describe('main 的落位（最容易静默失效的一环）', () => {
  /**
   * 本项目 Next 产物是 EdgeOne Build Output 形态：上传的是 `out/.edgeone`，不是 `out`。
   * 如果 edgeone.json 写到 `out/` 根，它不会进入上传目录 —— 配置失效且无任何报错。
   * 这两条断言就是防这个陷阱。
   *
   * 用 `EDGEONE_PAGES_DIR` 注入而不是 `process.chdir()`：chdir 是进程级全局状态，
   * 会污染同一 worker 内并发执行的其它测试（实测搞坏了
   * `fix-next-static-html-lang.test.ts`，单跑却通过，很难查）。
   */
  it('存在 .edgeone 时写进 .edgeone（即真正被上传的目录）', async () => {
    const root = makeOutputDir();
    mkdirSync(join(root, 'out', '.edgeone', 'assets'), { recursive: true });

    main({ NEXT_PUBLIC_REGION: 'cn', EDGEONE_PAGES_DIR: join(root, 'out') });

    expect(existsSync(join(root, 'out', '.edgeone', EDGEONE_CONFIG_FILENAME))).toBe(true);
    expect(existsSync(join(root, 'out', EDGEONE_CONFIG_FILENAME))).toBe(false);
  });

  it('没有 .edgeone 时退回 out（纯静态导出场景）', async () => {
    const root = makeOutputDir();
    mkdirSync(join(root, 'out'), { recursive: true });

    main({ NEXT_PUBLIC_REGION: 'global', EDGEONE_PAGES_DIR: join(root, 'out') });

    const parsed = JSON.parse(readFileSync(join(root, 'out', EDGEONE_CONFIG_FILENAME), 'utf8'));
    expect(parsed.redirects.filter((rule: { source: string }) => rule.source.includes('zh-cn'))).toEqual([]);
    expect(parsed.redirects).toContainEqual({
      source: '/en-us/*',
      destination: '/:splat',
      statusCode: 301,
    });
  });

  it('region 缺失时按 cn 兜底，与 src/lib/region.ts 的默认一致', async () => {
    expect(resolveRegion({})).toBe('cn');
    expect(resolveRegion({ NEXT_PUBLIC_REGION: 'global' })).toBe('global');
    expect(resolveRegion({ VITE_REGION: 'global' })).toBe('global');
    // 非法值不应静默变成 global
    expect(resolveRegion({ NEXT_PUBLIC_REGION: 'CN' })).toBe('cn');
  });
});
