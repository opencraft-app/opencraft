# Frontend Design Notes

## Hover Tooltip

设置页里的自定义 hover/focus 悬浮提示，默认使用文件管理器当前统一后的 tooltip 样式。

- 触发器外层使用 `group relative inline-flex`。
- Tooltip 展示在触发器上方，居中对齐：`absolute bottom-full left-1/2 mb-2 -translate-x-1/2`。
- 视觉样式：白底深色字，`border border-[var(--border-subtle)]`，`rounded-md`，`px-3 py-1.5`，`text-[11px] font-medium`，轻阴影如 `0 8px 24px rgba(15,23,42,0.12)`。
- Tooltip 底部带白底小三角，可以用一个 `h-2 w-2 rotate-45` 的方块实现，并给三角加底边/右边边框衔接气泡。
- 行为：`pointer-events-none`，默认 `opacity-0`，`group-hover` 和必要的 `group-focus-within` 时显示，过渡时间保持短。
- 不要用浏览器原生 `title` 来替代这个样式；禁用按钮需要解释原因时，也使用这套 tooltip，例如 `未选择文件`。
