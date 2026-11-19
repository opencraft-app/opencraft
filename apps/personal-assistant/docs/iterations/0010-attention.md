# 第十轮：无人关注的例行任务保护

AttentionService拥有一个持久关注状态，不拥有安排或工作。记录最近用户活动、显式打开会话、未查看结果通知数、例行触发次数、提醒、暂停和暂缓时间。RoutineService仍独占安排状态与发生记录。

本地conversation命令视为用户显式打开会话，清计数；模型的只读history/context查询不算用户查看，后台进度/推理不刷新关注。say和新建/恢复安排表示真实用户活动，取消等待中的暂停判断。这里是本地请求信号，不代表真正知道用户眼睛读过内容。

无人活动3天，且结果通知至少15条或例行触发至少20次，先提示一次；再过3天仍无活动，暂停所有active安排。提醒、暂停、原安排取消后续执行和主历史写入同事务；崩溃不会只记已提醒却丢消息。已发生的结果/副作用保留，不回放未知外部动作。

state跨重启保留；snooze可以暂缓检查，不能偷偷恢复已暂停任务。routine-resume由用户明确恢复单个paused安排，并检查到期/次数上限，产生新安排版本。保护只管例行安排，不自动关闭事件规则。

```sh
node bin/assistant.mjs attention-status --profile DIR
node bin/assistant.mjs attention-snooze --profile DIR --duration-ms 604800000
node bin/assistant.mjs routine-resume --profile DIR --routine ROUTINE_ID
```

schema8→9新增attention。attention.test.mjs以推进应用时钟验证提醒→重启→暂停、用户返回、查看/模型查询区别、暂缓到期及暂停事务失败回滚，无需等待现实六天。
