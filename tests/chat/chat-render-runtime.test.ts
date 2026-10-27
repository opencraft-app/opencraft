import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Context } from "@deepseek-ai/cordis";

import type { ChatDocumentNode } from "@opencraft/chat-document";
import {
  ChatFadeTimeline,
  chatFileCitationPresentation,
  chatReferenceTarget,
  createChatRenderRuntime,
  registerStandardChatResourcePolicy,
  resolveStandardChatResource,
  type ChatNodeRenderer,
  type ChatRenderContext,
} from "@opencraft/chat-render-react";
import {
  normalizeTerminalOutput,
  parseAnsiTerminalOutput,
} from "../../packages/chat-render-web/src/renderers/terminal/ansi-terminal-text";
import { ChatEnhancementService } from "../../packages/chat-render-web/src/services/chat-enhancement-service";
import { CodeText } from "../../packages/chat-render-web/src/renderers/code/code-text";
import {
  codeBlockWrapPreference,
  codeLanguageLabel,
  isSvgCodeSnippet,
  resolveCodeSurfacePolicy,
} from "../../packages/chat-render-web/src/renderers/code/code-block-model";
import {
  appendUnhighlightedCodeTail,
  unwrapHighlightedCodeHtml,
} from "../../packages/chat-render-web/src/extensions/shiki/highlighted-code-html";
import {
  OPENCRAFT_DARK_SYNTAX,
  OPENCRAFT_LIGHT_SYNTAX,
} from "@opencraft/chat-render-react/code-highlight-themes";
import {
  createMermaidRenderKey,
  createMermaidRenderState,
  isMermaidRenderRevealed,
  mermaidShellHeight,
  MERMAID_INITIAL_HEIGHT,
  prepareMermaidSource,
  reduceMermaidRenderState,
} from "../../packages/chat-render-web/src/extensions/mermaid/mermaid-render-model";
import {
  writeTextWithClipboardFallback,
  writeToClipboard,
} from "../../packages/chat-render-web/src/clipboard";

const codeBlockSource = readFileSync(
  new URL(
    "../../packages/chat-render-web/src/renderers/code/code-block.tsx",
    import.meta.url,
  ),
  "utf8",
);
const codeBlockStyles = readFileSync(
  new URL(
    "../../packages/chat-render-web/src/renderers/code/code-block.scss",
    import.meta.url,
  ),
  "utf8",
);
const shikiAdapterSource = readFileSync(
  new URL(
    "../../packages/chat-render-web/src/extensions/shiki/shiki-code.tsx",
    import.meta.url,
  ),
  "utf8",
);
const shikiPluginSource = readFileSync(
  new URL(
    "../../packages/chat-render-web/src/extensions/shiki/plugin.tsx",
    import.meta.url,
  ),
  "utf8",
);
const enhancementSource = readFileSync(
  new URL(
    "../../packages/chat-render-web/src/services/chat-enhancement-service.ts",
    import.meta.url,
  ),
  "utf8",
);
const workbenchStyles = readFileSync(
  new URL("../../apps/workbench-web/src/styles/app.scss", import.meta.url),
  "utf8",
);
const webDocumentSource = readFileSync(
  new URL(
    "../../packages/chat-render-web/src/web-chat-document.tsx",
    import.meta.url,
  ),
  "utf8",
);
const markdownCopySource = readFileSync(
  new URL("../../packages/chat-render-web/src/markdown-copy.ts", import.meta.url),
  "utf8",
);

const context: ChatRenderContext = {
  documentId: "doc",
  theme: "light",
  externalResourcePolicy: "allow",
  streaming: false,
  allowWideBlocks: true,
};

const textNode: ChatDocumentNode = {
  kind: "text",
  stableKey: "text",
  completeness: "complete",
  sourceRange: { start: 0, end: 4 },
  text: "test",
  segments: [],
};

const renderer: ChatNodeRenderer = {
  name: "test-text",
  priority: 10,
  kinds: ["text"],
  component: () => null,
};

