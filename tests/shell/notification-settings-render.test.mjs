import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("notification destination settings render a saved redacted target and device controls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notification-settings-render-"));
  try {
    await symlink(join(root, "node_modules"), join(dir, "node_modules"), "dir");
    const source = `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { IntlProvider } from 'react-intl';
      import { AsyncNoticesContext } from './apps/workbench-web/src/components/async-notices-context';
      import { NotificationDestinationSettings } from './apps/workbench-web/src/components/notification-destination-settings';
      const config={actorId:'user',enabled:true,hosts:['local-codex'],imTargets:[],destinations:[{id:'one',kind:'webhook',label:'receiver.example / ••••••',enabled:true,authorized:true}]};
      const snap={phase:'ready',configuration:config,busy:null};
      const owner={getSnapshot:()=>snap,subscribe:()=>()=>{},operation:async()=>config};
      const notices={loading(){},info(){},success(){},warning(){},error(){},dismiss(){},dismissAll(){}};
      const local={supported:true,permission:'granted',enabled:true,busy:false,delivery:'page',backgroundAvailable:false,testSent:false,error:null};
      export default ()=>renderToStaticMarkup(React.createElement(IntlProvider,{locale:'en'},React.createElement(AsyncNoticesContext.Provider,{value:notices},React.createElement(NotificationDestinationSettings,{controller:{destinations:owner},local,localDescription:'Local device'}))));
    `;
    const outfile = join(dir, "render.mjs");
    await build({
      stdin: { contents: source, resolveDir: root, sourcefile: "notification-render-fixture.ts", loader: "tsx" },
      outfile,
      banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node26",
      logLevel: "silent",
      external: ["react", "react/*", "react-dom", "react-dom/*", "react-intl"],
      loader: { ".scss": "empty", ".css": "empty" },
    });
    const { default: render } = await import(pathToFileURL(outfile).href);
    const html = render();
    assert.match(html, /receiver\.example/);
    assert.match(html, /Add notification method/);
    assert.match(html, /Local device/);
    assert.doesNotMatch(html, /private-token/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
