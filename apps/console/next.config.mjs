/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    PHAROS_API_BASE: process.env.PHAROS_API_BASE ?? "http://localhost:4000",
  },
};

export default nextConfig;
