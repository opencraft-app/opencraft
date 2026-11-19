# 文件搜索资源生命周期修复

本次迁入源提交为内部 mono2 的
`f41a819022e1f7fb87a8611044384b1e573e2fec`，按独立仓库根路径适配共享实现、测试和设计说明。

- 打开文件面板只创建本地搜索句柄，首次非空查询才申请原生索引。
- 拒绝文件系统根目录、宽泛存储根及 Linux 内核/设备树。
- 清空查询或销毁 controller 时发送停止请求；启动晚到也必须释放会话。
- 查询更新串行执行，取消后不再因迟到的错误重新启动会话。
- 保持旧版 one-shot AppServer 兼容。

路径检查属于客户端资源保护，不能代替服务端真实路径校验或原生索引容量上限。
代码合入与运行版本更新分别验证，本次不发布 npm 或切换部署。

聚焦验证：`tests/chat/chat-appserver-fuzzy-file-search.test.ts` 和
`npm run typecheck --workspace @opencraft/composer-appserver`。
2026-11-11 在本内部发行版工作树验证：6项聚焦测试及该包类型检查均通过。
