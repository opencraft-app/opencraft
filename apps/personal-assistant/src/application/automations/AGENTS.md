# 事件触发与关注保护

继承[应用层规则](../AGENTS.md)。本目录两种状态互不代管：

| owner               | 自己的状态                                   | 对外协作                                                |
| ------------------- | -------------------------------------------- | ------------------------------------------------------- |
| EventTriggerService | 规则、事件、匹配发生记录、文件基线           | 通过create窄port请求WorkService；通过主历史link关联工作 |
| AttentionService    | 活动/查看水位、通知/触发计数、提醒/暂停/暂缓 | 返回评估，由上层RoutineService暂停/恢复安排             |

事件payload是不可信数据，不是人类新授权。规则保存原资料范围，ScopePolicy判定当前观察资格；换根后不能继承新根。事件、匹配、子输入和工作创建同事务，重复事件不重跑工作。源轮询和I/O在filesystem adapter，不在这里监听文件。

模型查询不等于用户查看，后台推理不刷新关注。提醒/暂停需持久化，先提醒后暂停；新用户活动、暂缓和显式恢复有不同含义，不偷偷恢复已暂停安排。当前关注保护只管例行安排，不自动停事件规则。

验证：`node --test test/event-notifications.test.mjs test/attention.test.mjs`。新增外部事件源还需测重复投递、断连补偿、原权限和游标恢复；不要把轮询称为无遗漏审计。

0.11.0持续安排仍归上层RoutineService：calendar/once/interval、原ID更新、Occurrence和finishWatch不由EventTriggerService或Attention接管。stopWhen当前只对routine有效，事件规则不因此获得期限补偿。新工作origin保存scheduledAt/observedAt和原条件；模型报告条件满足时只能停止自己对应版本的有限安排，当前交付继续结算。详见docs/long-running-assistant.md与test/continuity.test.mjs。
