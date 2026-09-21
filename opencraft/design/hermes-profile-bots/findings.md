# 所有权/隔离

- Host稳定身份(account,region,instance)，物理TAT/Dashboard只一份；profile不是新Host。
- 控制面(v1/instances/{id}/bots)返回BotID/ProfileID；profile main仅在adapter映射为native default，display name不作执行身份。
- AppServer bot目录对接native profiles.list；只暴露控制面与runtime一致的profile，不注入虚构default；旧runtime opt-in身份保留兼容。
- Bot/conversation绑定profile不可随UI选择改变；stored session→profile恢复由native索引/唯一查找决定。profile缺失/不支持明确拒绝；不全局activate profile。
- 新正式模式management false并在handler拒绝写操作，不能靠隐藏按钮拦profiles.create/delete；原有显式runtime test opt-in兼容。
- 消息/execution/profile恢复使用现有adapter；取消必须核对execution归属conversation，未知普通thread通知不投影为Bot事件。
- Ctl/前端仅作为当前契约事实参照，不改变其API/云资源；真实实例测试与本地替身分开。

## 恢复检查追加

- 冷 `activateProjection` 会在REST历史之后补入正在运行的Turn；Handler必须登记激活后的执行账本，否则返回了执行却无法取消。新增RED用例证实旧行为，现已修复。
- `profiles.list` 的canonical/last会话提示必须先整体校验，再发布到stored→profile索引；同一stored ID出现在两个profile或改变已绑定归属时fail-closed，不能采用最后一个profile。
- Canonical conversation和execution ID在单Host内有唯一归属；catalog可刷新资格/显示名，但不可迁移Bot的native route。取消仅允许原会话的当前active execution，不暂停另一个Bot的队列。
