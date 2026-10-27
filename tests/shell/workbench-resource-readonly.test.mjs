import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";

// Render the real panel and capture its mutation at the Query boundary. This
// exercises a direct save attempt even though the preview hides its buttons.
const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  stdin: {
    contents: `export { WorkspaceResourcePreviewPanel, WorkspaceResourcePanel } from './apps/workbench-web/src/panels/workspace-resource-panel';`,
    resolveDir: new URL("../..", import.meta.url).pathname,
  },
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
  // This harness exercises panel semantics; actual styles are covered in Chromium.
  loader: { ".scss": "empty" },
  plugins: [{ name: "panel-boundaries", setup(builder) {
    const modules = {
      "@tanstack/react-query": `export const useQueries = () => []; export const useQuery = () => globalThis.__panelTest.query ?? ({data:globalThis.__panelTest.resourceData ?? {text:'# Hello',blob:null}}); export const useQueryClient = () => ({invalidateQueries:async()=>{}}); export const useMutation = options => {globalThis.__panelTest.mutation=options.mutationFn;return {}};`,
      "../runtime/appserver-runtime-context": `export const useAppServerRuntime=()=>globalThis.__panelTest.runtime;export const useAppServerSnapshot=()=>({hostId:globalThis.__panelTest.hostId??'bot-a',conversation:null});export const useBlobResources=()=>globalThis.__panelTest.blobs;`,
      "../runtime/blob-files": `import {BlobUrlManager} from '${new URL("../../packages/blob-resources/src/browser.ts", import.meta.url).pathname}';export const fileBlobResource=(_runtime,hostId,path)=>({scope:hostId,path});export const fileBlobUrls=new BlobUrlManager();export const acquireFileBlob=()=>{};`,
      "../appearance-theme": `export const useAppearanceTheme=()=>({resolvedTheme:'light'});`,
      "../runtime/appserver-media-loader": `export const createAppServerMediaSourceLoader=()=>()=>{};`,
      "@opencraft/i18n/react": `export const useIntl=()=>({formatMessage:m=>m.defaultMessage});`,
      "@opencraft/chat-render-web": `export const WebChatDocument=()=>null; export const ZoomableImage=()=>null;`,
      "./workspace-pdf-preview": `export const WorkspacePdfPreview=()=>null;`,
      "./workspace-code-editor": `export const WorkspaceCodeEditor=()=>{throw new Error("editor unavailable")};`,
      "./workspace-file-icon": `export const WorkspaceFileIcon=()=>null;`,
    };
    builder.onResolve({filter:/.*/}, args => args.path in modules ? {path:args.path,namespace:"boundary"} : undefined);
    builder.onLoad({filter:/.*/,namespace:"boundary"}, args => ({contents:modules[args.path],loader:"js",resolveDir:new URL("../..", import.meta.url).pathname}));
  }}],
});
const module = {exports:{}};
new Function("require", "exports", "module", outputFiles[0].text)(require, module.exports, module);
const exports = module.exports;
const {createElement} = require("react");
const {renderToString} = require("react-dom/server");

test("preview rejects direct writes; editable panel saves the captured target", async () => {
  const writes = [];
  const invalidations = [];
  globalThis.__panelTest = {
    runtime: {resources:{host:{canRequest:method=>method==="fs/writeFile"},fileSystem:{writeFile:async(...args)=>{writes.push(args)}}}},
    blobs: {invalidate:async resource=>{invalidations.push(resource)}},
  };
  try {
    const props = {tab:{resource:"/workspace/report.md"}};
    const html = renderToString(createElement(exports.WorkspaceResourcePreviewPanel, props));
    assert.doesNotMatch(html, /Save file|Edit file|Search workspace files/);
    const target = {hostId:"bot-a",path:"/workspace/original.md",key:"original",text:"你好"};
    await assert.rejects(globalThis.__panelTest.mutation(target), /read-only/);
    assert.deepEqual(writes, []);
    assert.deepEqual(invalidations, []);
    const editableHtml = renderToString(createElement(exports.WorkspaceResourcePanel, props));
    assert.match(editableHtml, /aria-label="Search workspace files" disabled=""/);
    await globalThis.__panelTest.mutation(target);
    assert.deepEqual(writes, [[target.path, Buffer.from(target.text).toString("base64")]]);
    assert.deepEqual(invalidations, [{scope:"bot-a",path:target.path}]);
  } finally { delete globalThis.__panelTest; }
});


test("Markdown preview and source switch without loading the editor", async () => {
  const { JSDOM } = require("jsdom");
  const { createRoot } = require("react-dom/client");
  const { act } = require("react");
  const dom = new JSDOM('<div id="app"></div>', {url:"http://localhost"});
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, {window:dom.window, document:dom.window.document, IS_REACT_ACT_ENVIRONMENT:true});
  globalThis.__panelTest = { runtime:{resources:{host:{canRequest:()=>false},fileSystem:{}}}, blobs:{} };
  const root = createRoot(document.getElementById("app"));
  try {
    await act(() => root.render(createElement(exports.WorkspaceResourcePreviewPanel, {tab:{resource:"/workspace/report.md"}})));
    const button = name => Array.from(document.querySelectorAll("button")).find(node => node.textContent === name);
    for (let i = 0; i < 2; i++) {
      await act(() => button("Source").click());
      assert.equal(document.querySelector("pre code")?.textContent, "# Hello");
      assert.equal(document.querySelector("[contenteditable=true]"), null);
      assert.equal(button("Source").getAttribute("aria-pressed"), "true");
      await act(() => button("Preview").click());
      assert.ok(document.querySelector(".workspace-file-markdown"));
      assert.equal(document.querySelector("pre"), null);
    }
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    delete globalThis.__panelTest;
    for (const key of keys) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete globalThis[key];
    }
  }
});

