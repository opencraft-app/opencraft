# Hermes 大备份 Multipart 导出与上海 Worker 发布 SOP

## 1. 目的

本 SOP 用于修复和发布 Hermes Agent 大备份导出能力，解决单次 COS `PUT Object`
在大归档场景下失败的问题，并确保：

- 不把完整 ZIP 写入救援系统盘；
- 不把永久腾讯云密钥下发到用户 VM；
- 临时凭据不进入 Temporal Workflow History；
- 导出失败或取消后可以终止未完成的 COS Multipart Upload；
- 旧的在途 Workflow 可以继续重放；
- 上海 `rescue-exporter` 与 `hermes-importer` 滚动后均可用。

## 2. 已确认现状

### 2.1 故障证据

已观察到目标实例包含约 7.78 GiB 可导出原始数据。现有 `rescue-uploader` 边压缩边执行
单次 `PUT Object`，COS 返回：

```text
400 EntityTooSmall
Your proposed upload is smaller than the minimum allowed object size.
```

同一存储桶中较小归档可以成功，因此这不是通用网络、Bucket 权限或邮件故障。失败发生在
`rescue-uploader -> COS`，早于成功邮件通知。

### 2.2 运行身份

- Shanghai Worker 当前使用 Root 主账号永久密钥，不是 CAM 子账号。
- 当前 Access Key 处于有效状态。
- 同一账号已验证可以签发 1800 秒、精确到单个 COS 对象的 STS 临时凭据。
- 已使用随机测试对象验证：
  `InitiateMultipartUpload -> UploadPart -> CompleteMultipartUpload -> DeleteObject`。
- COS CAM Resource 中 `uid/` 后使用 APPID，不使用 Owner UIN：

```text
qcs::cos:<region>:uid/<APPID>:prefix//<APPID>/<bucket-name>/<object-key>
```

不要在日志、MR、TAT 输出或本文档中记录 SecretId、SecretKey、Token、预签名 URL 或完整
STS 响应。现有导出协议会把最终下载 URL 保存在 Workflow History 并用于发送邮件；它属于
限时敏感数据，不应额外复制到日志或验收记录。STS 三元组和含凭据的 TAT 脚本不得进入
Workflow History。

## 3. 目标架构和所有权

### 3.1 组件职责

| 组件 | 职责 |
|---|---|
| Service Gateway | 校验登录用户和 Bot 所有权，启动/查询/取消 Temporal Workflow；接口保持不变 |
| Temporal Workflow | 编排救援模式、TAT、Multipart 补偿、邮件和退出救援模式 |
| rescue-exporter Worker | 创建对象键、初始化 Multipart、申请 STS、提交 TAT、失败时 Abort |
| rescue-uploader | 在救援 VM 中只读挂载数据盘，流式压缩并上传 Part，最后 Complete |
| COS | 保存最终 ZIP；未完成 Part 必须由补偿逻辑回收 |

### 3.2 安全边界

Worker 永久密钥只存在于 `workers-runtime-secrets`。VM 仅获得：

- 30 至 60 分钟有效的 STS 三元组；
- 当前 `rescue-exports/<instance>-<timestamp>.zip` 的精确权限；
- `UploadPart` 和 `CompleteMultipartUpload` 权限。

`InitiateMultipartUpload` 和失败后的 `AbortMultipartUpload` 由 Worker 使用自己的凭据执行。
Worker 先用一个 Activity 初始化 Multipart 并把非敏感会话返回给 Workflow，使补偿在 TAT
提交前即可登记。临时凭据与 TAT 脚本必须在后续同一个 Activity 内生成并提交；两个 Activity
只返回非敏感字段：

- Object Key；
- Upload ID；
- TAT Command ID；
- TAT Invocation ID；
- TAT Command ID 和 Invocation ID。

## 4. 开发 SOP

### 4.1 准备工作区

1. 从最新 `origin/master` 创建独立分支和干净 worktree。
2. 确认没有复用包含其他服务修改的脏工作区。
3. 阅读 `workers/AGENTS.md`、`workers/README.md` 和本 SOP。

