/** @type {import('next').NextConfig} */

// The URL path the site will be served from, baked into every emitted asset and
// route URL at BUILD time. This CANNOT be corrected afterwards by renaming,
// moving or rezipping files: a build is tied to the path it will be served from,
// so it has to be known before `npm run build` runs.
//
//   project Pages site   https://<owner>.github.io/<repo>/   ->  '/<repo>'
//   user or org site     https://<owner>.github.io/          ->  ''
//   custom domain root   https://example.com/                ->  ''
//
// Override per build instead of editing this file:
//   PowerShell   $env:NEXT_PUBLIC_BASE_PATH='/their-repo'; npm run build
//   bash         NEXT_PUBLIC_BASE_PATH=/their-repo npm run build
//   root-hosted  $env:NEXT_PUBLIC_BASE_PATH=''; npm run build
//
// An empty string is not nullish, so it passes through ?? unchanged and really
// does mean "serve from the root" rather than falling back to the default.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '/Cyclowatt_Logger_Multi_Sensor'

const nextConfig = {
  // Static export: the whole app is pre-rendered into out/ as plain files, which
  // is all GitHub Pages can serve. This also FORBIDS every server-side feature,
  // which is why the firmware "version shelf" route handlers under app/api/ were
  // removed rather than ported - see the note in components/image-picker.tsx.
  // It also disables `next start`; preview a build with a static file server.
  output: 'export',

  basePath,
  assetPrefix: basePath,

  eslint: {
    ignoreDuringBuilds: true,
  },
  // typescript.ignoreBuildErrors was dropped once the repo went tsc-clean
  // (Web Bluetooth / Web Serial types installed, chart.tsx typed for
  // recharts 3) - the build now fails on a genuine type error instead of
  // masking it.
  images: {
    // Required by output: 'export' - the default image loader optimizes on the
    // fly and needs a server, and there is none.
    unoptimized: true,
  },
}

export default nextConfig
