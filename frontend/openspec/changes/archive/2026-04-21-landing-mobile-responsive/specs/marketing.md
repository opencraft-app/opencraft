---
spec: marketing
change: landing-mobile-responsive
delta_type: additive + modified
---

# Delta Spec：Marketing 移动端响应式

## ADDED（新增能力）

### Landing Navbar 响应式

- 新增 `useIsDesktop()` hook（位于 `landing-navbar.tsx` 内部），通过
  `window.matchMedia("(min-width: 768px)")` 订阅断点变化
- 移动端（< 768px）：右上角显示「登录」小按钮（未登录）+ 汉堡按钮；
  已登录时仅显示 Avatar + 汉堡
- 汉堡面板展开：包含所有导航项；未登录额外追加「立即创建」CTA 铺满宽度
- 桌面与移动**只挂载一份** `<UserAvatarMenu />` 实例，避免
  `document.mousedown` 监听重复注册

### 响应式断点规范

在 `specs/marketing.md` 的"业务规则"中增加：

6. **响应式断点**：营销模块统一采用 Tailwind 默认断点
   - `default`（< 768px）：移动端单列堆叠布局
   - `md`（≥ 768px）：平板双列或多列
   - `lg`（≥ 1024px）：桌面完整布局（原设计稿）
   所有 section 必须在默认断点下提供可用的移动体验，不允许出现横向溢出。

## MODIFIED（修改能力）

### Landing 分区组件

所有 `landing/*.tsx` 分区组件均遵循新的响应式约束：
- 内边距：`px-4 md:px-6 lg:px-10` / `lg:px-[80px]`
- 字号：移动端基础字号下调（如 hero 标题从 `lg:text-[56px]` 改为
  `text-[28px] md:text-[40px] lg:text-[56px]`）
- 栅格：`grid-cols-1 md:grid-cols-2 lg:grid-cols-3`
- CTA 按钮：移动端 `w-full`，桌面保持原宽

### 账号页（`account-page.tsx`）

- 头像 + 昵称区块：`flex flex-col md:flex-row` 控制堆叠方向
- 操作按钮（退出 / 注销）：`flex-1 md:flex-initial` + `py-2 md:py-[4px]`，
  移动端等宽铺满双列，桌面保持紧凑

## NOTE（已记录的技术债 / TODO）

1. `useIsDesktop` 当前作为 navbar 私有 hook，尚未抽到 `lib/hooks/`。
   如 account / subscribe 等页面出现同类需求，应重构为 `useMediaQuery(query)`。
2. Avatar 容器目前通过 JS 切换 `ml-0 / ml-auto`，未来若 nav 在桌面端被隐藏，
   需补 `md:ml-auto` 作为 CSS 兜底。
3. `mql.addEventListener` 无旧 Safari（< 14）fallback，视 browserslist 而定。
