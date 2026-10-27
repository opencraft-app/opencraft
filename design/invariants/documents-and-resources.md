# Workbench invariants: Documents and resources

[Invariant index](../invariants.md) · [Design index](../README.md)

## Image preview gestures

Web image previews share a bounded local pinch/rotate/pan viewport. Scaling spans 0.2–5× the fitted size;
rotation and scaling preserve the two-finger anchor, with rotated bounds for pan. Lightboxes use the
full available screen as that viewport, never the initial image rectangle;
embedded resources retain the panel boundary. Manipulation never
changes the document, page scale, source or active gallery index. Preview controls
remain outside the transformed image and reachable at every scale; cancelling a
pointer ends its participation without closing the modal or starting navigation.



## Link label action ownership

A link owns its resource action. Its label retains Markdown formatting and image
children but suppresses text decorations that would create nested interactive
mentions. The document compiler preserves target/title and source-range contracts;
the renderer owns target safety, streaming activation and semantic open intent.
Changing node construction must not create a second resource or identity owner.


## 图片附件呈现（2026-09-27）

- 草稿图片的语义身份和处理状态只属于 Composer Draft；浏览器 `File`、临时预览 URL 和处理任务属于 Controller 的草稿所有者附件会话，不写入可序列化 Draft。切换会话或页面缓存淘汰保留资源，晚到结果只能修改原 Draft；移除、清空或草稿所有者销毁须中止任务并释放 URL。新内容准入失败必须回收尚未被草稿接收的 File 预览，不启动孤立任务。
- 图片选中即在输入卡片内显示方形缩略图；处理中、失败和删除均原位反馈。触控删除始终可见，不能依赖 hover；处理中不宣称网络上传百分比，失败图片不允许发送。
- 已发送图片由 Timeline 及媒体加载边界投影。缩略图进入图片查看器，不绕过通用链接策略来打开 `data:` URL；查看器按原资源身份加载并在关闭后恢复焦点。

## Markdown 文件预览
- 文件标题栏提供文件树显隐开关；收起后内容占满宽度，树保持挂载以保留展开、搜索和滚动位置，不重建预览或编辑器。只读嵌入预览仍无目录入口。验证：`scripts/smoke/resources/smoke-file-tree-toggle.ts`。
- 文件树的目录数据归Host作用域Query缓存，展开/键盘活动项/滚动归当前面板；按数据版本排序、展开分支拍平，DOM仅挂载可视窗口和overscan。侧栏/聊天更新不得触发未变化目录排序或每目录会话订阅。隐藏和搜索保留展开/滚动，键盘上下/Home/End/左右/Enter与选中文件仍可达；目录折叠后迟到数据不恢复子行。验证：`tests/resources/workspace-file-tree-model.test.ts`、`scripts/smoke/resources/smoke-workspace-file-tree.ts`。
- 下载按钮沿用文件标题栏同排操作的尺寸、图标和反馈样式；不单独放大下载控件或为它撑高标题栏。
- 文件预览标题栏右侧提供下载原文件；包括空文件、图片和不可预览的二进制。下载使用当前 Host/path/runtime generation 下已读取的 Blob 和文件名，不导出渲染 HTML 或未保存编辑草稿，不写回 Host。读取未完成、读取失败或旧资源 URL 尚未替换时禁用；切换身份/关闭释放 URL。只读内嵌预览同样允许下载。
- 文件面板默认将 `.md` / `.markdown`（大小写不敏感）交给既有 WebChatDocument 排版，可切换到原始文本；不将原始 HTML 注入 DOM。相对文件链接与图片以当前文件目录解析，继续消费当前 Host 的资源接口和 Blob lease。
- 内嵌模式维持只读、无目录/搜索/监听/写入；写入执行入口必须先检查只读状态，拒绝后不得调用 Host 写入或失效 Blob 缓存。预览/源码是文件身份下的局部状态，不修改会话或源文件。
- HTML 预览在创建沙盒 iframe 前移除普通链接、图片热区及 SVG 链接的目标、自动刷新跳转和可恢复链接目标的 SVG 动画；点击预览正文不得将 iframe 导航到外部页面，避免离开初始 CSP 后加载外部资源。源码视图继续显示未经改写的文件内容。

## 通用媒体与 PDF 文件预览

