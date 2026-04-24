---
change: landing-mobile-responsive
status: archived
branch: feat/landing-mobile-responsive
archived_at: 2026-04-22
---

# 变更提案：Landing 页与账号页移动端适配

## 动机

在 https://lightclaw.pages.dev 上线后，通过移动端访问存在两类体验问题：

1. **Landing 页**：桌面端大屏布局直接缩放到手机上，出现：
   - Hero 区文案字号溢出、按钮铺满屏幕
   - 多列卡片区（what-it-does / why-trust / how-easy）在窄屏下单列堆叠但间距异常
   - Footer CTA 铺屏但留白过大
   - 导航栏右上角缺少移动端友好的菜单/登录入口；已登录时头像位置错乱
2. **账号页（/account）**：个人信息区和头像/操作按钮区在小屏下出现横向溢出、按钮挤压变形。

## 影响范围

### 前端
- `frontend/src/pages/marketing/landing/` 全部分区组件（8 个）
- `frontend/src/pages/marketing/account-page.tsx`

### 未触及
- 后端：无变更
- 其他业务模块：无变更

## 能力变更（Deltas）

| 能力 | 变更类型 | 说明 |
|------|---------|------|
| Landing Navbar 响应式 | 新增 | 移动端增加汉堡菜单 + 登录按钮；已登录时头像按断点挂载到右侧 |
| Landing 分区响应式间距 | 修改 | 所有 section 增加 `md:`/`lg:` 断点，字号/内边距按断点分级 |
| Account 个人信息区响应式 | 修改 | 头像+昵称区移动端堆叠垂直布局；退出/注销按钮移动端等宽铺满 |
| 方案 B 汉堡菜单布局 | 新增 | 登录/创建 CTA 在移动端下沉到汉堡菜单内 |

## 非目标

- 不做深度 i18n 抽文案（已知技术债，后续规划）
- 不拆 `account-page.tsx` 的 35KB 巨文件（本次只做响应式）
- 不替换 `openclaw-settings-page.tsx`（与本次无关）

## 关联

- 用户反馈：移动端访问落地页体验差、账号页横向溢出
- P0 修复：已登录时 Avatar 在移动端位置错乱（`landing-navbar` 内 Avatar 同时挂载两份）
- P1 修复：account 页 logout/delete 按钮 padding 挤压
