# Runtime Direct Conversation routing design

## Problem

VelaChat 的 Human 私信不是腾讯 IM C2C，而是平台权威 `DirectConversation` 映射到的双人 Work 群。
Web 因此把私信发送到 `an_dm_*` Group。当前 Runtime Directory 只返回 Channel 与 Member，Computer
Gateway 只建立以下两类授权路由：

- `#channel` → Channel Group/Topic；
- `@member` → 腾讯 C2C。

当 Agent 收到平台私信群消息时，IM Transport 能正常收包，但 Gateway 的授权反向索引里不存在该
Group。Directory 已就绪时，Gateway 会拒绝未知会话并返回 `gateway_register_failed`。第一条失败消息
随后成为有序消费 gap，后续消息表现为 `message_handler_failed`，历史恢复仍重复同一授权失败；Runtime
和 Codex 从未收到 prompt。

线上证据是 Linux Computer v0.1.49 在 2026-08-17 20:04 收到两条 `conversation_kind=group` 消息，
持久 cursor gap 的 Group 为 `an_dm_*`，其第一条未消费消息与 `gateway_register_failed` 日志一致。

## Decision

Runtime Directory 显式投影当前 Agent 被授权参与的 Direct Conversation。Computer Gateway 以该投影
建立 `@peer` 到平台私信 Group 的路由，并将它作为该 peer 的权威私信传输；仅在尚无平台
Direct Conversation 时保留现有腾讯 C2C fallback。

不采用以下方案：

1. **按 `an_dm_` 前缀放行。** Group 名称不是授权证明，会把租户、Server 和参与者校验下沉为可伪造
   字符串规则。
2. **按消息发送者推断 `@peer`。** 发送者属于 Server 不代表当前 Agent 被授权进入任意 Group，也无法
   证明 Group 就是这两个 Member 的平台 Direct Conversation。
3. **把 Human 私信改回腾讯 C2C。** 这会推翻现有 `DirectConversation` authority、可靠建群 Operation、
   Web 历史与会话身份，影响面远大于修复授权目录。

## Contract

### OpenAPI

`RuntimeDirectory` 增加兼容性可选字段 `directConversations`，元素类型
`RuntimeDirectoryDirectConversation`：

- `id`: 平台 Direct Conversation ID；
- `peerMemberId`: 相对当前 Agent 的另一位参与者；
- `imGroupId`: 腾讯 Work 群 ID；
- `imState`: `provisioning | ready | error | deleting`；
- `revision`: Direct Conversation revision。

字段在当前协议版本中保持 optional：Backend 会始终输出数组，但旧 Backend 缺失该字段时，新
Computer 按空数组处理。这样允许 Backend 先发布、Computer 后升级，也允许 Computer 暂时回退到旧
Backend 而不破坏 Channel/C2C 路由。该字段不包含腾讯凭据、消息正文或不属于当前 Agent 的会话。

### Backend authorization

Runtime Directory Repository 从现有 `direct_conversations` authority 读取，不增加表或 migration。只投影：

- `server_id` 等于当前 Runtime Server；
- `status=active`；
- 当前 Agent 是 `member_a_id` 或 `member_b_id`；
- peer 是同 Server active、IM-ready Member，且已存在于同一 Directory 的 `members` 集合。

投影可携带非 ready 的 Direct Conversation 状态，但 Gateway 只注册 `imState=ready` 的 Group。Directory
revision 必须纳入 Direct Conversation 的 ID、peer、Group、状态与 revision；状态变化或新建私信因此会
使缓存失效并触发安全刷新。

### Computer client and Gateway

Computer platform client 对新字段执行有界解析、UUIDv7、peer membership、Group ID、状态和 revision
校验。缺失字段等价于空数组；重复 ID、重复 peer、self peer、未知 peer 或非法 Group 使整个 Runtime
Directory 无效，不能部分接受模糊授权。

Gateway 构建索引时：

1. 注册 ready Channel Group/Topic；
2. 注册 ready Direct Conversation Group，并将 canonical alias 设为 peer 的 `@handle`；
3. 注册 Member 腾讯 C2C，但若该 `@handle` 已由 ready Direct Conversation 占用，则跳过 C2C。

反向索引因此能把入站 `an_dm_*` Group 精确还原为 `@peer`。发送、回复、history、message resolve 与
附件继续复用现有 target/Conversation 管线，不增加第二套消息实现。Direct Conversation 不 ready 时不
猜测或放行其 Group；没有 ready Direct Conversation 的 Member 保留现有 C2C 行为。

## Recovery

无需手工清理 cursor gap。新版 Computer 启动或 Directory 刷新后，历史恢复会重新处理第一条未消费
消息；Gateway 此时能从授权目录识别 Group，成功写入 message index、生成 wake message 并交付 Runtime。
有序 coordinator 随后继续消费第二条消息。若 Direct Conversation 仍未 ready，gap 保留并继续报告稳定
错误码，不丢消息、不跳序。

## Invariants

1. `DirectConversation` 继续是 Server 内双人私信 Group 的 authority；腾讯 IM 保存正文和历史。
2. Runtime 只能发现自己参与的 Direct Conversation，不得按 Group 前缀、发送者或全 Server 列表扩权。
3. `@peer` 在 ready Direct Conversation 存在时唯一指向其 Group；不得同时暴露同 alias 的 C2C。
4. Channel/Topic 路由、Thread 路由、没有平台私信的 C2C fallback 保持兼容。
5. Directory revision 覆盖所有会影响授权路由的 Direct Conversation 字段。
6. 新字段不得携带 token、UserSig、消息正文或其他参与者之外的成员信息。
7. 现存 gap 必须通过正常 history recovery 重放，不直接修改或删除状态文件。

## TDD slices

1. **OpenAPI-first:** 先增加 schema/生成物契约测试，证明字段可选且响应能输出显式数组。
2. **Backend projection:** Repository RED 测试覆盖同 Server、参与者、active、peer ready、上限与 revision；
   Service/Handler RED 测试覆盖 DTO 和无越权数据。
3. **Computer parsing:** platform client RED 测试覆盖合法目录、字段缺失兼容、重复/未知 peer 拒绝。
4. **Gateway routing:** RED 测试证明 Direct Conversation Group 入站映射为 `@peer`、发送回同一 Group、
   ready Group 覆盖 C2C，以及未授权 `an_dm_*` 仍被拒绝。
5. **Recovery integration:** RED 测试构造第一条 Group DM 失败形成 gap，目录就绪后 history recovery 顺序
   交付两条消息且不重复。

## Release order and verification

1. 发布 Backend：OpenAPI 响应开始包含 `directConversations`；验证旧 Computer 仍在线、Channel 消息不受
   影响。
2. 发布下一不可变 Computer 双平台版本；Linux/macOS target 必须同时构建、签名、验签并切 catalog。
3. 重启/升级目标 Computer 后验证原 gap 自动恢复，Codex 收到两条 prompt，并在同一 Direct
   Conversation Group 回复。
4. 验证未知 `an_dm_*` Group 仍产生授权失败；验证 Channel、Topic、C2C fallback、附件和 Thread 回归。
5. 运行 Backend 全部门禁、Agent `go test ./...`、`go test -race ./...`、`go vet ./...`、凭据扫描及正式
   Computer 发布验收。

Backend 与 Computer 的发布事实必须分别以 Git commit、镜像/Release Set digest、3/3 Ready、Computer
目标版本和实际消息重放为证据；构建成功不等于功能已发布。