- `MEDIA:<path>` 是与扩展名无关的资源交付入口，图片、音频、视频、PDF 和未知文件均先经共享资源策略，再进入当前 Host 的文件预览。PDF 不按执行引擎或连接位置分支，所有能够提供文件字节的 Host 共用 PDF.js；未知或无法解码的文件保留下载动作。
- PDF 文档、Worker、当前页绘制与文字层属于资源 View；换文件或卸载取消旧任务，晚到结果不得写入新资源。每次只绘制当前页，限制高 DPI 画布像素，Worker、CMap、字体和编解码资源随构建提供，不依赖外部 CDN。
- 文件预览不修改原附件、文件、会话或引擎能力。Web 的共享 Renderer 不宣称已完成 Expo 原生 PDF 阅读器。

独立与内嵌入口共用 Composer 编辑区域高度规则；新会话与已有会话保持一致，增长由同一输入区域承担，工具栏继续位于底部。

Markdown preview entry: explicit `.md` / `.markdown` paths in completed inline code are clickable and use the same resource policy and Host-scoped right panel as Markdown links. Bare names, commands, external URLs, streaming paths and code within an explicit link retain their original semantics. No file is read before clicking.

HTML preview entry: completed inline-code `.html` / `.htm` paths use that same right-panel resource flow. The read-only file panel defaults to a sandboxed page preview and can switch to escaped source without reading the file again. Scripts and external subresources are blocked; inline styles and embedded data/Blob media can render. The file remains owned by the Host, and changing files replaces the preview document.

国内嵌入聊天采用 compact 右栏初始宽度：既有默认宽度的 2/3，并继续遵守面板最小宽度和聊天内容保留宽度；拖拽调整由原 Shell owner 负责，独立工作台保持 standard 默认。

国内桌面嵌入聊天由控制台占满侧栏右侧的内容列，去除设置页外围 gutter 和宽度上限；宿主通过下游嵌入适配器对齐 68px 导航表头。嵌入根将表头高度投影到 toolbar token（缺省 46px），具体产品装配由下游持有，消息正文保留内部间距；移动端与旧聊天入口沿用原布局。

只读 Markdown 文件预览的“源码”直接呈现转义后的原文，可选择复制和键盘滚动，不依赖按需加载的编辑器模块；可编辑工作台继续由 CodeMirror 持有草稿。

## Chat document tracking (2026-10-15)

Web/Electron chat documents and lazy/error source fallbacks use normal letter spacing, independent of the Shell body’s -0.01em tracking. Assistant prose and formatted user messages share the document root, so headings, paragraphs, lists, tables and nested content inherit the same natural spacing. Existing family, size, line-height, weight, paragraph rhythm and code font selection remain owned by their current renderers. The composer and Shell are outside this document boundary; conversation list titles keep their independently approved 13px/normal role.

### Files entry in the right panel

The built-in resource plugin owns one Files creation action for both empty-panel launcher and new-tab picker. Its semantic folder glyph is retained in both classic and standard presentation; the classic panel fallback must not turn Files into a generic add action. Its directory comes from the current conversation toolbar context, with a stable directory resource tab; previews opened elsewhere cannot replace that retained tab. No directory means no action. Host filtering still owns embedded availability; the launcher does not grant filesystem permissions or change tree/preview lifetime.

- Browser storage startup failures are not release asset failures: dynamic-import
  rejection must reach the storage recovery boundary; early recovery retains
  saved data, gives a reload action, and does not expose raw storage diagnostics.

分支会话的参与者不继承父会话：新分支头像先显示已认证创建者，后续实际接收的用户消息增加参与者。历史消息继续保留原作者。继承来源由Host持久化，刷新、重连与再次分支不能将历史作者恢复为新分支成员；创建者在头像列表去重。核心发送者回归入口：`tests/chat/opencraft-message-senders.test.ts`。历史产品记录另引用 `tests/enterprise-identity-participants.test.ts`、`scripts/smoke-fork-participants.ts`；这两项未随独立公开核心交付，不能作为本仓库当前可运行的验收证据。

- Workspace resource panels default to a collapsed file tree for all file types; the header folder
  toggle remains available. Manual visibility takes precedence for that panel
  lifetime, preserving mounted viewer/tree state while browsing files.

### Markdown table scroll ownership

Wide content may automatically exceed prose width, but its scrollport and actions
stay inside the current reading surface. The layout owns available width and
panel limits; table and Mermaid renderers share the budget. Compact latest-turn
previews and ownerless embedded documents cannot borrow ancestor/window space.
Narrow surfaces do not use negative margins selected by window size. Toolbar
anchors are scoped per table with an inside-container fallback. Evidence:
`scripts/smoke/resources/smoke-markdown-wide-layout.ts` (live resizing and independent previews).

