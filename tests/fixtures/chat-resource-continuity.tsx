import React, { useState } from "react";
import { createIntlTestRoot } from "./intl-root";
import { ChatMediaLayoutContext, createWebChatRenderRuntime, WebChatDocument, WebChatRenderRuntimeProvider, type ChatMediaLayout, type ChatMediaSourceLoader } from "@opencraft/chat-render-web";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";

initializeAppearanceTheme();
const runtime = await createWebChatRenderRuntime();
const layouts = new Map<string, ChatMediaLayout>();
let reads = 0, releases = 0;
let delay = 0;
const loader: ChatMediaSourceLoader = async ({ resolvedTarget, signal }) => {
  reads++;
  await new Promise(resolve => setTimeout(resolve, delay));
  signal?.throwIfAborted();
  const html = resolvedTarget.endsWith(".html");
  const blob = new Blob([html ? '<div style="height:100px">Inline document</div>' : '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><rect width="240" height="100" fill="#789"/></svg>'], { type: html ? "text/html" : "image/svg+xml" });
  const source = URL.createObjectURL(blob);
  return { source, release() { releases++; URL.revokeObjectURL(source); } };
};
const source = "```js\nconst answer = 42;\n```\n\n$$\n\\sum_{i=1}^n i^2 = \\frac{n(n+1)(2n+1)}{6}\n$$\n\n![Resource](/fixture/image.svg)\n\n\uE200visualize\uE202" + JSON.stringify({ path: "/fixture/preview.html", title: "Inline document" }) + "\uE201\n\nReading anchor";

function Demo() {
  const [visible, setVisible] = useState(true);
  const [revision, setRevision] = useState(0);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [tail, setTail] = useState("");
  (window as any).resourceFixture = {
    hide() { setVisible(false); }, show() { setVisible(true); },
    refresh() { setRevision(n => n + 1); },
    append() { setTail("\n\nNew text"); },
    async evict() {
      for (let i = 0; i < 101; i++) await runtime.context.chatEnhancements.run({ cacheKey: `eviction-${i}`, lane: "highlight", run: async () => "unused" });
      setRevision(n => n + 1);
    },
    delay(value: number) { delay = value; },
    theme(value: "light" | "dark") { setTheme(value); setThemePreference(value); },
    inspect() { return { reads, releases, layouts: [...layouts] }; },
  };
  return <main data-revision={revision} style={{ width: "100%", maxWidth: 640, padding: 16 }}>
    <WebChatRenderRuntimeProvider runtime={runtime}><ChatMediaLayoutContext.Provider value={layouts}>
      {visible && <WebChatDocument documentId="resource-document" source={source + tail} hostId="fixture" conversationId="conversation" cwd="/fixture" theme={theme} loadMediaSource={loader} onMeasurementRequest={() => { /* deliberately replaced callback */ }} />}
    </ChatMediaLayoutContext.Provider></WebChatRenderRuntimeProvider>
  </main>;
}
createIntlTestRoot(document.getElementById("root")!).render(<Demo />);
