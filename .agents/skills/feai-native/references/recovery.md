# 中断恢复

`ENGINE` 指本 skill 目录下的 `scripts/engine.mjs`（全局 `feai native <cmd>` 等价），命令在项目根执行。

**总原则：一律先 `status`，不要手改 `.workflow/native/` 下任何文件。**

`status` 只读（外加指针自愈）、不加锁，任何时候都安全。state.yaml / current.json / .lock 由引擎以原子写 + revision CAS + 锁维护；手改会破坏幂等指纹、revision 链与批准 hash，引擎按 fail-closed 处理（65/73），反而更难恢复。

## 场景表

| 场景 | 现象 | 恢复动作 |
|---|---|---|
| 崩溃于 next 前（命令未发出/未执行） | status 显示阶段未推进，无锁残留 | 按 continuation 重新执行即可 |
| 崩溃于 next 中（锁已拿、状态未写） | 重试报 73 锁冲突，`owner` 是已死进程 | 先 status 确认状态；**等锁释放**：同主机 + 进程已死 + 锁龄超 10 分钟，后续命令自动回收，之后重试 |
| 崩溃于 next 后（状态已写、响应没收到） | 不确定上次推进是否生效 | **同参数重发**：命中幂等重放，返回 `replayed: true` + 上次结果；不会二次推进、不重复计失败。凡 `replayed: true` 均非新推进（无论 phase 是否变化），即上次已生效 |
| 锁残留（.lock 未删） | next/archive 报 73 | 不要手删。引擎自动判定回收（条件同上）；不满足条件说明真有持有者在运行，等它结束 |
| 指针残留（archive 搬完目录、没来得及清指针） | current.json 指向已归档的 change | status 自愈：删指针，返回 `healed: true`，按无 active change 继续 |
| revision 冲突 | next 报 73「revision 不匹配」 | 重新 status 拿最新 revision，带 `--expect-revision <新值>` 重试；或去掉该参数直接重试 |
| 放弃 change（hard-stop 或需求确认废弃） | verify 累计 12 次失败触发 hard-stop（75 / `repair-hard-stop`），此时 new 报 65（active change 存在）、archive 报 65（非终步），引擎内无出口 | **唯一允许手工操作的场景**：必须先向用户确认放弃，再由用户明确决定后手工删除 `.workflow/native/changes/<name>/` 与 `.workflow/native/current.json`，之后 status 确认无 active change 再继续；引擎级 `abandon` 命令排入 v2 |

## 恢复检查清单

1. `node ENGINE status --json` —— 看 change / phase / revision / continuation。
2. 对照上表定位场景，按对应动作恢复。
3. 恢复后再次 `status` 确认，再按 continuation 继续正常流程。
