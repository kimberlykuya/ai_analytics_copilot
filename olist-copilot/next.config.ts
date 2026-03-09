import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a minimal self-contained build for Docker (no node_modules copy needed)
  output: "standalone",
};

export default nextConfig;
