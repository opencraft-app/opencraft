# 原生 Pi 接入

目标：参考 BB 的原生 provider 使用方式，让本机及 Bash 接入的个人机器发现、配置、
选择和运行目标机器安装的 Pi CLI。沿用 Settings Agent 列表与 onboarding 模型选择，
不增加并列配置真源或假登录操作。

## 边界与设计

- 只读参考本机 BB 0.48.1 的 `guide providers`、provider 声明与 Pi 模型命令：借鉴
  原生 CLI 发现、终端配置、按工作区选择模型和 Full 权限声明。没有复制参考源码。
- Shared Host 拥有原生命令、进程、执行状态和历史 Worker；Pi 拥有原生配置、账号、
  工具和 JSONL。Renderer 只消费 Host 的就绪、模型、图片和思考档位声明。
- `pi-cli:`／`picli_` 明确隔离已有 Pi SDK 的 `pi:`／`pi_`，避免旧 owner 抢占。
- 已安装未配置、检测失败、已就绪、模型加载中、选定和开始沿用现有状态 owner。
  未配置提供终端 `pi` 命令；切 Host 撤销旧结果，保持原有模型选择／开始校验。
- 不支持的扩展弹窗取消；未知执行结果不重放；取消由原生 abort 完成。资源能力按
  已选沙盒配置接入，失败拒绝运行。

## 验证记录

源码检查：Host、Web、ACP plugin 类型检查；i18n、controls、boundaries 通过。
执行与发现回归覆盖模型、工作目录隔离、图片、停止、重试、提前完成、原生历史图、
未知结果、SDK bin 遮蔽及错误沙盒配置。完整 gate 停在已有 Expo/worklets 安装版本
不匹配（安装 0.13.1，SDK 要求 0.13.0），未改动相关依赖。

实机链路：读取本机 Pi 1.5.2 原生四个模型；隔离配置接本地模拟 HTTP 模型验证真实
CLI 图片、原生 Bash 执行、停止子进程、冷历史恢复，证据
`/tmp/opencraft-connected-pi-native.json`。不将模拟模型称作外部账号推理验证。

真实 React 消费者：`smoke-pi-onboarding.ts` 在 1100px 桌面和 390px 触控输入中
选择模型、切 Host、注入迟到结果、完成开始、中文复制终端命令，并检查浅色、深色、
lavender 主题及横向溢出。Host 边界为模拟；实际查看 desktop-light、desktop-dark、
touch-terminal-setup 截图，Agent 行／模型从属关系明确，按钮文字可读，窄屏说明换行，
操作保留在容器中。主题截图禁用有限 CSS 过渡，避免把主题切换中间帧当终态。

实际预览已由新 Node 26.7.0 进程启动。真实 `/settings/chat` 检测 Pi 1.5.2 为就绪，
onboarding 实际展开四个原生模型，无页面错误。实际查看
`/tmp/opencraft-pi-live-settings.png` 与 `/tmp/opencraft-pi-live-models.png`：设置列表
沿用原有统一 Agent 行，模型作为 Pi 行的下属内容，整体没有横向溢出；未发送用户
模型请求或完成新会话。Web 生产构建通过，安装包／Electron 窗口未验。

Bash 更新归档已逐字核对 39 个相关路径，收据
`/tmp/opencraft-pi-package/receipt.json`，SHA-256 为
`b7f397bc9e68e5ed2c9296f2eb652ae01c2d6a621a9f0b1cdd0f4fba8df1a007`。
通过独立临时 index 构建，用户正常 index 未改动。远端仍须升级伴随程序，不能把
本机测试视为已部署远端证据。入口说明见 [原生 Pi](../../docs/native-pi-cli.md)。
