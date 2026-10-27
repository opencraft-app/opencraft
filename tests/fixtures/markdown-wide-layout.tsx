import React, { useState } from "react";
import { WebChatDocument } from "@opencraft/chat-render-web";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";
const source = `| 项目 | 已有证据 | 请研发处理什么 | 验证要求 | 负责人 |
| --- | --- | --- | --- | --- |
| 国际站创建失败 | 五个账号、九次失败；套餐和配额有效，当前资源池没有可用库存 | 检查失败请求、容量与安全组配额，历史失败不能重跑用户升级命令 | 保留历史记录和原始文档结构 | Alice |
| 国内站会话接口 | 分别报告模块导入失败；新进程却能正常导入 | 检查长驻进程与磁盘代码版本，验证会话列表及网页对话 | 保留所有会话与当前草稿 | Bob |`;
const diagram = "```mermaid\ngraph LR\n A[开始] --> B[识别会话安全边界] --> C[限制自动扩宽] --> D[保留横向滚动] --> E[验证侧栏变化] --> F[结束]\n```";
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
function Demo() {
  const [width, setWidth] = useState<number | null>(null);
  const [shift, setShift] = useState(0);
  const [tail, setTail] = useState("");
  Object.assign(window, {
    setWideLayout: (next: number, offset = 0) => { setWidth(next); setShift(offset); },
    appendWideRow: () => setTail("\n| 追加 | 流式内容 | 保留同一个表格和滚动位置 | 验证 | Carol |"),
  });
  return <main style={{ display: "flex", height: "100dvh", width: "100%" }}>
    <div style={{ width: width ?? "100%", maxWidth: "100%", flex: "none", minWidth: 0 }}>
      <div className="thread-scroll" style={{ flexDirection: "column", paddingTop: 0 }}>
        <div className="thread-scroll-surface" style={{ transform: `translateX(${shift}px)`, "--thread-wide-block-inline-shift": `${Math.abs(shift)}px` } as React.CSSProperties}>
          <div className="thread-content thread-layout-width">
            <p data-prose>正文保留阅读列宽，表格允许自动使用两侧留白。</p>
            <section data-case="wide"><WebChatDocument documentId="wide" source={source + tail} /></section>
            <section data-case="short"><WebChatDocument documentId="short" source={"| A | B |\n| --- | --- |\n| 1 | 2 |"} /></section>
            <section data-case="preview" className="thread-composer-overlay__response" style={{ width: 300, maxWidth: "100%", padding: 12, boxSizing: "border-box" }}>
              <WebChatDocument documentId="preview" source={source} />
              <section data-diagram="preview"><WebChatDocument documentId="preview-diagram" source={diagram} /></section>
            </section>
            <section data-diagram="main"><WebChatDocument documentId="diagram" source={diagram} /></section>
            <section data-case="embedded"><WebChatDocument allowWideBlocks={false} documentId="embedded" source={source} /></section>
          </div>
        </div>
      </div>
    </div>
    <aside style={{ flex: 1, minWidth: 0, background: "var(--surface-subtle)" }}>Right panel<section data-ownerless style={{ width: 280, maxWidth: "100%" }}><WebChatDocument documentId="ownerless" source={source} /></section></aside>
  </main>;
}
createIntlTestRoot(document.getElementById("root")!).render(<Demo />);
