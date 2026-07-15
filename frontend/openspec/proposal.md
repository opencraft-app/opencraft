# 需求提案：统一 Agent 名称真源并清理出生证旧逻辑

## 背景

当前用户侧会出现 Agent 名称有时显示“我的Hermes”、有时显示“Hermes宝宝”的不一致。代码排查显示，后端 CTL 已支持 `CreateInstanceRequest.name` 并在 `InstanceResponse.name` 中返回持久化名称，但前端 `CtlInstancePayload` 未声明 `name`，`projectInstanceToBot` 也没有读取后端名称，而是优先使用本地 draft，最后 fallback 到硬编码 “Hermes宝宝”。

同时，前端和 CTL 仍保留“出生证”“今天出生的第几个 Hermes 宝宝”等早期产品叙事。用户已确认这属于脏逻辑残留，应从用户体验和后续创建链路中清理。

## 范围

本次包含：

- Agent 创建时把用户可见名称传给 CTL `/v1/instances`。
- Agent 展示以 CTL 返回的 `instance.name` 为真源，旧 draft 仅作为老数据兼容 fallback。
- 默认名称从“宝宝”叙事收敛为国内站“我的Hermes”、国际站“My Hermes”。
- 移除前端出生证弹窗、按钮、borncard repository 契约和相关文案。
- 停止 CTL 在新建实例成功后继续 enqueue / inline 执行出生档案投影任务。
- 移除 CTL 列表和 internal bots 响应中的出生日期 / 出生序号字段，并下线 borncard 路由。
- 移除 gateway-dashboard 中“中国出生日期”“第几只”列和类型字段。
- 更新 OpenSpec / 实现文档中对 `getBotBornCard`、出生证、出生卡投影的描述。

本次不包含：

- 删除历史 migration `000010_create_instance_birth_profiles.*`；历史迁移不可改写。
- 第一阶段直接 drop `instance_birth_profiles` 表；如需删表，后续单独新增 forward migration 并确认无消费者与无队列残留。
- 改动 Hermes/OpenClaw 运行时内部身份设定或 SOUL 文件。
- 改动订阅、实名、支付、quota 或 pass 逻辑。

## 发布站点与同步策略

- 发布范围：国内站与国际站同步。
- 国内站默认名称：`我的Hermes`。
- 国际站默认名称：`My Hermes`。
- 差异化原因：仅默认文案/i18n 不同，名称真源和出生证清理策略一致。

## LightVela 影响面

- 前端页面/路由：`/subscribe` 创建链路、`/agents` 控制台、Workbench、历史成功页 / 创建页残留代码。
- 前端数据层：`BotRepository.createBot`、`projectInstanceToBot`、HTTP / fake repository、domain 类型、repository 类型和测试。
- CTL 后端：实例创建成功后的 birth profile task enqueue、borncard public/internal route、internal bots list response、transport DTO、相关测试。
- Gateway Dashboard：CTL bots 列表列定义和类型。
- 文档/OpenSpec：移除出生证/出生卡作为当前能力的说明。

## 验收标准

- 创建 Agent 的 POST `/v1/instances` body 包含 `name`。
- 后端返回 `name` 时，前端列表/详情/Workbench 均展示后端名称，不被 localStorage draft 中的 `Hermes宝宝` 覆盖。
- 后端 `name` 为空时，前端 fallback 为国内站“我的Hermes”、国际站“My Hermes”；不再 fallback 到“Hermes宝宝”。
- 用户可见页面不再出现“出生证”“出生证明”“第几个 Hermes 宝宝”“Hermes宝宝”等旧叙事。
- 前端 repository 不再暴露或调用 `getBotBornCard`。
- CTL 新建实例成功后不再创建新的 `BuildInstanceBirthProfile` 任务。
- `/v1/instances/{id}/borncard` 和 `/internal/bots/{id}/borncard` 不再作为有效路由返回出生卡。
- gateway-dashboard bots 表不再展示出生日期和出生序号列。
- 相关前端、CTL、dashboard 测试通过；如全量测试因环境缺依赖无法完成，需要记录已跑的范围和阻塞原因。

## 风险

- CTL 删除 borncard 字段/路由会影响仍在调用该接口的旧前端版本。本分支会同步移除当前前端调用；线上发布时建议前后端同批发布或先前端后端按兼容窗口处理。
- 已在队列中的 `BuildInstanceBirthProfile` 任务如果 worker 仍注册，理论上可能继续消费；本次目标是停止新创建和下线消费者入口。若要彻底删除 worker/DAO/表，需要在确认队列清空后做第二阶段清理。
