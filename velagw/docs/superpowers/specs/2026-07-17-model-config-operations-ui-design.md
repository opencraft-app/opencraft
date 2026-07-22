# 模型配置运营界面简化设计

## 背景

当前“模型配置”页面把配置来源、发布目标、差异检查、渠道清单、版本、发布记录、回滚、备份和 JSON 详情放在同一工作区。后端能力完整，但页面要求运营人员同时理解配置包、revision、fingerprint、drift 和 Set 等内部概念，无法快速判断“现在是否需要处理、下一步做什么”。

本次只重组控制台信息架构，不修改渠道包、版本、发布任务或 worker 的后端语义。

## 目标

- 默认先呈现结果，再呈现操作。
- 用 Tab 隔离日常下发、配置查看和历史追溯。
- 页面打开时不实时扇出所有 Set，只读取 worker 最近一次检查结果。
- 保留现有差异、发布、回滚、备份和 JSON 能力，但降低低频技术能力的视觉权重。
- 让不理解 LLMGateway 内部建模的运营人员也能完成一次安全发布。

## 页面结构

页面标题保持“模型配置”，主体改为单一全宽工作区，不再使用“左侧操作区 + 右侧配置包列表”的并排布局。

顶层包含三个 Tab：

1. **下发配置**：默认 Tab，负责展示最近检查结果和执行发布。
2. **配置内容**：查看当前配置中的渠道与模型，并从黄金集群更新配置。
3. **发布记录**：查看版本、发布进度、失败原因和执行回滚。

页面默认固定进入 `golden-channels` 生产配置。其他测试或历史配置收进“其他配置”侧栏，只有明确选择后才进入操作页面；内容指纹与生产配置相同时标记“内容相同”。配置编号不在日常界面展示。

工作区上方增加常驻但紧凑的四步引导：`查看结果 → 更新配置 → 检查差异 → 下发更新`。其中明确说明全部一致即可结束、检查只读、下发按钮仅在需要更新时出现。三个 Tab 使用运营语义命名为“检查与下发”“配置内容”“版本与记录”。

## 下发配置

### 数据来源

打开页面时调用只读接口 `GET /api/channel-bundles/{bundle_id}/delivery-status`。该接口只聚合 LLMGateway MySQL 中的 bundle、active Set、`ChannelBundleSyncState` 和最近 release，不得创建 new-api client，也不得访问任何 Set。结果区域显示检查结果的覆盖时间，并提供“重新检查”按钮；只有用户主动点击后才逐个调用现有 `plan` 操作访问目标 Set。`plan` 是渠道包领域中的只读检查动作。

响应 DTO 固定为：

```json
{
  "bundle_id": "golden-channels",
  "status": "synced",
  "eligible_sets": 6,
  "checked_sets": 6,
  "coverage_checked_at": "2026-07-17T06:00:00Z",
  "stale_after_seconds": 600,
  "has_stale_results": false,
  "counts": {
    "synced": 6,
    "pending": 0,
    "drift": 0,
    "error": 0,
    "unchecked": 0,
    "stale": 0
  },
  "sets": [
    {
      "set_id": "set-auto-000091",
      "set_name": "Set 000091",
      "status": "synced",
      "last_checked_at": "2026-07-17T06:00:00Z",
      "last_error": "",
      "diff_json": "{}"
    }
  ]
}
```

eligible Set 定义为 `status=active` 且已经完成 setup 的 Set。下线或 disabled Set 不计入；新加入但还没有状态行的 Set 计为 `unchecked`。`coverage_checked_at` 可空：没有任何 eligible Set 被检查时为 `null`；否则取所有已检查 eligible Set 中最早的 `last_checked_at`，表达“整批结果至少新到什么时间”。没有 eligible Set 时返回 `status=empty`、所有 counts 为 0、`coverage_checked_at=null`，页面提示先准备服务集群且不显示检查或发布按钮。

