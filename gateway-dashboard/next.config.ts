import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: "/admin/gateway",
  output: "standalone",
  async redirects() {
    return [
      {
        source: "/",
        destination: "/admin/gateway/login",
        basePath: false,
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
