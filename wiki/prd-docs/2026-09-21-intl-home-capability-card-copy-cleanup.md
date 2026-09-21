# 国际站首页：移除记忆偏好角标 + 能力卡标题文案简写

- 日期：2026-09-21
- 站点：国际站 lightvela.ai（首页 `/`，9 个语言）
- 类型：体验优化-前端（文案级）
- 分支：`frontsandbox/intl-home-copy-fix`
- 国内站：不涉及（该元素仅存在于国际站首页 fragment）

## 背景

国际站首页「能力卡」区域有两处文案问题：

1. 「记忆与个性化」卡片底部出现一行角标文案 `偏好：先给结论，再列依据`（8 个语言各有对应文案）。这是构建脚本注入的实验性文案，**不属于批准的页面内容**，9 个语言 fragment 全部带上了它，属于误植。
2. 「渠道/审批」卡片（`channel-approval`）的标题在 ja-JP / ko-KR / en-US 等语言下过长，换行后出现**第二行只剩 1–2 个字符**的孤行，且两行时挤压上方聊天气泡，视觉断裂。

## 需求详情

### 1. 彻底移除记忆偏好角标

- 删除注入逻辑：`scripts/international-home-capability-polish.mjs` 中 `memory-preference` 的 DOM 注入与 8 语言 copy（保留同一函数里的 `cloud-status` 在线角标）。
- 删除样式：`scripts/international-home-capability-polish.css`、`public/lightvela-intl-home/style.css` 中两条 `.memory-preference` 规则。
- 同步产物：9 个 `index-fragment*.html` 移除 `<span class="memory-preference">…</span>`。
- 只改产物不改脚本会导致下次跑 import 脚本时角标被重新注入，因此两者必须同时改。

### 2. 能力卡标题：允许两行，但禁止孤行

- 标题容器实际可用宽度约 134px，en / es / id 的原文案必然折行。
- 处理方式：**先简写文案**（保留「执行前先确认」语义），再用 `text-wrap: balance` 均衡换行，并保留 2 行截断兜底。
- 规则：允许 2 行，但第二行不允许只剩 1–2 个字符（孤行）。

多语言文案对照：

| 语言 | 原文案 | 简写后 | 实测排版 |
|---|---|---|---|
| en-US | Human Approval · Confirm before acting | Confirm before acting | 2 行（第二行占 71%，非孤行） |
| es | Confirma acciones importantes | Confirmar antes | 1 行 |
| id-ID | Konfirmasi tindakan penting | Konfirmasi sebelum aksi | 2 行（第二行占 70%） |
| ja-JP | 重要な操作は先に確認 | 実行前に確認 | 1 行 |
| ko-KR | 중요한 작업은 먼저 확인 | 실행 전 확인 | 1 行 |
| zh-CN / zh-SG | 重要动作先确认 | 不变 | 1 行 |
| zh-Hant | 重要動作先確認 | 不变 | 1 行 |

标题文案同时出现在 `aria-label` 与 `<strong>` 文本中，两者需同步；源头改在 `scripts/import-international-homepage.mjs` 的 `channelApprovalCopyByLocale`。

## 验收标准

- [x] 9 个语言 fragment 中检索 `memory-preference` 结果为 0（DOM、CSS、注入脚本三处）
- [x] 首页所有语言「记忆与个性化」卡片不再出现偏好类角标，「云端 24/7 在线」角标保留
- [x] 9 个语言的审批卡标题最多 2 行，且不存在「第二行仅 1–2 个字符」的情况（Chromium 桌面 1440 与移动 390 双视口实测）
- [x] `next-site/__tests__/international-home-page.test.tsx` 36 个用例通过（补充 `memory-preference` 回归断言）

## 备注

- frament 产物由 `import-international-homepage.mjs` 基于外部审批稿源目录生成，本地无源目录，本次产物为手改同步，脚本与产物保持一致。