test("Cordis renderer registry is ordered, subscribable and disposable", async () => {
  const runtime = await createChatRenderRuntime({ maximumSessions: 16 });
  let notifications = 0;
  const unsubscribe = runtime.renderers.subscribe(() => {
    notifications += 1;
  });
  const remove = runtime.renderers.register(renderer);
  assert.equal(
    runtime.renderers.resolve(
      runtime.renderers.getSnapshot(),
      textNode,
      context,
    )?.name,
    "test-text",
  );
  assert.equal(notifications, 1);
  assert.throws(() => runtime.renderers.register(renderer), /already exists/);
  remove();
  assert.equal(
    runtime.renderers.resolve(
      runtime.renderers.getSnapshot(),
      textNode,
      context,
    ),
    null,
  );
  assert.equal(notifications, 2);
  unsubscribe();
  await runtime.dispose();
});

test("resource policies reject restricted external resources and can be overridden", async () => {
  const runtime = await createChatRenderRuntime();
  const removeStandard = registerStandardChatResourcePolicy(runtime.resources, "test-standard-url");
  const restricted = {
    ...context,
    externalResourcePolicy: "restricted" as const,
  };
  assert.equal(
    runtime.resources.resolve("https://example.com", restricted).allowed,
    false,
  );
  assert.equal(runtime.resources.resolve("javascript:alert(1)", context).allowed, false);
  assert.equal(runtime.resources.resolve("src/main.ts", { ...context, cwd: "/opencraft" }).target, "file:///opencraft/src/main.ts");
  const removeHostRestriction = runtime.resources.register({
    name: "host-restricted-domain",
    priority: 100,
    matches: target => URL.canParse(target) && new URL(target).origin === "https://private.example",
    resolve: () => ({ allowed: false, kind: "blocked", target: null, reason: "Host policy" }),
  });
  assert.equal(runtime.resources.resolve("https://private.example/path", context).allowed, false);
  assert.equal(runtime.resources.resolve("https://private.example.other.test/path", context).allowed, true);
  removeHostRestriction();
  const remove = runtime.resources.register({
    name: "workspace-files",
    priority: 100,
    matches: (target) => target.startsWith("file://"),
    resolve: (target) => ({ allowed: true, target }),
  });
  assert.equal(
    runtime.resources.resolve("file:///opencraft/a.ts", restricted).allowed,
    true,
  );
  remove();
  removeStandard();
  await runtime.dispose();
});

test("Chat URLs distinguish navigation, workspace files, external links and unsafe schemes", () => {
  const context = { cwd: "/opencraft", externalResourcePolicy: "allow" as const };
  assert.deepEqual(resolveStandardChatResource("src/main.ts", context), {
    allowed: true,
    kind: "workspace-file",
    target: "file:///opencraft/src/main.ts",
  });
  assert.equal(
    resolveStandardChatResource("https://example.com", context).kind,
    "external",
  );
  assert.equal(
    resolveStandardChatResource(
      "https://example.com/docs?x=1&oai_link_source=model_response_hotline",
      context,
    ).target,
    "https://example.com/docs?x=1",
  );
  assert.deepEqual(
    resolveStandardChatResource("src/main.ts:12:4-18:9", context),
    {
      allowed: true,
      kind: "workspace-file",
      target: "file:///opencraft/src/main.ts#L12C4-L18C9",
    },
  );
  assert.equal(
    resolveStandardChatResource("mcp://server/resource", context).kind,
    "resource",
  );
  assert.equal(
    resolveStandardChatResource("agent://thread/child", context).kind,
    "app-route",
  );
  assert.equal(
    resolveStandardChatResource("tel:+8612345", context).kind,
    "external",
  );
  assert.equal(resolveStandardChatResource("#result", context).kind, "anchor");
  assert.equal(
    resolveStandardChatResource("app://settings", context).kind,
    "app-route",
  );
  assert.equal(
    resolveStandardChatResource("javascript:alert(1)", context).allowed,
    false,
  );
});

test("legacy Codex resource URIs remain classified without rewriting their target", () => {
  for (const target of ["codex://settings", "CoDeX://settings"]) {
    assert.deepEqual(resolveStandardChatResource(target, { cwd: null, externalResourcePolicy: "restricted" }), {
      allowed: true,
      kind: "app-route",
      target,
    });
  }
});

