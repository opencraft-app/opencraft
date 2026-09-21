import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { compile } from "sass";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("selection capabilities are owned by shells and content renderers", async () => {
  for (const [path, policy] of [
    ["apps/workbench-web/src/components/app-shell.tsx", "chrome"],
    ["apps/workbench-web/src/components/settings-page.tsx", "chrome"],
    ["apps/workbench-web/src/components/conversation.tsx", "text"],
    ["packages/chat-render-web/src/web-chat-document.tsx", "text"],
    ["plugins/bot-chat/src/bot-chat-view.tsx", "text"],
    ["plugins/terminal/src/index.tsx", "text"],
  ]) assert.ok((await read(path)).includes(`data-selection="${policy}"`), path);
  assert.match(await read("apps/workbench-web/src/styles/app.scss"), /@use "@opencraft\/design-system\/selection.web"/);
});

test("browser cascade preserves nested content, controls, portals and editors", {
  skip: !process.env.OPENCRAFT_TEST_CHROMIUM && "Set OPENCRAFT_TEST_CHROMIUM for browser verification",
}, async () => {
  const css = compile(fileURLToPath(new URL("packages/design-system/src/selection.web.scss", root))).css;
  const directory = await mkdtemp(join(tmpdir(), "opencraft-selection-"));
  try {
    const file = join(directory, "fixture.html");
    await writeFile(file, `<style>${css}</style>
      <main data-selection="chrome">
        <h2 id="heading">Model services</h2>
        <button id="provider"><span id="label">DeepSeek</span></button>
        <input id="search" value="Search connections">
        <section data-selection="text"><p id="message">Copy message</p>
          <button id="copy">Copy</button>
          <nav data-selection="chrome"><span id="toolbar">Toolbar</span></nav>
        </section>
        <pre id="code">source code</pre><p role="alert" id="error">Diagnostic</p>
        <textarea id="textarea">draft</textarea>
        <div contenteditable="true" id="editor">Editable</div>
        <div contenteditable="false" id="readonly">Label</div>
      </main>
      <div role="menu"><span id="portal-label">Menu</span><input id="portal-input" value="filter"></div>
      <script>
        const expected = {heading:'none', provider:'none', label:'none', search:'text',
          message:'text', copy:'none', toolbar:'none', code:'text', error:'text',
          textarea:'text', editor:'text', readonly:'none', 'portal-label':'none', 'portal-input':'text'};
        const failures = Object.entries(expected).filter(([id, value]) => getComputedStyle(document.getElementById(id)).userSelect !== value);
        document.body.dataset.result = failures.length ? JSON.stringify(failures) : 'PASS';
      </script>`);
    const output = execFileSync(process.env.OPENCRAFT_TEST_CHROMIUM, [
      "--headless", "--no-sandbox", "--disable-gpu", "--dump-dom", pathToFileURL(file).href,
    ], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
    assert.match(output, /data-result="PASS"/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
