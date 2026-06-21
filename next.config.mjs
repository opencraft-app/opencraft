import { createMDX } from 'fumadocs-mdx/next';

const config = {
  allowedDevOrigins: ['127.0.0.1'],
  reactStrictMode: true,
};

const withMDX = createMDX();

export default withMDX(config);
