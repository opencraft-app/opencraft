# Frontend Design Notes

## Corner Radius

页面内的卡片、面板、列表项和表单容器默认使用 `rounded-md`。除非是头像、圆形图标按钮、胶囊标签、弹窗外壳或明确需要强调柔和感的特殊组件，不要随手使用 `rounded-lg` / `rounded-xl` / `rounded-2xl`。

这样可以让工作台、设置页和任务面板保持更克制的工具感，避免卡片弧度过大导致界面显得松散、偏营销化。

## Modal Layout

弹窗标题区和首个内容块必须结构隔离，不能依赖内容块第一行的 padding、line-height 或顶部 margin 来“撑开”标题间距。标题容器应显式承担底部留白，例如使用 `mb-5` / `pb-4`；首个内容块再从正常文档流开始。

- 带边框列表、表格、卡片组的弹窗，标题和内容之间必须有清晰可见的空白节奏，内容边框不能贴近或侵入标题基线。
- 不要用负 margin、绝对定位或 overflow 裁切来调整首个内容块的位置；如果出现标题与内容贴住、重叠或看似被内容顶上来的情况，优先检查标题容器与内容容器的结构间距。
- 调整这类问题时，不要只反复修改内容块自身的 `mt-*`。应让标题区拥有间距责任，内容区保持独立，避免后续首行高度、滚动容器或列表样式变化后再次回归。

## Dropdown / Select

产品内的下拉选择器不要直接依赖浏览器原生 `<select>` 展开菜单。原生菜单的选中态、边框、阴影和字体会跟随系统实现，容易和 Agent 控制台、自动任务弹窗等自定义浮层风格不一致。

- 触发器优先使用按钮式控件：白底、轻边框、圆角或胶囊形态、右侧 `ChevronDown`，通过 `aria-haspopup="listbox"` / `aria-expanded` 保留语义。
- 展开层使用产品内浮层样式：白底、`border border-black/10`、`rounded-xl`、`p-1.5`、`shadow-xl`，位置从触发器下方 `top-[calc(100%+6px)]` 展开。
- 选项使用按钮渲染，`role="option"` / `aria-selected` 标记当前值；选中态使用项目内统一的高对比样式，不暴露系统蓝色高亮。
- 需要解释范围、限制或完整能力入口时，在菜单顶部放静态提示文案，而不是塞进不可选的 `<option>`。例如日志条数下拉可提示“查看完整日志请执行导出操作”。
- 菜单宽度可以独立于触发器。触发器应保持紧凑，浮层需要承载提示文案时可以适当加宽，避免长文案撑破或换行过碎。

## Hover Tooltip

设置页里的自定义 hover/focus 悬浮提示，默认使用文件管理器当前统一后的 tooltip 样式。

- 触发器外层使用 `group relative inline-flex`。
- Tooltip 展示在触发器上方，居中对齐：`absolute bottom-full left-1/2 mb-2 -translate-x-1/2`。
- 视觉样式：白底深色字，`border border-[var(--border-subtle)]`，`rounded-md`，`px-3 py-1.5`，`text-[11px] font-medium`，轻阴影如 `0 8px 24px rgba(15,23,42,0.12)`。
- Tooltip 底部带白底小三角，可以用一个 `h-2 w-2 rotate-45` 的方块实现，并给三角加底边/右边边框衔接气泡。
- 行为：Tooltip 本体必须允许鼠标进入和文本选择，使用 `pointer-events-auto select-text`，不要使用 `pointer-events-none`。默认 `opacity-0`，`group-hover` 和必要的 `group-focus-within` 时显示，过渡时间保持短。
- 可复制性：当鼠标从触发器移到 tooltip 气泡内时，气泡应保持可见，用户可以拖拽选择并复制里面的文案。使用 portal 或 JS 控制显隐的 tooltip，需要在触发器与气泡之间保留短暂 hover 缓冲，或让气泡自身的 `mouseenter` / `mouseleave` 参与显隐状态。
- 不要用浏览器原生 `title` 来替代这个样式；禁用按钮需要解释原因时，也使用这套 tooltip，例如 `未选择文件`。
