# Lexical Composer 设计规格

## 1. 目标

本轮将 VelaChat 现有纯文本消息输入框替换为一个结构化 Composer，为 Channel 和 DM 提供一致的文字、Mention、附件和引用提交体验。

核心目标：

- Web 端使用 Lexical 编辑器，自然支持行内的结构化 Mention。
- Mention 面向当前会话的全部可用 Server 成员，包括自然人和 Agent。
- 用户看到的一次“发送”可同时包含文本、Mention 和多个附件。
- 底层仍只使用腾讯 IM 标准消息，腾讯 IM 仍是唯一消息真相源。
- 附件上传部分失败时，不提交最终 Mention 文本，不错误唤醒 Agent。

本轮不实现：

- `@所有人`。
- 平台后台聊天消息表或聊天事务协调。
- 腾讯多 Elem 私有协议或合并转发消息伪装。
- 客户端重启后恢复尚未上传的本地文件对象。
- 无关的时间线、Thread 或后台领域重构。

## 2. 视觉与交互

### 2.1 布局

- 桌面端 Composer 是会话底部居中的浮动容器，最大宽度 860px，使用完整圆角、边框和克制阴影。
- 移动端保留底部停靠的紧凑布局，避免浮动容器挤压可视高度。
- 文本编辑区在上，操作栏在下；发送按钮为右下角圆形箭头。
- 编辑区随内容增长，最大高度 200px，超过后内部滚动。
- 附件作为 Composer 内的暂存卡片显示，但不进入 Lexical 文档树。

### 2.2 键盘与 Mention

- 输入 `@` 后根据紧随文字过滤成员。
- 上下键移动候选，Enter 或 Tab 插入，Escape 关闭候选。
- 选中后插入原子、不可内部编辑的 Mention 节点。
- Backspace/Delete 一次删除相邻 Mention 节点。
- 未经候选列表选中的 `@名字` 只是普通文本，不产生腾讯 `atUserList`。
- 同一成员可在正文出现多次；发送时 `imUserId` 去重，可见文本不改写。
- 候选项用人类/Agent 标记区分主体类型。
- 中文输入法 composition 期间不提交、不抢占候选键。
- Enter 发送，Shift+Enter 换行。

### 2.3 发送时的界面状态

- 点击发送后，当前草稿立即冻结为 Submission，Composer 立即清空并可继续编辑下一条。
- 时间线显示一个乐观组合消息，附件可分别显示上传进度。
- 单个附件失败后组合消息进入“暂停”：已成功部分保留，失败部分可重试，最终文本尚未发送。
- 重试仅处理失败和未发送分片，不重复发送已确认分片。
- 取消暂停的 Submission 时，已发送的腾讯消息保留；未发送附件和最终文本被丢弃，Agent 不被唤醒。

## 3. 领域模型

### 3.1 Composer 文档

`client-core` 定义与 UI 框架无关的版本化文档：

```ts
type ComposerNode =
  | {type: "text"; text: string}
  | {
      type: "mention";
      id: string;
      memberId: string;
      memberKind: "human" | "agent";
      imUserId: string;
      displayName: string;
      handle: string;
    };

interface ComposerDocument {
  version: 1;
  nodes: ComposerNode[];
}
```

Mention 快照保存发送所需的稳定身份和显示文本。候选人只接受 `status=active` 、`imState=ready` 且具有非空 `imUserId` 的当前会话成员。

`ComposerDocument` 提供纯函数：

- 归一化相邻文本节点，删除空文本节点。
- 生成用户可见文本。
- 生成去重后的 `MessageMention[]`。
- 生成导航栏草稿预览。
- 在 Lexical JSON 与 ComposerDocument 之间稳定转换。

### 3.2 附件草稿

```ts
interface ComposerAttachmentDraft {
  id: string;
  kind: "image" | "file";
  source: AttachmentSource;
  name: string;
  mimeType?: string;
  size?: number;
  previewUri?: string;
}

interface ComposerDraft {
  document: ComposerDocument;
  attachments: ComposerAttachmentDraft[];
  quote?: MessageQuote;
}
```

