# 单 Server 多 Human：实施边界与覆盖账本

状态：分阶段实施。首个切片验证核心双 Human 请求隔离，修复旧发现入口的资源过滤；不代表共享工作台、多人 Channel 或不可信执行隔离已完成。

数据库与长期归属正在进行[所有权与数据库模型评审](architecture/resource-ownership-review.md)：比较 Actor 直接所有与管理作用域所有，列出候选约束、迁移及回退风险；方案尚未批准，暂停新增 schema 与权限行为改造。

## 核心与插件

一个工作台作用域对应一个当前 Human；一个 Server 可同时服务多个 Human 与 Agent。桌面本地 Renderer 只是 Client，不能使本机 Server 具有一个会随界面切换的全局当前 Human。桌面与 headless 是角色装配方式，身份与资源权威遵循同一契约。

核心拥有 Actor、登录会话、资源授权、请求身份、订阅资格、消息接管与执行归属。登录证明来源、本地密码策略、企业目录同步和产品 Portal 呈现可以由插件或可信产品装配提供。停用 UI 或登录来源插件不能绕过核心授权，也不能把 Server 降级为匿名共享。Agent 使用独立主体，委托显式保存。

既有下游 IM Collaboration 是独立产品扩展，不作为核心多人 Server 的依赖，也不把其第三方 IM 历史写进 Agent Thread。参见[Human 工作台](architecture/human-workbench.md)、[执行所有权](execution-ownership.md)、[核心协作接口](actor-collaboration-api.md)。

## 当前入口覆盖

| 入口 / owner | 当前事实 | 后续工作 |
| --- | --- | --- |
| `ActorAccess` | 每请求认证、连接 lease 与有效性复核，无 Server 全局当前 Human | 扩展桌面本地与远端并存的装配验收 |
| `serve-workbench-web.mjs` WebSocket | 建立服务端 ActorContext 和 resourceOwner，连接撤销有独立检查 | 逐方法核对资源权限、推送范围；连接具名不等于所有方法已隔离 |
| 核心协作 HTTP | 作者由认证上下文提供，Actor 范围幂等，私聊历史按双方身份读取 | 多人 Channel、成员管理与订阅另行实现 |
| `Collaboration.discoverMetadata` | 返回前按 `conversation.discover` 过滤资源 | 分页可返回空页，消费者须沿 nextCursor 继续 |
| `Collaboration.discover` | 本次补齐相同的逐资源过滤与查询后撤权检查 | 历史共享资源政策仍保持，不偷偷重分配所有者 |
| `readConversation` / metadata | 读取前后复核资源权限 | 继续审计旧原生历史与目录入口，不将本接口验收外推到全站 |
| 协作执行请求 | 复用现有 Host 队列，稳定请求身份、领取前授权与未知结果对账 | 共享频道触发执行的产品策略与多人控制权限尚待落地 |
| 原生 Thread、文件、终端、浏览器 | 部分路径已有资源 owner，但仍存在旧共享接口及部署兼容策略 | 独立列出逐方法准入和事件可见范围，再决定迁移；不能宣称多租户隔离 |
| 客户端工作台 | 已有账号/连接作用域机制 | 两个真实用户的共享资源 UI、撤权收敛和跨设备连续性待验收 |

已有 `conversationAllowed` 对具有 orchestration 归属的会话采用 owner 或显式 grant；无该关系的历史会话仍沿用实例共享政策。本次不把旧会话默认为私有，不从当前查看者猜测所有者，也不借 orchestration 关系表新造一套通用共享资源目录。

发现权限不自动授予读取、发送或执行权限。过滤掉一页所有结果也保留 nextCursor，不把空页误当目录结束。当前游标是既有目录游标，未声明具备租户侧信道隔离。

## 首个切片证据

- `tests/chat/conversation-collaboration.test.ts`：两个 Human 并发发现各自资源、显式共享发现权限、发现不授予历史读取、持有查询期间撤权、空页保留游标。
- 修复前双 Human 发现测试失败，返回了另一用户私有会话的标题与引用；修复后通过。
- `tests/identity/actor-collaboration.test.ts`：真实 HTTP Server 同时接收两个 Human 的请求；同名幂等键互不覆盖，作者归属准确，向同一 Agent 发私聊不共享双方私聊历史，禁用其中一人不影响另一人。
- HTTP 测试使用合成身份来源与执行替身，不代表真实设备登录、物理手机或模型执行端到端验收。

## 后续按闭环推进

1. 补全所有旧原生 RPC、目录、推送和工具入口的动作/资源授权覆盖表；先选择明确的历史数据兼容政策，不开启一个覆盖不完整的“严格模式”。
2. 在现有资源权威中实现共享成员与动作权限；若需存储变更，使用受管迁移。多人协作 Channel 与执行 Thread 分开建模，不新增可独立派发的执行队列。
3. 复用工作台与现有成员入口完成共享资源 UI。桌面本地 A、远端 B 共用同一 Server，验证私有不可见、共享同步、并发提交和审批唯一处理。
4. 验证断线、账号切换、成员撤销与后台服务生命周期。关闭 A 的窗口不自动停止 B 的共享任务；退出登录与撤销已接受任务分别处理。
5. 面向互不信任用户前，完成 Host 文件、进程、浏览器 profile、凭据与存储隔离；核心资源权限不能替代执行沙箱。

本账本不授权部署、变更现网成员或迁移历史资源所有权。发布与兼容切换沿用实际用户授权和发布流程。
