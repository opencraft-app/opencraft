# Computer 安装状态收敛设计

## 背景

当前安装流程有三个相互独立、但都属于状态未向用户侧正确收敛的问题：

1. `/install` 返回稳定的 POSIX bootstrap。bootstrap 使用一次性短码调用
   `POST /v1/computer/setup-codes:redeem`。短码无效、过期或已经使用时，接口正确返回
   HTTP 401；但 bootstrap 当前启用了 `curl --fail`，用户只能看到
   `curl: (22) ... 401`。
2. 当前 macOS 用户已经安装 Computer 时，再执行另一条安装命令会落入通用
   `Computer 首次安装状态冲突`，没有表达“本机已经安装”的真实状态。
3. 成功生成安装命令会增加后台 Computer revision；前端收到响应后没有更新本地
   Computer revision，关闭弹窗后再次生成会错误触发并发冲突。

## 目标

- 保持短码一次性、不可重放。
- 保持 redemption API 的 HTTP 状态码和统一错误语义。
- 在终端显示稳定、可操作的英文错误提示。
- 不把短码写入磁盘、URL、日志或错误信息。
- 已完成安装不得被另一条安装命令静默覆盖或重新绑定。
- 前端使用 mutation 响应中的权威 revision 收敛本地投影。

## 设计

### Bootstrap 错误映射

bootstrap 调用 redemption API 时保存响应体到现有受限临时目录，并单独读取 HTTP
状态码。curl 必须在兼容 `set -e` 的 `if` 控制流中执行，退出状态与 HTTP 状态分别
处理；不使用会把 HTTP 401 混同为传输失败的 `--fail`。只有精确的 HTTP 200 才执行
下载到的 `setup.sh`。

- HTTP 401、403、404、409 或 410：输出
  `Computer setup code is invalid, expired, or already used. Generate a new setup code and try again.`
- 网络或 TLS 失败：输出
  `Unable to contact the Computer setup service. Check your network and try again.`
- 其他 HTTP 状态：输出
  `Computer setup service returned an unexpected response. Try again later.`

所有失败均返回非零退出码。错误提示不区分短码不存在、过期或已消费，避免形成短码状态探针。
服务端 JSON 或 shell 形态的错误正文不直接执行，也不原样输出。curl 自身 stderr 被抑制，
避免与稳定提示混杂。临时目录清理使用 POSIX trap 条件 `0 HUP INT TERM`，不使用
非 POSIX 的 `EXIT`。

### 本机已经安装

Agent 安装服务读取到 `stage=complete` 的有效安装 journal 后，立即返回独立的
`already installed` 错误；该判断发生在替换二进制、claim 新 enrollment 或修改本地
凭据之前。提示固定为：

`Vela Computer is already installed for this macOS user.`

安装入口不自动替换已有 Computer。重新绑定、卸载和升级是独立生命周期，不借用首次安装
协议隐式完成。未完成 journal 仍仅允许完全相同的事务恢复；不匹配继续作为真正的恢复冲突。

### 前端 revision 收敛

`createComputerRegistrationScript` 返回的 `computerId` 与 `revision` 是该 mutation 的权威
结果。应用 store 成功收到响应后，只更新匹配 Computer 的 `revision` 字段，不保存一次性
安装命令。再次生成命令必须携带更新后的 revision。

## 测试与验收

- 真实执行生成的 bootstrap，模拟 200、401、网络错误和未知 5xx。
- 200 时仅执行合法响应脚本。
- 401、网络错误和 5xx 分别断言精确 stdout、stderr 与非零退出码。
- 失败输出不得包含 curl 诊断、请求 URL、服务端正文或测试短码。
- mock 服务验证短码只存在于 POST body，不出现在 URL、query 或 header。
- 所有非 200 响应，即使正文是合法 shell，也不得被执行。
- 已完成安装再次收到相同或不同 release 时，都在覆盖文件和调用 claim 前返回
  `already installed`；未完成的相同事务仍可恢复。
- 前端连续生成两次安装命令，第二次携带第一次响应返回的新 revision；store 中不出现脚本正文。
