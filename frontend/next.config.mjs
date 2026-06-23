import { createMDX } from 'fumadocs-mdx/next';

const teaThemeableResetCss = '@tencent/tea-component/dist/tea-themeable.css';
const teaThemeableNoResetCss = '@tencent/tea-component/dist/tea-themeable-no-reset.css';

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  output: 'export',
  assetPrefix: process.env.NEXT_PUBLIC_ASSET_PREFIX || undefined,
  trailingSlash: true,
  pageExtensions: ['next.tsx', 'next.ts'],
  images: {
    unoptimized: true,
  },
  turbopack: {
    root: new URL('.', import.meta.url).pathname,
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
