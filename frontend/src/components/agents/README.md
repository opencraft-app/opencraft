# Agents 展示组件

公开入口为 `@/components/agents`。组件只消费调用端传入的文案、受控值和 actions；不读取 Repository、账户 Context、token、路由或 SDK。请求、取消、身份判定、表单草稿和 pending 生命周期保留在功能 controller / 宿主页面。

| API | 用途与约束 |
| --- | --- |
| `AgentSection` | `title` 必填；可选 `description`、`actions`、`headingLevel={2 \| 3}`、`contentClassName`。标题为命名 section 提供可访问名称。 |
| `AgentToolbar` | `label` 必填，可选 `actions`；普通控件组，各控件保持原来的 Tab 顺序。 |
| `AgentField` | `label` 和 render-prop `children` 必填；可选 `description`、`error`、`required`、`controlId`。将生成的 `id`、描述和错误关联属性传到实际控件。 |
| `AgentState` | `kind="loading" \| "empty" \| "error" \| "success"`、`title` 必填；说明和单个主要 action 由调用端提供。无隐藏请求和自动重试。 |
| `AgentTooltip` | `content` 可选；`triggerMode="control"` 使用调用端已有的可聚焦控件，不增加 Tab 停靠点；默认 `explanation` 提供可聚焦解释容器，适用于禁用按钮和说明图标。内容始终通过带 `agents-ui` 标记的 Portal 渲染。 |
| `AgentConfirmDialog` | 受控 `open/onOpenChange`、文案和 `onConfirm`；`confirmDisabled` 与 `cancelDisabled` 分开，`confirmVariant="default" \| "destructive"`。不等待 Promise、不自行关闭；可传 `returnFocusRef` 或 `onCloseAutoFocus` 指定成功后的稳定目标。块级 `description` 通过 div 安全组合。 |
| `agentButtonClassName` / `agentFieldClassName` | 显式用于共享 Button/Input 的 Agents 外观；共享默认样式不变。 |
| `agentPanelClassName` | `DESIGN.md` 约定的圆角、边框和卡片阴影。 |
| `agentPortalClassName` | 稳定的 `agents-ui` 标记；本身不注入全局 CSS。宿主可组合自己的作用域 class。 |

```tsx
<AgentSection title={t("模型配置")} actions={<Button onClick={save}>...</Button>}>
  <AgentField label={t("模型名称")} error={nameError} required>
    {(field) => (
      <Input {...field} className={agentFieldClassName} value={name}
        onChange={(event) => setName(event.target.value)} />
    )}
  </AgentField>
</AgentSection>
```

## Radix 原语

直接从 `@/components/ui/dropdown-menu`、`alert-dialog`、`tooltip`、`checkbox`、`switch`、`sheet` 导入。保留 Radix 的受控 props、事件、ref 和 `asChild` 组合能力；Sheet 复用现有 Dialog 的 Root、Portal、Overlay 和 Close，`SheetContent.closeLabel` 必填。

新浮层的 Content 接受 `portalClassName`，将其直接加在 body Portal 中的 Content；AlertDialog / Sheet 同时加在 Overlay。需要下游作用域时显式传入，例如 `portalClassName={cn(agentPortalClassName, "consumer-scope")}`。CSS 必须覆盖浮层节点本身，不能只依赖页面祖先；新增 class 不会改变现有其他页面。

菜单的 `onSelect` 表示动作，`disabled` 会阻止选择。菜单打开 Dialog 时，宿主通过 `onCloseAutoFocus` 阻止菜单在卸载时抢回焦点，并在 Dialog 关闭后恢复到稳定触发器。可运行示例见 `../ui/__tests__/agents-primitives.test.tsx`。

## 异步确认

`AlertDialogAction` 保留 Radix 默认的同步关闭行为。需要由宿主控制关闭时机的动作先 `event.preventDefault()`，再发出原有 action。关闭时机沿用各功能原策略：例如模型删除成功才关、失败留窗；通道断开等待请求结束后关闭；高级设置先关确认再提交。下方代码仅展示宿主控制关闭的组合，不规定统一的异步政策。取消、Esc、遮罩、pending 禁用条件沿用原流程，不能由 UI 组件推断业务规则。

```tsx
<AlertDialog open={open} onOpenChange={onOpenChange}>
  <AlertDialogContent portalClassName={agentPortalClassName}
    onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }}>
    <AlertDialogHeader>
      <AlertDialogTitle>{title}</AlertDialogTitle>
      <AlertDialogDescription>{description}</AlertDialogDescription>
    </AlertDialogHeader>
    {error && <AgentState kind="error" title={error} />}
    <AlertDialogFooter>
      <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
      <AlertDialogAction disabled={pending || !canConfirm} onClick={(event) => {
        event.preventDefault();
        onConfirm(); // 宿主处理 Promise、失败反馈和最终 open 状态。
      }}>{pending ? pendingLabel : confirmLabel}</AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

`TooltipProvider` 可放在 Agents 宿主；默认保留 Radix 的 hover 缓冲与可 hover 内容，勿设置 `disableHoverableContent`。内容支持文本选择，键盘 focus 展示、Esc 关闭。禁用按钮无法获得焦点，需要说明时用 `TooltipTrigger asChild` 包含可聚焦、有可访问名称的解释容器，内部放 disabled button；勿增加点击业务动作。

依赖版本按现有 `@radix-ui/react-dialog@1.1.15` 的底层依赖组合锁定，避免为本批原语升级既有依赖。OpenCraft 等生成消费者必须使用标准同步脚本同步源码和新增直接依赖；本批没有修改生成物。

参考：[Radix AlertDialog 异步提交](https://www.radix-ui.com/primitives/docs/components/alert-dialog#close-after-asynchronous-form-submission)、[DropdownMenu](https://www.radix-ui.com/primitives/docs/components/dropdown-menu)、[Tooltip](https://www.radix-ui.com/primitives/docs/components/tooltip)。
