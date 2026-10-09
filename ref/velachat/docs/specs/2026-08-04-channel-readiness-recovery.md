# Channel 就绪自动恢复

## 背景

用户进入 Server 根路由时，平台成员关系可能已经可见，但腾讯 IM 的 Channel Topic 映射仍在异步收敛。当前前端只读取一次 Channel 列表；若当时没有可路由 Channel，就会一直显示“频道正在同步”，直到用户手动刷新页面。

## 目标

- Server 上下文成功加载后，如果没有可路由 Channel，但存在已加入且仍在 provisioning 的 Channel，自动重新读取 Channel 列表。
- Channel 就绪后更新应用状态，由现有路由逻辑自动进入优先级最高的 Channel。
- 重试有界，不建立永久轮询。
- 页面组件只展示状态，不直接拥有定时器或网络请求。

## 判定

可路由 Channel 必须同时满足：

- `joined = true`
- `imState = ready`
- `imGroupId` 非空
- `imTopicId` 非空

优先选择 `systemKey = all` 的全员 Channel，其次选择第一个可路由 Channel。

## 状态流

1. `selectServer` 完成首次 Channel 列表读取。
2. 每次成功快照按固定优先级分类：
   - 存在可路由 Channel：成功结束；
   - 否则存在 `joined = true && imState = provisioning` 的 Channel：继续重试；
   - 否则存在 `joined = true && imState = error` 的 Channel：错误结束；
   - 否则：以“暂无可用频道”结束，不推断为腾讯 IM 正在同步。
3. 有界恢复是 `selectServer` 单飞的一部分：每 1 秒重新调用一次 `listChannels`，最多等待 15 秒。
4. 任意一次读取出现可路由 Channel，立即采用最新 `channels` 并结束恢复。
5. 15 秒后最新成功快照仍为 provisioning 时结束恢复，保留 Server 页面并提供重新加载动作。
6. 切换 Server、退出登录或启动新的 Server 选择时，旧恢复循环必须失效，不得覆盖新 Server 状态。

## 错误与并发

- 单次暂时性读取失败不替换最新成功快照，并可在剩余窗口内继续尝试。截止状态按固定优先级决定：最后一次结果是读取失败，则呈现读取错误；否则最新成功快照仍为 provisioning，则呈现同步超时。
- 恢复循环复用现有 `selectServer` 单飞与 `serverSelection` generation fencing。同一 Server 同一 selection 最多存在一个恢复循环。
- 每次请求前、请求返回后、等待前后和写入状态前都检查 selection generation、Server ID 和本次恢复的本地 deadline/结束标志；旧 selection 或截止后返回的请求不得覆盖当前 Server，旧 selection 的清理也不得清除新单飞。
- 同 Server 手动重试只在旧单飞结束后启动新的 selection；切换 Server 和退出登录会递增 generation，使旧循环失效。
- `channels = []`、全部未加入、或者 ready 但缺少 IM 路由字段时，不启动轮询，直接展示可重试的“暂无可用频道”。

## 验收

- 首次读取返回 provisioning，第二次返回 ready：无需刷新，自动进入 Channel。
- 首次即 ready：不产生额外请求。
- 空列表，以及非空但无已加入 provisioning Channel：不轮询，显示“暂无可用频道”。
- `error + provisioning` 的混合快照继续等待；没有 provisioning 后才呈现 error。
- 暂时读取失败后恢复为 ready：采用 ready 快照并正常进入 Channel。
- Channel 进入 error：停止重试并显示明确错误。
- 一直 provisioning：达到上限后停止请求，可由用户手动重试。
- 恢复期间切换 Server、退出登录或同 Server 手动重试：旧请求结果不会污染新状态。
- 截止后返回的旧请求不能写入状态；截止后不再产生新请求；同一 selection 始终单飞。
