# Web 主聊天滚动策略切换：response-placement → natural 贴底

日期：2026-09-18。参考快照：`ref/codex`（r3562 逐函数对照）。

## 决定

Web 主聊天入口（`apps/workbench-web/src/app.tsx`）的 `scrollPolicy` 从
`"response-placement"` 切换为 `"natural"`，与 side chat（`side-chat-panel-plugin.tsx`
此前已是 natural）对齐。这取代 [codex-response-placement-selection.md](codex-response-placement-selection.md)
中"用户明确选择回答定位分支"的 Web 主入口选择；不改 `ConversationScrollPolicy`
类型、不删除 response-placement 分支，两分支保持互斥。

依据是用户对真实 Codex 与 Vela 的体感反馈：工具调用/流式输出期间
"高光内容不跟随、跑着跑着掉出视野"。对照证据表明这不是移植偏差，而是
response-placement 分支本身的语义。

## 对照证据（真实时钟 + production renderer，本机复跑）

命令模板（`CODEX_SCROLL_REFERENCE_ROOT` 指向本仓库 `ref/codex`，
Playwright 经 `OPENCRAFT_PLAYWRIGHT_MODULE` 注入临时安装的 playwright-core）：

```sh
CODEX_SCROLL_ESSAYS=1 CODEX_SCROLL_RENDERER=production CODEX_SCROLL_REAL_CLOCK=1 \
CODEX_SCROLL_REFERENCE_ROOT=<repo>/ref/codex npx tsx scripts/compare-codex-scroll.ts
# natural 分支：
#   CODEX_SCROLL_NATURAL_ONLY=1 CODEX_SCROLL_REFERENCE_POLICY=baseline
```

| 运行 | 对照 | 结果 |
| --- | --- | --- |
| run1b（response-placement） | Vela 当前分支 vs r3562 原版同分支函数 | 143 个事件边界 1px 内一致 |
| run2（natural） | Vela natural 分支 vs r3562 原版自然路径 | 34 个事件边界 1px 内一致 |

同场景（贴底提交、无输入、正文增长到 3078 字符）下两条策略的离底距离：

| 字符数 | response-placement | natural |
| ---: | ---: | ---: |
| 100 | 37px（static，spacer 348px） | 0px |
| 500 | 235px | 0px |
| 1000 | 529px | 0px |
| 2000 | 1095px | 0px |
| 3078 | 1727px | 0px |

response-placement 分支在 `static` 下锚定回答开头是 Codex 该分支的既定语义
（正文增长不自动取得跟随权）；自然贴底路径由测量事务保持离底 0px。两者都与
各自的原版分支一致——"不跟随"的体感来自策略选择，不是实现错误。

## 附带核实

- "上滑后本轮 prework 不再重新跟随"在原版同样存在（原版 `be` 同样清零 spacer），
  不是移植错误。
- watch→follow 的 24px/spacer 门控、放置弹簧、放置阈值与原版逐函数一致。
- 表格超宽溢出对话列是原版设计：ref/codex 的 CSS module 类映射
  （`TableContainer/TableScroller/TableWrapper/MarkdownTablePreview/TableActions`）
  与 `chat-render-web` 的 `chat-table-*` 一一对应，宽块在 scroller 内横向滚动。
- 早前记录的 windowZoom 差异：`tests/workbench-timeline-host.test.ts` 已有
  "reflow pinning follows Codex window-zoom compensation" 用例，reflow 锚定已含
  zoom 补偿；follow 溢出路径的 zoom 因子差异仍为潜在项（opencraft 无窗口缩放功能时不生效）。

## 验证与剩余边界

- `tsx --test tests/workbench-timeline-host.test.ts tests/chat-web-follow-measurement.test.ts`：62 项通过。
- `npm run typecheck --workspace @opencraft/workbench-web`：通过。
- 未验证：真实登录、模型、Host 与外部服务链路下的实机流式会话；
  production 构建与 Electron 呈现按 build-matrix 另行验收。
- Expo native 仍走 `NativeResponsePositionedTurns`（response 定位语义），跨端
  交互有意保持差异，切换 native 属独立决策。
