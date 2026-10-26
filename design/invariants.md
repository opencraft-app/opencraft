# 工作区不变量

本页是不变量索引。正式约束、实现责任、证据与未验证边界按职责维护在下列专题；修改行为时更新对应专题，避免在本页继续追加正文。相同约束合并为一个正文，既有章节链接保留。

| 专题 | 范围 |
| --- | --- |
| [Shell and layout](invariants/shell-and-layout.md) | DOM projections, pane geometry, embedded presentation and shared layout ownership |
| [Navigation and sidebar](invariants/navigation-and-sidebar.md) | Routing, Sidebar gestures, groups, filters, search and row presentation |
| [Composer and input](invariants/composer-and-input.md) | Input ownership, drafts, keyboard, queue, model selection and Composer continuity |
| [Conversation and history](invariants/conversation-and-history.md) | Conversation identity, recovery, history, references and message presentation |
| [Activities and tools](invariants/activities-and-tools.md) | Reasoning, activity disclosure, tool surfaces and execution feedback |
| [Documents and resources](invariants/documents-and-resources.md) | File/media previews, document rendering, images and reading controls |
| [Browser and desktop](invariants/browser-and-desktop.md) | Browser lifecycle, viewing, layout, leases and cloud desktop composition |
| [Tasks and follow-up](invariants/tasks-and-follow-up.md) | Task editor, Board, AI follow-up, Morning, linking and scheduled tasks |
| [Appearance and controls](invariants/appearance-and-controls.md) | Typography, themes, icons, shared controls, material and hover policy |
| [Identity and connections](invariants/identity-and-connections.md) | Accounts, execution environments, network settings and plugin settings |
| [Lifecycle and verification](invariants/lifecycle-and-verification.md) | Workspace contracts, lifecycle boundaries, measurement, power and evidence |

## 章节索引

旧章节锚点继续有效；重复章节链接指向同一份正式约束。

### Shell and layout

