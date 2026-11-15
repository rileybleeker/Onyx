import type { NextConfig } from "next";

// Riley 2026-11-14: testing never slows a deployment. The production build only compiles; type checking and lint
// run against master in .github/workflows/scheduled-tests.yml (the frontend-types job's tsc --noEmit and the lint
// job's npm run lint) and after deploy the smoke test runs.
// Measured on Vercel before this change: lint + type check took 16 s of a ~90 s deploy.
const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
