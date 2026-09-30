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
    resolveDir: new URL("..", import.meta.url).pathname,
  },
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
  plugins: [{ name: "panel-boundaries", setup(builder) {
    const modules = {
      "@tanstack/react-query": `export const useQuery = () => ({data:{text:'# Hello',blob:null}}); export const useQueryClient = () => ({invalidateQueries:async()=>{}}); export const useMutation = options => {globalThis.__panelTest.mutation=options.mutationFn;return {}};`,
      "../runtime/appserver-runtime-context": `export const useAppServerRuntime=()=>globalThis.__panelTest.runtime;export const useAppServerSnapshot=()=>({hostId:'bot-a',conversation:null});export const useBlobResources=()=>globalThis.__panelTest.blobs;`,
      "../runtime/blob-files": `export const fileBlobResource=(_runtime,hostId,path)=>({scope:hostId,path});export const fileBlobUrls={};export const acquireFileBlob=()=>{};`,
      "../appearance-theme": `export const useAppearanceTheme=()=>({resolvedTheme:'light'});`,
      "../runtime/appserver-media-loader": `export const createAppServerMediaSourceLoader=()=>()=>{};`,
      "@opencraft/i18n/react": `export const useIntl=()=>({formatMessage:m=>m.defaultMessage});`,
      "@opencraft/chat-render-web": `export const WebChatDocument=()=>null;`,
      "./workspace-code-editor": `export const WorkspaceCodeEditor=()=>{throw new Error("editor unavailable")};`,
      "./workspace-file-icon": `export const WorkspaceFileIcon=()=>null;`,
      "lucide-react": `export const AlertTriangle=()=>null;export {AlertTriangle as ChevronDown,AlertTriangle as ChevronRight,AlertTriangle as Folder,AlertTriangle as FolderOpen,AlertTriangle as Image,AlertTriangle as LoaderCircle,AlertTriangle as Pencil,AlertTriangle as RotateCcw,AlertTriangle as Save,AlertTriangle as Search};`,
    };
    builder.onResolve({filter:/.*/}, args => args.path in modules ? {path:args.path,namespace:"boundary"} : undefined);
    builder.onLoad({filter:/.*/,namespace:"boundary"}, args => ({contents:modules[args.path],loader:"js"}));
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
    runtime: {resources:{fileSystem:{writeFile:async(...args)=>{writes.push(args)}}}},
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
    renderToString(createElement(exports.WorkspaceResourcePanel, props));
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
  globalThis.__panelTest = { runtime:{resources:{fileSystem:{}}}, blobs:{} };
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
