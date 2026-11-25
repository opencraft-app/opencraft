# 存储与运行时

存储 owner 管理提交顺序、事务、迁移和关闭。运行时通过领域操作调用它。把必须共同成立的更新交给一次提交，其他路径从已提交记录读取或重建投影。

**目标样例。** 等待结算与生成通知属于同一次存储提交，提交成功后才唤醒投递。

```ts
const result = await core.call.settleWaitAndQueueNotifications({
  waitId,
  observedOutcomes,
});

if (result.queuedNotifications > 0) {
  delivery.wake();
}
```

owner 在事务内读取当前状态，决定结算是否仍有效。未改变的状态无需持久化写入。Node Worker 与 Cloudflare DO 应复用领域提交语义，各自实现调用与生命周期边界。持久化结构由 owner 的迁移演进。

**如何验证。** 让通知写入失败，确认等待也未结算，重试只生成一批通知。用旧版数据库验收升级后数据与迁移记录仍在，篡改历史 checksum 后打开失败。对 Node 与 DO 的共同语义复用行为用例。

现有参考见 [Node 存储 owner](../apps/headless-server/src/server-core-worker.mjs)、[DO 存储 owner](../apps/headless-server/src/assembly/server-core-same-thread.ts) 和 [迁移测试](../tests/storage/server-storage.test.ts)。
