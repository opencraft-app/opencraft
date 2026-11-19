import "./smoke-annotation-v2-integrated.scss";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import zhMessages from "../../../apps/workbench-web/src/i18n/locales/zh-CN.json";
import { IntlProvider } from "react-intl";
import { createComposerController } from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { BrowserAnnotationSinkProvider } from "../../../apps/workbench-web/src/browser-annotation/composer-sink";
import { BrowserAnnotationLayer } from "../../../apps/workbench-web/src/browser-annotation/annotation-layer";
import { useFilePreviewAnnotation } from "../../../apps/workbench-web/src/browser-annotation/use-file-preview-annotation";

const composer = createComposerController(
  { type: "existing-thread", key: createConversationKey("local", "annotation-v2") },
  {
    now: () => Date.now(),
    createId: () => crypto.randomUUID(),
  },
);
const page = `<!doctype html><html><meta charset="utf-8"><body style="margin:0;padding:70px 20px;font:18px sans-serif;min-height:1400px;background:#fff;color:#222">
<h2 style="margin:0 0 20px">Project preview</h2><p id="text">Please change this sentence carefully.</p>
<div style="display:flex;gap:24px;margin:24px 0"><button id="first" style="padding:16px;border-radius:12px;background:#ddd">First action</button><button id="second" style="padding:16px;border-radius:12px">Second action</button></div>
<div id="visual" style="height:90px;background:#eee">Visual region</div>
<input type="password" value="private-password" aria-label="Password">
<script>window.pageClicks=0;document.querySelector('#first').onclick=()=>window.pageClicks++;window.ready=true;<\/script></body></html>`;
const theme = location.hash === "#dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(theme)))
  document.documentElement.style.setProperty(key, String(value));
const state: Record<string, any> = { composer };
(window as any).integratedAnnotation = state;
function App() {
  const frame = useRef<HTMLIFrameElement>(null),
    slot = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState(page);
  const { srcDoc, controller } = useFilePreviewAnnotation({
    frame,
    html,
    hostId: "local",
    path: "/project/demo.html",
    tabId: "preview",
  });
  state.controller = controller;
  state.frame = frame;
  state.reload = () => setHtml(page + "<!-- new document -->");
  return (
    <>
      <button id="activate" onClick={controller.toggle}>
        Annotate
      </button>
      <div ref={slot} style={{ position: "relative", width: "100%", height: "calc(100vh - 42px)" }}>
        <iframe
          title="Project file"
          ref={frame}
          sandbox="allow-scripts"
          srcDoc={srcDoc ?? undefined}
          style={{ width: "100%", height: "100%", border: 0 }}
        />
      </div>
      <BrowserAnnotationLayer
        controller={controller}
        slot={slot}
        portal={document.body}
        touch={navigator.maxTouchPoints > 0}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <IntlProvider
    locale={location.search.includes("zh") ? "zh-CN" : "en"}
    messages={location.search.includes("zh") ? zhMessages : undefined}
  >
    <BrowserAnnotationSinkProvider controller={composer}>
      <App />
    </BrowserAnnotationSinkProvider>
  </IntlProvider>,
);
