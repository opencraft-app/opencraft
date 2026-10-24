import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { transform } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import * as core from "@opencraft/chat-core";
import * as renderReact from "@opencraft/chat-render-react";
import * as listMarker from "../../packages/chat-render-native/src/renderers/list-marker";
import * as mediaParagraph from "../../packages/chat-render-native/src/renderers/media-paragraph";
import * as proseSpacing from "../../packages/chat-render-native/src/renderers/prose-spacing";
import * as imageSize from "../../packages/chat-render-native/src/renderers/image-size";
import * as resourceOpening from "../../packages/chat-render-native/src/renderers/resource-opening";
import * as actionArtwork from "@opencraft/design-system/action-artwork";
import * as sidebarArtwork from "@opencraft/design-system/sidebar-toggle-glyphs";
import { workingShimmerMotion } from "@opencraft/design-system/tokens";
import * as typography from "@opencraft/design-system/typography";
import { nativeThemes } from "@opencraft/design-system/tokens.native";

// Execute the production Native component and InteractiveSurface with only
// their platform/unused host seams replaced. This is not an iPhone OS test.
const require = createRequire(import.meta.url);
// tsx's Node harness emits the shared React package's JSX in classic mode;
// production Vite/Metro use the automatic runtime. Preserve the harness seam.
const previousReact = Object.getOwnPropertyDescriptor(globalThis, "React");
Object.assign(globalThis, { React });
test.after(() => {
  if (previousReact) Object.defineProperty(globalThis, "React", previousReact);
  else Reflect.deleteProperty(globalThis, "React");
});
const theme = nativeThemes.light;
const styles = {
  hairlineWidth: 1,
  create: (value: object | ((theme: typeof nativeThemes.light) => object)) =>
    typeof value === "function" ? value(theme) : value,
};
function platformElement(tag: string) {
  return function Element({ children, accessibilityLabel, accessibilityRole, accessibilityState, selectable, onPress, style }: any) {
    const flattenedStyle = Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
    return React.createElement(tag, {
      "aria-label": accessibilityLabel,
      role: accessibilityRole,
      "aria-expanded": accessibilityState?.expanded,
      "data-selectable": selectable ? "true" : undefined,
      "data-font-weight": flattenedStyle.fontWeight,
      "data-font-style": flattenedStyle.fontStyle,
      onClick: onPress,
    }, children);
  };
}
class AnimatedValue {
  constructor(readonly value: number) {}
  setValue() {}
  interpolate() { return 0; }
}
const View = platformElement("div");
const Text = platformElement("span");
const Pressable = platformElement("button");
const native = {
  View, Text, Pressable, ScrollView: View,
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  Easing: { bezier: () => (value: number) => value },
  Platform: { OS: "ios", select: (options: { default?: unknown }) => options.default },
  Animated: {
    Value: AnimatedValue, View,
    multiply: () => 0,
    timing: () => ({ start() {}, stop() {} }),
  },
  AccessibilityInfo: {
    isReduceMotionEnabled: async () => true,
    addEventListener: () => ({ remove() {} }),
  },
};
const icon = () => React.createElement("span", { "aria-hidden": true });
const seams: Record<string, unknown> = {
  "react": React,
  "react/jsx-runtime": require("react/jsx-runtime"),
  "react-native": native,
  "react-native-svg": { __esModule: true, default: icon, Circle: icon, Path: icon, Rect: icon, Ellipse: icon, Line: icon, Polygon: icon, Polyline: icon },
  "@opencraft/design-system/action-artwork": actionArtwork,
  "@opencraft/design-system/sidebar-toggle-glyphs": sidebarArtwork,
  "@opencraft/chat-core": core,
  "@opencraft/design-system/tokens": { workingShimmerMotion },
  "@opencraft/chat-render-native": {},
  "@opencraft/chat-render-react": renderReact,
  "@opencraft/design-system/tokens.native": { nativeThemes },
  "@opencraft/design-system/typography": typography,
  "./styles": { StyleSheet: styles },
  "../styles": { StyleSheet: styles },
  "./renderers/image-gallery": { NativeImageGalleryProvider: ({ children }: any) => children },
  "./presentation-language": { NativeChatLanguageProvider: ({ children }: any) => children },
  "./list-marker": listMarker,
  "./media-paragraph": mediaParagraph,
  "./prose-spacing": proseSpacing,
  "./image-size": imageSize,
  "./resource-opening": resourceOpening,
  "../presentation-language": { useNativeChatCopy: () => ({}) },
  "./image-gallery": { useNativeImageGallery: () => null },
  "expo-clipboard": { setStringAsync: async () => undefined },
  // Only OS clipboard and touch-scroll plumbing are substituted; production
  // document/prose/code/link components and resource policy execute below.
  "./use-copy-feedback": { useCopyFeedback: () => ({ copied: false, copy: () => undefined }) },
  "../horizontal-scroll-owner": { useNativeHorizontalOverflowTouchOwner: () => ({ scrollEnabled: true }) },
  "@opencraft/timeline-render-react": {
    TimelineBlockView: ({ block }: any) => React.createElement("span", { "data-block-type": block.type }, block.command ?? block.text),
    useWorkStatusLabel: (item: core.WorkStatusItem) => core.deriveWorkStatusLabel(item, 0),
  },
  "@opencraft/workbench-runtime": {},
  "../styles/workbench-styles": { StyleSheet: styles, useWorkbenchTheme: () => ({ theme }) },
  "../../styles/workbench-styles": { StyleSheet: styles },
  "./native-response-positioned-turns": {},
  "./native-turn-target-context": { NativeTurnTargetContext: React.createContext(null) },
  "./use-native-user-message-collapse": {},
  "./ui/button": { Button: Pressable, IconButton: Pressable },
};
async function compileNative(url: URL, expose = "") {
  const { code } = await transform(readFileSync(url, "utf8") + expose, {
    sourcefile: url.pathname, loader: "tsx", jsx: "automatic", format: "cjs", target: "es2022",
  });
  const module = { exports: {} as any };
  new Function("require", "exports", "module", code)((name: string) => {
    assert.ok(Object.hasOwn(seams, name), `Unexpected Native seam ${name}`);
    return seams[name];
  }, module.exports, module);
  return module.exports;
}
seams["@opencraft/design-system-native/action-icons"] = await compileNative(new URL("../../packages/design-system-native/src/action-icons.tsx", import.meta.url));
seams["./ui/interactive-surface"] = await compileNative(new URL("../../apps/workbench-expo/src/components/ui/interactive-surface.tsx", import.meta.url));
const { NativeProseRenderer, nativeProseNodeKinds } = await compileNative(new URL("../../packages/chat-render-native/src/renderers/prose.tsx", import.meta.url));
const { NativeCodeRenderer } = await compileNative(new URL("../../packages/chat-render-native/src/renderers/code.tsx", import.meta.url));
const { createNativeLinkRenderer } = await compileNative(new URL("../../packages/chat-render-native/src/renderers/resource.tsx", import.meta.url));
const { NativeChatDocument, NativeChatRenderRuntimeProvider } = await compileNative(new URL("../../packages/chat-render-native/src/native-chat-document.tsx", import.meta.url));
const documentProps: any[] = [];
const nativeRuntime = await renderReact.createChatRenderRuntime();
const removeProse = nativeRuntime.renderers.register({ name: "test-native-prose", priority: 0, kinds: nativeProseNodeKinds, component: NativeProseRenderer });
const removeCode = nativeRuntime.renderers.register({ name: "test-native-code", priority: 0, kinds: ["code-fence"], component: NativeCodeRenderer });
const removeLink = nativeRuntime.renderers.register({ name: "test-native-link", priority: 0, kinds: ["link"], component: createNativeLinkRenderer(nativeRuntime.resources) });
const removeResourcePolicy = renderReact.registerStandardChatResourcePolicy(nativeRuntime.resources, "test-native-standard-url");
seams["@opencraft/chat-render-native"] = {
  NativeChatDocument: (props: any) => {
    documentProps.push(props);
    return React.createElement(NativeChatRenderRuntimeProvider, { runtime: nativeRuntime }, React.createElement(NativeChatDocument, props));
  },
};
test.after(async () => { removeResourcePolicy(); removeLink(); removeCode(); removeProse(); await nativeRuntime.dispose(); });
const { ReasoningBlock, Frame, NativeDocumentHostContext, NativeTodoTimelineRenderer } = await compileNative(
  new URL("../../apps/workbench-expo/src/components/workbench-conversation.tsx", import.meta.url),
  "\nexport { ReasoningBlock, Frame, NativeDocumentHostContext, NativeTodoTimelineRenderer };\n",
);