### 4.2 先写失败测试

至少先加入以下测试：

1. 300 KiB 归档可以用一个 Part 完成。
2. 33 MiB 归档被拆成两个 Part。
3. 非最后 Part 不小于 1 MiB。
4. 最后 Part 允许小于 1 MiB。
5. 同一 Part 网络失败后使用相同 `partNumber` 重试。
6. 压缩器失败时关闭 Pipe，上传循环不会死锁。
7. UploadPart、Complete 或 TAT 失败时触发 Abort。
8. Workflow 取消时在 disconnected cleanup context 中触发 Abort。
9. 超过 10,000 个 Part 时失败并 Abort。
10. 成功结果保留最终 ZIP 的字节数和 SHA-256。
11. 旧 Workflow History 可以 replay，不产生 nondeterminism。
12. STS、永久密钥、上传器预签名 URL 和含凭据脚本不出现在状态、错误和测试快照中；
    最终下载 URL 只保留在既有的导出结果与邮件协议字段中。

### 4.3 修改 rescue-uploader

主要文件：

```text
workers/cmd/rescue-uploader/main.go
workers/internal/rescuearchive/
workers/internal/rescuemultipart/
```

实现要求：

- 使用 `cos-go-sdk-v5` 的 `UploadPart` 和 `CompleteMultipartUpload`。
- 默认 Part 大小为 32 MiB，必须大于 COS 的 1 MiB 下限。
- 使用单个 Part buffer 顺序上传，默认内存上限约 32 MiB。
- 对每个完整 Part 设置明确 `ContentLength`。
- 每个 Part 最多重试 3 次，退避必须有上限。
- 收集并按 `partNumber` 排序 ETag。
- 生产者写入 Pipe 时同步计算 SHA-256 和字节数。
- 消费者失败时主动关闭 Pipe，并等待压缩 goroutine 退出，禁止 goroutine 泄漏。
- uploader 不负责持久保存 STS，也不输出 STS。
- 成功只输出一行结构化结果：

```text
RESCUE_UPLOAD_RESULT={"object_url":"...","device":"...","bytes":123,"sha256":"...","parts":4}
```

- 失败日志至少包含：`stage`、`part_number`、`generated_bytes`、
  `uploaded_bytes`、COS Error Code 和 Request ID。

### 4.4 修改 Worker Activity

主要文件：

```text
workers/internal/rescue/activities.go
workers/internal/rescue/cos.go
workers/internal/rescue/tencent.go
workers/internal/rescue/types.go
```

实现要求：

1. Worker 创建 Object Key 和 Multipart Upload ID，并先把非敏感会话返回 Workflow。
2. Workflow 在启动 TAT 前保存 Upload ID，从此后的任意失败都能执行补偿。
3. 使用 `GetFederationToken` 申请精确对象权限。
4. STS TTL 至少为 `CommandTimeoutSeconds + 600`，并限制在账号允许范围内。
5. 在同一个 Activity 内构造含 STS 的 TAT Script 并调用 `RunCommand`。
6. 不把含 STS 的 Script 作为 Activity Result 返回。
7. 返回独立的 sanitized struct，禁止把敏感配置嵌入其中。
8. Abort 必须幂等：已完成或已不存在的 Upload ID 视为清理完成。

### 4.5 修改 Workflow

主要文件：

```text
workers/internal/rescue/workflow.go
workers/internal/rescue/workflow_test.go
```

执行要求：

1. 使用 `workflow.GetVersion` 为 multipart 路径建立版本标记。
2. 老 History 继续执行旧 Activity 序列；新 Workflow 执行 multipart 序列。
3. 一旦拿到 Upload ID，即登记需要补偿。
4. TAT 失败、Finalize 失败、Workflow Cancel 或 Timeout 均执行 Abort。
5. Complete 成功且结果校验通过后才解除 Abort 补偿。
6. 不改变退出救援模式的既有 finally/cleanup 语义。
7. 不改变邮件发送和 COS 成品自动删除子 Workflow 的协议。

## 5. 本地验证门禁

在 `workers/` 目录执行：