- <a id="owned-dom-projection-names"></a>[Owned DOM projection names](invariants/shell-and-layout.md#owned-dom-projection-names)
- <a id="experimental-mobile-web-container"></a>[Experimental mobile Web container](invariants/shell-and-layout.md#experimental-mobile-web-container)
- <a id="internal-projection-metadata-identity"></a>[Internal projection metadata identity](invariants/shell-and-layout.md#internal-projection-metadata-identity)
- <a id="floating-material-ownership"></a>[Floating material ownership](invariants/shell-and-layout.md#floating-material-ownership)
- <a id="floating-sidebar-presentation-boundary"></a>[Floating sidebar presentation boundary](invariants/shell-and-layout.md#floating-sidebar-presentation-boundary)
- <a id="embedded-panel-host-presentation"></a>[Embedded panel host presentation](invariants/shell-and-layout.md#embedded-panel-host-presentation)
- <a id="shell-pane-ownership"></a>[Shell pane ownership](invariants/shell-and-layout.md#shell-pane-ownership)
- <a id="下游产品国内嵌入预览面板"></a>[下游产品国内嵌入预览面板](invariants/shell-and-layout.md#下游产品国内嵌入预览面板)
- <a id="shared-side-panel-glyphs"></a>[Shared side-panel glyphs](invariants/shell-and-layout.md#shared-side-panel-glyphs)
- <a id="header-首帧与浮动侧栏几何所有权"></a>[Header 首帧与浮动侧栏几何所有权](invariants/shell-and-layout.md#header-首帧与浮动侧栏几何所有权)
- <a id="受管站点品牌独立-web-外观与导航"></a>[受管站点品牌独立 Web 外观与导航](invariants/shell-and-layout.md#受管站点品牌独立-web-外观与导航)
- <a id="unified-shell-会话横向留白"></a>[Unified Shell 会话横向留白](invariants/shell-and-layout.md#unified-shell-会话横向留白)
- <a id="shared-floating-material"></a>[Shared floating material](invariants/shell-and-layout.md#shared-floating-material)
- <a id="right-panel-toolbar-divider-alignment"></a>[Right-panel toolbar divider alignment](invariants/shell-and-layout.md#right-panel-toolbar-divider-alignment)
- <a id="shell-right-panel-host-replacement-2026-10-19"></a>[Shell right-panel host replacement (2026-10-19)](invariants/shell-and-layout.md#shell-right-panel-host-replacement-2026-10-19)
- <a id="personal-toolbardock"></a>[Personal ToolbarDock](invariants/shell-and-layout.md#personal-toolbardock)

- <a id="ios-home-screen-edge-navigation"></a>[iOS Home Screen edge navigation](invariants/shell-and-layout.md#ios-home-screen-edge-navigation) — Runtime bridges reserved contacts to shared sidebar arbitration

- [Shared safe layout container](invariants/shell-and-layout.md#shared-safe-layout-container) — host-owned edge allocation, independent of sidebar mode

### Navigation and sidebar

- <a id="persistent-sidebar-control-beside-the-brand"></a>[Persistent sidebar control beside the brand](invariants/navigation-and-sidebar.md#persistent-sidebar-control-beside-the-brand)
- <a id="sidebar-server-filter-continuity"></a>[Sidebar Server filter continuity](invariants/navigation-and-sidebar.md#sidebar-server-filter-continuity)
- <a id="mobile-sidebar-theme-surface"></a>[Mobile Sidebar theme surface](invariants/navigation-and-sidebar.md#mobile-sidebar-theme-surface)
- <a id="sidebar-scroll-ownership"></a>[Sidebar scroll ownership](invariants/navigation-and-sidebar.md#sidebar-scroll-ownership)
- <a id="native-conversation-pinning"></a>[Native conversation pinning](invariants/navigation-and-sidebar.md#native-conversation-pinning)
- <a id="mobile-sidebar-gestures"></a>[Mobile sidebar gestures](invariants/navigation-and-sidebar.md#mobile-sidebar-gestures)
- <a id="unified-sidebar-scroll"></a>[Unified sidebar scroll](invariants/navigation-and-sidebar.md#unified-sidebar-scroll)
- <a id="application-navigation-restoration"></a>[Application navigation restoration](invariants/navigation-and-sidebar.md#application-navigation-restoration)
- <a id="application-navigation-glyphs"></a>[Application navigation glyphs](invariants/navigation-and-sidebar.md#application-navigation-glyphs)
- <a id="sidebar-折叠分组密度"></a>[Sidebar 折叠分组密度](invariants/navigation-and-sidebar.md#sidebar-折叠分组密度)
- <a id="sidebar-attention-and-read-receipts"></a>[Sidebar attention and read receipts](invariants/navigation-and-sidebar.md#sidebar-attention-and-read-receipts)
- <a id="thread-list-typography-2026-10-15"></a>[Thread list typography (2026-10-15)](invariants/navigation-and-sidebar.md#thread-list-typography-2026-10-15)
- <a id="small-screen-unified-sidebar-presentation-2026-10-15"></a>[Small-screen unified sidebar presentation (2026-10-15)](invariants/navigation-and-sidebar.md#small-screen-unified-sidebar-presentation-2026-10-15)
- <a id="sidebar-matching-results-continuation"></a>[Sidebar matching-results continuation](invariants/navigation-and-sidebar.md#sidebar-matching-results-continuation)
- <a id="desktop-navigation-surface-2026-10-15"></a>[Desktop navigation surface (2026-10-15)](invariants/navigation-and-sidebar.md#desktop-navigation-surface-2026-10-15)
- <a id="unified-navigation-conversation-search"></a>[Unified navigation conversation search](invariants/navigation-and-sidebar.md#unified-navigation-conversation-search)
- <a id="conversation-group-disclosures"></a>[Conversation group disclosures](invariants/navigation-and-sidebar.md#conversation-group-disclosures)
- <a id="consolidated-conversation-filters"></a>[Consolidated conversation filters](invariants/navigation-and-sidebar.md#consolidated-conversation-filters)
- <a id="navigation-preview-author-identity"></a>[Navigation preview author identity](invariants/navigation-and-sidebar.md#navigation-preview-author-identity)
- <a id="global-conversation-search"></a>[Global conversation search](invariants/navigation-and-sidebar.md#global-conversation-search)
- <a id="mobile-search-presentation"></a>[Mobile search presentation](invariants/navigation-and-sidebar.md#mobile-search-presentation)
- <a id="sidebar-rendering-ownership"></a>[Sidebar rendering ownership](invariants/navigation-and-sidebar.md#sidebar-rendering-ownership)
- <a id="sidebar-presentation-policy-ownership"></a>[Sidebar presentation policy ownership](invariants/navigation-and-sidebar.md#sidebar-presentation-policy-ownership)
- <a id="sidebar-menu-rendering-isolation"></a>[Sidebar menu rendering isolation](invariants/navigation-and-sidebar.md#sidebar-menu-rendering-isolation)
- <a id="sidebar-directory-grid-bounds"></a>[Sidebar directory grid bounds](invariants/navigation-and-sidebar.md#sidebar-directory-grid-bounds)
- <a id="sidebar-modal-target-membership"></a>[Sidebar modal target membership](invariants/navigation-and-sidebar.md#sidebar-modal-target-membership)
- <a id="saved-sidebar-directory-refresh-failures"></a>[Saved Sidebar directory refresh failures](invariants/navigation-and-sidebar.md#saved-sidebar-directory-refresh-failures)
- <a id="sidebar-metadata-badge-placement-2026-10-20"></a>[Sidebar metadata badge placement (2026-10-20)](invariants/navigation-and-sidebar.md#sidebar-metadata-badge-placement-2026-10-20)
- <a id="single-line-title-badge-placement-2026-10-21"></a>[Single-line title badge placement (2026-10-21)](invariants/navigation-and-sidebar.md#single-line-title-badge-placement-2026-10-21)
- <a id="single-line-title-badge-placement-2026-10-21-1"></a>[Single-line title badge placement (2026-10-21)](invariants/navigation-and-sidebar.md#single-line-title-badge-placement-2026-10-21)
- <a id="compact-title-accessory-conversation-rows"></a>[Compact title-accessory conversation rows](invariants/navigation-and-sidebar.md#compact-title-accessory-conversation-rows)
- <a id="offscreen-ordinary-navigation-rows"></a>[Offscreen ordinary navigation rows](invariants/navigation-and-sidebar.md#offscreen-ordinary-navigation-rows)
- <a id="single-line-title-badge-placement-2026-10-21-2"></a>[Single-line title badge placement (2026-10-21)](invariants/navigation-and-sidebar.md#single-line-title-badge-placement-2026-10-21)
- <a id="compact-title-accessory-conversation-rows-1"></a>[Compact title-accessory conversation rows](invariants/navigation-and-sidebar.md#compact-title-accessory-conversation-rows)
- <a id="touch-navigation-glass-groups"></a>[Touch navigation glass groups](invariants/navigation-and-sidebar.md#touch-navigation-glass-groups)

### Composer and input

- <a id="conversation-model-display-continuity"></a>[Conversation model display continuity](invariants/composer-and-input.md#conversation-model-display-continuity)
- <a id="composer-input-action-icons"></a>[Composer input action icons](invariants/composer-and-input.md#composer-input-action-icons)
- <a id="queued-message-authors"></a>[Queued-message authors](invariants/composer-and-input.md#queued-message-authors)
- <a id="queue-modified-enter-shortcut"></a>[Queue modified-Enter shortcut](invariants/composer-and-input.md#queue-modified-enter-shortcut)
- <a id="desktop-input-ownership"></a>[Desktop input ownership](invariants/composer-and-input.md#desktop-input-ownership)
- <a id="听写输入所有权"></a>[听写输入所有权](invariants/composer-and-input.md#听写输入所有权)
- <a id="floating-composer-ownership"></a>[Floating composer ownership](invariants/composer-and-input.md#floating-composer-ownership)
- <a id="mobile-keyboard-composer-budget"></a>[Mobile keyboard Composer budget](invariants/composer-and-input.md#mobile-keyboard-composer-budget)
- <a id="conversation-selection-quote-2026-10-15"></a>[Conversation selection quote (2026-10-15)](invariants/composer-and-input.md#conversation-selection-quote-2026-10-15)
- <a id="composer-attached-rail"></a>[Composer attached rail](invariants/composer-and-input.md#composer-attached-rail)
- <a id="touch-newera-composer"></a>[Touch Newera composer](invariants/composer-and-input.md#touch-newera-composer)
- <a id="reasoning-effort-discrete-slider"></a>[Reasoning effort discrete slider](invariants/composer-and-input.md#reasoning-effort-discrete-slider)
- <a id="common-workbench-keyboard-commands"></a>[Common workbench keyboard commands](invariants/composer-and-input.md#common-workbench-keyboard-commands)
- <a id="first-submit-presentation-continuity"></a>[First-submit presentation continuity](invariants/composer-and-input.md#first-submit-presentation-continuity)
- <a id="first-submit-thread-handoff"></a>[First-submit Thread handoff](invariants/composer-and-input.md#first-submit-thread-handoff)
- <a id="explicit-session-model-selection"></a>[Explicit session model selection](invariants/composer-and-input.md#explicit-session-model-selection)
- <a id="authorized-desktop-composer-entry"></a>[Authorized desktop Composer entry](invariants/composer-and-input.md#authorized-desktop-composer-entry)
- <a id="product-composer-desktop-entry"></a>[Product composer desktop entry](invariants/composer-and-input.md#product-composer-desktop-entry)
- <a id="composer-modeldepth-hierarchy"></a>[Composer model/depth hierarchy](invariants/composer-and-input.md#composer-modeldepth-hierarchy)
- <a id="touch-composer-content-geometry"></a>[Touch Composer content geometry](invariants/composer-and-input.md#touch-composer-content-geometry)
- <a id="engine-identity-in-model-selection"></a>[Engine identity in model selection](invariants/composer-and-input.md#engine-identity-in-model-selection)
- <a id="side-chat-slash-command"></a>[Side chat slash command](invariants/composer-and-input.md#side-chat-slash-command)
- <a id="inline-command-discovery"></a>[Inline command discovery](invariants/composer-and-input.md#inline-command-discovery)
- <a id="side-chat-model-display"></a>[Side chat model display](invariants/composer-and-input.md#side-chat-model-display)
- <a id="message-continuity-and-dictation-motion-preference"></a>[Message continuity and dictation motion preference](invariants/composer-and-input.md#message-continuity-and-dictation-motion-preference)
- <a id="new-conversation-follow-up-input"></a>[New conversation follow-up input](invariants/composer-and-input.md#new-conversation-follow-up-input)
- <a id="personal-speed-defaults-and-conversation-selections"></a>[Personal speed defaults and conversation selections](invariants/composer-and-input.md#personal-speed-defaults-and-conversation-selections)
- <a id="composer-warning-material"></a>[Composer warning material](invariants/composer-and-input.md#composer-warning-material)
- <a id="queue-admission-continuity"></a>[Queue admission continuity](invariants/composer-and-input.md#queue-admission-continuity)

### Conversation and history

- <a id="optional-conversation-overview"></a>[Optional conversation overview](invariants/conversation-and-history.md#optional-conversation-overview)
- <a id="user-message-sender-display"></a>[User message sender display](invariants/conversation-and-history.md#user-message-sender-display)
- <a id="conversation-recovery-feedback"></a>[Conversation recovery feedback](invariants/conversation-and-history.md#conversation-recovery-feedback)
- <a id="conversation-work-status-entry-motion"></a>[Conversation work-status entry motion](invariants/conversation-and-history.md#conversation-work-status-entry-motion)
- <a id="turn-completion-reminders"></a>[Turn completion reminders](invariants/conversation-and-history.md#turn-completion-reminders)
- <a id="conversation-loading-presentation"></a>[Conversation loading presentation](invariants/conversation-and-history.md#conversation-loading-presentation)
- <a id="会话生命周期补充2026-09-15"></a>[会话生命周期补充（2026-09-15）](invariants/conversation-and-history.md#会话生命周期补充2026-09-15)
- <a id="会话权限目录2026-09-26"></a>[会话权限目录（2026-09-26）](invariants/conversation-and-history.md#会话权限目录2026-09-26)
- <a id="会话顺序与展示分段2026-10-05"></a>[会话顺序与展示分段（2026-10-05）](invariants/conversation-and-history.md#会话顺序与展示分段2026-10-05)
- <a id="会话顶部信息"></a>[会话顶部信息](invariants/conversation-and-history.md#会话顶部信息)
- <a id="plugin-owned-conversation-participant-badges"></a>[Plugin-owned conversation participant badges](invariants/conversation-and-history.md#plugin-owned-conversation-participant-badges)
- <a id="conversation-overview-authority"></a>[Conversation overview authority](invariants/conversation-and-history.md#conversation-overview-authority)
- <a id="optional-statistics-loading"></a>[Optional statistics loading](invariants/conversation-and-history.md#optional-statistics-loading)
- <a id="shared-turn-follow-policy"></a>[Shared Turn follow policy](invariants/conversation-and-history.md#shared-turn-follow-policy)
- <a id="shared-history-backfill-ownership"></a>[Shared history backfill ownership](invariants/conversation-and-history.md#shared-history-backfill-ownership)
- <a id="conversation-presentation-contributions"></a>[Conversation presentation contributions](invariants/conversation-and-history.md#conversation-presentation-contributions)
- <a id="legacy-realtime-envelope-presentation"></a>[Legacy realtime envelope presentation](invariants/conversation-and-history.md#legacy-realtime-envelope-presentation)
- <a id="conversation-interaction-continuity"></a>[Conversation interaction continuity](invariants/conversation-and-history.md#conversation-interaction-continuity)
- <a id="conversation-references"></a>[Conversation references](invariants/conversation-and-history.md#conversation-references)
- <a id="retained-history-recovery-presentation"></a>[Retained-history recovery presentation](invariants/conversation-and-history.md#retained-history-recovery-presentation)
- <a id="conversation-top-spacing"></a>[Conversation top spacing](invariants/conversation-and-history.md#conversation-top-spacing)

### Activities and tools

- <a id="asynchronous-operation-feedback"></a>[Asynchronous operation feedback](invariants/activities-and-tools.md#asynchronous-operation-feedback)
- <a id="reasoning-presentation-work"></a>[Reasoning presentation work](invariants/activities-and-tools.md#reasoning-presentation-work)
- <a id="activity-icon-rendering"></a>[Activity icon rendering](invariants/activities-and-tools.md#activity-icon-rendering)
- <a id="activity-disclosure-layout-identity"></a>[Activity disclosure layout identity](invariants/activities-and-tools.md#activity-disclosure-layout-identity)
- <a id="mcp-app-客户端宿主"></a>[MCP App 客户端宿主](invariants/activities-and-tools.md#mcp-app-客户端宿主)
- <a id="dsh-goal-execution-projection"></a>[DSH Goal execution projection](invariants/activities-and-tools.md#dsh-goal-execution-projection)
- <a id="activity-group-disclosure-replacement-2026-10-19"></a>[Activity group disclosure replacement (2026-10-19)](invariants/activities-and-tools.md#activity-group-disclosure-replacement-2026-10-19)
- <a id="command-and-review-presentation-replacement-2026-10-20"></a>[Command and review presentation replacement (2026-10-20)](invariants/activities-and-tools.md#command-and-review-presentation-replacement-2026-10-20)
- <a id="tool-image-and-subagent-presentation-replacement-2026-10-20"></a>[Tool, image and subagent presentation replacement (2026-10-20)](invariants/activities-and-tools.md#tool-image-and-subagent-presentation-replacement-2026-10-20)
- <a id="thinking-tool-group-restoration"></a>[Thinking tool-group restoration](invariants/activities-and-tools.md#thinking-tool-group-restoration)
- <a id="activity-detail-motion"></a>[Activity detail motion](invariants/activities-and-tools.md#activity-detail-motion)
- <a id="async-operation-feedback"></a>[Async operation feedback](invariants/activities-and-tools.md#async-operation-feedback)

### Documents and resources

- <a id="image-preview-gestures"></a>[Image preview gestures](invariants/documents-and-resources.md#image-preview-gestures)
- <a id="link-label-action-ownership"></a>[Link label action ownership](invariants/documents-and-resources.md#link-label-action-ownership)
- <a id="图片附件呈现2026-09-27"></a>[图片附件呈现（2026-09-27）](invariants/documents-and-resources.md#图片附件呈现2026-09-27)
- <a id="markdown-文件预览"></a>[Markdown 文件预览](invariants/documents-and-resources.md#markdown-文件预览)
- <a id="通用媒体与-pdf-文件预览"></a>[通用媒体与 PDF 文件预览](invariants/documents-and-resources.md#通用媒体与-pdf-文件预览)
- <a id="chat-document-tracking-2026-10-15"></a>[Chat document tracking (2026-10-15)](invariants/documents-and-resources.md#chat-document-tracking-2026-10-15)
- <a id="files-entry-in-the-right-panel"></a>[Files entry in the right panel](invariants/documents-and-resources.md#files-entry-in-the-right-panel)
- <a id="markdown-table-scroll-ownership"></a>[Markdown table scroll ownership](invariants/documents-and-resources.md#markdown-table-scroll-ownership)
- <a id="mermaid-diagram-geometry-and-visual-presentation-2026-10-17"></a>[Mermaid diagram geometry and visual presentation (2026-10-17)](invariants/documents-and-resources.md#mermaid-diagram-geometry-and-visual-presentation-2026-10-17)
- <a id="read-only-file-preview-ownership"></a>[Read-only file preview ownership](invariants/documents-and-resources.md#read-only-file-preview-ownership)
- <a id="code-caption-paint-continuity-2026-10-21"></a>[Code caption paint continuity (2026-10-21)](invariants/documents-and-resources.md#code-caption-paint-continuity-2026-10-21)
- <a id="streamed-code-fence-continuity-2026-10-21"></a>[Streamed code fence continuity (2026-10-21)](invariants/documents-and-resources.md#streamed-code-fence-continuity-2026-10-21)
- <a id="streamed-code-fence-continuity-2026-10-21-1"></a>[Streamed code fence continuity (2026-10-21)](invariants/documents-and-resources.md#streamed-code-fence-continuity-2026-10-21)
- <a id="document-reading-controls"></a>[Document reading controls](invariants/documents-and-resources.md#document-reading-controls)
- <a id="optional-image-editor-transaction"></a>[Optional image editor transaction](invariants/documents-and-resources.md#optional-image-editor-transaction)

### Browser and desktop

- <a id="browser-生命周期不变量"></a>[Browser 生命周期不变量](invariants/browser-and-desktop.md#browser-生命周期不变量)
- <a id="existing-native-desktop-binding"></a>[Existing native desktop binding](invariants/browser-and-desktop.md#existing-native-desktop-binding)
- <a id="browser-capability-compatibility"></a>[Browser capability compatibility](invariants/browser-and-desktop.md#browser-capability-compatibility)
- <a id="browser-presentation-handoff-leases-2026-10-20"></a>[Browser presentation handoff leases (2026-10-20)](invariants/browser-and-desktop.md#browser-presentation-handoff-leases-2026-10-20)
- <a id="recessed-browser-reading-plane"></a>[Recessed browser reading plane](invariants/browser-and-desktop.md#recessed-browser-reading-plane)
- <a id="cloud-desktop-product-composition"></a>[Cloud desktop product composition](invariants/browser-and-desktop.md#cloud-desktop-product-composition)
- <a id="remote-browser-viewing-and-control"></a>[Remote browser viewing and control](invariants/browser-and-desktop.md#remote-browser-viewing-and-control)
- <a id="conversation-browser-resources"></a>[Conversation browser resources](invariants/browser-and-desktop.md#conversation-browser-resources)
- <a id="browser-backing-layout-and-aperture"></a>[Browser backing layout and aperture](invariants/browser-and-desktop.md#browser-backing-layout-and-aperture)

### Tasks and follow-up

- <a id="tasks-v1-editor-continuity"></a>[Tasks V1 editor continuity](invariants/tasks-and-follow-up.md#tasks-v1-editor-continuity)
- <a id="tasks-view"></a>[Tasks View](invariants/tasks-and-follow-up.md#tasks-view)
- <a id="tasks-type-badge-continuity"></a>[Tasks type badge continuity](invariants/tasks-and-follow-up.md#tasks-type-badge-continuity)
- <a id="tasks-action-hierarchy-and-recycle-continuity"></a>[Tasks action hierarchy and recycle continuity](invariants/tasks-and-follow-up.md#tasks-action-hierarchy-and-recycle-continuity)
- <a id="tasks-board-card-width"></a>[Tasks board card width](invariants/tasks-and-follow-up.md#tasks-board-card-width)
- <a id="tasks-whole-card-activation"></a>[Tasks whole-card activation](invariants/tasks-and-follow-up.md#tasks-whole-card-activation)
- <a id="tasks-card-action-visibility"></a>[Tasks card action visibility](invariants/tasks-and-follow-up.md#tasks-card-action-visibility)
- <a id="tasks-archive-retention"></a>[Tasks archive retention](invariants/tasks-and-follow-up.md#tasks-archive-retention)
- <a id="tasks-first-snapshot-boundary"></a>[Tasks first snapshot boundary](invariants/tasks-and-follow-up.md#tasks-first-snapshot-boundary)
- <a id="tasks-first-round-research-disposition"></a>[Tasks first-round research disposition](invariants/tasks-and-follow-up.md#tasks-first-round-research-disposition)
- <a id="tasks-morning-overview"></a>[Tasks morning overview](invariants/tasks-and-follow-up.md#tasks-morning-overview)
- <a id="ai-follow-up-cards-and-morning-separation"></a>[AI follow-up cards and Morning separation](invariants/tasks-and-follow-up.md#ai-follow-up-cards-and-morning-separation)
- <a id="tasks-first-round-research-disposition-1"></a>[Tasks first-round research disposition](invariants/tasks-and-follow-up.md#tasks-first-round-research-disposition)
- <a id="tasks-morning-overview-1"></a>[Tasks morning overview](invariants/tasks-and-follow-up.md#tasks-morning-overview)
- <a id="ai-follow-up-cards-and-morning-separation-1"></a>[AI follow-up cards and Morning separation](invariants/tasks-and-follow-up.md#ai-follow-up-cards-and-morning-separation)
- <a id="scheduled-task-workbench-entry"></a>[Scheduled task workbench entry](invariants/tasks-and-follow-up.md#scheduled-task-workbench-entry)
- <a id="conversation-task-linking-entrance"></a>[Conversation task linking entrance](invariants/tasks-and-follow-up.md#conversation-task-linking-entrance)
- <a id="scheduled-task-creation"></a>[Scheduled task creation](invariants/tasks-and-follow-up.md#scheduled-task-creation)
- <a id="board-navigation-copy"></a>[Board navigation copy](invariants/tasks-and-follow-up.md#board-navigation-copy)
- <a id="conversation-task-summary"></a>[Conversation task summary](invariants/tasks-and-follow-up.md#conversation-task-summary)

### Appearance and controls

- [Mobile paint and content boundaries](invariants/shell-and-layout.md#experimental-mobile-web-container) — full viewport backgrounds with safe-area content insets.
- [Window appearance projection](invariants/appearance-and-controls.md#window-appearance-projection) — theme intent, host/display mode, startup, standalone WebKit edge-color compatibility and native evidence boundaries.

- <a id="discrete-slider-fill"></a>[Discrete slider fill](invariants/appearance-and-controls.md#discrete-slider-fill)
- <a id="ui-图标共享视觉语言"></a>[UI 图标：共享视觉语言](invariants/appearance-and-controls.md#ui-图标共享视觉语言)
- <a id="ui-font-preference-2026-10-15"></a>[UI font preference (2026-10-15)](invariants/appearance-and-controls.md#ui-font-preference-2026-10-15)
- <a id="ui-type-1--semantic-typography-ownership"></a>[UI-TYPE-1 — Semantic typography ownership](invariants/appearance-and-controls.md#ui-type-1--semantic-typography-ownership)
- <a id="touch-newera-conversation-header"></a>[Touch Newera conversation header](invariants/appearance-and-controls.md#touch-newera-conversation-header)
- <a id="contribution-icon-authority"></a>[Contribution icon authority](invariants/appearance-and-controls.md#contribution-icon-authority)
- <a id="appearance-runtime-ownership"></a>[Appearance runtime ownership](invariants/appearance-and-controls.md#appearance-runtime-ownership)
- <a id="opencraft-built-in-theme-identity"></a>[OpenCraft built-in theme identity](invariants/appearance-and-controls.md#opencraft-built-in-theme-identity)
- <a id="input-dependent-hover-across-web-surfaces"></a>[Input-dependent hover across Web surfaces](invariants/appearance-and-controls.md#input-dependent-hover-across-web-surfaces)
- <a id="hover-policy-enforcement-2026-10-23"></a>[Hover policy enforcement (2026-10-23)](invariants/appearance-and-controls.md#hover-policy-enforcement-2026-10-23)

### Identity and connections

- <a id="employee-account-entrance"></a>[Employee account entrance](invariants/identity-and-connections.md#employee-account-entrance)
- <a id="ssh-connection-management"></a>[SSH connection management](invariants/identity-and-connections.md#ssh-connection-management)
- <a id="设置中的执行端归属"></a>[设置中的执行端归属](invariants/identity-and-connections.md#设置中的执行端归属)
- <a id="运行在work-in与机器分组"></a>[运行在（Work in）与机器分组](invariants/identity-and-connections.md#运行在work-in与机器分组)
- <a id="服务器更新范围与任务连续性"></a>[服务器更新范围与任务连续性](invariants/identity-and-connections.md#服务器更新范围与任务连续性)
- <a id="installed-plugins-in-settings"></a>[Installed plugins in Settings](invariants/identity-and-connections.md#installed-plugins-in-settings)
- <a id="hub-network-settings"></a>[Hub network settings](invariants/identity-and-connections.md#hub-network-settings)
- <a id="relay-server-selection-in-settings"></a>[Relay server selection in Settings](invariants/identity-and-connections.md#relay-server-selection-in-settings)
- <a id="account-display-identity"></a>[Account display identity](invariants/identity-and-connections.md#account-display-identity)

### Lifecycle and verification

- <a id="工作区契约"></a>[工作区契约](invariants/lifecycle-and-verification.md#工作区契约)
- <a id="证据纪律"></a>[证据纪律](invariants/lifecycle-and-verification.md#证据纪律)
- <a id="回迁后的固定嵌入与业务-sqlite"></a>[回迁后的固定嵌入与业务 SQLite](invariants/lifecycle-and-verification.md#回迁后的固定嵌入与业务-sqlite)
- <a id="presentation-power-ownership"></a>[Presentation power ownership](invariants/lifecycle-and-verification.md#presentation-power-ownership)
- <a id="startup-and-deferred-presentation"></a>[Startup and deferred presentation](invariants/lifecycle-and-verification.md#startup-and-deferred-presentation)
- <a id="shared-measurement-transaction-ownership"></a>[Shared measurement transaction ownership](invariants/lifecycle-and-verification.md#shared-measurement-transaction-ownership)

### Overhome desktop

Applications opens the [miniapp desktop](../docs/architecture/platform/shell-and-navigation.md#overhome-and-miniapps)
through the existing Router. Its grid consumes extension-owned launch declarations;
its route owns the scrollport, shared controls own focus/hover/touch feedback and
the shared icon owner supplies glyphs. Returning to Chat preserves its draft,
selection and running execution. The retired conversation-card overview and its
Appearance setting are absent; task-board statistics remain independent.
The shared desktop material spans Shell chrome and the moving mobile page.
Icon-to-window motion holds transient geometry, keeps outgoing surfaces inert,
and obeys the latest Router intent and reduced-motion setting; it cannot reset
a retained Chat or write another route/history state.

### Shared shell action material

Application navigation rows and compact rail destinations remain flat navigation
controls, without a per-item glass backdrop. Shared Shell button material must
not replace their quiet resting, hover and current-state treatment.

Shell buttons on Web/Electron and phone/tablet share the same liquid glass owner.
The optical enhancement retains the shared readable frost; mobile sidebar scroll
paint reaches the bottom while floating action hosts own its safe inset.
Only existing size/density/grouping differ; commands, placement, icons, labels and
focus remain with controls. Dialog/form/menu content buttons keep their semantic
surfaces. See [shared Shell material](../docs/workbench-design-language.md#shared-shell-action-material).


### PWA content and appearance allocation

Browser Shell SafeLayout allocates main-content top/bottom once inside the
measured visible canvas; it adds no canvas/client metric reserve. Composer routes retain ordinary gaps; independent
drawer/modal surfaces keep their own explicit edges. The generated early head
and live appearance projector share catalog, mode, document background and color
hints. See [Shell layout](invariants/shell-and-layout.md) and
[appearance](invariants/appearance-and-controls.md). Native status pixels still
require device acceptance.
