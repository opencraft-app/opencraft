# Computer 内网 HTTP 一键安装设计

日期：2026-08-02

## 目标

允许明确标记为“可信内网”的 Chatserver 使用普通 HTTP 提供 Computer 一键安装入口，Canary
最终展示：

```sh
curl -fsS http://9.135.236.64/install | sh -s -- ABCD-EFGH-JKLM
```

命令仍由后台生成，Web 只展示后台返回的完整 `command`。默认部署继续只接受 HTTPS；远端
HTTP 必须同时配置独立的 Computer 安装 URL 和显式开关，避免影响 Agent 生命周期链路，
也避免测试能力被误用于公网。

## 决策与风险边界

采用独立 URL + 显式许可方案：

```text
--platform-public-url=https://127.0.0.1:18444
--computer-install-public-url=http://9.135.236.64
--allow-insecure-computer-install-http
```

- `platform-public-url` 继续只供既有 Agent Runtime/TAT 生命周期模板使用，不在本轮放宽。
- `computer-install-public-url` 只供 Computer setup、`/install`、兑换、artifact、claim 和
  Provider bootstrap 使用。未配置时回退到 `platform-public-url`，保持现有 HTTPS 部署兼容。
- `--allow-insecure-computer-install-http` 默认关闭；关闭时，远端 HTTP 与当前一样启动失败。
- 开关只允许平台一键安装链路使用 HTTP，不关闭 TLS 校验，也不允许任意协议。
- HTTPS 模式的现有输出和行为保持不变。
- HTTP 会使 `/install` Bootstrap、短码兑换请求和第二阶段脚本面临内网中间人篡改或窃听。
  后续制品的 SHA-256 与 Ed25519 校验只能保护被正确执行的安装器，不能弥补首段 Bootstrap
  本身被替换的风险。该风险由“可信内网 + 显式开关”的部署边界承担，不把 HTTP 描述成与
  HTTPS 等价。

## 配置与职责

### Chatserver

`serve` 增加 `computer-install-public-url` 和布尔配置
`allow-insecure-computer-install-http`，并把解析后的 Computer 安装配置传入 Enrollment 服务
和公开安装 Handler。Computer 安装 URL 校验规则为：

- `https://` 始终允许；
- `http://` 仅在显式开关开启时允许；
- URL 必须包含 host；path 只允许空或 `/`，统一规范化为无尾斜杠 origin；不得包含 userinfo、
  query、fragment、控制字符或不安全 shell 字符；
- 其他 scheme 一律拒绝。

显式 HTTP 开关只在 Computer 安装 URL 确实为 HTTP 时有效；开关开启但 URL 为 HTTPS 视为
错误配置，避免部署意图不明确。后台以规范化后的 Computer 安装 origin 生成 `/install`、
短码兑换、私有 artifact 入口和安装器 `--platform-url`。Web 不推导、不替换域名，也不根据
页面 origin 拼接命令。

### Computer 安装端

隐藏的安装命令增加 `--allow-insecure-platform-http`。后台只在自身已启用 Computer HTTP
模式且生成的安装 URL 确实为 HTTP 时，把该参数写入第二阶段脚本。

许可必须逐层传播：兑换生成的第二阶段脚本把许可传给下载的 `install.sh`；`install.sh` 再把
许可传给 `chatserver-computer install`；安装命令把许可写入状态绑定并传给 Enrollment 与
Provider 两个 HTTP 客户端。任一层缺失都在其首次网络请求前失败，不能仅放宽其中一个请求。

许可写入安装状态中的 `EnrollmentBinding`，并参与恢复时的绑定比较。这样安装中断后可以
继续同一种模式，但不能把已暂存的 HTTPS 安装静默改成 HTTP，或反向复用另一种绑定。旧状态
缺少该字段时按 `false` 读取，保持向后兼容；状态 schema 继续为 v1。HTTPS 状态使用
`omitempty`，不写入值为 `false` 的新字段，因此旧安装器仍可读取新代码产生的 HTTPS 状态。
HTTP 状态必须写入 `true`；旧安装器因严格未知字段校验而 fail-closed，这是显式 HTTP 模式
可接受且必须记录的回滚边界。

daemon 完成安装后依靠嵌入式 TAT 运行，不持续访问平台 HTTP，因此不把该许可加入
LaunchAgent 参数或长期运行配置。

## 安装数据流

1. Human 创建或刷新 Computer setup command。
2. Chatserver 根据配置返回完整命令；Canary 使用
   `curl -fsS http://9.135.236.64/install | sh -s -- <CODE>`，并保持
   `Cache-Control: no-store` 的 setup 响应。因为固定 IP 入口不需要跳转，HTTP 模式刻意移除
   `-L`，首段不跟随任何重定向。
3. 顶层 curl 从字面量 HTTP origin 获取公开 Bootstrap；Bootstrap 从标准参数读取 16 位短码。
4. Bootstrap 只向配置好的 HTTP origin 发起短码兑换，不跟随重定向，也不把短码写盘。
5. 返回的第二阶段脚本携带完整 Enrollment Token 和显式 HTTP 许可，在私有临时目录内下载
   平台 artifact 入口。
6. artifact 入口最多重定向一次到现有私有 COS HTTPS 签名 URL。HTTP 模式只允许
   `HTTP platform -> HTTPS COS`；禁止重定向到 HTTP 或其他协议。
7. 安装器继续验证 manifest、大小、SHA-256 与 Ed25519 签名，完成 claim、Provider 注册和
   用户级 LaunchAgent 启动。

curl 协议限制按 URL 模式生成：

