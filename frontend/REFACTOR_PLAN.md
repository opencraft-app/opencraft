# LightClaw 首页样式重构计划

本项目旨在基于最新的 Figma 设计稿，重构 LightClaw 首页的样式。当前使用技术栈为 **Vite + React + TypeScript + Tailwind CSS v4 + Framer Motion**。

## 重构原则
1. **清理历史包袱**：彻底移除旧版“新瑞士主义”遗留的全局 CSS 变量（如 `--lw-*`）和写死的内联 `style` 属性。
2. **拥抱 Tailwind v4**：将设计规范（颜色、字体、阴影、滤镜）提取到 `@theme` 或全局抽象层中，提升代码可维护性。
3. **极简科技风**：严格遵循设计稿中的黑白灰为主、高对比度、大圆角、搭配高亮度模糊光晕及玻璃拟态（Glassmorphism）的视觉风格。
4. **组件化复用**：识别并在重构复杂业务区前，先抽离共用的高频 UI 组件（如 CTA 按钮、光效装饰、毛玻璃容器）。
5. **体验一致性**：保留并优化原有的 Framer Motion 滚动揭示及交互动画，并确保各断点下的良好响应式体验。

---

## 进度追踪

### [x] 第一阶段：重塑设计令牌 (Design Tokens) 与基础样式
- [x] 移除 `src/styles.css` 和现有组件中的 `--lw-*` 旧变量及硬编码的内联样式。
- [x] 配置 Tailwind 主题：注入主背景色、主文本色及辅助色。
- [x] 配置 Tailwind 字体：引入/设置备用字体 `PingFang SC`，`SF Mono`，以及特殊字体 `Kalam` 和 `Alimama ShuHeiTi`。
- [x] 配置 Tailwind 特效：增加 `blur-100px` 环境光滤镜及毛玻璃参数。

### [x] 第二阶段：核心复用 UI 元素的抽象
- [x] 提取**主按钮 (Primary CTA)**：高 `64px`，大圆角（Pill），黑底白字加图标。
- [x] 提取**毛玻璃容器 (Glassmorphism Card)**：带有 `backdrop-blur` 和浅边框的半透明容器。
- [x] 提取**装饰性环境光 (Ambient Glow)**：配置纯色模糊光团的共用类或组件。

### [x] 第三阶段：分区块精准重构 (Section by Section)
- [x] 重构 `landing-navbar.tsx`：更新导航栏样式与按钮外观。
- [x] 重构 `hero-section.tsx`：更新 64px 主标语、对齐大 CTA 按钮并加入背景模糊背光。
- [x] 重构 `what-it-does-section.tsx`：实现包含“我的Claw/热门技能”和对话气泡的极简黑白灰毛玻璃聊天模拟器。
- [x] 重构 `where-to-use-section.tsx`：使用 CSS Grid 布局三大卡片，并为 QQ/微信卡片添加强力发光底色。
- [x] 重构 `how-easy-section.tsx`：实现带有 `Kalam` 字体“约 30 秒”标签和手写风大数字的垂直时间轴步骤区。
- [x] 重构 `why-trust-section.tsx`：实现透明紫罗兰色背景胶囊标签和介绍卡片排版。

### [x] 第四阶段：动画调优与响应式适配 (Polishing & Responsive)
- [x] 从设计稿资源中提取并引入必要的 SVG 图标资源。
- [x] 调优 Framer Motion 进入动画及元素的 Hover/Focus 状态反馈，确保顺滑且具有高级感。
- [x] 进行响应式适配，确保移动端及小屏设备下从两列/多列优雅降级为单列布局。

---

*注：在每一步重构开始之前，请查阅此文档了解当前进度及重构原则，并在完成每一步后及时打勾更新。*