test("read-only preview downloads the original Blob and retires the previous Host URL", async () => {
  const { JSDOM } = require("jsdom");
  const { createRoot } = require("react-dom/client");
  const { act } = require("react");
  const dom = new JSDOM('<div id="app"></div>', {url:"http://localhost"});
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, {window:dom.window, document:dom.window.document, IS_REACT_ACT_ENVIRONMENT:true});
  const bytes = Uint8Array.from([239, 187, 191, 35, 32, 65, 13, 10]);
  const loaded = blob => ({data:{blob,text:"# A",isFile:true,isDirectory:false}});
  globalThis.__panelTest = {
    runtime:{resources:{host:{canRequest:()=>false},fileSystem:{}}}, blobs:{},
    query: loaded(new Blob([bytes])),
  };
  const root = createRoot(document.getElementById("app"));
  const render = () => act(() => root.render(createElement(exports.WorkspaceResourcePreviewPanel, {tab:{resource:"/workspace/中文 下载.md"}})));
  const link = () => document.querySelector('a[download]');
  try {
    await render();
    assert.equal(link().getAttribute("download"), "中文 下载.md");
    assert.equal(link().getAttribute("aria-disabled"), null);
    const oldUrl = link().getAttribute("href");
    assert.deepEqual(new Uint8Array(await (await fetch(oldUrl)).arrayBuffer()), bytes);
    assert.doesNotMatch(document.body.textContent, /Save file|Edit file/);
    globalThis.__panelTest.hostId = "bot-b";
    globalThis.__panelTest.query = {isLoading:true};
    await render();
    assert.equal(link().getAttribute("href"), null);
    assert.equal(link().getAttribute("aria-disabled"), "true");
    await assert.rejects(fetch(oldUrl));
    globalThis.__panelTest.query = loaded(new Blob([]));
    await render();
    const newUrl = link().getAttribute("href");
    assert.equal((await (await fetch(newUrl)).arrayBuffer()).byteLength, 0);
    globalThis.__panelTest.query.isError = true;
    globalThis.__panelTest.query.error = new Error("Host read failed");
    await render();
    assert.equal(link().getAttribute("href"), null);
    globalThis.__panelTest.query = {data:{isDirectory:true,isFile:false,blob:null}};
    await render();
    assert.equal(link(), null);
    await assert.rejects(fetch(newUrl));
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    delete globalThis.__panelTest;
    for (const key of keys) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete globalThis[key];
    }
  }
});

test("HTML preview renders in an isolated frame and retains source access", async () => {
  const { JSDOM } = require("jsdom");
  const { createRoot } = require("react-dom/client");
  const { act } = require("react");
  const dom = new JSDOM('<div id="app"></div>', {url:"http://localhost"});
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, {window:dom.window, document:dom.window.document, IS_REACT_ACT_ENVIRONMENT:true});
  const html = '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://example.com/"><style>h1{color:red}</style></head><body><h1>Report</h1><a href="https://example.com/" ping="https://example.com/ping">External report</a><map><area href="https://example.com/area"></map><svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="https://example.com/svg"><set attributeName="href" to="https://example.com/animated" begin="0s"/>SVG report</a></svg><script>window.parent.bad = true</script></body></html>';
  globalThis.__panelTest = {
    runtime:{resources:{host:{canRequest:()=>false},fileSystem:{}}},
    blobs:{},
    resourceData:{text:html,blob:null},
  };
  const root = createRoot(document.getElementById("app"));
  try {
    await act(() => root.render(createElement(exports.WorkspaceResourcePreviewPanel, {tab:{resource:"/home/agentuser/.hermes/cron/output/wage_report_2026-10-10.html"}})));
    const frame = document.querySelector("iframe.workspace-file-html");
    assert.ok(frame);
    assert.equal(frame.getAttribute("sandbox"), "");
    assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
    assert.match(frame.getAttribute("srcdoc"), /^<!doctype html><meta http-equiv="Content-Security-Policy"/iu);
    assert.match(frame.getAttribute("srcdoc"), /script-src 'none'/u);
    assert.match(frame.getAttribute("srcdoc"), /<h1>Report<\/h1>/u);
    assert.doesNotMatch(frame.getAttribute("srcdoc"), /http-equiv="refresh"|\bhref=|\bping=|<set\b/iu);
    const preview = new JSDOM(frame.getAttribute("srcdoc"));
    assert.equal(preview.window.document.compatMode, "CSS1Compat");
    assert.equal(preview.window.getComputedStyle(preview.window.document.querySelector("h1")).color, "rgb(255, 0, 0)");
    preview.window.close();
    const button = name => Array.from(document.querySelectorAll("button")).find(node => node.textContent === name);
    await act(() => button("Source").click());
    assert.equal(document.querySelector("iframe"), null);
    assert.equal(document.querySelector("pre code")?.textContent, html);
    await act(() => button("Preview").click());
    assert.ok(document.querySelector("iframe.workspace-file-html"));
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    delete globalThis.__panelTest;
    for (const key of keys) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete globalThis[key];
    }
  }
});
