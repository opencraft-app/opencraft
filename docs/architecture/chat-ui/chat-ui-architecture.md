# ChatUI integration architecture

本页是架构入口。正式契约按职责归并在下列专题页中；实现状态、目标设计与验收限制保留在对应正文。修改行为时维护对应专题，避免继续在本页追加实现细节。

| 专题 | 范围 |
| --- | --- |
| [Architecture and acceptance](architecture-and-acceptance.md) | 架构边界、包归属、迁移状态与验收证据 |
| [Input delivery lifecycle](input-delivery-lifecycle.md) | 消息接收、执行采用、停止处置与回执恢复 |
| [Composer and drafts](composer-and-drafts.md) | 输入草稿、发送交接、移动输入与附件编辑 |
| [History and recovery](history-and-recovery.md) | 历史分页、恢复、会话连续性与持有的视口 |
| [Navigation and catalog](navigation-and-catalog.md) | 侧栏目录、会话行、导航与筛选状态 |
| [Activities and tools](activities-and-tools.md) | 活动折叠、工具详情、命令与子任务呈现 |
| [Questions and interactions](questions-and-interactions.md) | 异步提问、审批、输入草稿与键盘所有权 |
| [Documents and reading](documents-and-reading.md) | 流式文档、Markdown、时间与内容呈现 |
| [Files and resources](files-and-resources.md) | 文件差异、图片、资源列表与阅读位置 |

## 章节索引

下列旧章节锚点继续有效；仓库内的精确章节链接直接指向专题正文。

### Architecture and acceptance

