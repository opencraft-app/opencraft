import { WebChatDocument } from "@opencraft/chat-render-web";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

const params = new URLSearchParams(location.search);
initializeAppearanceTheme();
setThemePreference(params.get("theme") === "dark" ? "dark" : "light");
const source = `1. 第二页提示统一使用与第一页相同的格式。

2. 昵称一行改为输入当前账号昵称以继续。

[刷新预览查看](http://example.org:18096/preview?account=demo)

正文引用 [main.ts](/workspace/project/src/main.ts:42)，另一个 [main.ts](/workspace/other/main.ts:7)。

[/workspace/project/设计说明.pdf](/workspace/project/设计说明.pdf)

[季度数据](/workspace/reports/metrics.xlsx)

[截图](/workspace/output/preview.png)

[发布包](/workspace/output/release.zip)

[录音](/workspace/output/meeting.mp3)

[视频](/workspace/output/demo.mp4)

[文档目录](/workspace/docs/)

[使用指南](https://example.org/guide) 和 [https://example.org/really/long/path?query=1](https://example.org/really/long/path?query=1)

\`/workspace/project/README.md\`

\`\`\`sh
cat /workspace/project/src/main.ts
\`\`\`
`;
Object.assign(window, { openedResources: [] });
createIntlTestRoot(document.getElementById("root")!, undefined, "zh-CN").render(
  <main style={{ padding: 24, maxWidth: 760, margin: "auto" }}>
    <WebChatDocument documentId="resource-links" source={source} cwd="/workspace/project"
      onOpenResource={target => (window as any).openedResources.push(target)} />
  </main>,
);
