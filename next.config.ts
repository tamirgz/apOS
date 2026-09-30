import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Default is 1MB; project-file uploads go through a Server Action and are
    // capped at 20MB in files-actions.ts — raise the transport limit to match.
    serverActions: {
      bodySizeLimit: "20mb",
    },
  },
  // Home = Today. A plain 307 before anything renders: the old in-page
  // `redirect()` streamed the shell's loading fallback first, and Next's router
  // then crashed following it (React #310) → "This page couldn't load" at `/`.
  async redirects() {
    return [
      { source: "/", destination: "/m/today", permanent: false },
      { source: "/deck", destination: "/m/today", permanent: false },
    ];
  },
};

export default nextConfig;
