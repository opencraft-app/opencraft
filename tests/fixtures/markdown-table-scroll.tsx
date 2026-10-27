import React, { useState } from "react";
import { WebChatDocument } from "@opencraft/chat-render-web";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

const office = `| 插件 | 能力 | 主要区别 |
| --- | --- | --- |
| [omdsh-dev/dsh-office](https://example.test/omdsh-dev/dsh-office) | Word、Excel、PPT 生成与读取；Excel 编辑和公式重算；PPT 文字替换；PDF 拆分 | 办公文件处理覆盖比较全面 |
| [kw78/dsh-office-tools](https://example.test/kw78/dsh-office-tools) | 8 个工具，支持 Word、Excel、PPT 的生成、读取及部分更新 | 轻量、通过 DSH 文件服务操作；但 PPT 图片是外链，更新含二进制媒体的文档有限制 |
| [rong-coder/dsh-office-tool](https://example.test/rong-coder/dsh-office-tool) | 通过 OfficeCLI 创建、查询、修改文档元素，支持批量操作和 HTML 预览 | 更偏结构化编辑与预览；需要安装 OfficeCLI，DSH 侧栏预览还依赖 better-sidebar |`;
const many = `| 项目 | Word 文档 | Excel 表格 | PPT 演示 | PDF 文档 | 安装要求 | 工作区权限 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dsh-office | 支持创建和读取 | 支持编辑与公式重算 | 支持文字替换 | 支持拆分 | Node.js 插件 | 会话工作区 | 保留文档原始结构 |
| OfficeCLI | 结构化编辑 | 结构化编辑 | 创建和编辑 | 视工具能力 | 单独安装 CLI | 由宿主控制 | 可以提供文件预览 |`;
const small = "| A | B |\n| --- | --- |\n| 1 | 2 |";
const unbroken = `| 标识 | 长内容 |\n| --- | --- |\n| key | ${"LongIdentifier".repeat(40)} |`;
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
const probe = window as typeof window & { appendTableRow: () => void; copiedText: string; opens: string[]; officeSource: string };
probe.opens = [];
probe.officeSource = office;
Object.defineProperty(navigator, "clipboard", { value: {
  write: async (items: ClipboardItem[]) => { probe.copiedText = await (await items[0]!.getType("text/plain")).text(); },
  writeText: async (text: string) => { probe.copiedText = text; },
} });

function Demo() {
  const [tail, setTail] = useState("");
  probe.appendTableRow = () => setTail("\n| 新插件 | 新增工具能力 | 流式追加保留原表格与滚动位置 |");
  return <main style={{ height: "100dvh", width: params.has("narrow") ? 380 : "100%", maxWidth: "100%", display: "flex", flexDirection: "column" }}>
    <header style={{ height: 48, flexShrink: 0 }}>Markdown tables</header>
    <div className="thread-scroll" style={{ flexDirection: "column", paddingTop: 0 }}>
      <div className="thread-scroll-surface thread-layout-width" style={{ paddingInline: 24 }}>
        <p>表格前的正常段落，不能跟着表格横向移动。</p>
        {[office + tail, many, small, unbroken].map((source, index) => <section data-table-case={index} key={index}>
          <WebChatDocument allowWideBlocks={!params.has("embedded")} documentId={`table-${index}`} source={source} onOpenResource={(target) => probe.opens.push(target)} />
        </section>)}
        <p style={{ minHeight: 600 }}>表格后的内容：保持页面纵向滚动。</p>
      </div>
    </div>
  </main>;
}

createIntlTestRoot(document.getElementById("root")!).render(<Demo />);
