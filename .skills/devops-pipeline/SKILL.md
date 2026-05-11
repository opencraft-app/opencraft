---
name: devops-pipeline
description: 管理蓝盾流水线的构建操作，包括查询流水线列表、查询构建历史、获取启动参数、查看构建状态、启动构建、取消构建、修改流水线参数。当用户提及流水线、构建、部署、CI/CD、蓝盾或需要触发、取消构建、修改流水线参数时使用。
---

# 蓝盾流水线管理

通过 Python 脚本直接调用蓝盾 API 管理流水线构建。

## 脚本参考

**获取流水线列表**：参阅 [reference/pipeline-list.md](reference/pipeline-list.md)
**获取启动参数**：参阅 [reference/build-startinfo.md](reference/build-startinfo.md)
**启动构建**：参阅 [reference/build-start.md](reference/build-start.md)
**取消构建**：参阅 [reference/build-stop.md](reference/build-stop.md)
**查看构建状态**：参阅 [reference/build-status.md](reference/build-status.md)
**获取构建历史**：参阅 [reference/build-list.md](reference/build-list.md)
**修改流水线参数**：参阅 [reference/pipeline-update-params.md](reference/pipeline-update-params.md)

## 核心概念

- **projectId**：项目英文名（如 `myproject`）
- **pipelineId**：流水线 ID，以 `p-` 开头（如 `p-abc123`）
- **buildId**：构建 ID，以 `b-` 开头（如 `b-xyz789`）

## Stream CI / 蓝盾项目 ID 经验

Stream CI 和蓝盾流水线底层使用同一套构建体系。对工蜂仓库触发的流水线，`projectId` 通常不是工蜂 group，也不是仓库名，而是 `git_<工蜂项目数字ID>`。

当前 `wisp/mono2` 的固定值：

- 工蜂仓库：`wisp/mono2`
- 工蜂项目数字 ID：`1731878`
- 蓝盾 / Stream CI `projectId`：`git_1731878`

示例：

```bash
BK_CI_ACCESS_TOKEN="your_token" python3 .skills/devops-pipeline/scripts/pipeline_client.py status \
  --project-id git_1731878 \
  --pipeline-id p-bb05a019f51a4737804d680e74961096 \
  --build-id b-bf8d1c42b1c8426fb2485b88a380ca6c
```

已验证该 projectId 可查询 `GitOps 验收与自动合并`、`北京沙箱族 GitOps 漂移审计` 等 mono2 流水线状态。

## 重要规则

**启动构建前必须获得用户确认**：在调用启动构建脚本之前，必须向用户展示完整的构建入参并获得明确确认。未经用户确认，禁止执行构建操作。

**取消构建前必须获得用户确认**：在调用取消构建脚本之前，必须向用户展示待取消的 `projectId`、`pipelineId`、`buildId` 并获得明确确认。未经用户确认，禁止执行取消操作。

**修改流水线参数前必须获得用户确认**：在调用修改参数脚本之前，必须向用户展示将要修改的参数名和新值并获得明确确认。未经用户确认，禁止执行修改操作。

**访问令牌配置**：调用蓝盾 API 前必须先检查环境变量 `BK_CI_ACCESS_TOKEN`。如果没有 token，明确向用户索要 token，或请求用户授权用已登录浏览器打开 `https://devops.woa.com/ms/auth/api/user/bkToken/get` 获取；不要含糊跳过蓝盾 API，也不要把缺 token 当作只能改走其他排查路径。

## 常用工作流

### 1. 启动构建

```
步骤 1：获取启动参数 → 参阅 [reference/build-startinfo.md](reference/build-startinfo.md)
步骤 2：向用户展示构建参数，等待用户确认 ⚠️ 必须执行
步骤 3：用户确认后启动构建 → 参阅 [reference/build-start.md](reference/build-start.md)
步骤 4：查看状态 → 参阅 [reference/build-status.md](reference/build-status.md)
```

**步骤 2 确认模板**：
```
即将启动构建，请确认以下参数：
- 项目：{projectId}
- 流水线：{pipelineId}
- 构建参数：
  {列出所有参数的 key-value}

是否确认启动？
```

### 2. 取消构建