结果在以下任一条件下标记 stale：存在 eligible Set 没有状态行，或某状态的 `last_checked_at` 早于 `check_channel_drift` worker 当前 interval 的两倍。接口从 job 定义读取 interval，不引入固定分钟数。job 存在、启用且 interval 为正数时，`stale_after_seconds=interval*2`；job 缺失、停用或 interval 非法时返回 `stale_after_seconds=null`，现有状态不因时间自动过期，但缺失状态仍为 `unchecked`。

每个 eligible Set 必须且只能计入一个规范状态，确保 counts 之和等于 `eligible_sets`：

| 持久化状态 | 规范状态 | 说明 |
| --- | --- | --- |
| 无状态行 | `unchecked` | 尚无检查证据 |
| `last_checked_at` 为空或零值 | `unchecked` | pending 行不等于已经检查 |
| 检查时间早于当前 bundle 更新时间，或 desired fingerprint 与当前 bundle 不符 | `stale` | 旧版本证据，不允许用于当前发布 |
| 任意状态且超过 stale 时间 | `stale` | 结果过期，覆盖原状态参与聚合 |
| `synced` | `synced` | 已一致 |
| `pending` | `pending` | 已确认存在待下发更新 |
| `drift`、`conflict` | `drift` | 远端存在手工差异或冲突 |
| `error` | `error` | 最近检查失败 |
| `skipped` 或未知状态 | `unchecked` | 不把跳过或未知结果解释为可发布 |

`sets[].last_checked_at` 是可空字段。`checked_sets` 统计拥有非零检查时间的 Set，包括已经过期的 `stale`；`unchecked` 不计入。由于版本不匹配而成为 `stale` 的记录必须清空响应中的 `diff_json`，避免展示旧版本差异。

聚合状态优先级为 `empty > error > unchecked > stale > drift > pending > synced`；其中 `empty` 只在 eligible Sets 为 0 时成立。未检查与过期同时存在时返回 `unchecked`，主文案同时列出未检查和过期数量。`unchecked` 和 `stale` 均禁止发布，只允许重新检查。

### 结果状态

页面根据最近结果进入一个明确状态，并只突出与该状态对应的主动作：

| 状态 | 主文案 | 主动作 |
| --- | --- | --- |
| 从未检查 | 尚未检查服务集群 | 检查配置 |
| 结果过期 | 检查结果已过期 | 重新检查 |
| 检查中 | 正在检查集群配置 | 无，显示当前浏览器的完成数量 |
| 全部一致 | 所有集群配置一致 | 无发布按钮，仅可重新检查 |
| 有待更新 | N 个集群需要更新 | 下发更新 |
| 发现漂移 | N 个集群存在远端改动 | 查看差异 |
| 检查失败 | N 个集群检查失败 | 重试检查 |
| 发布中 | 正在下发到 N 个集群 | 无，显示当前请求仍在执行 |

当前页面发起的发布请求和检查请求是临时视觉状态，优先于接口聚合状态。错误、未检查和过期状态不出现发布按钮；drift 只能进入差异确认，pending 才能直接“下发更新”。

结果摘要默认只展示总数和异常项。全部一致的 Set 合并为一行；需要更新、漂移或失败的 Set 逐行展示。初始加载只展示持久化 `diff_json` 中可提取的动作数量和摘要，不伪造完整 plan；用户点击“重新检查”后，才使用本次返回的完整 `ChannelBundlePlan` 展示 `ChannelPlanResult` 和 `JsonVisualDiff`。

“检查中”和“发布中”是发起请求的当前浏览器本地状态，不新增持久化检查 run，也不承诺跨页面实时进度。请求完成后刷新 `delivery-status` 和发布记录。

发布范围默认是全部可用集群，也允许选择单个 Set。`delivery-status` 始终返回全部 eligible Sets，前端按当前选择重新计算摘要和按钮；重新检查、查看差异和发布都只作用于当前选择范围。选择范围不会自动触发检查。

手动检查结果必须绑定到 `bundle_id + target_set_id` 上下文。切换配置或目标范围后，旧检查详情和操作资格立即失效；即使旧请求随后返回，也不能在新上下文中展示或解锁覆盖操作。

