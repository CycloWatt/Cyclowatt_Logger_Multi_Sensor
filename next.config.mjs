/** @type {import('next').NextConfig} */
const nextConfig = {
  /*
  output: 'export',
  basePath: '/Data_Logger_CycloWatt',
  assetPrefix: '/Data_Logger_CycloWatt',
  */
  eslint: {
    ignoreDuringBuilds: true,
  },
  // typescript.ignoreBuildErrors was dropped once the repo went tsc-clean
  // (Web Bluetooth / Web Serial types installed, chart.tsx typed for
  // recharts 3) - the build now fails on a genuine type error instead of
  // masking it.
  images: {
    unoptimized: true,
  },
}

export default nextConfig
