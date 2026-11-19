# Vela 任务审核插件：Gateway 授权，独立执行器执行

这是受信产品插件，不是公开核心内置业务，也不是自动执行任意 Hands 目录代码的
用户 craft ABI。后端与前端分别安装；前端恢复与持久化契约见 `../../docs/instance-customizations.md`。

- `SupportReviewHttp` 拥有原 URL、GET/POST 语义、同源/意图校验、输入上限。
- 产品 composition 提供 OA 已验证员工与实例准入；请求体不能覆盖 actor。
  独立审核脚本继续决定 Reviewer 权限、修订/内容摘要、锁、账本与实际发送。
- Gateway 的 `HandsReviewExecutor` 只通过私有 Unix HTTP 调用插件，**没有本地执行 fallback**。
  Gateway 不安装业务 Python、读业务目录、持有 SMTP 环境，也不提升权限。
- 独立执行器复用 `hands-owner.ts` 只运行部署者指定的固定 Python/`support-review.py`，
  JSON 经 stdin，无 shell、PTY、模型回合。不能从请求覆盖解释器、工作目录或环境。
  复用原脚本与持久根；不复制审核账本，不启动自动扫描、队列 intake 或批量发信。
- 插件不由 Hands bootstrap 注册。`products/join/hands.mjs` 仅启动执行环境；
  平台显式启动独立插件执行器，缺失或无效插件不阻断核心服务。

## 私有部署配置（本批不写现网）

Gateway 与执行器分别将 `OPENCRAFT_SUPPORT_REVIEW_CONFIG` 指向自己的绝对路径 JSON。
配置和 token 文件必须归各自进程 UID 所有、0600、非符号链接。Root 执行器与 UID994
Gateway **不要共用一份 root-owned token 文件**：部署者分别交付同值随机 token 的私有副本。
不要把 token 写进 Compose 环境变量、源码或回执。

Gateway 配置：

```json
{"version":1,"socketPath":"/run/opencraft-plugins/support-review/owner.sock","tokenFile":"/run/opencraft-private/review.token"}
```

执行器配置（路径仅为示意；生产需指向原业务根，不能创建第二份状态）：

```json
{"version":1,"socketPath":"/run/opencraft-plugins/support-review/owner.sock","tokenFile":"/run/opencraft-private/review.token","workerRoot":"/srv/vela/support-review","pythonExecutable":"/usr/bin/python3","socketGid":990}
```

Socket 父目录由部署者预建：归执行器 UID、共享 GID，模式0710或0750，无组写权限。
Socket 模式0660；Gateway 需同 GID 与目录穿越权。将这个小型 IPC 目录挂给两角色，
各角色自己的配置/token 分别只读挂载；业务目录只需执行器可读写。
不 chmod 共享 `/data`，不改变浏览器 owner、会话执行或终端 socket 权限。

服务拒绝覆盖已有 socket，防止第二个 owner 替换活跃服务；正常 SIGTERM 清理 socket。
异常硬杀遗留时，部署者应先确认旧 owner 不在，再清理**这个插件自己的** socket，
不得删除整个 execution 或业务目录。现有 `.40` root Hands 自定义启动器未使用产品入口，
将来切换时必须显式保留其浏览器降权和 IPC 兼容逻辑，不能直接用新 Hands 镜像覆盖。

## 失败与生命周期

一次请求一次执行，无客户端自动重试。Python 非零退出、非法 JSON、输出超8MB、
90秒超时或 IPC 丢失都不当成成功；写操作返回 `review_operation_result_unknown`，
先查原账本再人工决定，不能自动重发。GET 可重新查阅。调用者断连不回滚或重启已经
提交的发送；撤权后不披露结果。最多4个并发 worker，超过拒绝；关闭/超时清理进程组。
诊断不输出 worker stderr、客户正文、草稿或凭据。

## 验证

`tests/support-review-http.test.ts` 使用临时 Unix socket 和合成 Python worker；
覆盖实际 IPC、身份覆盖、撤权、动作拒绝、超时、失败、单次提交及原状态续读。
`tests/support-review-config.test.ts` 覆盖私有配置、权限与 owner 排他。
这些不是生产审核/SMTP 端到端验收，不读取或发送真实客户邮件。

## 服务端适配作为实例数据：VFS 来源与执行环境分开

标准 Gateway 从 VFS 读取已批准的代码包，校验后加载自己的 `gateway.mjs`。
独立插件执行器加载 `execution.mjs` 并运行原 worker，**不在 Hands 启动流程中注册**。
`build.mjs` 输出审核包0.3，执行入口正常关闭会排空在途任务而不是直接中止。
执行器与 Gateway 选择相同的 manifest 摘要；两者角色配置/私有 token 各自管理。

原 `hands-owner.ts` / `HandsReviewExecutor` 是保留的内部 IPC 实现名称，不表示必须
由 Hands bootstrap 托管。旧低层调用及清单角色保留兼容；新包角色为 `execution`。
代码存储目录不是业务工作区；不会自动复制、迁移或替换生产 Python worker/账本。
详见 `../../runtime-plugins/README.md` 的安装、来源配置及独立执行入口。
