# 临时：存量企业微信转发记录卡片

一次性运维工具，不接入请求入口、定时任务或消息重放。使用 Node26+ 从固定提交装配源码运行 `.mjs`；无需安装依赖。先预览，之后在现有发布锁和独立监督器下冷停 Gateway、备份、应用、启动验证；不要对运行中的 SQLite owner 直接写库。CLI 会拒绝仍运行的 Gateway 或未退出的原生 owner。

```sh
node SOURCE/products/join/scripts/backfill-wecom-forwarded-records.mjs \
  --db /private/opencraft-server.sqlite --journal-root /private/join-wecom-inbound-journal \
  --plan /private/forwarded-backfill-plan.json
# 以下仅在 Gateway 已停止并完成 owner 检查后：
node SOURCE/products/join/scripts/backfill-wecom-forwarded-records.mjs \
  --db /private/opencraft-server.sqlite --plan /private/forwarded-backfill-plan.json \
  --apply --backup-dir /private/new-backup-directory
# 同样要求冷停；仅删除本次 backup 回执证明新增且摘要仍匹配的附件：
node SOURCE/products/join/scripts/backfill-wecom-forwarded-records.mjs \
  --db /private/opencraft-server.sqlite --plan /private/forwarded-backfill-plan.json \
  --rollback --backup-dir /private/new-backup-directory
```

- 只处理明确属于 WeCom 外部消息、以旧版 `[聊天记录] ` 标题开头且无附件的记录，最多1000条，超限拒绝；已存在任何附件一律不覆盖。
- 如私有已接收日志仍有结构化记录，来源、外部ID、消息ID、原文、时间、原生去重指纹全部一致才恢复原始结构。冲突跳过，不降级掩盖冲突。
- 只有旧文本时，只恢复旧格式中的显示标签和分行，所有 sender.id 为空，不推算缺失年份，不冒充已验证身份，不凭资料编号猜测图片或文件。明确 partial 和历史文本恢复说明。缩进的续行保留文字，不误当新消息。原生原文永不改变。
- 只往既有 `actor_channel_attachments` 插入 JSON；不改变消息ID、顺序、原文、时间、成员、源绑定、去重指纹、助理历史、Redis或入站日志；不发送群消息、不触发助理。
- 应用前对每条消息做不可变快照 CAS；事务全有或全无。重复执行相同计划不重复插入，其他附件/消息改变则拒绝。回滚必须持有原备份回执，并只删除该次真正拥有的新增附件；二次空跑的回滚不会删除第一次的结果。
- 计划、备份、回执包含私有消息，必须留在0700目录/0600文件内，不提交源码。备份 DB/WAL/SHM 并验证 quick_check；客户端需刷新以重读存量附件。
- 旧版本没留下的XML、真实发送者ID、年份、附件原件不能由此脚本恢复。界面标签不授予任何权限。