```bash
gofmt -w <本次修改的 Go 文件>
go test ./...
go vet ./...
```

然后从仓库根验证发布 bundle 契约：

```bash
python3 -m unittest discover \
  -s .ci/runtime/tests/contract_tests \
  -p 'test_release_bundle_contracts.py'
```

镜像产生后，CI 会调用完整的 release gate。手工诊断时可先输出 gate plan：

```bash
python3 .ci/runtime/commands/plan_release_gates.py \
  --service workers \
  --env shanghai-workers \
  --source-sha "$SOURCE_SHA" \
  --image "$WORKERS_IMAGE" \
  --pin-targets workers-rescue-exporter,workers-hermes-importer \
  --db-status not-required
```

Docker 可用时执行：

```bash
docker build -f workers/Dockerfile workers
```

检查镜像内同时存在：

```text
/usr/local/bin/rescue-exporter
/usr/local/bin/rescue-uploader
```

提交前执行密钥扫描，并检查 diff 中没有 STS 响应、Secret、预签名 URL 或测试产生的
Object Key。

## 6. 测试环境验证

不要直接使用生产用户实例做首次验证。准备专用测试 CVM 和测试 Hermes 目录：

1. 小归档：小于 1 MiB。
2. 中型归档：约 64 MiB。
3. 大归档：构造逻辑大小超过 5 GiB；使用稀疏或可控测试数据，确认最终 ZIP 实际超过 5 GiB。
4. 手工中断一次 TAT，确认 Multipart Upload 被 Abort。
5. 模拟一个 Part 返回 5xx，确认只重试当前 Part。
6. 导出成功后使用现有 Hermes Import 流程恢复到另一台测试实例。
7. 验证成功邮件下载链接和失败邮件均不包含内部错误、凭据或 TAT 元数据。

验收记录至少包含：Workflow ID、TAT Invocation ID、最终对象字节数、Part 数、SHA-256、
邮件投递状态和退出救援模式状态。不要记录签名 URL。

## 7. 合入与 CI 发布 SOP

### 7.1 提交 MR

MR 只能包含 `workers/` 和必要的 CI/GitOps 契约测试修改。提交信息使用：

```text
[FE-AI] fix(workers): stream rescue exports with COS multipart upload
```

MR 中列出：

- 已复现的 `EntityTooSmall`；
- multipart/STS/Abort 设计；
- Temporal replay 证据；
- `go test`、`go vet`、Docker build 结果；
- 测试 COS 对象已清理；
- 不需要发布 Service Gateway 和前端。

### 7.2 Master CI 行为

合入 `master` 后，`.ci/workers.yml` 因 `workers/**` 变更自动触发：

- 构建 `beijing-sandbox` workers 镜像；
- 构建 `shanghai-workers` workers 镜像；
- `shanghai-workers` 自动生成 GitOps image pin；
- 自动创建并合并 `promote-shanghai-workers-*` GitOps MR；
- Argo 自动同步和自愈。

不要把“master 已合入”或“镜像已构建”当作发布完成。

### 7.3 实际滚动范围

`.ci/workers.yml` 的 bundle 为：

```text
workers-rescue-exporter,workers-hermes-importer
```

两者共享同一个 `workers` 镜像，因此本次发布会同时滚动：

- `workers-rescue-exporter-shanghai-workers`；
- `workers-hermes-importer-shanghai-workers`。

`workers-runtime-shanghai-workers` 只管理 Connection 和 Secret，本次不需要修改或滚动，
除非新增 Secret 键。当前方案复用已有腾讯云 Root 凭据兑换 STS，不需要新增 Secret。

## 8. GitOps 与 Argo 验证

### 8.1 GitOps 真源

确认 `gitops` 分支以下两个文件的 `WORKERS_IMAGE` 指向同一个新 digest：

```text
argocd/services/workers-rescue-exporter/shanghai-workers/workers-platform.env
argocd/services/workers-hermes-importer/shanghai-workers/workers-platform.env
```

必须使用 digest，不以浮动 tag 作为最终验收依据。

