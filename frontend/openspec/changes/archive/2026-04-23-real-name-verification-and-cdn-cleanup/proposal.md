---
change: real-name-verification-and-cdn-cleanup
status: archived
branch: feat/real-name-verification
archived_at: 2026-04-23
---

# 变更提案：实名认证入口 + 静态资源 CDN 清理

## 动机

本次分支 `feat/real-name-verification` 合并自 MR !33，涵盖 3 个互相独立但在同一个窗口期完成的前端改动：

1. **实名认证入口（可下线）**：按照 Figma 视觉稿在账号页 `/account` 的「账号信息」模块放出实名认证入口与弹窗。但实名认证依赖腾讯云 shadow 侧的核验接口，合规 / 接口对接节奏不可控，产品侧担心**上不了**，因此需要「留好下线口子」，上线当天通过改一行常量即可整体关掉 UI。
2. **静态资源 CDN 清理**：之前 `asset-url.ts` 通过 `VITE_ASSET_CDN_ENABLED` 环境变量切换本地 `/assets/...` 与 CDN URL，后台默认已稳定走 CDN；开关反而拖累构建配置和本地排错。决定去掉环境变量，CDN 基址硬编码到源码常量，不再走 `.env`。
3. **订阅页文案回归 & 走查修正**：恢复订阅页「选择适合你的套餐」下被误删的一行小字（「根据你的使用场景，选一个套餐开始 AI Agent 之旅。」），同时合并 CR 意见（favicon type / 缩进 / 冗余判断 / 重复边框）。

## 影响范围

### 前端（frontend）
- `src/pages/marketing/account-page.tsx` — 实名认证入口 / 实名弹窗 / 总开关常量
- `src/pages/marketing/subscribe-page.tsx` — 小字说明文案恢复 + 走查修正
- `src/pages/marketing/openclaw-settings-page.tsx` — 移除 CDN 开关相关逻辑（loading 尺寸走查跟随）
- `src/lib/asset-url.ts` — 去环境变量化，CDN 基址改为源码常量
- `src/vite-env.d.ts` — 移除 `VITE_ASSET_CDN_ENABLED` / `VITE_ENABLE_REAL_NAME_VERIFICATION` 类型声明
- `.env.example` / `.env.production` — 清理已废弃的环境变量
- `index.html` — favicon type 修正
- `public/hermes_logo.png`、`public/lightvela-logo.jpg` — 新增品牌资源
- `src/components/site/legal-footer.tsx`、`src/pages/marketing/landing/cta-footer-section.tsx` — 走查文案修正

### 未触及
- 后端：无变更（实名认证核验接口尚未对接，本次仅做前端 UI 与下线开关）
- 其他业务模块：无变更

## 能力变更（Deltas）

| 能力 | 变更类型 | 说明 |
|------|---------|------|
| 账号页 · 实名认证入口 | 新增（默认下线） | 在「账号信息」模块新增一整行实名认证条目；首次进入时显示「去认证」CTA，已认证时显示姓名 + 已认证徽标；打开 Modal 录入姓名 + 身份证号 |
| 实名认证功能总开关 | 新增 | `account-page.tsx` 顶部 `REALNAME_ENABLED` 常量，默认 `false`；一行切换整模块是否渲染 |
| 静态资源 URL 工厂 | 修改 | 去掉 `VITE_ASSET_CDN_ENABLED` 分支；所有环境统一走 CDN；CDN 基址 `CDN_BASE` 硬编码于源码，改一行即可切换 |
| 订阅页引导文案 | 修改 | 恢复「选择适合你的套餐」下方「根据你的使用场景，选一个套餐开始 AI Agent 之旅。」说明小字 |
| 账号信息「展开/折叠」样式 | 修改 | 折叠时避免出现双边框线；展开态保持原视觉 |
| 环境变量清单 | 清理 | 从 `.env.example` / `.env.production` / `vite-env.d.ts` 中移除 `VITE_ASSET_CDN_ENABLED` 与 `VITE_ENABLE_REAL_NAME_VERIFICATION` |

## 非目标

- **不**真正打通实名认证后端接口（shadow 核验接口未就绪）；弹窗提交后走占位逻辑，等后端 Ready 再补
- **不**修改 OpenClaw 设置页 125KB 巨文件的业务逻辑，仅做 CDN 相关清理
- **不**抽取实名认证为独立组件（本次内联在 `account-page.tsx`，后续如复用再抽）
- **不**引入 feature flag 服务，总开关就一行常量；不过度工程化

## 关联

- 视觉稿：https://www.figma.com/design/UlSg2y8cH1vc3n86WTrWhG/lightVela%E7%8B%AC%E7%AB%8B%E7%AB%99?node-id=336-9301&m=dev
- MR：https://git.woa.com/wisp/mono/-/merge_requests/33
- 合入到 dev：1c2d2f0b（merge commit）
- 后续 fix（在 dev 上直提）：853d8984
