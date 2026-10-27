// Builds opencraft/build/idle-probe/preflight-cand.mjs (esbuild bundle, ws inlined) from idle-probe.source.mjs.
// Runtime deps resolve from THIS checkout's opencraft install (own-lock ws@8.22.0/esbuild@0.28.2); no cross-worktree paths.
import { createRequire } from "node:module";
const require_ = createRequire(new URL("../../../package.json", import.meta.url));
const { build } = require_("esbuild");
await build({
  entryPoints: [new URL("./idle-probe.source.mjs", import.meta.url).pathname],
  bundle: true, platform: "node", format: "esm", target: "node22",
  outfile: new URL("../../../build/idle-probe/preflight-cand.mjs", import.meta.url).pathname,
  nodePaths: [new URL("../../../node_modules/", import.meta.url).pathname],
  banner: {
    js: "// join-core idle probe (candidate maintenance tool; not the online gate). protocolVersion from app-host-protocol/src/version.mjs (verified), ws inlined.\n" +
        "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\n",
  },
});
console.log("idle-probe bundle built: opencraft/build/idle-probe/preflight-cand.mjs");
