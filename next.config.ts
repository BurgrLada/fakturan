import type { NextConfig } from "next";

// No nonce: the static shell of Cache Components cannot carry one. Dev needs eval for React's
// debugging features.
const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  ...(process.env.NODE_ENV === "development" ? ["'unsafe-eval'"] : []),
];

const csp = [
  "default-src 'self'",
  `script-src ${scriptSrc.join(" ")}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

// Sent unconditionally: headers() is frozen at build time, when BETTER_AUTH_URL may be unset, and
// browsers ignore HSTS received over plain HTTP, so local and non-TLS setups are unaffected.
const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  output: "standalone",
  // Above MAX_FILE_BYTES (src/lib/file-limits.ts) plus multipart overhead; Next defaults to 1 MB.
  experimental: { serverActions: { bodySizeLimit: "3mb" } },
  serverExternalPackages: ["better-sqlite3"],
  // Both are read from process.cwd() at runtime, which tracing cannot see.
  outputFileTracingIncludes: {
    "/*": ["./drizzle/**/*", "./src/server/auth/common-passwords.txt"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
