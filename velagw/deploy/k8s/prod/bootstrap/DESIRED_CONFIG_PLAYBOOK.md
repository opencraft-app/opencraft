# DesiredConfig Agent 导入手册

这份手册用于让一个不了解历史上下文的新 Agent，把本地完整模型配置可靠地导入 LLMGateway。DesiredConfig 包含上游明文密钥；只能存在于操作者本地，不能提交 Git、粘贴到聊天、写入日志或放入 ConfigMap。

## 1. 准备本地文件

默认路径：

```text
deploy/k8s/prod/bootstrap/private/desired-config.json
```

仓库已经忽略 `bootstrap/private/*`。先设置权限并确认文件没有被 Git 跟踪：

```bash
chmod 600 deploy/k8s/prod/bootstrap/private/desired-config.json
git check-ignore deploy/k8s/prod/bootstrap/private/desired-config.json
git ls-files --error-unmatch deploy/k8s/prod/bootstrap/private/desired-config.json && exit 1 || true
```

不要运行 `cat`、`jq .`、`set -x`，也不要把 API 错误响应和文件正文一起打印。只允许做静默结构校验。

## 2. 配置目标控制面

```bash
export LLMGATEWAY_CONTROL_URL='https://llmgw-control.lightvela.com'
export LLMGATEWAY_CONTROL_TOKEN='<cluster admin token>'
```

管理 token 只能放在当前终端环境或本机 Secret 管理工具里，不要写入仓库文件。

## 3. 只导入，不发布

第一次必须只导入。脚本会校验格式和明文渠道密钥，调用 `/api/desired-config/import`，随后确认对应 fingerprint 已经形成不可变 revision。它只输出 bundle、revision 和 fingerprint，不输出渠道密钥。

```bash
deploy/k8s/prod/bootstrap/import-desired-config.sh
```

也可以显式指定本地文件：

```bash
LLMGATEWAY_DESIRED_CONFIG_FILE=/secure/path/desired-config.json \
  deploy/k8s/prod/bootstrap/import-desired-config.sh
```

相同 fingerprint 可以重复导入，不会创建重复 revision。内容发生变化时会创建新 revision，但导入本身不会覆盖任何 Set。

## 4. 检查后发布

先在管理台“模型配置”中核对刚才输出的 fingerprint、渠道数量、模型和配置差异。确认目标正确后，显式开启发布：

```bash
DESIRED_CONFIG_RELEASE=true \
  deploy/k8s/prod/bootstrap/import-desired-config.sh
```

默认 `set_ids=[]`，表示发布到所有 active 且已 bootstrap 的 Set。只发布到指定 Set：

```bash
DESIRED_CONFIG_RELEASE=true \
DESIRED_CONFIG_SET_IDS_JSON='["set-auto-000001","set-auto-000002"]' \
  deploy/k8s/prod/bootstrap/import-desired-config.sh
```

发布固定使用 `force_drift=false` 和 `stop_on_failure=true`。遇到漂移或任一 Set 失败时停止，不允许 Agent 自动改成强制覆盖。先检查 release run 和远端差异，再由操作者决定是否在管理台执行“覆盖远端”。

## 5. 验收

完成标准：

1. 脚本输出 `DesiredConfig imported`，bundle、revision、fingerprint 均非空。
2. 开启发布时输出 `DesiredConfig released` 且 `status=success`、`stop_on_failure=true`。
3. 管理台“模型配置”显示所有目标 Set 为已同步，无 drift/error。
4. “集群”页面中目标 Set 的 Admission 为 `passed`；未通过的 Set 不允许承载新用户和流量。
5. 使用正式 traffic 域名执行一次 `auto` 模型 smoke，不直接调用 Set 地址。

新 Set 后续由 set reconciler 自动同步 LLMGateway MySQL 中的当前渠道包，不需要再次读取这份本地文件。

## 6. 失败处理

- `tracked by Git`：立即从 Git index 删除该文件，确认历史提交没有包含明文密钥；若已经提交，先轮换所有渠道 Key。
- `invalid DesiredConfig`：重新从黄金 Set 导出，不要手工删字段绕过校验。
- `no persisted immutable revision`：停止发布，检查 control MySQL 和 control 日志。
- `release ... error/partial`：到管理台查看 release item，修复目标 Set 后重试；不要直接设置 `force_drift=true`。
- Admission 未通过：检查渠道同步、定价完整性和权益 Plan 同步，不能手工把状态改成 passed。