Web/Electron tables preserve intrinsic column widths in a non-shrinking wrapper,
with long cells bounded and wrapped. The table scrollport owns horizontal
overflow; the timeline still owns vertical scrolling. Short tables remain within
the available container. Phone, iPad (including split view) and desktop Web use
this same container-driven contract and native touch/trackpad/scrollbar input;
ordinary text selection is not converted into panning. Links, source copy and
expanded preview keep their existing behavior. Streaming row additions retain
table DOM and horizontal position. Evidence: `scripts/smoke/resources/smoke-markdown-table-scroll.ts`;
Chromium touch is not iOS device proof.


Task recycle bin projects the existing seven-day soft-delete window from the Task authority. Restore retains task and conversation identities and original status, appends to that column and never controls execution. Main board/list stays mounted across recycle navigation. Errors flow through the platform reportError port into shared non-blocking notices. Verification: `scripts/smoke/tasks/smoke-tasks-recycle.ts` and task store/controller/Host tests.
Task description expand/collapse retains the same editor and draft; expanding does not save or change task data.

Conversation headers expose capability-gated rename in standalone as well as embedded layouts. The same Host/Thread title writer owns persistence; Escape cancels, Enter saves, and failures use shared nonblocking notices. The pencil remains reachable for touch outside the Newera floating-header presentation; there, the existing menu retains Rename.
Running sidebar rows with actions share a single trailing menu slot. Desktop shows activity until hover/focus/open; touch keeps the animated running ring beside actionable dots within the same 44px target, including while the menu is open. Existing Radix menu owns actions; rows without actions retain their status indicator. Title and avatar geometry is stable.

Pin/unpin paints the intended membership immediately without waiting for native
metadata writes or full-directory pagination. The shared action owner shows
Saving feedback even when the destination group is folded or paginated. Pending
intents survive stale reads, rejected writes restore confirmed membership and
report an error, and revoked connection scopes cannot project late results.
Existing group priority, filtering, six-pin/ten-recent budgets and ordering remain.

Pinned conversations use presentation-only paging after filtering: six rows initially, six more per Show more, and Show less resets to six. Both controls belong below the last visible pinned row inside the pinned section, disappear with the collapsed section, and do not change catalog membership, selection, or recent pagination.

Recent conversations use the same section-local paging controls as pinned conversations, with an independent ten-row initial limit and ten-row increments. Show less resets recent to ten. Filtering precedes slicing; selected identity, full task-flow groups, date headings and pin state remain independent of visibility. Both groups use shared small-control/tertiary styling and hide paging controls with their collapsed section.

### Mermaid diagram geometry and visual presentation (2026-10-17)

The Web diagram renderer owns SVG viewport containment and accessibility-only
source visibility. A successful SVG render must include all attached graphics,
not merely fit an already clipped viewBox into the transcript. The shell includes
its border and fractional layout height; preview export consumes the corrected
viewport. Actions reserve their own header space and never cover nodes, with
visible 44px targets on touch. Mermaid defaults to classic/base with lazily
registered ELK layout and existing semantic theme tokens; no neo node shadows.
This keeps the reading-surface wide-content limits and render-key continuity.
Actual layout and source visibility are verified by
`scripts/smoke/resources/smoke-mermaid-display.ts`.

## Read-only file preview ownership

- Host-authorized bytes and original download stay with the resource panel; an
  format adapter cannot resolve paths or write files. DOCX/PPTX/XLSX/XLS/XLSM,
  CSV/TSV, Draw.io/DIO, Excalidraw and standalone Mermaid files are parsed
  lazily, with read-only controls and no remote executable viewer dependency.
- Adapter registrations own extension support. The resource panel and preview
  service consume the same registry, rather than maintaining an Office-only
  allowlist. Unregister revokes previews and publishes the capability change.
- CSV/TSV preserve literal cell contents (including leading zeros and formula
  strings), support quoted separators/newlines and use a bounded virtual table.
  XLS requires an OLE signature; OOXML keeps its archive admission rules. Neither
  workbook path executes macros or writes back to the original file.
