/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // API routes read /data with fs at runtime; make sure it ships with the serverless functions.
    outputFileTracingIncludes: {
      "/api/**/*": ["./data/**/*"],
    },
  },
};

export default nextConfig;
