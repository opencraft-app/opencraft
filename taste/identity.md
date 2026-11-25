# 身份与权限

登录绑定识别登录来源。Human Actor 标识核心里的自然人。实例准入、空间成员资格和资源权限各有自己的作用域。代码在权威边界解析并校验外部声明，再用已验证的 Actor 和资源标识作授权决策。

**目标样例。** 一个成员变更在写入点用同一份身份验证上下文复核授权。提交前失效的请求由 owner 拒绝。

```ts
const identity = await sessions.requireVerifiedHuman(request);
const change = parseSpaceMembershipChange(input);

return spaceMembership.change({
  identity,
  spaceId: change.spaceId,
  memberActorId: change.memberActorId,
  role: change.role,
});
```

`change` 的调用边界保留操作者与被变更成员的区别。owner 决定实例准入和空间管理权限，复核仍然有效后提交。预检可以提前反馈，最终授权与写入使用同一份上下文。

**如何验证。** 同一人用两种已绑定登录看到同一份权限。只具备实例准入时，仍按空间规则决定资源访问。提交前撤销权限后，在途写入被拒绝。

现有参考见 [身份写入与提交复核](../packages/access-control/src/identity-writes.ts) 和 [身份与访问设计](../docs/architecture/platform/identity-and-access.md)。