test("file citations and mentions share the same display target on Web and Native", () => {
  const base = { stableKey: "source", completeness: "complete" as const, sourceRange: { start: 0, end: 30 } };
  const citation: Extract<ChatDocumentNode, { kind: "directive" }> = {
    ...base,
    kind: "directive",
    name: "file-citation",
    attributes: { path: "src/docs/readme.md", line_range_start: "12", line_range_end: "18" },
    raw: "【src/docs/readme.md†L12-L18】",
  };
  assert.deepEqual(chatFileCitationPresentation(citation), {
    label: "readme.md (L12–18)",
    target: "src/docs/readme.md:12-18",
  });
  const mention: Extract<ChatDocumentNode, { kind: "reference" }> = {
    ...base, kind: "reference", text: "@src/docs/readme.md", referenceKind: "workspace-file", segments: [],
  };
  assert.equal(chatReferenceTarget(mention), "src/docs/readme.md");
  assert.equal(chatReferenceTarget({ ...mention, text: "$workspace", referenceKind: "variable" }), null);
});

test("code blocks share word-wrap preference and normalize language labels", () => {
  let publications = 0;
  const unsubscribe = codeBlockWrapPreference.subscribe(() => {
    publications += 1;
  });
  codeBlockWrapPreference.set(false);
  codeBlockWrapPreference.toggle();
  assert.equal(codeBlockWrapPreference.getSnapshot(), true);
  assert.equal(publications, 1);
  assert.equal(codeLanguageLabel("tsx", false), "TypeScript");
  assert.equal(codeLanguageLabel("js", false), "JavaScript");
  for (const [language, label] of [["arduino", "Arduino"], ["python-repl", "Python REPL"],
    ["php-template", "PHP template"], ["patch", "Diff"]]) {
    for (const input of [language, ` ${language.toUpperCase()} `]) {
      for (const open of [false, true]) assert.equal(codeLanguageLabel(input, open), label);
    }
  }
  assert.equal(codeLanguageLabel(null, false), "Code");
  assert.equal(codeLanguageLabel(null, true), "");
  assert.deepEqual(resolveCodeSurfacePolicy({ code: "const x = 1", language: "ts" }), {
    variant: "default",
    wrap: "user-controlled",
  });
  assert.equal(resolveCodeSurfacePolicy({ code: "text", forceWrap: true, language: "text" }).wrap, "always");
  assert.equal(resolveCodeSurfacePolicy({ code: "text", language: "text", variant: "preview" }).wrap, "off");
  assert.equal(resolveCodeSurfacePolicy({ code: "<svg></svg>", language: "svg" }).wrap, "off");
  codeBlockWrapPreference.set(false);
  unsubscribe();
});

test("code wrap observers publish only changes and can release duplicate callback membership", () => {
  codeBlockWrapPreference.set(false);
  const observed: boolean[] = [];
  const listener = () => observed.push(codeBlockWrapPreference.getSnapshot());
  const first = codeBlockWrapPreference.subscribe(listener);
  const duplicate = codeBlockWrapPreference.subscribe(listener);
  try {
    codeBlockWrapPreference.set(false);
    codeBlockWrapPreference.set(true);
    codeBlockWrapPreference.set(true);
    assert.deepEqual(observed, [true]);
    assert.equal(first(), true);
    assert.equal(first(), false);
    codeBlockWrapPreference.toggle();
    assert.deepEqual(observed, [true]);
    assert.equal(codeBlockWrapPreference.getSnapshot(), false);
  } finally {
    first(); duplicate(); codeBlockWrapPreference.set(false);
  }
});

test("SVG preview policy needs an explicit markup language and wins over forced wrapping", () => {
  assert.equal(isSvgCodeSnippet("\n<SVG viewBox='0 0 1 1'></SVG>", " XML "), true);
  for (const code of ["<svgwhatever>", "text <svg >", "<!--comment--><svg >", "<?xml?><svg >"]) {
    assert.equal(isSvgCodeSnippet(code, "svg"), false);
  }
  assert.equal(isSvgCodeSnippet("<svg >", null), false);
  assert.equal(resolveCodeSurfacePolicy({code: "<svg >", language: "html", forceWrap: true}).wrap, "off");
  assert.equal(codeLanguageLabel(" Unknown-Language ", false), " Unknown-Language ");
});

