/** @type {import('next').NextConfig} */

// The URL path the site is served from, baked into every emitted asset and route
// URL at BUILD time. This CANNOT be corrected afterwards by renaming, moving or
// rezipping files: a build is tied to the path it will be served from, so the
// target has to be known before `npm run build` runs.
//
//   project Pages site   https://<owner>.github.io/<repo>/   ->  <repo>
//   user or org site     https://<owner>.github.io/          ->  empty
//   custom domain root   https://example.com/                ->  empty
//
// Pass the BARE repository name, with no leading slash:
//   PowerShell   $env:NEXT_PUBLIC_BASE_PATH='their-repo'; npm run build
//   bash         NEXT_PUBLIC_BASE_PATH=their-repo npm run build
//   root-hosted  $env:NEXT_PUBLIC_BASE_PATH=''; npm run build
//
// The leading slash is added below rather than being asked for, because Git Bash
// (MSYS) rewrites any value that STARTS with "/" into a Windows path: passing
// "/their-repo" there arrives as "C:/Program Files/Git/their-repo" and Next then
// fails with a confusing "basePath has to start with a /". Taking the bare name
// sidesteps that entirely on every shell.
const rawBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? 'Cyclowatt_Logger_Multi_Sensor'

// A drive letter means the mangling above happened anyway (someone passed a
// leading slash from Git Bash). Fail loudly: the alternative is a site that
// builds cleanly and has every single URL wrong.
if (/^[A-Za-z]:/.test(rawBasePath)) {
  throw new Error(
    `NEXT_PUBLIC_BASE_PATH looks like a Windows path ("${rawBasePath}"). ` +
      'Git Bash rewrote a leading "/". Pass the bare repository name instead, ' +
      'for example NEXT_PUBLIC_BASE_PATH=my-repo, or set it from PowerShell.',
  )
}

// An empty value really means "serve from the root" and must stay empty; it is
// not nullish, so it passes through the ?? above unchanged.
const basePath = rawBasePath === '' ? '' : `/${rawBasePath.replace(/^\/+/, '')}`

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
