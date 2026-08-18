import { createMDX } from 'fumadocs-mdx/next';
import { fileURLToPath } from 'node:url';

const teaThemeableResetCss = '@tencent/tea-component/dist/tea-themeable.css';
const teaThemeableNoResetCss = '@tencent/tea-component/dist/tea-no-reset.css';
const isDevelopment = process.env.NODE_ENV === 'development';
const isLocalProxy = (process.env.NEXT_PUBLIC_AUTH_API_BASE_URL || process.env.VITE_AUTH_API_BASE_URL || '').trim().toLowerCase() === 'local-proxy';
const localProxyTarget = (
  process.env.NEXT_PUBLIC_LOCAL_PROXY_TARGET
  || process.env.VITE_LOCAL_PROXY_TARGET
  || (process.env.NEXT_PUBLIC_REGION === 'global' || process.env.VITE_REGION === 'global'
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
  transpilePackages: ['velachat'],
  output: isDevelopment ? undefined : 'export',
  assetPrefix: process.env.NEXT_PUBLIC_ASSET_PREFIX || undefined,
  trailingSlash: true,
  // 桥接 VITE_AUTH_API_BASE_URL 到客户端 bundle，供 datong.ts 推断部署环境使用。
  // Next.js 只内联 NEXT_PUBLIC_* 变量，VITE_* 需通过 env 显式暴露到客户端。
  env: {
    VITE_AUTH_API_BASE_URL: process.env.NEXT_PUBLIC_AUTH_API_BASE_URL || process.env.VITE_AUTH_API_BASE_URL || '',
  },
  allowedDevOrigins: ['lightvela.ai', 'www.lightvela.ai', 'lightvela.com', 'lightvela.tencent.com', 'localhost', '127.0.0.1', 'lightclaw.pages.dev','intl-sandbox-kr-1.preview.lightclaw.tech'],
  pageExtensions: ['next.tsx', 'next.ts'],
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
    root: fileURLToPath(new URL('.', import.meta.url)),
    resolveAlias: {
      // AgentChat pulls Tea UI styles as a side effect. Use Tea's no-reset
      // build so the chat page cannot globally reset host page elements.
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
