# 取消流水线构建

命令：`python scripts/pipeline_client.py stop`

别名：`python scripts/pipeline_client.py cancel`

取消指定构建，底层调用 API：`POST /projects/{projectId}/build_stop?pipelineId={pipelineId}&buildId={buildId}`，请求体固定为 `{}`。保留 `X-Bkapi-Authorization` 鉴权，请求头 `X-DEVOPS-CHANNEL` 取自已认证目标的实际渠道；脚本先读取 `build_status`，再停止并限时验证。

## Stream CI 的“成功但未停止”陷阱

2026-10-05 实测：Stream 构建记录的实际渠道为 `GIT`。省略渠道的停止请求返回 `status=0, data=true`，但任务仍是 `RUNNING`、后续构建仍排队；携带真实 `X-DEVOPS-CHANNEL: GIT` 后，目标确认为 `CANCELED`，队列恢复推进。此经验不意味着所有流水线都用 `GIT`。

源码解释（外部上游，不等同于所有部署版本）：`ServiceBuildResourceImpl.manualShutdown` 返回 `Result(true)`，而 `PipelineBuildFacadeService.buildManualShutdown` 遇到 `pipelineInfo.channelCode != channelCode` 会直接返回；默认请求渠道是 `BS`。已核对的上游版本为 `d5420f2d3d09450961f2c43e929c2c5cb98d45d2`：

- [停止入口](https://github.com/TencentBlueKing/bk-ci/blob/d5420f2d3d09450961f2c43e929c2c5cb98d45d2/src/backend/ci/core/process/biz-process/src/main/kotlin/com/tencent/devops/process/api/ServiceBuildResourceImpl.kt)
- [取消与渠道匹配](https://github.com/TencentBlueKing/bk-ci/blob/d5420f2d3d09450961f2c43e929c2c5cb98d45d2/src/backend/ci/core/process/biz-process/src/main/kotlin/com/tencent/devops/process/service/builds/PipelineBuildFacadeService.kt)
- [渠道默认值](https://github.com/TencentBlueKing/bk-ci/blob/d5420f2d3d09450961f2c43e929c2c5cb98d45d2/src/backend/ci/core/common/common-pipeline/src/main/kotlin/com/tencent/devops/common/pipeline/enums/ChannelCode.kt)

停止前只提取 `id`、可用的 `pipelineId`、`status` 及渠道元数据，不输出整个 `variables`、构建参数、请求头或原始 agent 日志。优先交叉核对 `webhookInfo.channelCode`、`variables.BK_CI_START_CHANNEL` 和 `variables.pipeline.start.channel`；字段缺失、冲突或未知渠道时，不发停止请求。`--channel` 只用于另有可靠证据已确认归属的情况，不是权限绕过或逐个试渠道的开关。

必须保留同一鉴权身份和正常 API 门禁。停止后读新状态：只有 `CANCELED` 能证明此次取消完成；`SUCCEED` / `FAILED` 是任务结束，不是取消成功。队列恢复须另查目标新构建，不能由旧任务的取消响应推断。没有状态进展时，先查渠道和实际运行步骤，不盲目重发、猜测强制接口、改并发配置或启动重复构建。

父任务与发布子任务是不同目标。取消父任务后分别读取子任务；不得默认子任务已退出或把操作扩展到未授权 ID。暂停审批的 `STAGE_SUCCESS` 不是整条发布成功：若正常取消审批后显示 `REVIEW_ABORT`、阶段为 `STAGE_SUCCESS` 且设置了 `endTime`，还须确认正式发布步骤未执行；不要把拒绝审批说成已上线，也不要拿“通过旧审批”解除队列等待。

## ⚠️ 重要：必须先获得用户确认

**在调用此命令前，必须向用户展示待取消的构建信息并获得明确确认。未经确认禁止执行。**

确认内容必须包括：
- 项目 ID（projectId）
- 流水线 ID（pipelineId）
- 构建 ID（buildId）

## 参数

### 必需参数

| 参数 | 说明 |
|------|------|
| --project-id | 项目英文名 |
| --pipeline-id | 流水线 ID（p-开头） |
| --build-id | 构建 ID（b-开头） |

### 可选参数

| 参数 | 类型 | 说明 |
|------|------|------|
| --access-token | string | 访问令牌（也可通过 BK_CI_ACCESS_TOKEN 环境变量设置） |
| --channel | string | 已确认的实际渠道，BS/GIT/CREATIVE_STREAM；与响应冲突时拒绝停止，通常自动读取即可 |
| --wait-seconds | int | 0–60秒的状态复查窗口，默认30秒；不会自动重发停止请求 |

## 工作流

```
1. 使用 list 或 status 确认目标构建仍在运行中或排队中
2. ⚠️ 向用户展示待取消的 projectId、pipelineId、buildId，等待用户确认
3. 用户确认后调用 stop 或 cancel 取消构建
4. 再次调用 status，确认状态是否变为 CANCELED
```

## 示例

### 取消运行中的构建

```bash
python scripts/pipeline_client.py stop \
  --project-id myproject \
  --pipeline-id p-abc123 \
  --build-id b-xyz789
```

### 使用别名取消构建

```bash
python scripts/pipeline_client.py cancel \
  --project-id myproject \
  --pipeline-id p-abc123 \
  --build-id b-xyz789
```

## 返回说明

脚本返回已过滤的操作结果，例如：

```json
{
  "buildId": "b-xyz789",
  "channel": "GIT",
  "status": "CANCELED",
  "stopRequested": true,
  "cancellationVerified": true
}
```

## 注意事项

- 已是 `CANCELED` 时不重复写入；其他已结束/未知状态不发停止请求。
- 缺失或冲突渠道、状态读取失败、身份不匹配、停止响应失败时拒绝继续，不自动重试写操作。
- 限时复查未确认 `CANCELED` 时输出 `cancellationVerified: false` 并退出2；继续只读排查或交由正常控制台/CI维护者处理，不能宣称成功。
- 测试命令：`python3 -m unittest discover -s .agents/skills/devops-pipeline/tests -v`；仅模拟响应，不取消真实构建。