- 每个会话最多 9 个待发附件。
- 图片单件最大 28MB，普通文件单件最大 100MB。
- 完全空的草稿不可发送；纯文本、纯附件、文字加附件都可发送。
- 草稿仍使用现有 `channel:<id>` / `direct:<memberId>` 会话键隔离。
- 切换会话保留草稿。本地附件的 File/URI 只存在当前应用进程；刷新页面或终止应用后不承诺恢复。

### 3.3 Submission

```ts
type SubmissionPartStatus =
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "cancelled";

interface ComposerSubmissionPart {
  clientRequestId: string;
  index: number;
  role: "attachment" | "commit";
  status: SubmissionPartStatus;
  messageId?: string;
  error?: string;
}

interface ComposerSubmission {
  id: string; // UUIDv7
  conversationKey: string;
  channel: ConversationAddress;
  document: ComposerDocument;
  attachments: ComposerAttachmentDraft[];
  quote?: MessageQuote;
  parts: ComposerSubmissionPart[];
  phase: "queued" | "sending" | "blocked" | "committed" | "cancelled";
}
```

Submission 是提交瞬间的不可变内容快照。执行状态与快照分离更新，不再回写 ComposerDraft。

## 4. 发送协调

### 4.1 分片计划

Submission Planner 是纯函数：

1. 为 Submission 生成 UUIDv7。
2. 按用户排列顺序为每个附件生成一个 `attachment` 分片和独立 `clientRequestId`。
3. 如文档存在可见内容，最后生成一个 `commit` 文本分片。
4. 纯附件 Submission 没有额外空文本；最后一个附件成功即代表提交完成。
5. 引用优先绑定最终文本；纯附件时绑定第一个附件。

### 4.2 队列语义

- Submission Coordinator 在应用层按会话维护 FIFO Worker。
- 同一会话的多个 Submission 严格顺序执行，不互相穿插。
- 不同会话的 Worker 可并行，避免一个大文件阻塞全局聊天。
- Worker 对分片串行调用现有 MessagingPort：附件使用 `sendAttachment`，最终文本使用 `sendText`。
- 任一附件失败后 Worker 停止当前 Submission，不调用最终 `sendText`。
- 只有最终 `sendText` 携带 Mention，因此 Agent 在所有附件可用后才可能被唤醒。
- 重试从第一个 `failed/queued` 分片继续，已为 `sent` 的分片保留原 `clientRequestId/messageId`。
- 队列是客户端进程内协调机制，不是新的持久消息队列或聊天真相源。

### 4.3 腾讯元数据

每个分片在 `cloudCustomData` 中写入：

```json
{
  "schema": "vela.composer-submission/v1",
  "clientRequestId": "<part uuidv7>",
  "submission": {
    "id": "<submission uuidv7>",
    "index": 0,
    "count": 3,
    "role": "attachment",
    "final": false
  }
}
```

- `count` 是实际腾讯消息分片数。
- 最后分片 `final=true`；有文本时其 `role=commit`，纯附件时其仍为 `attachment`。
- 现有 `quote` 和 `thread` 元数据保留，合并到同一个版本化 JSON 对象。
- 归一化器宽松读取未知字段。非法 submission 元数据只被忽略，消息本身仍正常展示。
- VelaChat 可根据该元数据把相邻分片视觉聚合为一组。其他腾讯 IM 客户端将看到标准的连续消息，功能可正常降级。

## 5. 组件边界

### 5.1 `client-core`

负责：

- `ComposerDocument` / `ComposerDraft` / `ComposerSubmission` 类型。
- 文档归一化、文本导出、Mention 导出和预览。
- Submission Planner 和分片元数据类型。
- MessagingPort 中面向人类/Agent 的通用 Mention 身份。

不依赖 React、Lexical 或腾讯 SDK。

### 5.2 Lexical 编辑器

负责：

- 将 ComposerDocument 渲染为 Lexical 状态。
- MentionNode、候选弹层、键盘导航、中文输入法和文档变更通知。
- Web 直接渲染 Lexical。Native 通过 Expo DOM 包装同一编辑器核心，不另建第二套文档语义。

