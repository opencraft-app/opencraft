# OpenCraft website

The source for [opencraft.app](https://opencraft.app) lives in this directory. The website links to the repository's releases, deployment guide, and documentation.

## Build and preview

Run from this directory with the repository's pinned Node version.

```sh
npm ci
npm run build
npx wrangler@4.168.0 dev
```

The build writes the English site to `dist/index.html`. To add a language, add its
message catalogue and URL path to `render.mjs`. The build generates its page and
includes it in the sitemap and language navigation.

Motion enhances the page entrance. The Three.js effect loads after the hero
image, and the site works with JavaScript off or reduced motion enabled.

## Cloudflare

Deploy from this directory as a static assets Worker. The Cloudflare account must own the active `opencraft.app` zone.

```sh
npm ci
npm run build
npx wrangler@4.168.0 deploy
```

To publish automatically from the Cloudflare dashboard using Workers Builds, connect this repository and set the production branch to `main`, the root directory to `website`, the build command to `npm ci && npm run build`, and the deploy command to `npx wrangler@4.168.0 deploy`. Include `website/**` and `apps/workbench-web/public/opencraft-icon.svg` in the build watch paths.
