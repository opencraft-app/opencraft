# OpenCraft website

This directory owns the public site at [opencraft.app](https://opencraft.app).
Follow the [repository instructions](../AGENTS.md) and see the [website README](README.md) for build and deployment commands.

## Source and behavior

- Keep the homepage usable as static HTML. [render.mjs](render.mjs) owns the copy and page template. English is the published language. Add future locales through the message catalog and route so the build can generate language navigation, metadata, and sitemap entries together.
- [build.mjs](build.mjs) produces `dist/` from the source, static assets, and shared [OpenCraft icon](../apps/workbench-web/public/opencraft-icon.svg). Edit the source and commit the website's own lockfile for dependency changes.
- Treat Motion and the deferred Three.js scene as enhancements. Keep the primary content and links usable with JavaScript disabled, reduced motion enabled, or WebGL unavailable.
- Use the current product documentation as the source for capability claims. Use the repository's GitHub Releases and maintained guides for download and self-hosting links.

## Validation and deployment

- Run `npm ci` and `npm run build` in `website/` with the repository's pinned Node version. For visible changes, preview the built site in a browser and check desktop, touch, keyboard navigation, and any affected fallback.
- For changes to asset routing or response headers, verify the affected URLs in the local Wrangler preview. Check the homepage, static assets, and an unknown path when the change affects routing.
- [wrangler.jsonc](wrangler.jsonc) owns the site's Cloudflare Worker configuration and custom domain. Use local previews for review. When asked to publish, deploy the verified build and check the public HTTPS response and affected routes.