- <a id="target"></a>[Target](architecture-and-acceptance.md#target)
- <a id="non-negotiable-boundaries"></a>[Non-negotiable boundaries](architecture-and-acceptance.md#non-negotiable-boundaries)
- <a id="package-ownership"></a>[Package ownership](architecture-and-acceptance.md#package-ownership)
- <a id="current-migration-ledger"></a>[Current migration ledger](architecture-and-acceptance.md#current-migration-ledger)
- <a id="established"></a>[Established](architecture-and-acceptance.md#established)
- <a id="compatibility-boundary"></a>[Compatibility boundary](architecture-and-acceptance.md#compatibility-boundary)
- <a id="production-hardening-not-architecture-blockers"></a>[Production hardening, not architecture blockers](architecture-and-acceptance.md#production-hardening-not-architecture-blockers)
- <a id="evidence-required-for-completion"></a>[Evidence required for completion](architecture-and-acceptance.md#evidence-required-for-completion)
- <a id="owned-projection-metadata-identity"></a>[Owned projection metadata identity](architecture-and-acceptance.md#owned-projection-metadata-identity)

### Composer and drafts

- <a id="browser-reconnect-outbox"></a>[Browser reconnect outbox](composer-and-drafts.md#browser-reconnect-outbox)
- <a id="browser-local-input-drafts"></a>[Browser-local input drafts](composer-and-drafts.md#browser-local-input-drafts)
- <a id="跨桌面手机和平板的会话连续性"></a>[跨桌面、手机和平板的会话连续性](composer-and-drafts.md#跨桌面手机和平板的会话连续性)
- <a id="outgoing-message-handoff"></a>[Outgoing message handoff](composer-and-drafts.md#outgoing-message-handoff)
- <a id="embedded-submission-and-recovery"></a>[Embedded submission and recovery](composer-and-drafts.md#embedded-submission-and-recovery)
- <a id="native-composer-input-boundary"></a>[Native Composer input boundary](composer-and-drafts.md#native-composer-input-boundary)
- <a id="composer-material-and-native-caret"></a>[Composer material and native caret](composer-and-drafts.md#composer-material-and-native-caret)
- <a id="mobile-viewport-diagnostic-measurement-budget"></a>[Mobile viewport diagnostic measurement budget](composer-and-drafts.md#mobile-viewport-diagnostic-measurement-budget)
- <a id="mobile-composer-content-bounds"></a>[Mobile Composer content bounds](composer-and-drafts.md#mobile-composer-content-bounds)
- <a id="first-submit-pending-conversation"></a>[First-submit pending conversation](composer-and-drafts.md#first-submit-pending-conversation)
- <a id="first-submit-thread-handoff"></a>[First-submit Thread handoff](composer-and-drafts.md#first-submit-thread-handoff)
- <a id="product-desktop-composer-shortcut"></a>[Product desktop composer shortcut](composer-and-drafts.md#product-desktop-composer-shortcut)
- <a id="owned-composer-naming"></a>[Owned Composer naming](composer-and-drafts.md#owned-composer-naming)
- <a id="pasted-multiline-json"></a>[Pasted multiline JSON](composer-and-drafts.md#pasted-multiline-json)
- <a id="initial-user-echoes-and-explicit-steering-acknowledgements"></a>[Initial user echoes and explicit steering acknowledgements](composer-and-drafts.md#initial-user-echoes-and-explicit-steering-acknowledgements)
- <a id="composer-model-menu-close-continuity"></a>[Composer model menu close continuity](composer-and-drafts.md#composer-model-menu-close-continuity)
- <a id="composer-connection-warning-material"></a>[Composer connection warning material](composer-and-drafts.md#composer-connection-warning-material)
- <a id="composer-execution-material-feedback"></a>[Composer execution material feedback](composer-and-drafts.md#composer-execution-material-feedback)
- <a id="inherited-fast-status-in-compact-input"></a>[Inherited Fast status in compact input](composer-and-drafts.md#inherited-fast-status-in-compact-input)
- <a id="new-conversation-submission-presentation"></a>[New conversation submission presentation](composer-and-drafts.md#new-conversation-submission-presentation)
- <a id="composer-image-attachment-preview"></a>[Composer image attachment preview](composer-and-drafts.md#composer-image-attachment-preview)
- <a id="optional-browser-image-editing"></a>[Optional browser image editing](composer-and-drafts.md#optional-browser-image-editing)

### History and recovery

- <a id="shared-history-backfill-coordinator"></a>[Shared history backfill coordinator](history-and-recovery.md#shared-history-backfill-coordinator)
- <a id="shared-turn-measurement-transactions"></a>[Shared Turn measurement transactions](history-and-recovery.md#shared-turn-measurement-transactions)
- <a id="initial-history-and-display-reuse"></a>[Initial history and display reuse](history-and-recovery.md#initial-history-and-display-reuse)
- <a id="history-positions-and-concurrent-observations"></a>[History positions and concurrent observations](history-and-recovery.md#history-positions-and-concurrent-observations)
- <a id="turn-identity-handoff-and-mounted-window"></a>[Turn identity handoff and mounted window](history-and-recovery.md#turn-identity-handoff-and-mounted-window)
- <a id="restored-baseline-versus-live-entry-motion"></a>[Restored baseline versus live entry motion](history-and-recovery.md#restored-baseline-versus-live-entry-motion)
- <a id="server-owned-native-codex-history"></a><a id="durable-host-legacy-history"></a>[Durable Host legacy history](history-and-recovery.md#durable-host-legacy-history)
- <a id="bounded-history-recovery"></a>[Bounded history recovery](history-and-recovery.md#bounded-history-recovery)
- <a id="recovery-technical-details"></a>[Recovery technical details](history-and-recovery.md#recovery-technical-details)
- <a id="external-conversation-presentation-and-history-reads"></a>[External conversation presentation and history reads](history-and-recovery.md#external-conversation-presentation-and-history-reads)
- <a id="in-progress-recovery-observations"></a>[In-progress recovery observations](history-and-recovery.md#in-progress-recovery-observations)
- <a id="recovery-correlation-and-socket-liveness"></a>[Recovery correlation and socket liveness](history-and-recovery.md#recovery-correlation-and-socket-liveness)
- <a id="legacy-realtime-envelope-presentation"></a>[Legacy realtime envelope presentation](history-and-recovery.md#legacy-realtime-envelope-presentation)
- <a id="mcp-app-widget-state-continuity"></a>[MCP App widget state continuity](history-and-recovery.md#mcp-app-widget-state-continuity)
- <a id="retained-history-recovery-presentation"></a>[Retained-history recovery presentation](history-and-recovery.md#retained-history-recovery-presentation)
- <a id="history-loading-space"></a>[History loading space](history-and-recovery.md#history-loading-space)
- <a id="archived-and-missing-conversation-restoration"></a>[Archived and missing conversation restoration](history-and-recovery.md#archived-and-missing-conversation-restoration)
- <a id="retained-web-viewport-measurements"></a>[Retained Web viewport measurements](history-and-recovery.md#retained-web-viewport-measurements)

### Navigation and catalog

- <a id="sidebar-goal-reads-on-multi-engine-hosts"></a>[Sidebar Goal reads on multi-engine Hosts](navigation-and-catalog.md#sidebar-goal-reads-on-multi-engine-hosts)
- <a id="thread-goals"></a>[Thread goals](navigation-and-catalog.md#thread-goals)
- <a id="product-thread-badge-slot"></a>[Product Thread badge slot](navigation-and-catalog.md#product-thread-badge-slot)
- <a id="sidebar-catalog-lifecycle-and-row-metadata"></a>[Sidebar catalog lifecycle and row metadata](navigation-and-catalog.md#sidebar-catalog-lifecycle-and-row-metadata)
- <a id="navigation-preview-author"></a>[Navigation preview author](navigation-and-catalog.md#navigation-preview-author)
- <a id="sidebar-directory-track-bounds"></a>[Sidebar directory track bounds](navigation-and-catalog.md#sidebar-directory-track-bounds)
- <a id="sidebar-action-target-lifetime"></a>[Sidebar action target lifetime](navigation-and-catalog.md#sidebar-action-target-lifetime)
- <a id="conversation-group-heading-continuity"></a>[Conversation group heading continuity](navigation-and-catalog.md#conversation-group-heading-continuity)
- <a id="conversation-list-display-context"></a>[Conversation list display context](navigation-and-catalog.md#conversation-list-display-context)
- <a id="personal-header-toolbardock"></a>[Personal header ToolbarDock](navigation-and-catalog.md#personal-header-toolbardock)
- <a id="optional-conversation-summary"></a>[Optional conversation summary](navigation-and-catalog.md#optional-conversation-summary)

### Activities and tools

- <a id="activity-closure-and-disclosure-authority"></a>[Activity closure and disclosure authority](activities-and-tools.md#activity-closure-and-disclosure-authority)
- <a id="returned-thinking-content"></a>[Returned thinking content](activities-and-tools.md#returned-thinking-content)
- <a id="disclosure-scroll-anchor-lifetime"></a>[Disclosure scroll anchor lifetime](activities-and-tools.md#disclosure-scroll-anchor-lifetime)
- <a id="subagent-detail-continuity"></a>[Subagent detail continuity](activities-and-tools.md#subagent-detail-continuity)
- <a id="command-elapsed-presentation"></a>[Command elapsed presentation](activities-and-tools.md#command-elapsed-presentation)
- <a id="activity-disclosure-spacing-ownership"></a>[Activity disclosure spacing ownership](activities-and-tools.md#activity-disclosure-spacing-ownership)
- <a id="conversation-process-visual-ownership"></a>[Conversation process visual ownership](activities-and-tools.md#conversation-process-visual-ownership)
- <a id="web-search-activity-detail-projection"></a>[Web search activity detail projection](activities-and-tools.md#web-search-activity-detail-projection)
- <a id="tool-detail-choices-in-a-retained-view"></a>[Tool detail choices in a retained View](activities-and-tools.md#tool-detail-choices-in-a-retained-view)
- <a id="host-owned-tool-details"></a>[Host-owned tool details](activities-and-tools.md#host-owned-tool-details)
- <a id="delayed-command-completion-placement"></a>[Delayed command completion placement](activities-and-tools.md#delayed-command-completion-placement)
- <a id="live-tool-disclosure-state"></a>[Live tool disclosure state](activities-and-tools.md#live-tool-disclosure-state)
- <a id="tool-detail-choices-in-a-retained-view-1"></a>[Tool detail choices in a retained View](activities-and-tools.md#tool-detail-choices-in-a-retained-view-1)
- <a id="live-turn-resource-entry-motion"></a>[Live Turn resource entry motion](activities-and-tools.md#live-turn-resource-entry-motion)
- <a id="command-log-reading-continuity"></a>[Command log reading continuity](activities-and-tools.md#command-log-reading-continuity)
- <a id="subagent-lifecycle-notices"></a>[Subagent lifecycle notices](activities-and-tools.md#subagent-lifecycle-notices)
- <a id="subagent-summary-density"></a>[Subagent summary density](activities-and-tools.md#subagent-summary-density)
- <a id="host-owned-tool-details-1"></a>[Host-owned tool details](activities-and-tools.md#host-owned-tool-details-1)
- <a id="display-selection-and-provenance"></a>[Display selection and provenance](activities-and-tools.md#display-selection-and-provenance)
- <a id="website-tool-call-details"></a>[Website tool call details](activities-and-tools.md#website-tool-call-details)
- <a id="approval-reviews-on-tools-without-results"></a>[Approval reviews on tools without results](activities-and-tools.md#approval-reviews-on-tools-without-results)
- <a id="raw-tool-result-facts"></a>[Raw tool result facts](activities-and-tools.md#raw-tool-result-facts)
- <a id="message-footer-time-disclosure"></a>[Message footer time disclosure](activities-and-tools.md#message-footer-time-disclosure)
- <a id="details-arriving-in-a-mounted-activity-row"></a>[Details arriving in a mounted activity row](activities-and-tools.md#details-arriving-in-a-mounted-activity-row)
- <a id="command-result-language"></a>[Command result language](activities-and-tools.md#command-result-language)

### Questions and interactions

- <a id="mcp-elicitation-presentation"></a>[MCP elicitation presentation](questions-and-interactions.md#mcp-elicitation-presentation)
- <a id="agent-originated-async-questions"></a>[Agent-originated async questions](questions-and-interactions.md#agent-originated-async-questions)
- <a id="hermes-direct-approval-ownership"></a>[Hermes direct approval ownership](questions-and-interactions.md#hermes-direct-approval-ownership)
- <a id="mcp-approval-multiline-parameters"></a>[MCP approval multiline parameters](questions-and-interactions.md#mcp-approval-multiline-parameters)
- <a id="blocking-question-input-continuity"></a>[Blocking question input continuity](questions-and-interactions.md#blocking-question-input-continuity)
- <a id="question-keyboard-composition"></a>[Question keyboard composition](questions-and-interactions.md#question-keyboard-composition)
- <a id="pending-interaction-recovery-motion"></a>[Pending interaction recovery motion](questions-and-interactions.md#pending-interaction-recovery-motion)
- <a id="pending-interaction-draft-recovery"></a>[Pending interaction draft recovery](questions-and-interactions.md#pending-interaction-draft-recovery)
- <a id="mcp-approval-keyboard-ownership"></a>[MCP approval keyboard ownership](questions-and-interactions.md#mcp-approval-keyboard-ownership)
- <a id="setup-interaction-drafts"></a>[Setup interaction drafts](questions-and-interactions.md#setup-interaction-drafts)
- <a id="asynchronous-question-cards"></a>[Asynchronous question cards](questions-and-interactions.md#asynchronous-question-cards)

### Documents and reading

- <a id="inline-link-label-construction"></a>[Inline link label construction](documents-and-reading.md#inline-link-label-construction)
- <a id="trusted-web-renderer-composition"></a>[Trusted Web renderer composition](documents-and-reading.md#trusted-web-renderer-composition)
- <a id="message-timestamp-presentation"></a>[Message timestamp presentation](documents-and-reading.md#message-timestamp-presentation)
- <a id="user-message-copy-action"></a>[User message copy action](documents-and-reading.md#user-message-copy-action)
- <a id="user-message-sender-display"></a>[User message sender display](documents-and-reading.md#user-message-sender-display)
- <a id="queued-message-sender-display"></a>[Queued-message sender display](documents-and-reading.md#queued-message-sender-display)
- <a id="streaming-projection-and-document-reuse"></a>[Streaming projection and document reuse](documents-and-reading.md#streaming-projection-and-document-reuse)
- <a id="user-message-code-block-sizing"></a>[User message code-block sizing](documents-and-reading.md#user-message-code-block-sizing)
- <a id="conversation-content-search-deadlines"></a>[Conversation content search deadlines](documents-and-reading.md#conversation-content-search-deadlines)
- <a id="code-language-labels"></a>[Code language labels](documents-and-reading.md#code-language-labels)
- <a id="skill-display-names"></a>[Skill display names](documents-and-reading.md#skill-display-names)
- <a id="skill-and-hook-presentation-compatibility"></a>[Skill and Hook presentation compatibility](documents-and-reading.md#skill-and-hook-presentation-compatibility)
- <a id="relational-style-invalidation-during-editing"></a>[Relational style invalidation during editing](documents-and-reading.md#relational-style-invalidation-during-editing)
- <a id="code-text-selection"></a>[Code text selection](documents-and-reading.md#code-text-selection)
- <a id="conversation-reference-copy-feedback"></a>[Conversation reference copy feedback](documents-and-reading.md#conversation-reference-copy-feedback)

### Files and resources

- <a id="changed-file-review"></a>[Changed-file review](files-and-resources.md#changed-file-review)
- <a id="image-and-plan-reading-continuity"></a>[Image and plan reading continuity](files-and-resources.md#image-and-plan-reading-continuity)
- <a id="browser-image-attachment-presentation"></a>[Browser image attachment presentation](files-and-resources.md#browser-image-attachment-presentation)
- <a id="selection-add-to-chat"></a>[Selection Add to chat](files-and-resources.md#selection-add-to-chat)
- <a id="turn-file-list-choices-in-a-retained-view"></a>[Turn file-list choices in a retained View](files-and-resources.md#turn-file-list-choices-in-a-retained-view)
- <a id="diff-reader-position-in-a-retained-view"></a>[Diff reader position in a retained View](files-and-resources.md#diff-reader-position-in-a-retained-view)
- <a id="reading-expanded-file-diffs-in-a-retained-view"></a>[Reading expanded file diffs in a retained View](files-and-resources.md#reading-expanded-file-diffs-in-a-retained-view)
- <a id="code-and-table-reading-positions-in-a-retained-view"></a>[Code and table reading positions in a retained View](files-and-resources.md#code-and-table-reading-positions-in-a-retained-view)
- <a id="plan-preview-natural-height"></a>[Plan preview natural height](files-and-resources.md#plan-preview-natural-height)

### Recovered native Turn activity

Native history may retain `inProgress` for a Turn whose process ended. Shared
Chat Runtime projects that historical Turn as interrupted only after an
authoritative history proves a later Turn exists. Thread status arrives on an
independent stream: even an authoritative `idle` / `notLoaded` notification can
predate a new Turn start, so it cannot end the latest Turn. A cached status or a
lost connection cannot interrupt remote work. The latest genuinely active Turn remains active. This projection
removes automatic-retry indicators from the recovered historical Turn without
changing native history, sending an interrupt, or claiming this client stopped it.
Composer and all timeline consumers use this same projection so an old status
cannot leave the Stop action or working indicator active after later work ends.

### Read before execution

Opening or reconnecting a persisted conversation reads its native history; it
must not Resume, register execution tools, or claim interaction ownership.
`ThreadResumeCoordinatorService.read` owns the read baseline and older pages.
`resumeState` remains `needs_resume` until an explicit send or continuation
resumes execution. History authority and execution readiness are independent.
The shared Workbench command boundary waits for the read baseline, then Resume
and capability registration before admitting an execution write. Temporary fork
streams retain their existing adopted ownership.

Codex, DSH and Pi Hosts advertise `opencraft/read-history` v1 for a metadata read with an
`initialTurnsPage` of ten full native Turns. The disposable transcript cache
preserves the native full-items wire contract, including cold output bodies;
no UI is told that reading grants execution. See the
[Stage 0 design](../../../design/thread-orchestration-spec.md) and
[cache lifecycle](../server/sqlite-lifecycle.md#transcript-read-cache).

Older native paginators that ignore `itemsView=full` use the existing Item-page
reader to hydrate their Turns without Resume. A passive history subscription can
observe already-running Turns; it cannot answer platform tools or retain an
execution lease. Sending or continuing still acquires execution ownership first.

Read buffers notifications while the canonical baseline is loading. Native snapshots
and additive deltas have no common sequence. If a delta overlaps a read, the
coordinator supersedes those notifications with another read and obtains a quiet
cut before releasing the buffer; the existing request timeout bounds continuous
churn. It never appends an ambiguous delta to a snapshot that may include it.
Oversized full windows and older pages fall back to headers plus adaptive Item
pages, retaining their native cursor and the lossless full-body result.

Message-window providers without `opencraft/read-history` v1 retain their
existing Resume bootstrap, early REST preview and history retry semantics.
Metadata-only `thread/read` does not imply that this provider can bootstrap a
window without Resume. Explicit read-history support opts that provider into
read-only opening; Codex paging remains read-only without requiring this legacy
message-window handshake.

### Recovery placeholder shimmer

The App projects active connection/history recovery through `placeholderPending` on
both draft and conversation composers. The placeholder plugin decorates only the
empty editable paragraph; generated highlight copy adds no editor widget or caret
boundary. Motion consumes `recoveryPlaceholderShimmerMotion` cadence (2s sweep, 3s cycle), leaves readable base text,
and disappears with content, completed/terminal recovery, reduced motion or forced
colors. The normal follow-up placeholder remains static. No recovery state, input
admission or Draft ownership changes.

The placeholder highlight travels two text widths per sweep; excess offscreen
travel must not compress the visible sweep into a short flash. Execution activity
text retains its independent working cadence.

## 会话时间线所有权

- Conversation 中“执行轮次”与“展示分段”不是同一所有权：一个 Turn 可以包含异步提问、多次回答与 Steer，必须按原顺序投影连续片段，不能将用户消息、回答和工作记录分别全局收集后重排。折叠只改变片段可见性；异步提问不因原生 final phase 获得最终回答资格。顺序、片段身份和当前响应判定归共享 `chat-core`，Web/Native 不各自补排序。执行状态与总用时仍只有一个 Turn owner，Thinking 最多一个当前 owner；测试必须覆盖同轮次多次跟进、折叠、补历史、刷新和流式 DOM 身份。
- Codex Bridge 在实时消息、检查点和流结束事件中保留原生的消息阶段与异步投递标记。进度消息进入工作区段，最终回答和异步提问按自己的语义呈现。
- Bridge 实时投影沿用 AppServer 时间线契约，保留异步提问选项、命令动作和终端输入、推理分段索引，以及上下文压缩、搜索、子 Agent 和 Hook 条目。