| 请求 | HTTPS 模式 | 显式 HTTP 模式 |
| --- | --- | --- |
| 顶层 `/install` | 保持现有 HTTPS 短命令；现有 HTTPS 域名可按既有规则跟随 HTTPS 跳转 | 使用字面量 HTTP URL 且不带 `-L`，不跟随重定向 |
| Bootstrap 兑换 | 初始只允许 HTTPS，不跟随重定向 | 初始只允许 HTTP，不跟随重定向 |
| 第二阶段 artifact | 初始只允许 HTTPS，重定向只允许 HTTPS，最多一次 | 初始允许配置的 HTTP，重定向只允许 HTTPS，最多一次 |

不得使用允许 `file:`、`ftp:` 或 HTTP 降级重定向的宽泛 curl 配置。

## 改动边界

本轮修改：

- Chatserver `serve` 配置和 Enrollment/安装 Handler 的 URL 校验；
- Bootstrap 与第二阶段脚本的 scheme 限制；
- Computer 隐藏安装命令、Enrollment/Provider HTTP 客户端和安装状态绑定；
- 新的不可变 Computer release（版本 `0.1.2`）：重新构建、签名、上传 `install.sh` 和程序，
  更新 release catalog/ConfigMap；
- Canary 的独立 Computer 安装 URL 与显式 HTTP 开关。

本轮不修改：

- OpenAPI 的 `ComputerSetupCommand` 结构和前端展示逻辑；
- 短码、claim、Computer credential、错误码和幂等语义；
- COS 签名 URL 的 HTTPS 强制要求及客户端下载时的 TLS 校验；
- `platform-public-url`、Agent 生命周期编译器、普通 `computer run`、旧 `computerhost` 手工
  配置或其他平台 API 的 HTTP 许可；
- 长期 daemon/TAT 链路；
- 自签名证书、证书忽略参数或 HTTP 自动探测。

## 失败语义

- 远端 HTTP URL 未配显式开关：Chatserver 启动失败，不能生成不可执行命令。
- 安装脚本收到 HTTP URL 但缺少显式许可：在任何网络请求前失败。
- 保存状态的 URL、发布 target 或 HTTP 许可与恢复参数不一致：按现有 binding mismatch 失败，
  不覆盖 pending credential。
- 兑换、artifact 下载、重定向或校验失败：沿用现有非零退出、临时目录清理和可安全重试语义。
- HTTP 模式不得放宽日志脱敏；短码、Enrollment Token、Computer credential 和 COS 签名参数
  仍不得进入日志或 fixture。

## 测试与验收

自动测试：

- 默认拒绝远端 HTTP：serve 配置、安装 Handler、Enrollment 客户端、Provider 客户端和状态
  绑定分别有失败测试。
- 显式许可后接受远端 HTTP，并证明许可从后台第二阶段脚本传播到安装命令和两个客户端。
- HTTP Bootstrap 使用准确的 HTTP 兑换 URL、禁止重定向，短码仍不落盘。
- HTTP artifact 下载只允许一次 `HTTP -> HTTPS` 跳转，拒绝 HTTP 重定向、其他 scheme 和多跳。
- Computer 安装 URL 拒绝非根 path，证明所有层使用同一规范化 origin；Agent 生命周期仍使用
  原 HTTPS `platform-public-url`。
- HTTPS 生成结果与既有安全限制保持兼容。
- 安装状态可读取缺少新字段的旧 HTTPS v1 文件；新 HTTP 状态可恢复；许可不一致被拒绝。
- 新 release 的 installer 与 `chatserver-computer` 都认识并逐层传递 HTTP 许可；旧 release
  不被用于 HTTP setup。
- OpenAPI/生成一致性、全量 Go 测试、race、vet 与凭证扫描通过。

Canary 验收：

- Deployment 保留 Agent 用 HTTPS `platform-public-url`，另设
  `computer-install-public-url=http://9.135.236.64` 和显式 HTTP 开关；Recreate 完成后 3 个
  Pod Ready、无重启。
- Human 端生成的命令严格以 `curl -fsS http://9.135.236.64/install` 开头，不出现
  `127.0.0.1:18444`、长 Enrollment Token 或底层 Provider 信息。
- `GET /install` 返回英文 Bootstrap；缺少短码仍输出
  `Missing the 16-character Computer setup code.` 并以状态 2 退出。
- 无效短码经过真实 HTTP 入口返回稳定、不可枚举的失败；服务健康检查保持正常。
- 若有隔离 Computer 可用，再执行一次真实 setup -> redeem -> artifact -> claim -> online
  闭环；不得接管或覆盖现有 Computer。

## 部署与回滚

先通过测试门禁，构建并签名不可变 `0.1.2/darwin-arm64` release，上传到私有 COS 并验证远端
实字节；随后创建新的不可变 catalog ConfigMap。最后以同一个 Deployment PodTemplate revision
更新镜像 digest、catalog 挂载、Computer 安装 URL 和显式开关。无需数据库迁移，也不修改
Service。

现有 Canary 策略是 `Recreate`，本轮不改成 RollingUpdate。发布会先停止旧 Pod，再启动 3 个
新 Pod，接受短暂内部停机；验收必须确认最终 3/3 Ready、0 重启和健康响应。

回滚使用完整的上一版 Deployment 清单/ReplicaSet，使旧镜像、旧 catalog 挂载、旧参数同时
恢复；不能只回滚镜像，也不能只关闭开关后保留远端 HTTP URL。新 HTTPS 状态可被旧程序读取，
但已开始的 HTTP=true 安装状态不能由旧 `0.1.1` 安装器继续，必须保留新 `0.1.2` 完成或清理
隔离 Canary 状态后重试。部署完成后以实际镜像 digest、release catalog、Deployment 参数和
在线响应为验收依据。