test("syntax highlighting preserves the permanent code-box geometry", () => {
  const shikiHtml =
    '<pre class="shiki"><code><span style="color:red">const</span> x</code></pre>';
  assert.equal(
    unwrapHighlightedCodeHtml(shikiHtml),
    '<span style="color:red">const</span> x',
  );
  assert.equal(
    appendUnhighlightedCodeTail(
      "const x",
      '<span style="color:red">const</span> x',
      "const x\n<&",
    ),
    '<span style="color:red">const</span> x\n&lt;&amp;',
  );
  assert.equal(appendUnhighlightedCodeTail("old", "highlighted", "new"), "");
  assert.match(
    codeBlockSource,
    /<pre>[\s\S]*<CodeText/u,
  );
  assert.equal(renderToStaticMarkup(createElement(CodeText, { code: "const x < y", highlightedHtml: null })),
    "<code>const x &lt; y</code>");
  assert.equal(renderToStaticMarkup(createElement(CodeText, { code: "const x", highlightedHtml: '<span style="color:red">const</span> x' })),
    '<code class="chat-code-highlight"><span style="color:red">const</span> x</code>');
  assert.doesNotMatch(codeBlockSource, /<div className="chat-code-highlight"/u);
});

test("code enhancement leases are owned by one bounded Cordis service", () => {
  assert.match(enhancementSource, /class ChatEnhancementService extends Service/u);
  assert.match(enhancementSource, /"600px 0px"/u);
  assert.match(enhancementSource, /\["highlight", 4\]/u);
  assert.match(enhancementSource, /while \(this\.resultCache\.size > 100\)/u);
  assert.match(shikiAdapterSource, /<CodeBlockSurface/u);
  assert.match(shikiAdapterSource, /enhancements\.run\(/u);
  assert.match(shikiAdapterSource, /loadShikiEngine\(\)/u);
  assert.doesNotMatch(shikiAdapterSource, /Suspense|\blazy\(/u);
  assert.doesNotMatch(shikiPluginSource, /Suspense|\blazy\(/u);
});

test("Chat enhancement service bounds concurrency and deduplicates cached work", async () => {
  const cordis = new Context();
  const fiber = cordis.plugin(ChatEnhancementService);
  await fiber;
  let active = 0;
  let maximumActive = 0;
  const jobs = Array.from({ length: 8 }, (_, index) => cordis.chatEnhancements.run({
    lane: "highlight",
    run: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return index;
    },
  }));
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(maximumActive, 4);

  let calls = 0;
  const first = cordis.chatEnhancements.run({
    cacheKey: "same-highlight",
    lane: "highlight",
    run: async () => ++calls,
  });
  const second = cordis.chatEnhancements.run({
    cacheKey: "same-highlight",
    lane: "highlight",
    run: async () => ++calls,
  });
  assert.equal(await first, 1);
  assert.equal(await second, 1);
  assert.equal(calls, 1);
  await fiber.dispose();
});

test("Chat enhancement cancellation reaches queued and active work without cancelling shared consumers", async () => {
  const cordis = new Context();
  const fiber = cordis.plugin(ChatEnhancementService);
  await fiber;

  const activeAbort = new AbortController();
  let activeSignalObserved = false;
  const active = cordis.chatEnhancements.run({
    lane: "diagram",
    signal: activeAbort.signal,
    run: (signal) => new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => resolve(1), 100);
      signal.addEventListener("abort", () => {
        activeSignalObserved = true;
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      }, { once: true });
    }),
  });
  const queuedAbort = new AbortController();
  let queuedStarted = false;
  const queued = cordis.chatEnhancements.run({
    lane: "diagram",
    signal: queuedAbort.signal,
    run: async () => {
      queuedStarted = true;
      return 2;
    },
  });
  queuedAbort.abort();
  await assert.rejects(queued, { name: "AbortError" });
  assert.equal(queuedStarted, false);
  activeAbort.abort();
  await assert.rejects(active);
  assert.equal(activeSignalObserved, true);

  const firstConsumer = new AbortController();
  let sharedSignalAborted = false;
  let sharedCalls = 0;
  const runShared = (signal: AbortSignal) => new Promise<number>((resolve) => {
    sharedCalls += 1;
    signal.addEventListener("abort", () => {
      sharedSignalAborted = true;
    }, { once: true });
    setTimeout(() => resolve(3), 5);
  });
  const first = cordis.chatEnhancements.run({
    cacheKey: "shared-cancellable-highlight",
    lane: "highlight",
    signal: firstConsumer.signal,
    run: runShared,
  });
  const second = cordis.chatEnhancements.run({
    cacheKey: "shared-cancellable-highlight",
    lane: "highlight",
    run: runShared,
  });
  firstConsumer.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(await second, 3);
  assert.equal(sharedCalls, 1);
  assert.equal(sharedSignalAborted, false);

  await fiber.dispose();
});

