# deepmerge 4.3.2-opencraft.1

Vendored from deepmerge 4.3.1 (MIT, [TehShrike/deepmerge](https://github.com/TehShrike/deepmerge))
so the workspace can carry the fix for
[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) before
upstream publishes a fixed release. `4.3.1` is the latest published version and
is affected through its `mergeObject()` assignment of `__proto__` keys.

Only the write helper differs from upstream: `__proto__`, `constructor` and
`prototype` are defined as own enumerable data properties instead of being
assigned, so a malicious source object cannot set the merged object's
prototype. `index.js`, `dist/cjs.js` and `dist/umd.js` carry the same change.
The package version is bumped so the lockfile records a version outside the
advisory's affected range.

The root `package.json` pins this directory with a `file:` dependency and the
`$deepmerge` override that applies it to transitive consumers (`@expo/config`).
Remove both once upstream publishes a fixed release or Expo stops depending on
`deepmerge`; do not edit these files in place.

Verification:

```bash
node -e "const merge = require('deepmerge'); const out = merge(Object.create(null), JSON.parse('{\"__proto__\":{\"polluted\":true}}')); if (({}).polluted !== undefined || Object.getPrototypeOf(out) !== Object.prototype) process.exit(1)"
```
