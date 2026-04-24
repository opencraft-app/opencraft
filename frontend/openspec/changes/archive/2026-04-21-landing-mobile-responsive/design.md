---
change: landing-mobile-responsive
---

# 设计文档：Landing 页与账号页移动端适配

## 设计目标

1. **首屏零脚本闪烁**：依赖 Tailwind 原生媒体查询（`md:` / `lg:` 前缀）完成绝大多数响应式，避免 JS 判断导致的布局抖动。
2. **断点统一**：对齐 Tailwind 默认断点：`md = 768px`，`lg = 1024px`。
3. **桌面端零视觉回归**：所有改动仅新增 `md:` 还原既有桌面样式，默认态（移动）重写间距、字号、布局。

## 断点方案

| 断点 | 范围 | 典型设备 | 布局特征 |
|------|------|---------|---------|
| `default`（< 768px） | 手机 | iPhone / Android | 单列堆叠、边距 `px-4`、汉堡菜单、CTA 铺满 |
| `md`（≥ 768px） | 平板 / 小桌面 | iPad 竖屏 | 双列卡片、edge `px-6`、水平导航 |
| `lg`（≥ 1024px） | 桌面 | 笔记本 / 台式 | 原设计稿布局（多列、`px-10` / `px-[80px]`） |

## 核心改动

### 1. Landing Navbar — 汉堡 + Avatar 按断点挂载

**问题**：若桌面与移动各放一份 `<UserAvatarMenu />`，会导致：
- 两个组件同时注册 `document.mousedown` 监听
- dropdown state 双份运行，互相干扰

**方案**：引入 `useIsDesktop()` hook（内部用 `matchMedia`），**在任一时刻只挂载一份 Avatar**：
- 桌面（≥ 768px）：Avatar 与桌面 CTA 并列在右侧
- 移动（< 768px）：Avatar 紧邻汉堡按钮

未登录：桌面显示"立即创建 + 登录"双按钮；移动端右侧只显示"登录"小按钮 + 汉堡，CTA 下沉到汉堡菜单内。

### 2. Landing 分区 — 纯 CSS 响应式

每个 section 采用同一套模式：

```
默认（移动）：text-[28px]  px-4   py-10   gap-4   grid-cols-1
md:          text-[40px]  px-6   py-14   gap-6   grid-cols-2
lg:          text-[56px]  px-10  py-20   gap-10  grid-cols-3（保持原稿）
```

涉及文件：`hero-section` / `what-it-does-section` / `how-easy-section` / `where-to-use-section` / `why-trust-section` / `cta-footer-section`。

### 3. Account 个人信息区

- 头像 + 昵称区：`flex flex-col md:flex-row` 控制堆叠方向
- 操作按钮（退出/注销）：移动端 `flex-1` 等宽铺满；桌面 `md:flex-initial` 保持紧凑

## 关键决策

| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|
| 响应式方案 | A. 全 CSS B. 全 JS C. 混合 | **A 为主，仅 Navbar Avatar 因需要"二选一挂载"用 B** | CSS 零抖动、零白屏；JS 仅在"必须单例"场景使用 |
| 汉堡菜单内容 | A. 只放导航 B. 放导航+CTA | **B（方案B）** | 未登录用户在移动端有明确转化路径，不强迫滚到 footer |
| Avatar 挂载位置 | A. 双份 hidden/flex 切换 B. 单份按断点挂载 | **B** | 避免重复挂载的 state/监听问题 |
| hook 位置 | A. 放 navbar 内私有 B. 抽 lib/hooks | **A（本次）** | 目前只有 navbar 使用；后续如有复用再抽（记入 TODO） |

## 已知权衡与后续优化

- `useIsDesktop` 当前作为 navbar 私有 hook，**未复用**。后续如 account/subscribe 等页面出现同类需求，再抽到 `lib/hooks/use-media-query.ts`。
- `mql.addEventListener` 未加旧 Safari（< 14）fallback，依赖项目 Vite 默认 browserslist，目前无投诉。
- Avatar 容器的 `ml-0 / ml-auto` 是 JS 控制，而非 Tailwind `md:ml-auto`；未来如果 nav 被隐藏，桌面端 Avatar 需加 `md:ml-auto` 兜底（已在 CR 中记录）。

## 风险

- **低风险**：所有改动为 Tailwind class 增量，桌面端视觉零变化
- **已验证**：本地浏览器设备模拟（iPhone 12 / iPad / 桌面 1440）均通过视觉走查
