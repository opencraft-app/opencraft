import { createMDX } from 'fumadocs-mdx/next';

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  output: 'export',
  trailingSlash: true,
  pageExtensions: ['next.tsx', 'next.ts'],
  images: {
    unoptimized: true,
  },
  turbopack: {
    root: new URL('.', import.meta.url).pathname,
    rules: {
      '*.txt': {
        type: 'raw',
      },
    },
  },
  webpack: (webpackConfig) => {
    webpackConfig.module.rules.push({
      resourceQuery: /raw/,
      type: 'asset/source',
    });
    return webpackConfig;
  },
};

const withMDX = createMDX();

export default withMDX(config);