### 8.2 Argo 收敛

确认两个 Application：

```text
workers-rescue-exporter-shanghai-workers
workers-hermes-importer-shanghai-workers
```

同时满足：

- source targetRevision 为 `gitops`；
- revision 等于本次 GitOps merge commit；
- Sync 为 `Synced`；
- Health 为 `Healthy`；
- 实际 WorkerDeployment image 等于 GitOps digest。

### 8.3 Temporal Worker 验证

确认：

- 新 WorkerDeployment Version 已 Ready；
- 新 Pod 可以连接 `temporal.lightvela.com:443`；
- `tencent-cvm-rescue-export` 和 `hermes-import` 两个 Task Queue 都有 Poller；
- 没有 nondeterminism、credential、TLS 或 gRPC long-poll 错误；
- 旧 Version 在 sunset 窗口内没有仍在执行的 Workflow 后再缩容。

当前 WorkerDeployment 配置为：

```text
rollout.strategy: AllAtOnce
sunset.scaledownDelay: 30m
sunset.deleteDelay: 2h
```

因此不能只看 Pod Ready；还要观察至少一个完整旧 Workflow 和一个新 Workflow 的完成情况。

## 9. 生产验收

按顺序执行：

1. 使用专用测试实例导出小备份，验证单 Part。
2. 使用专用测试实例导出超过 5 GiB 的 ZIP，验证 multipart。
3. 从邮件下载大备份，核对最终对象大小和 SHA-256。
4. 将备份导入另一台测试实例，执行 Hermes 配置和状态检查。
5. 查询 COS，确认没有该 Workflow 遗留的未完成 Multipart Upload。
6. 确认实例已经退出救援模式并恢复 `RUNNING`。
7. 观察 30 分钟 Worker sunset 窗口和错误率。

只有以上全部通过，才能通知原失败用户重试。不得直接替用户重新执行导出。

## 10. 回滚 SOP

出现以下任一情况立即回滚：

- Workflow nondeterminism；
- TAT 成功但 Workflow 无法 Finalize；
- Multipart Part 持续残留；
- `hermes-import` 回归；
- Worker 无 Poller、反复重启或无法连接 Temporal；
- STS 或永久凭据出现在日志或 History。

回滚步骤：

1. 找到发布前两个 Worker App 共同使用的旧镜像 digest。
2. 在 `gitops` 分支把两个 `workers-platform.env` 同时恢复到旧 digest。
3. 合并 GitOps MR，等待 Argo 自动同步。
4. 确认两个 Application 均 `Synced / Healthy` 且实际镜像为旧 digest。
5. 保留新代码的 `workflow.GetVersion` 兼容分支；不要立即删除 multipart Activity 名称。
6. 查询并 Abort 回滚前新版本创建但未完成的 Multipart Upload。
7. 验证所有受影响实例已退出救援模式。

不要只回滚 `rescue-exporter` 而保留 `hermes-importer` 新 digest；共享镜像必须保持一致。

## 11. 故障排查字段

生产问题至少收集以下非敏感字段：

```text
workflow_id
run_id
workflow_version
instance_id
region
object_key
upload_id_hash
tat_command_id
tat_invocation_id
stage
part_number
part_count
generated_bytes
uploaded_bytes
cos_error_code
cos_request_id
rescue_exit_status
```

看到 `curl` 的 `% Total / % Received / Xferd` 只能说明 uploader 下载过程，不能当成根因。
必须继续读取其后的 uploader 或 COS 错误。

## 12. 后续安全加固

本次功能修复不被以下事项阻塞，但应单独跟踪：

1. 创建专用 CAM 子账号或角色替换 Shanghai Worker 的 Root 永久密钥。
2. 权限仅保留 CVM Rescue、TAT、STS 和指定 COS Bucket 前缀。
3. 对 Bucket 配置自动清理未完成 Multipart Upload 的生命周期规则，作为 Temporal Abort 的兜底。
4. 将临时 uploader 对象改为按二进制 SHA-256 命名的内容寻址对象，避免每次导出产生一份
   永久残留的 uploader 副本。
