# Channel 独立成员

状态：v1 当前设计  
日期：2026-08-03

## 1. 固定模型

Channel 只有两种成员语义，不增加可配置的 membership mode：

- 系统 Channel `#全员`：成员等于 Server 全部 active Member；
- 所有普通 Channel：成员由 `channel_members` 明确维护。

`visibility = public | private` 只描述平台侧能否被 Server 成员发现，不决定腾讯云 IM
Topic 类型，也不改变成员关系。

## 2. 腾讯云映射

- `#全员` 映射 Community 根会话，不创建普通 Topic；
- 所有普通 Channel 均映射 Tencent Private Topic；
- 普通 Channel 的添加、移出和退出使用携带 `TopicId` 的成员接口；
- 公开 Channel 可以被发现，但未加入的成员不能收发其消息；
- 平台不复制腾讯云消息，也不以本地数据假装 IM 权限已经改变。

腾讯云 Public Topic 与 Community 共用成员，不能支持逐 Channel 加人、踢人，因此 v1 不使用
Public Topic 承载普通 Channel。

## 3. 创建事务

新建普通 Channel 时，创建请求的 Human Member 是首个显式成员。以下事实必须在同一个本地
事务中落库：

1. Channel；
2. 创建者的 active `channel_member`；
3. `im.topic.ensure`；
4. 创建者的 `im.membership.ensure`；
5. 两条对应 Outbox；
6. 幂等响应 locator。

Topic 与成员操作分别由可靠 Worker 收敛。成员操作若早于 Topic 创建到达腾讯云，按短暂依赖
未就绪重试，不得直接标记永久失败。

## 4. 读取与权限

- `system_key=all`：成员列表取 Server active Member，成员变更返回 `implicit_membership`；
- `system_key IS NULL`：成员列表只取 active `channel_members`；
- Owner/Admin 可添加或移出普通 Channel 成员；
- Server 普通成员可发现 public Channel，并把自己加入 public Channel；
- 未加入的 private Channel 对普通成员不可见，必须由 Owner/Admin 邀请；
- 普通成员可退出自己，不能移出别人；
- Agent 必须先是该 Server 的 active Member，才能被加入 Channel；
- UI 根据 `systemKey` 判断只读根群，不再依据 `visibility` 猜测成员能力。

人数、成员列表和操作能力必须来自同一份成员事实。

Channel 响应中的 `joined=true` 表示当前 Human 的显式成员关系已经同步到腾讯云 IM，可以安全
打开 Topic；本地成员关系仍在 `provisioning` 时保持 `joined=false`，前端显示“正在加入”，不得
抢跑调用腾讯 IM。

## 5. 旧数据策略

v1 不兼容旧的普通 Public Topic。测试、Canary 与部署环境中的旧普通 Channel 直接废弃并重建，
不增加遗留模式字段、只读兼容分支、Topic 替换流程或消息搬运代码。

已发布消息历史不进入平台数据库。若未来正式产品需要导入旧站数据，应作为独立导入项目重新
设计，不污染 v1 核心模型。

## 6. 验收

1. 新建 public 与 private 普通 Channel 均创建 Tencent Private Topic；
2. 创建者是唯一初始成员，Server 其他成员不会自动出现；
3. 添加 Agent 后 Channel 人数增加，腾讯 Topic 实际成员同步成功；
4. 移出 Agent 后其不再接收该 Channel 消息；
5. `#全员` 只读继承 Server 成员；
6. OpenAPI 不暴露 Tencent TopicType 或冗余 membership mode；
7. SQLite、TDSQL、OpenAPI、前后端生成与安全门禁全部通过。
