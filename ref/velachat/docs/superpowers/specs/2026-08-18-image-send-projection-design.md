# 图片发送投影收敛设计

## 问题

Composer 发送附件时会先插入本地占位消息。`SubmissionCoordinator` 虽然能收到
`MessagingPort.sendAttachment()` 返回的腾讯消息投影，却只记录 `messageId` 并把本地消息标记为已发送，
没有把返回消息中的图片 URL、缩略图和尺寸合并回 Store。因此页面会显示一个已发送但没有可渲染内容的
附件容器；刷新后从腾讯历史重新加载完整消息才恢复。

## 设计

保持腾讯云 IM 为消息权威来源，不增加平台聊天副本：

1. `AttachmentSource` 的 `platform-file` 分支增加可选 `previewUri`、`width`、`height`。Expo ImagePicker
   把 asset 的 `uri/width/height` 沿 `AttachmentSource -> ComposerAttachmentDraft -> ComposerSubmissionPart`
   传递；`optimisticAttachmentMessage()` 将这些字段写入 `ImageMessageContent`。
2. `SubmissionCoordinator` 增加 confirmed 消息投影和上传进度回调。附件上传进度变化、发送成功时，
   都通过同一个 `clientRequestId` 通知 Store；`retryMessage()` 或 reconciliation 成功得到消息时也复用
   同一 confirmed 合并路径。这里不新增 prepared 回调：现有 optimistic 投影已经覆盖上传阶段，避免扩大
   所有 MessagingPort 实现的接口面。
3. Store 收到 confirmed 投影后，用 `mergeMessages` 按 `clientRequestId` 原位替换本地消息；confirmed
   投影携带腾讯返回的 URL、缩略图和尺寸。这与官方 UIKit 的 create -> insert -> progress -> edit
   生命周期等价，不依赖发送方的 `MESSAGE_RECEIVED`。
4. 附件感知合并规则位于 Store 的投影合并边界：如果腾讯返回的图片投影暂时缺少 URL、缩略图或尺寸，
   则从同 `clientRequestId` 的既有 optimistic 图片内容保留这些字段；远端字段存在时始终优先。

## 错误与生命周期

- 上传失败保留同一消息与本地预览，并显示可重试状态。
- 不完整的 confirmed 投影不得删除已有的本地图片 URL 或尺寸。
- Object URL 若由客户端创建，必须在消息被远端 URL 替代或离开会话时释放；Expo picker 已提供 URI 时不额外创建。
- 文件消息沿用相同投影通道，但不强制图片尺寸语义。

## 验证

- Picker：Web `platform-file` 保留 preview URI 与图片尺寸。
- Coordinator：附件发送会发布 progress 和 confirmed 投影。
- Store：Composer 发送完成后，无需刷新即可看到 confirmed 图片 URL/尺寸，并且只保留一条同
  `clientRequestId` 消息。
- 回归：直接附件发送、失败重试、组合消息顺序和腾讯历史加载保持通过。
