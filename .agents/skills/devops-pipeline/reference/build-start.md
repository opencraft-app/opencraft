# 启动流水线构建

命令：`python scripts/pipeline_client.py start`

手动触发流水线构建。

## ⚠️ 重要：必须先获得用户确认

**在调用此命令前，必须向用户展示完整的构建参数并获得明确确认。未经确认禁止执行。**

确认内容必须包括：
- 项目 ID（projectId）
- 流水线 ID（pipelineId）
- 所有构建入参（--params 的完整内容）

## 参数

### 必需参数

| 参数 | 说明 |
|------|------|
| --project-id | 项目英文名 |
| --pipeline-id | 流水线 ID（p-开头） |

### 可选参数

| 参数 | 类型 | 说明 |
|------|------|------|
| --build-no | number | 手动指定构建版本号 |
| --params | JSON 字符串 | 流水线入参，无参数时可不传 |
| --access-token | string | 访问令牌（也可通过 BK_CI_ACCESS_TOKEN 环境变量设置） |

## 工作流

```
1. 调用 startup-info 获取需要的参数
2. 准备 --params 填入参数值
3. ⚠️ 向用户展示完整参数，等待用户确认
4. 用户确认后调用 start 启动构建
5. 使用返回的 buildId 调用 status 监控状态
```

## 示例

### 无参数启动

```bash
python scripts/pipeline_client.py start \
  --project-id myproject \
  --pipeline-id p-abc123
```

### 带参数启动

```bash
python scripts/pipeline_client.py start \
  --project-id myproject \
  --pipeline-id p-abc123 \
  --params '{"branch":"master","env":"production","version":"1.0.0"}'
```

### 指定构建号启动

```bash
python scripts/pipeline_client.py start \
  --project-id myproject \
  --pipeline-id p-abc123 \
  --build-no 100
```

### 从文件读取参数

```bash
python scripts/pipeline_client.py start \
  --project-id myproject \
  --pipeline-id p-abc123 \
  --params "$(cat params.json)"
```

## 返回说明

成功启动后返回：

```json
{
  "data": {
    "id": "b-xxx",        // 构建 ID，用于状态查询
    "pipelineId": "p-xxx",
    "projectId": "xxx",
    "num": 123,           // 构建号
    "executeCount": 1
  },
  "status": 0,
  "message": ""
}
```

## 注意事项

- **⚠️ 必须在启动前获得用户对构建参数的明确确认**
- `--params` 的 key 需要与流水线定义的参数名一致
- 先调用 `startup-info` 确认参数要求
- 返回的 `id`（buildId）用于后续状态查询
