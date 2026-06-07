# Frontend Design Notes

## Corner Radius

页面内的卡片、面板、列表项和表单容器默认使用 `rounded-md`。除非是头像、圆形图标按钮、胶囊标签、弹窗外壳或明确需要强调柔和感的特殊组件，不要随手使用 `rounded-lg` / `rounded-xl` / `rounded-2xl`。

这样可以让工作台、设置页和任务面板保持更克制的工具感，避免卡片弧度过大导致界面显得松散、偏营销化。

## Hover Tooltip

设置页里的自定义 hover/focus 悬浮提示，默认使用文件管理器当前统一后的 tooltip 样式。

- 触发器外层使用 `group relative inline-flex`。
- Tooltip 展示在触发器上方，居中对齐：`absolute bottom-full left-1/2 mb-2 -translate-x-1/2`。
- 视觉样式：白底深色字，`border border-[var(--border-subtle)]`，`rounded-md`，`px-3 py-1.5`，`text-[11px] font-medium`，轻阴影如 `0 8px 24px rgba(15,23,42,0.12)`。
- Tooltip 底部带白底小三角，可以用一个 `h-2 w-2 rotate-45` 的方块实现，并给三角加底边/右边边框衔接气泡。
- 行为：Tooltip 本体必须允许鼠标进入和文本选择，使用 `pointer-events-auto select-text`，不要使用 `pointer-events-none`。默认 `opacity-0`，`group-hover` 和必要的 `group-focus-within` 时显示，过渡时间保持短。
- 可复制性：当鼠标从触发器移到 tooltip 气泡内时，气泡应保持可见，用户可以拖拽选择并复制里面的文案。使用 portal 或 JS 控制显隐的 tooltip，需要在触发器与气泡之间保留短暂 hover 缓冲，或让气泡自身的 `mouseenter` / `mouseleave` 参与显隐状态。
- 不要用浏览器原生 `title` 来替代这个样式；禁用按钮需要解释原因时，也使用这套 tooltip，例如 `未选择文件`。