不负责腾讯发送顺序或重试。

### 5.3 `MessageComposer`

负责：

- 编辑器、附件卡片、工具栏和发送按钮的组合。
- 附件选择、删除、限制校验和本地预览。
- 将草稿提交给应用层，不直接调用腾讯 SDK。

### 5.4 应用层 Submission Coordinator

负责：

- 冻结草稿、生成 Submission、维护每会话 FIFO Worker。
- 创建和更新乐观时间线状态。
- 串行发送分片，暂停、重试和取消。
- 不提供跨进程耐久性。

### 5.5 腾讯适配层

负责：

- 将通用 Mention 转换为 `atUserList`。
- 将 submission/quote/thread 元数据序列化到 `cloudCustomData`。
- 将历史和实时腾讯消息归一化，保留组合分片元数据。

## 6. 兼容与迁移

- 现有 `MessageMention.agentId` 迁移为通用 `memberId/memberKind`；适配层仅依赖 `imUserId/displayName`。
- 现有纯字符串 `conversationDrafts` 迁移为 `ComposerDraft` 映射。本产品尚未发布，不实现持久旧草稿迁移。
- 旧 `vela.client-message/v2` 和 `vela.thread-reply/v1` 仍可被归一化；新发送根据是否属于 Submission 选择新 schema。
- 不包含 submission 元数据的历史消息保持当前展示。

## 7. 错误语义

- 附件超数量或超单件大小：在进入草稿前拒绝，给出明确的本地提示。
- 附件源不可读：当前分片失败，Submission 暂停。
- 腾讯上传或发送失败：保留分片错误和已确认消息 ID，允许重试。
- 最终文本失败：附件已经在腾讯 IM 中存在，只重试最终文本，不重发附件。
- 应用被终止：尚未发送的本地分片不承诺恢复；重启后从腾讯历史恢复已成功分片，不伪造原子完成。
- 非法或未知元数据：忽略聚合信息，按普通单条消息展示，不导致会话中断。

## 8. 测试与验收

### 8.1 纯领域测试

- ComposerDocument 归一化、空白、多段文本、Mention 预览。
- Mention 身份保留、可见文本保留和 `imUserId` 去重。
- 纯文本、纯附件、混合 Submission 分片顺序、`final` 和引用绑定。
- 会话键隔离与草稿预览。

### 8.2 编辑器测试

- `@` 检索、上下键、Enter/Tab/Escape。
- Mention 原子删除、重复 Mention、普通 `@文本`。
- 中文输入法 composition 不触发提交。
- Enter 发送、Shift+Enter 换行、受控草稿外部切换。
- 附件数量/大小校验和删除。

### 8.3 协调器测试

- 附件严格先于最终文本发送。
- 附件失败后不调用最终文本。
- 重试不重发已成功分片，且复用 `clientRequestId`。
- 同会话 FIFO 不穿插，不同会话可并行。
- 取消失败 Submission 不发送最终文本。

### 8.4 腾讯适配测试

- 通用自然人/Agent Mention 都正确进入 `atUserList`。
- `cloudCustomData` 同时保留 submission、quote 和 thread。
- 新旧 schema、未知字段、非法 JSON 和非法 submission 的宽松读取。
- 实时消息和历史消息归一化结果一致。

### 8.5 集成门禁

- 现有客户端和 client-core 测试全部通过。
- TypeScript 类型检查通过。
- Web 生产构建通过。
- 凭据扫描通过。
- 桌面端浮动布局和移动端停靠布局通过人工视觉验收。

## 9. 实施顺序

1. 先在 `client-core` 用测试固化文档、Mention 和 Submission Planner。
2. 扩展 MessagingPort 和腾讯元数据归一化。
3. 在应用层实现 Submission Coordinator，替换附件即时发送。
4. 实现 Lexical 编辑器和 MentionNode，接入结构化草稿。
5. 完成浮动 Composer、附件卡片和时间线组合状态。
6. 执行全量验证和真实 Web 预览。
