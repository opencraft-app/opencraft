import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { packageModules } from "../../apps/mobile/scripts/packaged-modules.mjs";
import { startPackagedModules } from "../../apps/mobile/scripts/packaged-module-runtime.mjs";

const chunk = (fileName, code, isEntry = false) => ({ fileName, code, isEntry });
test("packaged modules link shared imports and load optional code only on demand", () => {
  const { manifest, resources } = packageModules([
    chunk("assets/main.js", 'import { value } from "./shared.js"; globalThis.result=value; globalThis.loadMore=()=>import(`./lazy.js`);', true),
    chunk("assets/shared.js", "export const value=7;"),
    chunk("assets/lazy.js", "globalThis.optionalLoaded=true; export const answer=42;"),
  ], []);
  // Execute real ES modules in an isolated realm, replacing only the native
  // transport and Blob URL allocation (Node has no browser Blob module loader).
  const script = `
    import assert from 'node:assert/strict';
    const resources = new Map(${JSON.stringify([...resources])});
    globalThis.window=globalThis;
    globalThis.opencraftMobile={version:1,runtimeId:'live'};
    const reads=[];
    URL.createObjectURL=blob => { throw new Error('synchronous test Blob required'); };
    globalThis.Blob=class { constructor(parts) { this.text=parts.join(''); } };
    URL.createObjectURL=blob=>'data:text/javascript;base64,'+Buffer.from(blob.text).toString('base64');
    globalThis.ReactNativeWebView={postMessage(raw) {
      const request=JSON.parse(raw); reads.push(request.resourceId);
      queueMicrotask(()=> {
        window.__opencraftPackagedReceive({...request,runtimeId:'retired',text:'throw new Error("stale");'});
        window.__opencraftPackagedReceive({...request,text:resources.get(request.resourceId)});
      });
    }};
    (${startPackagedModules.toString()})(${JSON.stringify(manifest)});
    for(let i=0;i<100 && globalThis.result!==7;i++) await new Promise(r=>setTimeout(r,5));
    assert.equal(globalThis.result,7);assert.equal(globalThis.optionalLoaded,undefined);assert.equal(reads.length,2);
    const result=await globalThis.loadMore();assert.equal(result.answer,42);assert.equal(globalThis.optionalLoaded,true);assert.equal(reads.length,3);
    await globalThis.loadMore();assert.equal(reads.length,3);
    await assert.rejects(globalThis.__opencraftPackagedImport('https://example.org/code.js'),/Unknown/);
    await assert.rejects(globalThis.__opencraftPackagedImport('__proto__'),/Unknown/);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});
test("missing static dependencies and static link cycles fail during packaging", () => {
  assert.throws(() => packageModules([chunk("main.js", 'import "./missing.js";', true)], []), /Unpackaged/);
  assert.throws(() => packageModules([chunk("a.js", 'import "./b.js";', true), chunk("b.js", 'import "./a.js";')], []), /cycle/);
});
test("computed plugin imports remain constrained to the packaged registry", () => {
  const { resources } = packageModules([chunk("main.js", "globalThis.openPlugin=url=>import(url);", true)], []);
  assert.match([...resources.values()][0], /__opencraftPackagedImport\(url\)/);
});
