# 第九轮：事件触发与有选择的通知

## 事件

EventTriggerService拥有触发规则、入站事件、匹配发生记录和文件观察基线。配置最多32条规则，以eventType和可选相对path精确匹配；目标由用户配置，事件payload作为不可信数据传入执行快照，不变成新的授权。

本地Unix socket/CLI的event-emit可以接入其他本机源；FileEventSource真实轮询当前已绑定资料根下显式监听的路径，每秒一次，沿原资料适配器限制相对路径、格式、大小和符号链接。首次观察只建立基线，修改/删除后触发；基线带版本持久化，重启间发生的变更也会发现，A→B→A→B不会被错误合并成同一事件。轮询不能保证捕获两次观察之间所有瞬时变更，不宣称是操作系统审计日志。

事件、匹配、子输入收据和工作创建同事务；稳定事件ID重复提交不再创建工作，不同payload复用ID拒绝。每条规则捕获创建时的资料binding；换根后不会继续观察新根或间接扩大旧规则委托。工作仍由原WorkService创建，Pi负责实际执行。禁用规则阻止未来匹配，已经创建的工作仍按原委托处理。

## 通知

WorkService捕获origin_json，包含direct/routine/event、来源key、notify和quietOrigin。修改工作保留原来源，重启不会丢静默属性。安排/事件默认never；可配置always或changed。需要通知的后台工作才关联主会话。

OutcomeService仍先完成原mailbox接受和工作结算，再由NotificationService选择主会话通知。direct结果沿原即时result消息；后台结果持久排队，250ms后按同一来源/会话合并，每条最多8个完成结果，正文单项6000字符，长内容标记截断，完整结果仍在工作详情和mailbox。不是把通知抑制当成执行或交付失败。

changed比较同一来源最近排队/已发结果的完整文本哈希，抑制完全相同内容；不是模型语义去重，改写措辞、产物路径变化可能被视为新结果。never不发主会话结果。队列按稳定delivery身份去重，主历史与sent标记同事务；重启只补通知，不重跑模型。直接交付重复接受也不会重复增加未读计数。

## 使用

```sh
node bin/assistant.mjs trigger-add --profile DIR --event-type file.changed --path project.md --text '检查项目变化并记录下一步' --notify changed
node bin/assistant.mjs trigger-list --profile DIR
node bin/assistant.mjs event-emit --profile DIR --event-type project.updated --data '{"project":"alpha"}' --id event-001
node bin/assistant.mjs trigger-enable --profile DIR --trigger TRIGGER_ID --revision 1 --enabled false
```

routine-add同样支持--notify never|always|changed。无外部Slack/飞书订阅、远程认证或自然语言创建规则的验收；当前是本地可运行源和显式命令配置。

schema7→8新增工作来源、安排策略、规则/事件/匹配/观察/通知表。event-notifications.test.mjs覆盖实际文件变化/重启/循环、真实CLI事件工作交付、事件去重、旧binding隔离、选择/合并、恢复及队列事务失败。初轮测试暴露通知SQL占位数错误，以及测试漏等异步笔记、模拟时间未推进；随后一次嵌套输入修改造成语法失败，均在evidence/phase9-\*原日志保留，修复后重验。
