## 认证与 API 地址

<!-- vela-website-credential-fallback:v1 -->

每个实例拥有一个由平台预置的永久凭据（`VELA_WEBSITE_KEY`）。
凭据格式为 `vik_<key_id>_<secret>`，权限范围绑定该实例及其所属用户，
只能调用建站相关接口，不暴露任何账号级权限；凭据不得复制或外泄。

**取值方式**（按顺序取第一个非空值）：

1. 当前执行环境中的 `VELA_WEBSITE_KEY`。
2. 环境变量为空时，在当前终端命令中加载平台预置的 `/etc/vela/website-credential.env`，并导出其中的 `VELA_WEBSITE_KEY` 和 `VELA_API_BASE`。
3. 只有上述两个来源都不可用、文件不可读或加载后 Key 仍为空，才停下来提示用户需要通过 Vela 平台初始化实例，**不要继续调用 API**。

**环境变量为空不等于实例未初始化。必须先尝试凭据文件兜底，不需要用户重启 Agent、gateway 或实例。**

API 地址优先使用 `VELA_API_BASE`（包括凭据文件加载的值）。
如果该变量仍不存在，按站点归属取生产默认值：
国内 `https://api.lightvela.com`、国际 `https://api.lightvela.ai`。
**只有 API 地址有默认值，凭据没有默认值。**

**加载凭据和使用凭据必须放在同一次终端执行中。** 推荐包在子 Shell 内，避免把 Key 留在外层终端会话快照中。
分多次调用终端时，每一次需要认证的命令都要执行同样的加载步骤，不要假定上一次的 export 会保留。
不得输出凭据文件内容或 Key，不得将其写入聊天、日志、项目代码或上传文件；不要开启 shell 的 `set -x` 调试。

读取示例（在同一个子 Shell 中继续执行建站 API 请求或脚本）：

```bash
(
  set +x  # 禁止调试输出泄露凭据
  if [ -z "${VELA_WEBSITE_KEY:-}" ]; then
    if [ ! -r /etc/vela/website-credential.env ]; then
      printf '%s\n' 'website credential unavailable' >&2
      exit 1
    fi
    set -a
    . /etc/vela/website-credential.env
    set +a
  fi

  # Key 无默认值；只有文件兜底也失败后才停止。
  KEY="${VELA_WEBSITE_KEY:?website credential unavailable}"
  API_BASE="${VELA_API_BASE:-https://api.lightvela.com}"
  export VELA_WEBSITE_KEY
  export VELA_API_BASE="$API_BASE"

  # 在这里执行建站 API 请求或脚本；不要打印 KEY。
)
```

请求头：

```
Authorization: Vela-Instance-Key <key>
Content-Type: application/json
```
