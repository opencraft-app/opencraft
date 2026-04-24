---
change: real-name-verification-and-cdn-cleanup
status: completed
---

# 任务清单：实名认证入口 + 静态资源 CDN 清理

## 调研与设计
- [x] 对照 Figma 视觉稿（336-9301）梳理账号页实名认证的行条目 / Modal 布局
- [x] 确认实名认证后端接口状态（shadow 侧尚未就绪），确立「默认下线 + 留口子」策略
- [x] 评估 feature flag 方案：环境变量 vs 源码常量 vs 远程 FF，选择源码常量
- [x] 评估 CDN 开关去留：去除 `VITE_ASSET_CDN_ENABLED`，硬编码 CDN 基址
- [x] 从 git 历史检索订阅页小字原文「根据你的使用场景，选一个套餐开始 AI Agent 之旅。」

## 实名认证入口（account-page.tsx）
- [x] 顶部新增 `REALNAME_ENABLED` 常量（默认 `false`），并写明下线策略注释
- [x] 「账号信息」区新增实名认证整行：未认证时「去认证」CTA，已认证时姓名 + 已认证徽标
- [x] 新增 `VerifyModal`（姓名 + 身份证号），挂载由 `showVerifyModal` 控制
- [x] 所有实名相关 JSX 均包在 `{REALNAME_ENABLED && (...)}` 中，下线时整体不渲染
- [x] 保留 `verified` / `verifiedName` / `showVerifyModal` 等 state 声明，避免下线时改动面过大
- [x] 引入 `ShieldCheck` 等 lucide 图标，表达「已认证」徽标

## 静态资源 CDN 清理
- [x] `src/lib/asset-url.ts`：移除 `VITE_ASSET_CDN_ENABLED` 分支，`CDN_BASE` 改为源码常量
- [x] `assetUrl()`：增加对 `http(s)://` / `data:` 的 passthrough，路径归一化
- [x] 保留 `isUsingCdn = true` 导出以兼容既有调用方
- [x] `src/vite-env.d.ts`：删除 `VITE_ASSET_CDN_ENABLED` / `VITE_ENABLE_REAL_NAME_VERIFICATION` 类型声明
- [x] `.env.example` / `.env.production`：清理已废弃环境变量；`.env.example` 补充说明注释
- [x] `openclaw-settings-page.tsx`：移除依赖 `VITE_ASSET_CDN_ENABLED` 的 loading 尺寸分支（loading 咖啡图标尺寸统一为 78px）

## 订阅页与走查修正
- [x] `subscribe-page.tsx`：恢复「选择适合你的套餐」下方小字文案
- [x] `index.html`：favicon `type` 修正
- [x] `legal-footer.tsx` / `cta-footer-section.tsx`：走查文案修正
- [x] `public/hermes_logo.png`、`public/lightvela-logo.jpg`：新增品牌资源
- [x] 处理账号信息折叠时出现的双边框线视觉问题

## 验证
- [x] 桌面 1440px：账号页、订阅页视觉走查通过
- [x] `REALNAME_ENABLED=false` 时，账号页无任何实名相关 DOM 渲染
- [x] 首页 / 落地页 / 订阅页静态资源全部走 CDN 加载
- [x] OpenClaw 设置页 loading 咖啡图标尺寸为 78px

## 代码评审
- [x] CR 意见：favicon type / 缩进 / 冗余判断修正
- [x] CR 意见：折叠态双边框线修复
- [x] 自 CR：识别「实名 state 保留不清理」为短期技术债
- [x] 自 CR：识别 `isUsingCdn` 恒为 true 可后续批量清理

## 提交与合并
- [x] `feat/real-name-verification` 分支提交 `feat: 走查修改`（e640d13e）
- [x] 同分支提交 CR 修正 `fix: 走查修改 CR 意见修正（favicon type / 缩进 / 冗余判断）`（93975698）
- [x] 创建 MR !33，合入 `dev`（merge commit 1c2d2f0b）
- [x] 在 `dev` 分支直提 `fix: 移除 REALNAME 环境变量开关，资源统一走 CDN 清理冗余开关`（853d8984）
- [x] 推送到 `origin/dev`
