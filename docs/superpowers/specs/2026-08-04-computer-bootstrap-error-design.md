# Computer 安装短码错误提示设计

## 背景

`/install` 返回稳定的 POSIX bootstrap。bootstrap 使用一次性短码调用
`POST /v1/computer/setup-codes:redeem`。短码无效、过期或已经使用时，接口正确返回
HTTP 401；但 bootstrap 当前启用了 `curl --fail`，用户只能看到
`curl: (22) ... 401`，无法知道下一步应当重新生成安装码。

## 目标

- 保持短码一次性、不可重放。
- 保持 redemption API 的 HTTP 状态码和统一错误语义。
- 在终端显示稳定、可操作的英文错误提示。
- 不把短码写入磁盘、URL、日志或错误信息。

## 设计

bootstrap 调用 redemption API 时保存响应体到现有受限临时目录，并单独读取 HTTP
状态码。只有 HTTP 200 才执行下载到的 `setup.sh`。

- HTTP 401、403、404、409 或 410：输出
  `Computer setup code is invalid, expired, or already used. Generate a new setup code and try again.`
- 网络或 TLS 失败：输出
  `Unable to contact the Computer setup service. Check your network and try again.`
- 其他 HTTP 状态：输出
  `Computer setup service returned an unexpected response. Try again later.`

所有失败均返回非零退出码。错误提示不区分短码不存在、过期或已消费，避免形成短码状态探针。
服务端 JSON 错误正文不直接执行，也不原样输出。

## 测试与验收

- 真实执行生成的 bootstrap，模拟 200、401、网络错误和未知 5xx。
- 200 时仅执行合法响应脚本。
- 401 时只出现约定的英文提示，不出现裸 `curl: (22)`、服务端 JSON 或短码。
- 网络失败和 5xx 分别出现对应提示。
- 继续检查短码仅通过请求体传输，且不落盘。

