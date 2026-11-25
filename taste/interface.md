# 界面与跨端

业务对象有稳定标识，视图通过它读取共享状态。布局看容器可用空间，触控呈现看共享偏好与能力，当前交互反馈看输入方式。

**现有模型。** 触控呈现与触控交互是独立的读口，组合后才决定触控文本输入行为。

```ts
export function isTouchTextEntry(document: Document): boolean {
  return isTouchPresentation(document) && isTouchInteraction(document);
}
```

同样的边界适用于会话草稿和选区。会话草稿跟随会话标识保持可用，由渲染器订阅。焦点、选区和滚动按各自生命周期，在布局切换或视图恢复时由对应 owner 续接。异步响应应用前核对当前会话和交互是否仍匹配。

**如何验证。** 在实际入口写入草稿、选择文字，再切换布局或输入方式。观察草稿是否还在、焦点和选区是否合理恢复，并用迟到响应验证旧会话数据不会进入新会话。

现有参考见 [共享输入呈现](../packages/design-system-web/src/input-presentation.ts) 和 [会话草稿连续性测试](../tests/chat/conversation-draft-continuity.test.ts)。
