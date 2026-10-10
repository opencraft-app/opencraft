import { createMDX } from 'fumadocs-mdx/next';
import { fileURLToPath } from 'node:url';

import { isGlobalRegion, resolvePageExtensions } from './next-site/page-extensions.mjs';

const teaThemeableResetCss = '@tencent/tea-component/dist/tea-themeable.css';
const teaThemeableNoResetCss = '@tencent/tea-component/dist/tea-no-reset.css';
const isDevelopment = process.env.NODE_ENV === 'development';
// Temporary preview domains are explicitly opted in by the local dev service.
const previewDevOrigins = isDevelopment
  ? (process.env.NEXT_DEV_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
  : [];
const isLocalProxy = (process.env.NEXT_PUBLIC_AUTH_API_BASE_URL || process.env.VITE_AUTH_API_BASE_URL || '').trim().toLowerCase() === 'local-proxy';
const localProxyTarget = (
  process.env.NEXT_PUBLIC_LOCAL_PROXY_TARGET
  || process.env.VITE_LOCAL_PROXY_TARGET
  || (isGlobalRegion()
    ? 'https://api.lightvela.ai'
    : 'https://lightclaw.tech')
).replace(/\/$/, '');

const localProxyRewrites = isLocalProxy
  ? [
      {
        source: '/auth/:path*',
        destination: `${localProxyTarget}/auth/:path*`,
      },
      {
        source: '/subscriptions/:path*',
        destination: `${localProxyTarget}/subscriptions/:path*`,
      },
      {
        source: '/support/feedback/:path*',
        destination: `${localProxyTarget}/support/feedback/:path*`,
      },
      {
        source: '/v1/:path*',
        destination: `${localProxyTarget}/v1/:path*`,
      },
      {
        source: '/api/worker-actions/:path*',
        destination: `${localProxyTarget}/api/worker-actions/:path*`,
      },
    ]
  : [];

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  devIndicators: false,
  // 只在本地开发时允许双 dev 实例使用独立 dist 目录，避免影响 CI / export build。
  distDir: isDevelopment && process.env.NEXT_DIST_DIR ? process.env.NEXT_DIST_DIR : '.next',
  transpilePackages: ['@lightvela/collaboration-web', '@lightvela/vela-chat-client-core', 'velachat', '@lightvela/agent-core', '@opencraft/mobile-account-sdk', '@opencraft/mobile-bot-bridge', '@opencraft/workbench-panels'],
  output: isDevelopment ? undefined : 'export',
  assetPrefix: process.env.NEXT_PUBLIC_ASSET_PREFIX || undefined,
  trailingSlash: true,
  // 桥接 VITE_AUTH_API_BASE_URL 到客户端 bundle，供 datong.ts 推断部署环境使用。
  // Next.js 只内联 NEXT_PUBLIC_* 变量，VITE_* 需通过 env 显式暴露到客户端。
  env: {
    VITE_AUTH_API_BASE_URL: process.env.NEXT_PUBLIC_AUTH_API_BASE_URL || process.env.VITE_AUTH_API_BASE_URL || '',
    // 国内站只发布中文，其余字典按需加载（见 src/i18n/index.ts）。这里由 Next
    // 内联成字面量，打包器才能把未用到的 JSON 当死代码消除。
    //
    // 不能让 src/i18n/index.ts 直接读 NEXT_PUBLIC_REGION：该文件被 vendoring 进
    // opencraft 嵌入式工作台，而那边的 Vite 把 NEXT_PUBLIC_REGION 固定替换成
    // 'cn'（见 opencraft/apps/workbench-web/vite.config.ts 的 vendoredEnvKeys），
    // 会连带把国际站嵌入式控制台的英文字典一起裁掉。换成本变量后，嵌入式构建
    // 取到空值即保持全量同步装载。
    NEXT_PUBLIC_I18N_LAZY_LOCALES: isGlobalRegion() ? '0' : '1',
  },
  allowedDevOrigins: ['lightvela.ai', 'www.lightvela.ai', 'lightvela.com', 'lightvela.tencent.com', 'localhost', '127.0.0.1', 'lightclaw.pages.dev','intl-sandbox-kr-1.preview.lightclaw.tech','frontend.sandbox-bj-7.lightclaw.tech', ...previewDevOrigins],
  // `.intl.tsx` = 仅国际站存在的页面（当前是 src/app/(site)/[lang]/**）。
  // 为什么不能用「generateStaticParams 返回空数组」表达国内站不需要 [lang]，
  // 见 next-site/page-extensions.mjs 的注释（Next 在 output: 'export' 下会报
  // missing "generateStaticParams()" 并中断构建）。
  pageExtensions: resolvePageExtensions(),
  ...(isDevelopment
    ? {
        async rewrites() {
          return [
            ...localProxyRewrites,
            {
              source: '/__skillhub_api/:path*',
              destination: 'https://api.skillhub.cn/:path*',
            },
          ];
        },
      }
    : {}),
  images: {
    unoptimized: true,
  },
  turbopack: {
    root: fileURLToPath(new URL('..', import.meta.url)),
    resolveAlias: {
      // AgentChat pulls Tea UI styles as a side effect. Use Tea's no-reset
      // build so the chat page cannot globally reset host page elements.
      // 历史：SDK @tencent/agentchat-lightvela-panel@1.4.2 已处理掉直接依赖，
      // 实测侧栏 <a> 不再被 tea-themeable.css 染蓝（global.css 里的 revert-layer
      // 防护已随之移除）。此 alias 保留作为构建层兜底，防止未来 SDK 任一环节
      // 退化时污染再次进入产物。
      [teaThemeableResetCss]: teaThemeableNoResetCss,
    },
    rules: {
      '*.txt': {
        type: 'raw',
      },
    },
  },
  webpack: (webpackConfig) => {
    webpackConfig.resolve ??= {};
    webpackConfig.resolve.alias ??= {};
    webpackConfig.resolve.alias[teaThemeableResetCss] = teaThemeableNoResetCss;
    webpackConfig.module.rules.push({
      resourceQuery: /raw/,
      type: 'asset/source',
    });
    return webpackConfig;
  },
};

const withMDX = createMDX();

export default withMDX(config);
