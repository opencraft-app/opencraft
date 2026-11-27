# Prebuilt Valdi Web Bundle (`@opencraft/design-system-valdi`)

`valdi-web-bundle.mjs` contains the compiled browser ESM output of
`packages/design-system-valdi` paired with Snapchat Valdi's `ValdiWebRenderer`
(MIT, see `NOTICE`, upstream commit `bc20bfc0da56d89278516ca67a4a670bd8e6b5a8`).

Checking this precompiled ESM artifact in allows `npm run dev:web` and
`npm run build:web` to run on any developer or CI machine without requiring a
local Bazel toolchain.

## Regenerating

After editing `packages/design-system-valdi/src/*`:

```bash
VALDI_WORKSPACE=/path/to/valdi-upstream node packages/design-system-valdi/scripts/build-web.mjs
```
