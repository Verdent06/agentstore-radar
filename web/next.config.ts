import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  typedRoutes: false,
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
