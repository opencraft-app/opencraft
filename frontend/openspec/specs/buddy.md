# Buddy 伙伴系统 (Buddy)

## 概述

Buddy（AI 搭子）是 Lightclaw 的人设抽卡玩法模块。在 Hermes 实例 Settings 内，从 SkillHub 公共接口拉取 Soul（人设）目录，渲染成 9 张抽卡槽（3×3 网格）。每抽到一张人设填入下一格，视觉对齐 SkillHub `/hermes/edit-soul`。

当前版本（v0.8）仅保留 Soul（人设）浏览与抽卡能力。

## 页面 / 路由

- 入口：Agent 控制台 `/agents` 下对应 section 承载（具体 section slug 见 `agent-settings-page.tsx`）
- 数据来源：跨域直连 `https://api.skillhub.cn` 公共接口（经 `@/lib/skillhub-api`）

## 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| `OpenClawBuddyPanel` | `hermes-agent-buddy-panel.tsx`（65KB，v0.8） | 抽卡面板主入口，3×3 网格渲染 9 张槽位 |
| `OpenClawBuddyCards` | `openclaw-buddy-cards.tsx` | 卡片列表渲染 |
| `OpenClawBuddyDrawModal` | `openclaw-buddy-draw-modal.tsx` | 抽卡弹窗 |
| `OpenClawBuddySoulTestModal` | `openclaw-buddy-soul-test-modal.tsx` | 灵魂测试弹窗 |
| 数据层 | `openclaw-buddy-soul-test-data.ts` | 灵魂测试题库（中文） |
| 数据层（英文） | `openclaw-buddy-soul-test-data.en.ts` | 灵魂测试题库（英文，国际站） |
| 存储工具 | `lib/buddy-storage.ts` | Buddy 本地存储读写 |

## 数据流

- 抽卡数据策略：**前端从公共 souls 池 `Math.random`**，自动剔除已抽到的 slug，每次抽出新一张。
- **不调** SkillHub 的 draw 接口（鉴权方案待落地）。
- 抽到的卡用 `SoulFaceCard`（bgUrl 全卡面），未抽到的用 `CardBack`（灰底 + 拼图 icon）。
- 国际站灵魂测试题库走 `.en.ts` 变体，由 `isGlobal` 编译期分支选择。

## 业务规则

1. **抽卡逻辑**：前端 `Math.random` 从公共 souls 池抽取，自动去重已抽到的 slug；9 格抽满即止。
2. **数据来源**：跨域直连 `https://api.skillhub.cn` 公共接口，经 `@/lib/skillhub-api`。
3. **鉴权**：当前不调 SkillHub draw 接口（鉴权方案待落地）。
4. **灵魂测试**：题库分中英文两份（`soul-test-data.ts` / `.en.ts`），按 `isGlobal` 编译期选择。
5. **范围**：v0.8 仅保留 Soul 浏览与抽卡能力。

## 测试覆盖

<待用户补充>（当前未识别到 buddy 专属测试文件，需确认测试覆盖情况）

## 待用户补充

- Buddy 模块国内 / 国际站差异（是否双站都开放、是否有 region 分支）
- 抽卡次数限制 / 冷却 / 稀有度规则（若后端后续接入）
- 本地存储 key 命名与同步策略（纯本地 vs 后端）