test("code surface owns default and preview geometry", () => {
  assert.match(codeBlockSource, /policy\?: CodeSurfacePolicy/u);
  assert.match(codeBlockSource, /data-code-variant=\{resolvedPolicy\.variant\}/u);
  assert.match(codeBlockSource, /data-code-wrap-policy=\{resolvedPolicy\.wrap\}/u);
  assert.match(
    codeBlockStyles,
    /\[data-code-variant="preview"\][\s\S]*?max-height:\s*calc\(15lh \+ 16px\)/u,
  );
  assert.match(
    codeBlockStyles,
    /font-size:\s*var\(--opencraft-chat-font-size\)/u,
  );
  assert.doesNotMatch(
    workbenchStyles,
    /\.chat-code-block__scroller\s*\{[\s\S]{0,100}?max-height/u,
  );
});

test("Shiki uses the shared OpenCraft syntax palettes", () => {
  assert.deepEqual(OPENCRAFT_LIGHT_SYNTAX, {
    foreground: "#0d0d0d",
    comment: "#666666",
    string: "#008809",
    number: "#0071EA",
    regexp: "#001BCB",
    keyword: "#D53538",
    variable: "#BD5800",
    parameter: "#666666",
    function: "#751ED9",
  });
  assert.equal(OPENCRAFT_DARK_SYNTAX.function, "#B06DFF");
  assert.doesNotMatch(shikiAdapterSource, /github-(?:dark|light)/u);
});

test("Mermaid rendering keeps the last committed geometry across render keys", () => {
  const lightKey = createMermaidRenderKey("light", "graph TD; A-->B");
  const darkKey = createMermaidRenderKey("dark", "graph TD; A-->B");
  const initial = createMermaidRenderState(lightKey);
  assert.equal(mermaidShellHeight(initial), MERMAID_INITIAL_HEIGHT);

  const rendered = reduceMermaidRenderState(initial, {
    type: "rendered",
    key: lightKey,
    height: 317.4,
  });
  assert.equal(rendered.committedHeight, 317);
  assert.equal(isMermaidRenderRevealed(rendered), false);

  const revealed = reduceMermaidRenderState(rendered, {
    type: "reveal",
    key: lightKey,
  });
  assert.equal(isMermaidRenderRevealed(revealed), true);

  const rerendering = reduceMermaidRenderState(revealed, {
    type: "begin",
    key: darkKey,
  });
  assert.equal(rerendering.status, "rendering");
  assert.equal(mermaidShellHeight(rerendering), 317);
  assert.equal(isMermaidRenderRevealed(rerendering), false);

  assert.equal(
    reduceMermaidRenderState(rerendering, {
      type: "rendered",
      key: lightKey,
      height: 20,
    }),
    rerendering,
  );
});

test("Mermaid rendering fails closed and ignores document-owned directives", () => {
  const key = createMermaidRenderKey("light", "graph TD; A-->B");
  const state = reduceMermaidRenderState(createMermaidRenderState(key), {
    type: "failed",
    key,
    error: "parse failed",
  });
  assert.equal(state.status, "error");
  assert.equal(state.error, "parse failed");
  assert.equal(
    prepareMermaidSource(`%%{init: { 'theme': 'dark' }}%%
graph TD
  A --> B
  click A "javascript:alert(1)"`),
    "graph TD\n  A --> B",
  );
});

test("code-header stickiness is an explicit surface capability with shared scroll coordinates", () => {
  assert.match(
    webDocumentSource,
    /stickyCodeHeaders:\s*props\.stickyCodeHeaders \?\? false/u,
  );
  assert.match(codeBlockSource, /stickyHeader = false/u);
  assert.match(
    codeBlockSource,
    /data-code-sticky-header=\{stickyHeader \|\| undefined\}/u,
  );
  assert.match(
    codeBlockStyles,
    /\[data-code-sticky-header="true"\] figcaption\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*calc\(-1px - var\(--thread-sticky-header-top, 0px\)\);/u,
  );
  assert.doesNotMatch(
    codeBlockStyles,
    /figcaption\s*\{[\s\S]{0,160}?top:\s*var\(--thread-floating-content-top-inset/u,
  );
});

test("clipboard writes use the modern path and fall back when insecure contexts reject it", async () => {
  const calls: string[] = [];
  await writeTextWithClipboardFallback("modern", {
    writeModern: async (text) => {
      calls.push(`modern:${text}`);
    },
    writeLegacy: (text) => {
      calls.push(`legacy:${text}`);
      return true;
    },
  });
  await writeTextWithClipboardFallback("fallback", {
    writeModern: async (text) => {
      calls.push(`modern:${text}`);
      throw new Error("denied");
    },
    writeLegacy: (text) => {
      calls.push(`legacy:${text}`);
      return true;
    },
  });
  assert.deepEqual(calls, [
    "modern:modern",
    "modern:fallback",
    "legacy:fallback",
  ]);
  await assert.rejects(
    writeTextWithClipboardFallback("missing", {}),
    /Clipboard write is unavailable/u,
  );
});

test("clipboard payloads preserve plain-text and HTML MIME channels", async () => {
  assert.equal(typeof writeToClipboard, "function");
  const clipboardSource = readFileSync(
    new URL("../../packages/chat-render-web/src/clipboard.ts", import.meta.url),
    "utf8",
  );
  assert.match(clipboardSource, /new ClipboardItemConstructor/u);
  assert.match(clipboardSource, /data\["text\/plain"\]/u);
});

test("the Markdown root owns capture-phase semantic copy", () => {
  assert.match(
    webDocumentSource,
    /addEventListener\("copy", listener, \{ capture: true \}\)/u,
  );
  assert.match(
    markdownCopySource,
    /event\.clipboardData\.setData\("text\/html"/u,
  );
  assert.match(
    markdownCopySource,
    /event\.clipboardData\.setData\("text\/plain"/u,
  );
  assert.match(markdownCopySource, /annotation\[encoding=/u);
  assert.match(markdownCopySource, /data-markdown-copy-text/u);
});

test("fade timeline caps cumulative waiting and does not replay delay on remount", () => {
  const timeline = new ChatFadeTimeline();
  const delays = Array.from({ length: 8 }, (_, index) =>
    timeline.delayFor(`segment-${index}`, 100),
  );
  assert.deepEqual(delays, [0, 16, 32, 48, 64, 80, 96, 96]);
  for (let index = 8; index < 5_000; index++) assert.ok(timeline.delayFor(`segment-${index}`, 100) <= 96);
  assert.equal(timeline.delayFor("segment-4", 150), 14);
  assert.equal(timeline.delayFor("segment-4", 999), 0);
  assert.equal(timeline.isSettled("segment-4999", 346), true);
  timeline.settle("segment-4");
  assert.equal(timeline.isSettled("segment-4"), true);
  assert.equal(timeline.delayFor("after-idle-gap", 1_000), 0);
});

test("compiler service reuses a document session across virtualized remounts", async () => {
  const runtime = await createChatRenderRuntime();
  const first = runtime.documents.session("stable");
  const candidate = first.compile("hello", { streaming: true });
  candidate.commit();
  runtime.documents.release("stable");
  const remounted = runtime.documents.session("stable");
  assert.equal(remounted, first);
  assert.equal(remounted.getSnapshot()?.source, "hello");
  await runtime.dispose();
});

test("terminal output applies carriage-return overwrite and backspace semantics", () => {
  assert.equal(
    normalizeTerminalOutput("progress 10%\rprogress 100%\nab\bc"),
    "progress 100%\nac",
  );
});

test("terminal output preserves ANSI SGR spans without exposing escape codes", () => {
  const segments = parseAnsiTerminalOutput("plain \u001b[31mred\u001b[0m done");
  assert.deepEqual(segments, [
    { text: "plain ", style: undefined },
    { text: "red", style: { color: "#cf222e" } },
    { text: " done", style: undefined },
  ]);
  assert.deepEqual(parseAnsiTerminalOutput("\u001b[38;2;1;2;3mtruecolor"), [
    { text: "truecolor", style: { color: "rgb(1 2 3)" } },
  ]);
});
