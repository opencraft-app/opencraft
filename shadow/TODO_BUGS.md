# TODO BUGS

## 手机号更新的一致性风险

- 状态：未修复
- 严重度：高
- 位置：
  - [internal/shadow/service.go](/Users/skipzhang/code/shadow/internal/shadow/service.go#L336)
  - 原版参考：[src/routes/user/v1/update-phone.ts](/Users/skipzhang/code/smhapi/src/routes/user/v1/update-phone.ts#L103)

### 现象

在影子账号修改手机号流程里，当前顺序是：

1. 先更新本地用户手机号和 binding
2. 再调用腾讯云 `UpdatePhoneByAuthCodeForSaaS`
3. 最后补写本地 `appid_phone_bindings`

如果第 2 步已经成功，但第 3 步失败，当前实现会把本地用户手机号回滚为旧值，但不会把腾讯云侧手机号回滚，最终导致：

- 腾讯云侧手机号是新值
- 本地 `user` / `binding` / `appid_phone_bindings` 可能仍是旧值

### 风险

- 本地和腾讯云侧手机号不一致
- 后续依赖 `appid_phone_bindings` 的短信校验或支付链路可能异常
- 用户再次修改手机号时，旧手机号和新手机号的归属关系会变得不确定

### 建议修复方向

- 优先方案：云侧成功后，如果本地补写失败，不回滚本地手机号，而是把 `appid_phone_bindings` 补写任务落到重试队列
- 备选方案：把“本地最终一致性修复”做成后台补偿任务
- 不建议：云侧成功后仅回滚本地状态，因为这会制造跨系统不一致
