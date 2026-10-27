import React, { useState } from "react";
import { WebChatDocument } from "@opencraft/chat-render-web";
import { createIntlTestRoot } from "./intl-root";
import { buildOpenCraftThemeCssProperties, lavenderThemePalette } from "@opencraft/design-system/theme-engine";
import "../../apps/workbench-web/src/styles/app.scss";
const sources = {
  login: `flowchart LR
    U[用户浏览器] -->|访问和使用| T[团队自己的 OpenCraft]
    U -->|完成登录| A[公共登录服务]
    A -->|验证员工身份| I[企业身份]
    T -->|主动通过 HTTPS 取回登录结果| A`,
  tall: `flowchart TB\n${Array.from({length: 12}, (_, i) => `A${i}[步骤 ${i}] --> A${i+1}[步骤 ${i+1}]`).join("\n")}`,
  sequence: `sequenceDiagram
    participant U as 用户浏览器
    participant S as 团队服务器
    U->>S: 登录请求
    S-->>U: 登录结果`,
};
const requested = new URLSearchParams(location.search).get("theme") ?? "light";
const theme = requested === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const [name, value] of Object.entries(buildOpenCraftThemeCssProperties(theme, requested === "lavender" ? lavenderThemePalette.light : undefined))) document.documentElement.style.setProperty(name, value);
function Demo() {
  const [width, setWidth] = useState(960);
  const [revision, setRevision] = useState(0);
  const [tail, setTail] = useState(0);
  const [streaming, setStreaming] = useState(true);
  Object.assign(window, {
    appendDiagramTail: () => setTail(v => v + 1),
    finishDiagramStream: () => setStreaming(false),
  });
  Object.assign(window, { setDiagramWidth: setWidth, refreshDiagram: () => setRevision(v => v + 1) });
  return <div className="thread-scroll" style={{width, maxWidth: "100%", height: "100vh", padding: 0}}><div className="thread-scroll-surface"><div className="thread-content thread-layout-width">
    {Object.entries(sources).map(([kind, source]) => <section key={kind} data-diagram={kind}><WebChatDocument documentId={kind} theme={theme} streaming={streaming}
      onMeasurementRequest={event => ((window as any).diagramMeasurements ??= []).push({ tail, ...event })}
      source={"```mermaid\n" + source + (revision ? "\n%% refreshed" : "") + "\n```\n\n" + "后续流式文字。".repeat(tail)} /></section>)}
  </div></div></div>;
}
createIntlTestRoot(document.getElementById("root")!).render(<Demo />);
