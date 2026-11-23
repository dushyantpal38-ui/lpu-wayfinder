/** @type {import('next').NextConfig} */

// Security headers for every page and file. The Content-Security-Policy lists the only places the site may
// load code from or talk to: itself, and the Supabase database (OpenStreetMap is fetched by the site's own server).
// Anything else (an injected script, a hidden frame, a look-alike site framing ours) is blocked by the browser.
const dev = process.env.NODE_ENV !== "production";
const supabase = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://zypkjzwkbkmnqhpziade.supabase.co").replace(/\/+$/, "");

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`, // Next.js needs inline bootstrap scripts
  "style-src 'self' 'unsafe-inline'", // the map and the sheets set inline styles
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${supabase}`,
  "worker-src 'self' blob:", // MapLibre draws the map in a web worker
  "child-src 'self' blob:",
  "manifest-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=(), payment=(), usb=(), browsing-topics=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true }, // no ESLint config in this project; TypeScript errors do fail the build
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
