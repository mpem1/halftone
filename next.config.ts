import type { NextConfig } from "next";

// Dual build targets:
//   default (BUILD_TARGET unset)  → standalone server build for the runtime container
//   BUILD_TARGET=gh               → static export for GitHub Pages, served at /halftone/
// Static pages only: the halftone app is 100% client-side (Canvas2D), no API routes.
const isGH = process.env.BUILD_TARGET === "gh";
const basePath = isGH ? "/halftone" : "";

const nextConfig: NextConfig = {
  output: isGH ? "export" : "standalone",
  ...(basePath ? { basePath } : {}),
  images: { unoptimized: true },
  // Inlined at build time; client code prefixes asset URLs with it.
  // Empty locally, "/halftone" on Pages.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
