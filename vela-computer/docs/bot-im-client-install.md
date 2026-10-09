# Bot IM 客户端首次安装

从 `vela-computer/` 构建 Linux AMD64 客户端，放到现有北京安装器桶
`vela-installer-1388575217` 的不可变版本目录。安装权限复用 Bot 的现有实例归属和
命令执行鉴权，不增加专属地域白名单。

## 当前产物

- 版本：`v0.1.0-bot.20261009.1`，源码基线 `7593f9705693a4bd1d5f33ed52ebe025ca199170`。
- 平台：Linux AMD64，本机构建链接 glibc 2.38；安装前确认目标满足该运行库要求。
- 包含原生 TAT 桥接，没有内置自动更新通道。
- 对象前缀：`vela-im/releases/v0.1.0-bot.20261009.1/linux-amd64/`。
- 发布文件：`vela-computer`、`install.sh`、`VERSION`、`manifest.json`、`SHA256SUMS`。
- 已上传，五个普通 HTTPS 下载地址及 SHA-256 全部校验通过。
  `frontend/src/lib/generated/vela-im-client-release.json` 的 `published` 已置为 `true`。
  COS 上的不可变 manifest 保留构建时的元数据；入口开放状态由前端清单记录。

## 发布步骤

构建安装用二进制时使用原生桥接，不使用明确标为不具备部署资格的 CI candidate：

```sh
cd vela-computer/native/tat-agent
cargo build --locked --release
cd ../..
CGO_ENABLED=1 go build -trimpath -buildvcs=false -tags vela_tat_cgo \
  -ldflags '-X main.version=v0.1.0-bot.20261009.1' \
  -o /absolute/release/v0.1.0-bot.20261009.1/linux-amd64/vela-computer \
  ./cmd/vela-computer
```

在 Linux AMD64 的目标运行库环境构建；Go 版本满足 `go.mod`，版本目录不可复用。
将安装器复制为该目录的 `install.sh`，生成 `VERSION`、包含版本/源提交/平台/两个
下载 URL 与固定 SHA-256 的 `manifest.json`，为上述四个文件生成 `SHA256SUMS`。
本次已准备完整产物；重建时更换不可变版本并同步前端清单，不能沿用旧摘要。

使用现有安全配置的 coscmd INI 文件，`[common]` 包含 `secret_id`、`secret_key`，
临时认证可包含 `token`。不要把凭据写入源码、命令参数或安装包。

```sh
python3 vela-computer/scripts/publish-im-client.py \
  --config /absolute/private/cos.ini \
  --payload /absolute/release/v0.1.0-bot.20261009.1/linux-amd64
```

发布程序依赖现有 `cos-python-sdk-v5`，先验证本地完整摘要集合，上传时禁止覆盖对象，
回读 Bot 实际使用的 HTTPS 地址并核验全部摘要。复用安装器桶现有权限，不修改桶 ACL。

## 安装步骤

可直接交给 Bot 的完整操作步骤已发布至
[北京 COS 安装说明](https://vela-installer-1388575217.cos.ap-beijing.myqcloud.com/vela-im/guides/v0.1.0-bot.20261009.1/INSTALL.md)。

1. 确认前端版本清单指向已验证的发布文件且 `published=true`。
2. 在工作台执行 `show()`，选择目标 Bot，打开设置中的「IM 客户端」。
3. 点击「安装客户端」。现有 Bot 命令通道以 `agentuser` 执行短启动命令，下载在
   后台进行，页面轮询结果。下载和执行安装器之前先校验固定 SHA-256。
4. 程序位于 `$HOME/.local/share/lightvela/im-client/vela-computer`，入口位于
   `$HOME/.local/bin/vela-computer`。版本与二进制摘要均校验通过后才显示已安装。
5. 重复安装复用校验一致的程序；保留冲突的旧入口，不自动覆盖或升级。

也可在目标 Bot 的终端手工安装：下载版本清单指定的 `install.sh`，用其固定摘要
执行 `sha256sum -c`，再执行 `sh install.sh --binary-url <manifest.binaryUrl>
--sha256 <manifest.binarySha256> --version <manifest.version>`。不要直接管道执行下载。

安装只准备客户端。它不会重启现有 Hermes、重新注册 TAT、创建 Runtime 凭证或启动
第二个 Agent。IM 连接需使用控制面签发的 Agent Runtime Session/UserSig，并完成
托管实例的启动接线；「已安装」不表示 Bot 已连接 IM。