“覆盖远端”不作为并列主按钮。发现 drift 后，用户进入差异详情，在明确提示会覆盖远端手工改动后才能执行。

## 配置内容

默认使用运营可读表格展示：渠道名称、可用模型、服务地址、分组和状态。密钥只显示“已配置/未配置”，不展示哈希或指纹。

主要动作是“从黄金集群更新”。点击后在 Sheet 中选择来源集群，并明确提示“确认后将读取该集群当前配置；有变化时生成新版本”；确认后调用现有 import API。若 fingerprint 未变化，沿用当前 revision 并提示“配置未变化”，不声称生成了新版本。本期不新增导入预览 API。配置名称和编号不在导入表单中重复编辑。

“高级操作”折叠区域保留：

- 下载完整备份
- 从备份恢复
- 查看脱敏 JSON
- 查看配置编号和 fingerprint

## 发布记录

版本和发布 run 合并为按时间倒序的记录流。每条记录只展示当前数据模型可靠提供的字段：时间、目标数量、结果，以及有关联时的版本号。失败记录可展开查看已记录 Set 的错误；fail-fast 时未执行的目标不伪造成发布 item，也不提供语义不明确的“一键重试”。

当前指纹对应的最新 revision 标记为“当前版本”，禁止重复恢复；相同指纹的旧 revision 标记为“内容相同”。其他历史版本提供“恢复历史版本”，确认页明确说明该操作只创建新的当前 revision，不自动发布；成功后切回“检查与下发”，由用户重新检查并确认下发。

## 交互与错误处理

- 页面加载失败时保留 Tab 和配置选择器，在内容区显示重试，不清空上次成功数据。
- 重新检查、发布和恢复版本期间禁用当前页面内同一配置的冲突操作；服务端继续依赖现有 bundle release lease 防止并发发布。
- 所有耗时动作都显示当前阶段，不使用无限期的无解释菊花。
- 后端返回技术错误时，主提示使用运营文案；原始错误放在可展开详情中。
- 移动端 Tab 可横向滚动；表格保持稳定列宽并允许横向滚动。

## 代码边界

- `ChannelManagementPage` 只负责查询、mutation 和顶层 Tab 状态。
- 新增独立展示组件：`ChannelDeliveryTab`、`ChannelContentTab`、`ChannelHistoryTab`。
- 新增 `ChannelDeliveryStatus` DTO 和 `GET /api/channel-bundles/{bundle_id}/delivery-status`；后端只调用 store 接口进行本地聚合。
- 复用现有 `ChannelPlanResult`、`JsonVisualDiff`、`ChannelReleaseItems` 和状态 Badge；完整 diff 只用于手动检查的即时结果，持久化结果使用轻量摘要组件。

## 测试

- 前端测试覆盖三个 Tab、默认“检查与下发”Tab，以及只有存在其他配置时才出现次级入口。
- 前端测试覆盖生产配置默认入口、其他配置次级入口、检查结果上下文隔离和当前版本不可重复恢复。
- 覆盖空集群、从未检查、结果过期、全部一致、有待更新、漂移、检查失败、检查中和发布中状态的文案与主动作。
- 后端契约测试覆盖 mixed 状态优先级、missing/stale 状态、eligible Set 过滤、coverage 时间和 `delivery-status` 绝不访问 new-api。
- 验证页面初次渲染只调用 bundle 列表和 `delivery-status` 等本地元数据接口，不会调用 plan 或其他远端检查 API；点击“重新检查”才触发。
- 验证全部一致时不出现发布按钮，drift 时不直接出现“覆盖远端发布”。
- 验证配置内容和历史记录保留现有渠道、版本、回滚与备份能力。
- 使用桌面和移动视口进行截图检查，确认按钮、Tab、长模型名和错误文本不重叠。

## 非目标

- 不修改 new-api。
- 不改变渠道包 revision、release run 或回滚的数据模型。
- 不新增自动发布。
- 不在本次设计中重做渠道本身的编辑器。
