import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = ".local/chat-render-isolation";
await mkdir(output, { recursive: true });
// Real document/runtime/renderers; only the Host media callback is synthetic.
const fixture = `
import React,{useState}from'react';
import{flushSync}from'react-dom';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{createWebChatRenderRuntime}from'/packages/chat-render-web/src/runtime.ts';
import{WebChatRenderRuntimeProvider}from'/packages/chat-render-web/src/runtime-context.tsx';
import{WebChatDocument}from'/packages/chat-render-web/src/web-chat-document.tsx';
import'/apps/workbench-web/src/styles/app.scss';
const runtimes=[await createWebChatRenderRuntime(),await createWebChatRenderRuntime()];
window.events=[];window.pending=[];
const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvXkAAAAASUVORK5CYII=';
const callbacks=[0,1].map(id=>({
 onOpenResource:(target)=>window.events.push({kind:'open',id,target}),
 onMeasurementRequest:event=>window.events.push({kind:'measure',id,...event}),
 loadMediaSource:input=>new Promise(resolve=>window.pending.push({id,input,resolve:()=>resolve({source:pixel})})),
}));
const initial={documentId:'isolation',source:'Stable **paragraph**.\\n\\n[Open fixture](./fixture.ts)',streaming:true,theme:'light',hostId:'fixture',cwd:'/workspace',...callbacks[0]};
function App(){const[props,setProps]=useState(initial);const[,setTick]=useState(0);const[owner,setOwner]=useState(0);
window.fixture={tick(){flushSync(()=>setTick(n=>n+1))},patch(value){flushSync(()=>setProps(p=>({...p,...value})))},callbacks(id){flushSync(()=>setProps(p=>({...p,...callbacks[id]})))},runtime(){flushSync(()=>setOwner(1))}};
return <WebChatRenderRuntimeProvider runtime={runtimes[owner]}><WebChatDocument {...props}/></WebChatRenderRuntimeProvider>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-chat-render-isolation", server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "chat-render-isolation", enforce: "pre", resolveId: id => id === "/isolation.tsx" ? id : null,
    load: id => id === "/isolation.tsx" ? fixture : null,
    transform(code, id) {
      if (id.endsWith("/web-chat-document.tsx")) return code.replace(
        "function ResolvedWebChatDocument(props: WebChatDocumentProps) {",
        "function ResolvedWebChatDocument(props: WebChatDocumentProps) { window.__documents=(window.__documents??0)+1;");
      if (id.endsWith("/prose/prose-renderer.tsx")) return code.replace("const { node } = props;", "window.__prose=(window.__prose??0)+1;const { node } = props;");
    },
    configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/isolation.tsx"></script>');
    }); },
  }],
});
let browser: any;
const results: unknown[] = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: "reduce" });
    await context.addInitScript(() => { (window as any).__name = (fn: unknown) => fn; });
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as any).port}/`);
    await page.getByText("Stable", { exact: false }).first().waitFor();
    const root = await page.locator(".opencraft-chat-document").elementHandle();
    const unchanged = await page.evaluate(() => {
      const w = window as any, documents = w.__documents, prose = w.__prose;
      for (let n = 0; n < 20; n++) w.fixture.tick();
      return { documents: w.__documents - documents, prose: w.__prose - prose };
    });
    assert.deepEqual(unchanged, { documents: 0, prose: 0 });
    await page.getByText("Open fixture", { exact: true }).click();
    await page.evaluate(() => (window as any).fixture.callbacks(1));
    await page.getByText("Open fixture", { exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).events.filter((e: any) => e.kind === "open").map((e: any) => e.id)), [0, 1]);
    await page.evaluate(() => (window as any).fixture.patch({ theme: "dark", streaming: false }));
    assert.equal(await page.locator(".opencraft-chat-document").getAttribute("data-markdown-animated"), null);
    // Local async media state must still settle inside an otherwise memoized tree.
    await page.evaluate(() => (window as any).fixture.patch({ source: "![Fixture image](./fixture.png)" }));
    await page.waitForFunction(() => (window as any).pending.length > 0);
    await page.evaluate(() => { const w = window as any; w.events = []; w.pending.at(-1).resolve(); });
    await page.locator("img.chat-markdown-image").waitFor();
    await page.waitForFunction(() => (window as any).events.some((e: any) => e.kind === "measure" && e.id === 1 && e.reason === "resource-resolve" && e.generation > 1));
    // Runtime Context changes must cross memo even when every document prop is equal.
    const contextDelta = await page.evaluate(() => { const w = window as any, before = w.__documents; w.fixture.runtime(); return w.__documents - before; });
    assert.ok(contextDelta > 0);
    await page.waitForFunction(() => (window as any).pending.length > 1);
    await page.evaluate(() => (window as any).pending.at(-1).resolve());
    await page.locator("img.chat-markdown-image").waitFor();
    await page.evaluate(() => (window as any).fixture.patch({ source: "Updated **text**.\\n\\n```ts\\nconst answer = 42;\\n```".replaceAll("\\n", "\n"), streaming: true }));
    await page.getByText("Updated", { exact: false }).first().waitFor();
    await page.waitForFunction(() => (window as any).events.some((e: any) => e.kind === "measure" && e.id === 1 && e.reason === "code-highlight"));
    const darkHighlight = await page.locator(".chat-code-highlight").innerHTML();
    await page.evaluate(() => { const w = window as any; w.events = []; w.fixture.patch({ theme: "light" }); });
    await page.waitForFunction(() => (window as any).events.some((e: any) => e.reason === "code-highlight"));
    assert.notEqual(await page.locator(".chat-code-highlight").innerHTML(), darkHighlight, "Theme-only change refreshes syntax colors");
    assert.equal(await page.locator(".opencraft-chat-document").getAttribute("data-markdown-animated"), "true");
    // Closing a streamed fence must not replace the control the reader is using.
    const openCode = "```js\nconst longLine = '" + "readable code ".repeat(120) + "';";
    await page.evaluate(source => { const w = window as any; w.events = []; w.fixture.patch({ source }); }, openCode);
    const surface = page.locator("figure.chat-code-block");
    await surface.waitFor();
    assert.equal(await surface.getAttribute("data-code-open"), "true");
    assert.equal(await surface.getByRole("button", { name: "Copy code", exact: true }).count(), 0);
    const figure = await surface.elementHandle();
    const toggle = await surface.locator(".chat-code-action--wrap").elementHandle();
    const scroller = await surface.locator(".chat-code-block__scroller").elementHandle();
    await toggle!.focus();
    await scroller!.evaluate((e: HTMLElement) => { e.scrollLeft = 160; });
    const scrollLeft = await scroller!.evaluate((e: HTMLElement) => e.scrollLeft);
    assert.ok(scrollLeft > 0, "Long code scrolls locally");
    const appendedCode = openCode + "\nconst appended = 123;";
    await page.evaluate(source => (window as any).fixture.patch({ source }), appendedCode);
    assert.ok(await toggle!.evaluate((e: Element) => e === document.activeElement));
    assert.equal(await scroller!.evaluate((e: HTMLElement) => e.scrollLeft), scrollLeft);
    assert.equal(await surface.locator(".chat-code-highlight").count(), 0, "Open code stays plain");
    assert.equal(await page.evaluate(() => (window as any).events.filter((e: any) => e.reason === "code-highlight").length), 0);
    await page.evaluate(source => (window as any).fixture.patch({ source }), appendedCode + "\n```");
    assert.ok(await toggle!.evaluate((e: Element) => e.isConnected && e === document.activeElement), "Closing code keeps the focused wrap control");
    assert.ok(await figure!.evaluate((e: Element) => e.isConnected), "Closing code keeps its surface");
    assert.ok(await scroller!.evaluate((e: Element) => e.isConnected), "Closing code keeps its scroller");
    assert.equal(await surface.getAttribute("data-code-open"), null);
    await page.waitForFunction(() => (window as any).events.some((e: any) => e.reason === "code-highlight"));
    assert.equal(await scroller!.evaluate((e: HTMLElement) => e.scrollLeft), scrollLeft, "Highlighting keeps local scroll");
    assert.ok(await toggle!.evaluate((e: Element) => e === document.activeElement), "Highlighting keeps control focus");
    assert.equal(await surface.locator("code").textContent(), appendedCode.slice("```js\n".length));
    // The reader can select code before the stream finishes. Syntax colors
    // must not erase that selection, including its backwards direction.
    const selectableCode = "```ts\nconst selected = 42;\nconsole.log('你好🙂');";
    await page.evaluate(source => (window as any).fixture.patch({ source }), selectableCode);
    await surface.locator("code").filter({ hasText: "selected" }).waitFor();
    await surface.locator("code").evaluate((element, backwards) => {
      const text = element.firstChild!;
      const start = element.textContent!.indexOf("selected");
      window.getSelection()!.setBaseAndExtent(text, start + (backwards ? 8 : 0), text, start + (backwards ? 0 : 8));
    }, width === 1280);
    const selectionState = () => surface.locator("code").evaluate(element => {
      const selection = window.getSelection()!;
      const offset = (node: Node | null, position: number) => {
        if (!node || !element.contains(node)) return null;
        const range = document.createRange();
        range.selectNodeContents(element); range.setEnd(node, position);
        return range.toString().length;
      };
      return { text: selection.toString(), anchor: offset(selection.anchorNode, selection.anchorOffset), focus: offset(selection.focusNode, selection.focusOffset) };
    });
    const selected = await selectionState();
    assert.equal(selected.text, "selected");
    const selectionAppend = selectableCode + "\n// Additional streamed code";
    await page.evaluate(source => (window as any).fixture.patch({ source }), selectionAppend);
    assert.deepEqual(await selectionState(), selected, "Streaming append keeps code selection and direction");
    await page.evaluate(source => { (window as any).events = []; (window as any).fixture.patch({ source }); }, selectionAppend + "\n```\n\nTrailing text.");
    await page.waitForFunction(() => (window as any).events.some((event: any) => event.reason === "code-highlight"));
    assert.deepEqual(await selectionState(), selected, "Fence completion and highlight keep code selection");
    await page.evaluate(() => { (window as any).events = []; (window as any).fixture.patch({ theme: "dark" }); });
    await page.waitForFunction(() => (window as any).events.some((event: any) => event.reason === "code-highlight"));
    assert.deepEqual(await selectionState(), selected, "Theme recoloring keeps code selection");
    const trailing = page.locator(".opencraft-chat-document p").filter({ hasText: "Trailing text." });
    await trailing.evaluate(element => {
      const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
      window.getSelection()!.setBaseAndExtent(text, 0, text, 8);
    });
    await page.evaluate(() => { (window as any).events = []; (window as any).fixture.patch({ theme: "light" }); });
    await page.waitForFunction(() => (window as any).events.some((event: any) => event.reason === "code-highlight"));
    assert.equal(await page.evaluate(() => window.getSelection()!.toString()), "Trailing", "Recoloring does not steal a selection outside code");
    const spanningSelection = await page.evaluate(() => {
      const code = document.querySelector("figure.chat-code-block code")!;
      const trailing = Array.from(document.querySelectorAll(".opencraft-chat-document p")).find(element => element.textContent === "Trailing text.")!;
      const proseText = document.createTreeWalker(trailing, NodeFilter.SHOW_TEXT).nextNode()!;
      const codeText = document.createTreeWalker(code, NodeFilter.SHOW_TEXT).nextNode()!;
      window.getSelection()!.setBaseAndExtent(proseText, 8, codeText, 0);
      return window.getSelection()!.toString();
    });
    await page.evaluate(() => { (window as any).events = []; (window as any).fixture.patch({ theme: "dark" }); });
    await page.waitForFunction(() => (window as any).events.some((event: any) => event.reason === "code-highlight"));
    assert.equal(await page.evaluate(() => window.getSelection()!.toString()), spanningSelection, "A selection spanning code and prose survives recoloring");
    // A growing word keeps its rendered span but React replaces its text.
    // Keep the reader's exact range across word and whitespace appends.
    for (const sample of [
      { source: "Alpha selected", start: 6, end: 14, suffix: "More" },
      { source: "Alpha selected", start: 6, end: 14, suffix: " more words" },
      { source: "你好🙂 selected", start: 0, end: "你好🙂 selected".length, suffix: " more words" },
    ]) {
      await page.evaluate(source => (window as any).fixture.patch({ source, streaming: true }), sample.source);
      await page.evaluate(({ start, end, backwards }) => {
        const paragraph = document.querySelector(".opencraft-chat-document p")!;
        const point = (offset: number) => {
          const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
          let node: Node | null;
          while ((node = walker.nextNode()) !== null) {
            const length = node.textContent!.length;
            if (offset <= length) return { node, offset };
            offset -= length;
          }
          throw new Error("Selection offset outside the rendered paragraph");
        };
        const a = point(start), b = point(end);
        window.getSelection()!.setBaseAndExtent(backwards ? b.node : a.node, backwards ? b.offset : a.offset,
          backwards ? a.node : b.node, backwards ? a.offset : b.offset);
        (window as any).selectedProse = paragraph;
        (window as any).selectedProseFocus = document.activeElement;
      }, { start: sample.start, end: sample.end, backwards: width === 1280 });
      const proseSelection = () => page.evaluate(() => {
        const paragraph = document.querySelector(".opencraft-chat-document p")!;
        const selection = window.getSelection()!;
        const point = (node: Node | null, offset: number) => {
          if (!node || !paragraph.contains(node)) return null;
          const range = document.createRange(); range.selectNodeContents(paragraph); range.setEnd(node, offset);
          return range.toString().length;
        };
        return { text: selection.toString(), anchor: point(selection.anchorNode, selection.anchorOffset),
          focus: point(selection.focusNode, selection.focusOffset), scrollY: window.scrollY,
          sameParagraph: (window as any).selectedProse === paragraph,
          sameFocus: (window as any).selectedProseFocus === document.activeElement };
      });
      const before = await proseSelection();
      assert.equal(before.text, sample.source.slice(sample.start, sample.end));
      await page.evaluate(source => (window as any).fixture.patch({ source }), sample.source + sample.suffix);
      assert.deepEqual(await proseSelection(), before, "Appending to prose retains selected text, direction and UTF-16 offsets");
      await page.evaluate(() => (window as any).fixture.patch({ streaming: false }));
      assert.deepEqual(await proseSelection(), before, "Settling prose does not disturb the range");
    }
    // Both selected endpoints can live in syntax tokens replaced by the same
    // theme update. Include a third code surface inside the selected range.
    await page.evaluate(() => { (window as any).events = []; (window as any).fixture.patch({
      source: "```ts\nconst firstSelected = 42;\n```\n\nMiddle prose.\n\n```js\nconst middle = 0;\n```\n\nMore prose.\n\n```ts\nconst lastSelected = 84;\n```",
      streaming: false,
    }); });
    await page.waitForFunction(() => (window as any).events.filter((event: any) => event.reason === "code-highlight").length === 3);
    await page.evaluate(backwards => {
      const codes = Array.from(document.querySelectorAll("figure.chat-code-block code"));
      const first = document.createTreeWalker(codes[0]!, NodeFilter.SHOW_TEXT).nextNode()!;
      const walker = document.createTreeWalker(codes[2]!, NodeFilter.SHOW_TEXT);
      let last: Node = codes[2]!, node: Node | null;
      while ((node = walker.nextNode()) !== null) last = node;
      const selection = window.getSelection()!;
      if (backwards) selection.setBaseAndExtent(last, last.textContent!.length - 1, first, 1);
      else selection.setBaseAndExtent(first, 1, last, last.textContent!.length - 1);
      (window as any).selectedCodeRoots = codes;
      (window as any).selectedFocusOwner = document.activeElement;
    }, width === 1280);
    const multiCodeSelection = () => page.evaluate(() => {
      const codes = Array.from(document.querySelectorAll("figure.chat-code-block code"));
      const selection = window.getSelection()!;
      const point = (node: Node | null, position: number) => {
        const index = codes.findIndex(code => node && code.contains(node));
        if (index < 0 || !node) return null;
        const range = document.createRange(); range.selectNodeContents(codes[index]!); range.setEnd(node, position);
        return { index, offset: range.toString().length };
      };
      return { text: selection.toString(), anchor: point(selection.anchorNode, selection.anchorOffset),
        focus: point(selection.focusNode, selection.focusOffset), scrollY: window.scrollY,
        sameRoots: (window as any).selectedCodeRoots.every((code: Node, i: number) => code === codes[i]),
        sameFocus: (window as any).selectedFocusOwner === document.activeElement };
    });
    const multiCodeBefore = await multiCodeSelection();
    assert.ok(multiCodeBefore.text.includes("lastSelected"));
    await page.evaluate(() => { (window as any).events = []; (window as any).fixture.patch({ theme: "light" }); });
    await page.waitForFunction(() => (window as any).events.filter((event: any) => event.reason === "code-highlight").length === 3);
    assert.deepEqual(await multiCodeSelection(), multiCodeBefore, "Recoloring multiple code blocks keeps both selected endpoints and direction");
    await page.evaluate(() => window.getSelection()!.removeAllRanges());
    await page.evaluate(() => (window as any).fixture.patch({ streaming: false, dialect: "user-message" }));
    assert.equal(await page.locator(".opencraft-chat-document").getAttribute("data-chat-document-dialect"), "user-message");
    assert.ok(await root!.evaluate((e: Element) => e.isConnected), "Document DOM remains mounted");
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${output}/${width}.png` });
    results.push({ width, unchanged, contextDelta, callbacks: [0, 1], mediaAndHighlight: true, themeOnly: true, fenceCompletionFocusAndScroll: true, codeSelectionContinuity: true, proseSelectionContinuity: true, multiCodeSelectionContinuity: true, domRetained: true, errors });
    await context.close();
  }
  console.log(JSON.stringify({ passed: true, results }));
} finally { await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2)); await browser?.close(); await server.close(); }
