import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REGION_CN, REGION_GLOBAL, resolveRegion as resolveRegionFromEnv } from '../next-site/region.mjs';
import { resolveDeployDir } from './deploy-edgeone-pages.mjs';

/**
 * 生成 EdgeOne Pages 的 `edgeone.json`（只含 redirects），随构建产物一起发布。
 *
 * 为什么必须由构建期生成、而不是在仓库里放一份静态文件：
 * 1. 国内站与国际站是**同一份源码、两次构建**（`build:cn` / `build:global`），
 *    但需要的 301 规则不同 —— `/zh-cn/*` 只存在于国内站；
 * 2. 发布链路是「直传构建产物」（`edgeone makers deploy <dir>`，见
 *    `scripts/deploy-edgeone-pages.mjs`），EdgeOne 不会去读源码仓库根目录，
 *    配置必须躺在上传目录的根上。
 *
 * ⚠️ 静态导出（`output: 'export'`）下 Next 的 `redirects()` 完全不生效，
 * 这是唯一能让 301 进版本控制的位置。
 *
 * 语法约束（EdgeOne Makers 官方文档）：
 * - 不支持正则；只有精确路径、`:param`（单级）、`*`（通配，destination 用 `:splat`）；
 * - `source` 中最多一个 `*`；
 * - redirects 上限 100 条，source / destination 各 ≤ 500 字符；
 * - 用 `statusCode: 301`，**没有** Vercel 那种 `permanent` 字段。
 */

export const EDGEONE_CONFIG_FILENAME = 'edgeone.json';

/**
 * 文档站根路径 `/docs/` 返回 200，渲染的内容与 `/docs/overview/` 相同，
 * 其 canonical 已指向 `/docs/overview/`（实测两站一致）。
 * 即它是一个**真实存在的重复 URL**，靠 canonical 兜着 —— 301 更干净，
 * 且两个站点都需要。
 *
 * 注意 `trailingSlash: true`，线上真实 URL 带尾斜杠；EdgeOne 是否在匹配时
 * 归一化尾斜杠没有文档保证，故两种写法都登记（多一条规则的成本可忽略）。
 */
function docsRootRedirects() {
  return [
    { source: '/docs', destination: '/docs/overview/', statusCode: 301 },
    { source: '/docs/', destination: '/docs/overview/', statusCode: 301 },
  ];
}

/**
 * 国内站曾经生成过一整套 `/zh-cn/*` 前缀页面（返回 200，与裸路径重复）。
 * 现在这些路由已不再生成，若不配 301 就会变 404，历史索引与旧分享链接直接丢弃。
 *
 * 规则一对一映射、保留完整子路径，**不允许**全部跳首页。
 */
function zhCnPrefixRedirects() {
  return [
    // 精确两条兜住前缀本身（`*` 是否匹配空串无文档保证）
    { source: '/zh-cn', destination: '/', statusCode: 301 },
    { source: '/zh-cn/', destination: '/', statusCode: 301 },
    // 通配一条覆盖全部子路径：/zh-cn/docs/plans/ → /docs/plans/
    { source: '/zh-cn/*', destination: '/:splat', statusCode: 301 },
  ];
}

/**
 * 国际站默认语言 en-US 曾经也生成一整套 `/en-us/*` 前缀页面（返回 200，与裸路径重复），
 * 与国内站 `/zh-cn/` 是同一类问题。现已停止生成，同样需要 301 兜住历史索引。
 */
function enUsPrefixRedirects() {
  return [
    { source: '/en-us', destination: '/', statusCode: 301 },
    { source: '/en-us/', destination: '/', statusCode: 301 },
    { source: '/en-us/*', destination: '/:splat', statusCode: 301 },
  ];
}

export function buildEdgeOneConfig(region) {
  if (region !== REGION_CN && region !== REGION_GLOBAL) {
    throw new Error(`[write-edgeone-config] unsupported region: ${region}`);
  }

  const redirects = region === REGION_CN
    ? [...zhCnPrefixRedirects(), ...docsRootRedirects()]
    // 国际站没有、也从未有过 `/zh-cn/` 路由，加规则只会变成死配置。
    : [...enUsPrefixRedirects(), ...docsRootRedirects()];

  if (redirects.length > 100) {
    throw new Error(`[write-edgeone-config] redirects exceed EdgeOne limit: ${redirects.length} > 100`);
  }
  for (const rule of redirects) {
    if (!rule.source.startsWith('/')) {
      throw new Error(`[write-edgeone-config] source must start with "/": ${rule.source}`);
    }
    if ((rule.source.match(/\*/g) ?? []).length > 1) {
      throw new Error(`[write-edgeone-config] source allows at most one "*": ${rule.source}`);
    }
    if (rule.source.length > 500 || rule.destination.length > 500) {
      throw new Error(`[write-edgeone-config] source/destination must be <= 500 chars: ${rule.source}`);
    }
  }

  return { redirects };
}

export function writeEdgeOneConfig({ region, outputDir }) {
  const config = buildEdgeOneConfig(region);
  const target = join(outputDir, EDGEONE_CONFIG_FILENAME);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { target, config };
}

export function resolveRegion(env = process.env) {
  return resolveRegionFromEnv(env);
}

export function main(env = process.env) {
  const region = resolveRegion(env);
  /*
   * 必须写进「真正会被上传的那个目录根」。
   *
   * 本项目的 Next 产物是 EdgeOne Build Output 形态：静态文件在 `out/.edgeone/assets/`，
   * 而 `deploy-edgeone-pages.mjs` 的 `resolveDeployDir()` 上传的是 `out/.edgeone`
   * （只有在没有 `.edgeone` 时才退回 `out`）。若无脑写 `out/edgeone.json`，
   * 文件根本不会进入上传目录 —— 配置静默失效，且没有任何报错。
   *
   * 所以这里直接复用 `resolveDeployDir()`，保证两处判定永远一致；
   * 它同时支持 `EDGEONE_PAGES_DIR` 覆盖，测试因此不需要 `process.chdir()`
   * （chdir 是进程级全局状态，并发跑测试时会污染同 worker 内的其它用例）。
   */
  const outputDir = env.EDGEONE_CONFIG_OUTPUT_DIR?.trim() || resolveDeployDir(env);

  const { target, config } = writeEdgeOneConfig({ region, outputDir });
  console.log(
    `[write-edgeone-config] wrote ${config.redirects.length} redirect rule(s) for region=${region} to ${target}`,
  );
}

const currentModulePath = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] && resolve(process.argv[1]) === currentModulePath;

if (isMainModule) {
  main();
}
