---
change: landing-mobile-responsive
status: completed
---

# 任务清单：Landing 页与账号页移动端适配

## 调研与设计
- [x] 走查桌面站在 iPhone / iPad 设备模拟器下的体验问题
- [x] 梳理 Tailwind 断点方案（`md=768px` / `lg=1024px`）
- [x] 对齐汉堡菜单方案（方案B：导航 + CTA 下沉）
- [x] 确认 Avatar 单例策略（按断点挂载一份）

## Landing Navbar
- [x] 新增 `useIsDesktop` hook（`matchMedia` + cleanup）
- [x] 桌面端：未登录显示"立即创建 + 登录"；已登录显示 Avatar
- [x] 移动端：新增汉堡按钮 + "登录"小按钮（未登录）/ 仅汉堡（已登录）
- [x] 汉堡展开面板：导航项 + "立即创建"CTA（未登录时）
- [x] Avatar 按断点挂载到对应位置，保证只有一份 UserAvatarMenu 实例

## Landing 分区
- [x] `hero-section.tsx` 响应式字号 / 内边距 / 按钮
- [x] `what-it-does-section.tsx` 栅格断点
- [x] `how-easy-section.tsx` 栅格断点
- [x] `where-to-use-section.tsx` 栅格断点
- [x] `why-trust-section.tsx` 栅格断点
- [x] `cta-footer-section.tsx` 按钮铺满策略

## 账号页
- [x] 头像 + 昵称区 `flex-col md:flex-row` 堆叠
- [x] 操作按钮 `flex-1 md:flex-initial` 移动端等宽

## P0/P1 修复（已合并到本次变更）
- [x] P0：Avatar 在移动端重复挂载导致 dropdown 异常
- [x] P0：已登录状态下汉堡旁 Avatar 位置错乱
- [x] P1：account 页 logout / delete 按钮 padding 挤压
- [x] P1：navbar `hidden md:flex` 与 JS 条件重复判断导致状态错乱

## 验证
- [x] 桌面 1440px 视觉零回归
- [x] iPhone 12 / 13 Pro 视觉走查通过
- [x] iPad 竖屏 / 横屏过渡平滑
- [x] 已登录 / 未登录双态 × 桌面 / 移动双端共 4 种场景验证

## 代码评审
- [x] 自 CR：识别出 Issue-D（未来 nav 隐藏时需 `md:ml-auto`）作为 TODO
- [x] 自 CR：识别出 Issue-E（`useIsDesktop` 可抽通用 hook）作为后续

## 提交与合并
- [x] feat commit: `feat(marketing): landing 页与账号页移动端适配`
- [x] 分支：`feat/landing-mobile-responsive`
- [x] 推送到 origin
- [x] 已合并 master 最新（26fc96bc / ae61c0c3）