```
步骤 1：确认待取消的构建 ID（可先参阅 [reference/build-list.md](reference/build-list.md) 或 [reference/build-status.md](reference/build-status.md)）
步骤 2：向用户展示待取消构建信息，等待用户确认 ⚠️ 必须执行
步骤 3：用户确认后取消构建 → 参阅 [reference/build-stop.md](reference/build-stop.md)
步骤 4：再次查看状态，确认是否已取消 → 参阅 [reference/build-status.md](reference/build-status.md)
```

**步骤 2 确认模板**：
```
即将取消构建，请确认以下信息：
- 项目：{projectId}
- 流水线：{pipelineId}
- 构建 ID：{buildId}

是否确认取消？
```

### 3. 修改流水线参数

```
步骤 1：向用户展示将要修改的参数名和新值，等待用户确认 ⚠️ 必须执行
步骤 2：用户确认后调用 update-params → 参阅 [reference/pipeline-update-params.md](reference/pipeline-update-params.md)
```

**步骤 1 确认模板**：
```
即将修改流水线参数，请确认以下信息：
- 项目：{projectId}
- 流水线：{pipelineId}
- 修改参数：
  {参数名}: {旧值} -> {新值}

是否确认修改？
```


## 常用流水线

用户配置的常用流水线，参阅 [config.json](config.json)

**URL 解析规则**：从 `https://devops.woa.com/console/pipeline/{projectId}/{pipelineId}` 提取：
- `projectId`：`/pipeline/` 后的第一段
- `pipelineId`：以 `p-` 开头的最后一段

## 快速示例

### 获取流水线列表

```bash
# 获取项目所有流水线
python scripts/pipeline_client.py pipelines \
  --project-id myproject

# 按名称搜索流水线
python scripts/pipeline_client.py pipelines \
  --project-id myproject \
  --filter-by-pipeline-name "my-pipeline"

# 排序并限制返回数量
python scripts/pipeline_client.py pipelines \
  --project-id myproject \
  --sort-type UPDATE_TIME \
  --collation DESC \
  --page-size 10
```

### 查询最近构建

```bash
python scripts/pipeline_client.py list \
  --project-id myproject \
  --pipeline-id p-abc123 \
  --page 1 \
  --page-size 10
```

### 获取启动参数

```bash
python scripts/pipeline_client.py startup-info \
  --project-id myproject \
  --pipeline-id p-abc123
```

### 启动一次构建

```bash
python scripts/pipeline_client.py start \
  --project-id myproject \
  --pipeline-id p-abc123 \
  --params '{"branch": "master"}'
```

### 查看构建状态

```bash
python scripts/pipeline_client.py status \
  --project-id myproject \
  --pipeline-id p-abc123 \
  --build-id b-xyz789
```

### 取消运行中的构建

```bash
python scripts/pipeline_client.py stop \
  --project-id myproject \
  --pipeline-id p-abc123 \
  --build-id b-xyz789
```

### 修改流水线参数

```bash
python scripts/pipeline_client.py update-params \
  --project-id myproject \
  --pipeline-id p-abc123 \
  --params '{"BRANCH_NAME": "release/1.4.0.0"}'
```

## 构建状态枚举


| 状态 | 说明 |
|------|------|
| SUCCEED | 成功 |
| FAILED | 失败 |
| CANCELED | 已取消 |
| RUNNING | 运行中 |
| QUEUE | 排队中 |
| STAGE_SUCCESS | 阶段成功 |

## 如果 `BK_CI_ACCESS_TOKEN` 不存在，先找用户要

1. 先检查当前 shell 是否已有环境变量：`printf '%s\n' "${BK_CI_ACCESS_TOKEN:+set}"`。如果已有，直接使用，不要重复获取。
2. 如果没有 token，停止蓝盾 API 操作并明确问用户：`当前 shell 没有 BK_CI_ACCESS_TOKEN；请把 token 发我，或授权我用已登录浏览器打开 https://devops.woa.com/ms/auth/api/user/bkToken/get 获取。`
3. 用户提供 token 后，只在当前 shell 会话中导出：`export BK_CI_ACCESS_TOKEN="..."`；不要写入仓库、文档、提交信息或持久日志。
4. 如果用户授权使用浏览器登录态，再打开 `https://devops.woa.com/ms/auth/api/user/bkToken/get` 获取 token；如果接口返回 JSON，只提取 token 字段值。
5. 如果上述接口不可用，再参照 `https://iwiki.woa.com/p/4016670096` 获取访问令牌。
6. 没拿到 token 前，可以做本地/runner 侧辅助排查，但必须说明这不是蓝盾 API 日志查询的替代。
