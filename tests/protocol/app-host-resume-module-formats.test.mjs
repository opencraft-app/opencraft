import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The static release server imports these sources in Node strip-only mode,
// without tsx or a bundle. Neither non-erasable TS nor .js-to-.ts remapping is available.
test("AppHost resume package runs in native Node strip-only release imports", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { ResumeLink } from '@opencraft/app-host-resume';
    import { ResumeRegistry } from '@opencraft/app-host-resume/server';
    const link = new ResumeLink({ maxBytes: 32 });
    link.retain(link.next(), 'frame', 5);
    assert.deepEqual(link.replay(0), [{ seq: 1, data: 'frame' }]);
    const registry = new ResumeRegistry();
    const session = registry.create('native-owner', {}, () => {});
    assert.equal(session.isEnded, false);
    registry.close(); assert.equal(session.isEnded, true);
    await import('./apps/headless-server/src/serve-workbench-web.mjs');
    await import('@opencraft/client-session/memory');
  `], { cwd: new URL("../../", import.meta.url), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