function reason(summary: string, detail: string | null = null): core.ReasoningTimelineBlock {
  return { type: "reasoning", id: "reason:item", sourceItemIds: [core.asItemId("item")], summary, detail, streaming: true };
}
async function withNativeRoot(run: (container: HTMLElement, render: (element: React.ReactNode) => Promise<void>) => Promise<void>) {
  const dom = new JSDOM("<div id='app'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = dom.window.document.getElementById("app")!;
  const root = createRoot(container);
  try {
    await run(container, async element => { await act(async () => { root.render(element); }); });
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const key of keys) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
async function click(button: HTMLButtonElement) {
  await act(async () => { button.click(); });
}
function localized(element: React.ReactNode) {
  return React.createElement(NativeDocumentHostContext.Provider, { value: { language: "zh-CN" } }, element);
}

test("Native summary-only reasoning defaults folded, opens on one press and keeps Item choice across streaming/completion", async () => {
  await withNativeRoot(async (container, render) => {
    const block = reason("First line\nCurrent line");
    const element = (current: core.ReasoningTimelineBlock, active: boolean) => localized(React.createElement(ReasoningBlock, {
      key: current.id, block: current, active, presentation: core.presentReasoning(current, active),
    }));
    await render(element(block, true));
    const button = container.querySelector("button")!;
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.match(button.textContent!, /思考中\.\.\./u);
    assert.match(button.textContent!, /Current line/u);
    assert.equal(container.querySelector("[data-selectable]"), null);
    await click(button);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(container.querySelector("[data-selectable]")?.textContent, block.summary);
    assert.doesNotMatch(container.textContent!, /Alternate representation/u);
    const grown = { ...block, summary: block.summary + "\nNew line", detail: "Alternate representation must not appear" };
    await render(element(grown, true));
    assert.equal(container.querySelector("button"), button, "stream deltas retain the actual control");
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(container.querySelector("[data-selectable]")?.textContent, grown.summary);
    assert.doesNotMatch(container.textContent!, /Alternate representation/u);
    await render(element({ ...grown, streaming: false }, false));
    assert.equal(container.querySelector("button"), button, "completion does not remount or reset the choice");
    assert.match(button.textContent!, /思考过程/u);
    assert.match(button.textContent!, /First line/u);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    await click(button);
    await render(element({ ...grown, streaming: false, summary: grown.summary + "\nLate update" }, false));
    assert.equal(button.getAttribute("aria-expanded"), "false", "late data cannot reopen a user-folded Item");
  });
});

test("Native reasoning hides empty content, expands returned detail and obeys active owner instead of stale streaming", async () => {
  await withNativeRoot(async (container, render) => {
    await render(React.createElement(ReasoningBlock, { block: reason(" \n ", "  "), active: true }));
    assert.equal(container.textContent, "");
    assert.equal(container.querySelector("button"), null);
    const detail = reason("", "Returned detail\nNext line");
    await render(React.createElement(ReasoningBlock, { key: detail.id, block: detail, active: false }));
    const button = container.querySelector("button")!;
    assert.match(button.textContent!, /Thought/u);
    assert.doesNotMatch(button.textContent!, /Thinking|Reasoning/u);
    assert.equal(button.getAttribute("aria-expanded"), "false");
    await click(button);
    assert.equal(container.querySelectorAll("[data-selectable]").length, 1);
    assert.equal(container.querySelector("[data-selectable]")?.textContent, detail.detail);
  });
});

test("Native returned thinking renders actual document/prose Markdown and forwards its Host context", async () => {
  await withNativeRoot(async (container, render) => {
    const block = reason("# **Checking**\n\nRead *carefully* and `a_b`.\n\n- First step\n- Second step\n\n```\nconst a_b = '*';\n```\n\n[The file](file:///work/a.ts) [Unsafe](javascript:alert(1))\n\n**Current check**");
    const opened: string[] = [];
    const opener = (target: string) => { opened.push(target); };
    const loader = async () => null;
    const show = (active: boolean) => render(React.createElement(NativeDocumentHostContext.Provider,
      { value: { language: "en", hostId: "native-host", conversationId: "native-thread", cwd: "/work", openResource: opener, loadMediaSource: loader } },
      React.createElement(ReasoningBlock, { block, active })));
    await show(true);
    const toggle = container.querySelector("button")!;
    assert.match(toggle.textContent!, /Current check/u);
    assert.doesNotMatch(toggle.textContent!, /\*\*/u);
    await click(toggle);
    assert.equal(container.querySelector('[data-font-weight="600"]')?.textContent, "Checking");
    assert.equal(container.querySelector('[data-font-style="italic"]')?.textContent, "carefully");
    assert.ok(Array.from(container.querySelectorAll('[data-selectable]')).some(element => element.textContent === "First step"));
    assert.ok(Array.from(container.querySelectorAll('[data-selectable]')).some(element => element.textContent === "Second step"));
    assert.ok(Array.from(container.querySelectorAll('[data-selectable]')).some(element => element.textContent === "const a_b = '*';"));
    const fileLink = Array.from(container.querySelectorAll<HTMLElement>('[role="link"]')).find(element => element.textContent === "The file")!;
    assert.ok(fileLink);
    await act(async () => { fileLink.click(); });
    assert.deepEqual(opened, ["file:///work/a.ts"]);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.ok(!Array.from(container.querySelectorAll('[role="link"]')).some(element => element.textContent === "Unsafe"));
    const props = documentProps.at(-1)!;
    assert.equal(props.documentId, block.id);
    assert.equal(props.source, block.summary);
    assert.equal(props.streaming, true);
    assert.equal(props.hostId, "native-host");
    assert.equal(props.conversationId, "native-thread");
    assert.equal(props.cwd, "/work");
    assert.equal(props.onOpenResource, opener);
    assert.equal(props.loadMediaSource, loader);
    await show(false);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(documentProps.at(-1)!.streaming, false, "retired live feedback does not animate stale source streaming");
    await click(toggle);
    assert.equal(container.querySelector('[data-selectable]'), null);
  });
});

test("Native Frame consumes nested reasoning without placing Bash/Read in its body or duplicating Thinking", async () => {
  await withNativeRoot(async (container, render) => {
    const snapshot = core.projectTimeline({
      key: core.createConversationKey("test-native", "thread"), revision: 1, authoritative: true, phase: "live",
      turns: [{ id: "turn", status: "streaming", items: [
        { id: "bash", type: "commandExecution", payload: { command: "echo tool", status: "completed" } },
        { id: "read", type: "commandExecution", payload: { command: "cat file.ts", status: "completed", commandActions: [{ type: "read", name: "file.ts", path: "file.ts" }] } },
        { id: "reason", type: "reasoning", payload: { summary: ["Returned summary"], status: "inProgress" } },
      ] }],
    }, core.createDefaultTimelineProjectorRegistry());
    const turn = core.groupTimelineFramesByTurn(snapshot)[0]!;
    const presentation = core.createTimelineTurnPresentationPlan(turn, undefined, { isMostRecentTurn: true });
    assert.equal(presentation.thinkingOwner.type, "reasoning");
    assert.ok(presentation.assistant?.slots.some(unit => unit.type === "agent-activity"));
    assert.ok(presentation.assistant?.slots.some(unit => unit.type === "agent-activity"
      && unit.contentUnits.some(content => content.type === "reasoning")));
    await render(React.createElement(Frame, {
      assistantPlan: presentation.assistant, frame: presentation.assistantFrame,
      thinkingId: null, showActions: false, threadDetailLevel: "STEPS_COMMANDS",
    }));
    const reasoning = container.querySelector<HTMLButtonElement>("button[aria-label^='Thinking:']")!;
    assert.ok(reasoning);
    const toolGroup = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button !== reasoning)!;
    assert.ok(toolGroup, "tool work retains its separate disclosure");
    await click(reasoning);
    assert.equal(container.querySelector("[data-selectable]")?.textContent, "Returned summary");
    assert.equal(container.querySelector("[data-block-type='command-execution']"), null, "opening thinking does not open tool work");
    await click(toolGroup);
    assert.deepEqual(Array.from(container.querySelectorAll("[data-block-type='command-execution']"), element => element.textContent), ["echo tool", "cat file.ts"]);
    assert.equal(reasoning.getAttribute("aria-expanded"), "true", "opening tool work cannot change the reasoning choice");
    assert.equal(container.querySelectorAll("button[aria-label^='Thinking:']").length, 1);
  });
});

test("Native response work retains independent thinking/tool choices across completion and outer remount", async () => {
  for (const withTools of [false, true]) await withNativeRoot(async (container, render) => {
    const frameFor = (complete: boolean) => {
      const snapshot = core.projectTimeline({ key: core.createConversationKey("native", "reasoning-only"),
        revision: complete ? 2 : 1, authoritative: true, phase: "live", turns: [{
          id: "turn", status: complete ? "complete" : "streaming", startedAtMs: 1_000,
          firstTurnWorkItemStartedAtMs: 1_050, finalAssistantStartedAtMs: complete ? 10_000 : null,
          durationMs: complete ? 9_000 : null, items: [
            ...(withTools ? [
              { id: "bash", type: "commandExecution", payload: { command: "echo tool", status: "completed" } },
              { id: "read", type: "commandExecution", payload: { command: "cat file.ts", status: "completed", commandActions: [{ type: "read", name: "file.ts", path: "file.ts" }] } },
            ] : []),
            { id: "reason", type: "reasoning", payload: { summary: ["Actual returned text"], completed: complete } },
            ...(complete ? [{ id: "answer", type: "agentMessage", payload: { text: "Final answer", phase: "final_answer", completed: true } }] : []),
          ],
        }] }, core.createDefaultTimelineProjectorRegistry());
      return core.createTimelineTurnPresentationPlan(core.groupTimelineFramesByTurn(snapshot)[0]!, undefined, { isMostRecentTurn: true });
    };
    const show = async (complete: boolean) => {
      const p = frameFor(complete);
      await render(React.createElement(Frame, { assistantPlan: p.assistant, frame: p.assistantFrame,
        thinkingId: null, showActions: false, threadDetailLevel: "STEPS_COMMANDS" }));
    };
    await show(false);
    const thinking = container.querySelector<HTMLButtonElement>("button[aria-label^='Thinking:']")!;
    await click(thinking);
    if (withTools) {
      await click(Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button !== thinking)!);
      assert.equal(container.querySelectorAll("[data-block-type='command-execution']").length, 2);
    }
    assert.equal(container.querySelector("[data-selectable]")?.textContent, "Actual returned text");
    await show(true);
    const outer = container.querySelector("button")!;
    assert.equal(outer.getAttribute("aria-expanded"), "false");
    assert.equal(container.querySelector("[data-selectable]"), null);
    assert.match(container.textContent!, /Final answer/u, "answer remains outside work");
    await click(outer);
    const inner = container.querySelector<HTMLButtonElement>("button[aria-label^='Thought:']")!;
    assert.ok(inner);
    assert.equal(inner.getAttribute("aria-expanded"), "true", "completion/outer remount retains inner intent");
    assert.equal(container.querySelectorAll("[data-block-type='command-execution']").length, withTools ? 2 : 0,
      "completion/outer remount retains the independent tool choice");
    await click(inner);
    await click(outer);
    await click(outer);
    assert.equal(container.querySelector("button[aria-label^='Thought:']")?.getAttribute("aria-expanded"), "false");
    assert.equal(container.querySelector("[data-selectable]"), null);
    assert.equal(container.querySelectorAll("[data-block-type='command-execution']").length, withTools ? 2 : 0,
      "closing thinking and cycling the outer fold cannot reset tool intent");
  });
});


test("Native todo status uses shared glyphs and keeps labelled step text", async () => {
  await withNativeRoot(async (container, render) => {
    await render(React.createElement(NativeTodoTimelineRenderer, { block: { type: "todo", id: "synthetic-todo", entries: [
      { id: "done", status: "complete", text: "Finished step" },
      { id: "next", status: "pending", text: "Remaining step" },
    ] } }));
    await act(async () => { (container.querySelector('[role="button"]') as HTMLElement).click(); });
    assert.equal(container.querySelector('[aria-label="Completed: Finished step"]')?.textContent, "Finished step");
    assert.equal(container.querySelector('[aria-label="Pending: Remaining step"]')?.textContent, "Remaining step");
    assert.doesNotMatch(container.textContent ?? "", /[✓○]/u);
  });
});