- Draw.io normalizes compressed and multi-page XML within expansion limits and
  uses a packaged viewer in an opaque sandbox. The page fetches its own viewer
  asset before sandbox creation; the sandbox makes no script/network requests,
  including on loopback deployments with local-network protection. Excalidraw exports a read-only
  scene with packaged fonts; standalone `.mmd`/`.mermaid` use the same serialized
  Mermaid engine and theme configuration as chat. View transforms and page
  selection belong to the retained preview, never the Host document.
- Workbench owner + tab + Host/resource/runtime generation + immutable Blob
  revision + adapter generation identify each mutable preview. Hidden is not
  closed. Recent ready instances may be retained within explicit capacity and
  source-byte bounds; close/replacement/owner release revoke old work. Late
  results, evicted viewers and unregistered adapters dispose their resources.
- Loading, timeout and retry use the viewer's existing area; they cannot enlarge
  menus, rows or neighboring containers. File-tree visibility and PDF behavior
  remain owned by the existing panel contract.
- PPTX navigation belongs to its retained file preview: one selected slide,
  relative fit/zoom and an explicitly toggleable thumbnail rail. Fit consumes
  the actual preview container in both dimensions, not the browser width.
  Page navigation never scrolls the surrounding Shell or consumes input editing
  keys. The thumbnail rail is inert document content within navigation buttons;
  only near-viewport thumbnails (at most eight) hold render handles. Hidden/
  detached views release thumbnail work; close/replacement cancels all handles.
- Evidence: `tests/resources/file-preview-core.test.ts`, `tests/resources/structured-preview.test.ts`,
  `scripts/smoke/resources/smoke-office-preview.ts`, `scripts/smoke/resources/smoke-structured-preview.ts`;
  detailed boundaries and limits: [file previews](../../docs/file-preview.md).


## Code caption paint continuity (2026-10-21)

Ordinary Web code captions use normal stacking order with their code surface.
Touch scrolling must not briefly expose a blank language/action bar while the
code remains visible. Explicit sticky captions retain their elevated layer.


## Streamed code fence continuity (2026-10-21)

A Web non-Mermaid code fence keeps one surface, wrap control and scroller while
streaming and closing. Completion cannot remove a focused control or reset local
horizontal scrolling. Open code stays plain; only a complete fence enables
copying, SVG preview and near-viewport syntax enhancement. Highlighting changes
presentation without changing the canonical source or replacing the surface.

### Document reading controls

Legacy Word uses the same retained read-only preview identity, with local Worker/WASM and font disposal. CSV cell selection, column widths, find query and full multiline contents belong to that retained view; theme/locale switches do not reset them. Table bytes are never coerced or edited. Host-opened Office links admit only HTTP(S) without credentials; document fragments stay inside their own root, all other protocols are inert. Locale projection updates labels in place; diagrams keep the packaged offline sandbox. Known preview failures use actionable localized messages in the existing failure area and preserve download/retry.

## Optional image editor transaction

- The fullscreen draft image modal owns focus, portal and background input isolation.
  Its optional editor is a plugin View, never another Composer or draft owner.
- Plugin header/footer controls use shared typography, controls and semantic theme
  tokens; media content colors belong to the edited image. Tools remain reachable
  on narrow touch layouts. Done is primary; Cancel and Undo/Redo are secondary.
- Cancel changes nothing. Done only replaces the initiating attachment after checking
  active draft, attachment/source identity. Neither path submits a message. Crops,
  quarter turns and strokes share one undo/redo history; source pixels stay immutable
  within the editor. Pixelation is composited into the exported image.

- Image editing is touch-first: a second finger cancels unfinished ink/crop/placement; pinch/pan changes only viewport, with no editing until all fingers release. Undo/export use native document pixels. Keyboard resize preserves the same editing transaction and keeps tools in the visual viewport.


Image annotation text is entered at the tapped image position with a native multiline textarea for caret, selection and IME. It remains a local pending operation until confirmed or a tool/save action commits it once; Escape discards only pending text. View resize keeps native image coordinates and text. The input consumes shared touch typography; its resolved font and line spacing stay with the local text operation so canvas replay and export match the input. Normal editing shows tools without permanent instructions or a filename; accessible names and error feedback remain. Image editor interface glyphs use shared original artwork, including the pixel mosaic; sticker content previews are not interface artwork.
## Generated image pending feedback

- Generated-image pending feedback stays visible against the conversation canvas in light, dark and custom themes. Its skeleton derives from the current foreground rather than a raised surface that can equal the canvas; reduced motion keeps the same visible footprint without pulsing. The media owner retains its existing progress semantics and lifecycle.
