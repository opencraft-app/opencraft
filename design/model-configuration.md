# OpenCraft 模型配置所有权

## 产品真源

桌面默认使用 `~/.opencraft/models.json`。文件由 OpenCraft 的 ModelConfigurationRepository 自行读写，模型配置服务拥有校验、revision/CAS 和引擎应用协调。它不是 DSH settings 文件的改名或双向镜像。

版本 1 的结构：

```json
{
  "schemaVersion": 1,
  "revision": 0,
  "providers": [],
  "defaultModel": null
}
```

提供商字段为 id、name、可选 catalogId、protocol、baseUrl、credentialRef、enabled 和 models。模型字段为 id、可选 name/限制/输入类型及 enabled。默认选择仅持有 providerId、modelId 和可选 reasoningEffort。provider ID 是稳定身份，重命名不改变 ID；文件没有引擎名、settingsNs、apiKeyEnv 或 DSH 命名空间。

`~/.opencraft/credentials.json` 由 OpenCraft 独立凭据仓库管理，模型文件只保存引用。两个文件写入权限为 0600，目录为 0700；这是私有文件，不是加密保险箱，也不使用 macOS Keychain。

## 引擎边界

ModelEnginePort 只接收产品文档和窄的凭据解析能力，不获得模型仓库写权限。DSH 适配器把产品配置转换成运行时需要的临时设置/凭据；这些引擎文件是可重建的执行投影，不是反向写回来源。其他引擎可以实现同一端口，不要求迁移产品 JSON。

现有 runtime 模型命令暂由 DshModelConfigurationBridge 兼容，旧命名空间在适配边界转换为产品记录及全局文档 revision。UI 的旧协议投影尚保留兼容，不把它误称为整个工作台已经无 DSH 依赖。

## 默认选择与输入能力

`defaultModel: null` 表示没有产品默认，目录顺序不能制造默认模型。Web/Expo 共用明确选择/明确默认解析，过期的明确选择不静默切换到别的模型。创建新任务必须有明确选择或有效产品默认，校验在创建引擎会话前发生；现有会话的模型绑定不随全局默认变化。恢复时先回放 OpenCraft 保存的绑定，包含从未执行过推理、原生历史还没有 request header 的会话；不让 DSH 私有默认覆盖目录。DSH 内部 schema 要求 composition 默认非空，清除产品默认只撤销适配器写入的用户层选择，其内部 composition 不进入产品选择或替代用户意图，不使用伪模型占位。

模型输入能力通过受控引擎适配桥读取实际 `resolveModelInfo`，公共目录转换为 `input`/`inputModalities`。缺失元数据保守按文本处理，不按模型名称猜测图片能力。未注册的管理项只呈现声明，不冒充运行时能力。Composer 请求编译与 Host 校验消费相同的输入能力定义；文本模型的图片请求在读取本地附件或发起模型请求前拒绝，图片模型保留原生图片输入。切换模型不删除附件或改写历史，用户可以改选模型或移除不兼容附件。

自定义 Provider 的模型声明可由用户显式标记“图片输入”，保存为 `input: ["text", "image"]`；关闭时保存为 `input: ["text"]`。引擎明确返回的能力优先于声明；引擎返回未知时才回退到该声明，二者都未知时仍按文本处理。Model Services 只呈现这一用户可验证的输入能力，不按模型名称推断，也不把一次文本连通性检查冒充图片能力验证。

reasoning 保持已有不变量：无能力不发送档位，有能力的默认必须属于支持集合；`none` 只在明确支持时有效。选择、展示和编译共享解析，不用首档位充当缺失默认。

## 语音模型与应用服务

模型声明增加可选 `type: chat | asr`，旧文档省略时仍为 chat；用途不按名称推断。当前转写适配协议为 `hunyuan-asr`，仅允许固定 TokenHub HTTPS 基础地址。聊天默认只能引用聊天模型；独立的 `defaultSpeechModel` 只保存 providerId/modelId，不复制端点或密钥。移除/停用所选语音连接后保留不可用的明确选择，禁止偷偷换模型。

Headless 的 Model Services 在现有添加提供商表单中选择用途，复用同一提供商命令、全局 revision/CAS、凭据暂存和不确定提交核对；语音页只选择模型，不另建密钥表单或环境变量配置。ModelConfigurationRepository/ModelCredentialRepository 的存储格式、权限和所有权不变。没有安装应用语音服务的桌面/远端 Host 不广告可创建语音模型。DSH 兼容命名空间只用于管理投影，转换保留 type；语音提供商及其凭据完全排除于聊天引擎执行投影。管理目录展示转写模型，普通聊天目录不展示；也不提供文本探测/图片输入/聊天默认操作。

应用语音服务固定读取安装级 models 目录，切换 SSH/Thread/Bot 不更换该所有者。录音开始捕获不可读的绑定票据；它以进程私有 HMAC 绑定所选连接、模型和当前凭据。提交前读取一致快照并比较票据，配置变更/服务更换时拒绝旧录音，不转投新模型或新密钥。改名不退休录音；显式重试不改变票据。正在执行的转写继续使用提交时捕获的配置，不宣称可撤回供应商计费。票据不提供凭据散列、密钥读回或跨重启持久性。

旧 OPENCRAFT_SPEECH_API_KEY/MODEL 只允许通过显式迁移命令一次性导入；服务启动不导入、不回退读取环境密钥。已配置选择不覆盖，导入保留旧文件并提示核对后移除旧密钥部署配置。OPENCRAFT_SPEECH_PUBLIC_ACCESS 仅为部署准入策略，不是模型真源。实装与验收见 [cloud-dictation.md](../docs/cloud-dictation.md)。

## 聊天引擎提交与应用

1. 在 OpenCraft 文件锁内校验 revision 和完整文档。
2. 写入私有临时文件并原子替换 models.json。
3. 串行将最新文档应用到引擎。
4. 独立报告 applied/failed；失败不撤销产品配置，界面提供重试应用。

读取时比较产品 revision 和凭据文件版本，必要时重新应用；不会把旧引擎响应写回仓库。坏 JSON、未知版本或非法字段报错，禁止清空重建。跨进程写入通过文件锁与 CAS 防止覆盖。文件替换保证读者不读到半份 JSON；不承诺断电级 fsync 持久性。

## 迁移与验证

首次初始化可从明确的旧 DSH 目录做一次性导入；先校验和备份，再转成产品结构。只导入相关 API Key 引用，保留旧文件。目标 models.json 已存在时不自动合并或覆盖；凭据引用冲突则中止。更换 preview profile 不改变产品模型目录。

自动化必须显式传入隔离的 modelStorageDirectory，桌面测试通过 OPENCRAFT_MODEL_STORAGE_DIRECTORY 指定；不得让测试写入真实用户文件。验证包含无引擎的仓库/替代引擎测试、引擎失败后配置保留、真实 DSH 跨运行目录重启恢复。会话历史和登录状态仍有各自的存储所有者，不在本次模型迁移中移动。

## Personal defaults on shared servers

Only explicit choices on the new-conversation page immediately update personal model/effort/speed defaults; sending a message is not required. Editing a historical conversation changes only its own selection. It does not write personal defaults or change what subsequent new conversations inherit.

Authenticated account contributions may provide `AccountModelDefaultsPort`. Composer remembers explicit model/effort/service tier per verified account and Host in server-owned managed SQLite, with revision CAS. Another browser for the same account reads the same choice. The authenticated request determines the account; caller scope only fences identity changes. Anonymous requests cannot read or save personal defaults. Browser model history is not imported into this authority. New task submission waits for initial account/default hydration; embedded Host-default presentations do not consume this cache. Personal changes never call `config/batchWrite` or modify the Host-wide provider default; absent personal settings use that default, and existing Thread bindings remain unchanged. A removed personal model still requires explicit reselection. Standalone clients without an account authority retain installation memory. Explicit provider administration remains Host configuration.

## 会话模型的首帧展示

已有会话的模型与推理档位先从该会话 execution 快照或当前 Composer 的显式选择展示，
不等待完整模型目录。未知模型显示中性入口，未知档位不显示默认档位；不能借用个人、
Host 或其他会话的默认来填充。已有 runtime/View 保留的会话快照可立即用于展示。
相同 Host/runtime 已完成目录中的精确匹配模型元数据可复用显示名称，但只作为展示，
不提供可选项、输入能力或提交授权；按会话隔离的目录与发送时服务端校验保持。
历史会话不读取个人默认和新会话 config/read。目录刷新和分页在后台完成，失败保留
已知会话配置；切换 Host/runtime 后不复用前一个所有者的展示元数据。


## 会话选择与产品目录

Composer 的 `ModelSelectionPolicy` 显式区分三种模式：`user` 使用用户选择，
`host-default` 不提供模型覆盖，`session` 在用户未选择时继承 Host 当前默认、
选择后只影响当前会话。现有会话没有新选择时保持其模型；会话选择不写全局或个人默认。
策略由装配声明，不能仅凭“嵌入”或产品名推断。Web 嵌入入口省略策略时保留原宿主默认。

产品可通过 `readSelectableModels` 提供模型目录的可用项和显示分组/名称/备用角色；
产品设置接口和凭据仍由下游拥有。普通发送不读取产品设置，明确选择只查询已有缓存；
缓存缺失/失败交由 Host 做最终校验，明确的空目录拒绝已删除选择。菜单打开可主动刷新。
这是展示与提交前置检查，不替代服务端授权。模型ID与原生模型值保持区分。

`session` 菜单只显示模型、分组与备用标记；推理档位仍由 Host 管理。刷新保留已有名称，
冷目录显示静态占位，失败与空目录仍可打开重试，原始产品错误不进入菜单。
可选配置动作由装配提供；长名称由容器裁切并提供可复制的完整提示。
共享 Composer 保留触屏编辑焦点与键盘菜单语义，不复制产品设置页。

## Pi Durable execution projection

Headless Pi uses `PiModelEngineAdapter` through the same `ModelEnginePort` and
`ModelConfigurationService` as other engines. Catalog/config reads and new or
resumed execution synchronize the product revision and credential-file stamp.
The same native `ModelRuntime` remains attached to durable sessions; provider
replacement does not recreate ledgers or change existing Thread bindings.
Reads of history and interruption remain available when configuration is invalid.
Failed synchronization rejects catalog/admission until configuration is repaired.

Enabled chat models project their explicit input, limits and reasoning map.
Absent fields use exact provider/catalog ID plus model ID metadata from the SDK,
then its generic custom-model defaults (text, no reasoning, 128000 context and
16384 output tokens). Names never infer capabilities. Every undeclared reasoning
level is excluded; explicit `off: null` supports disabling with an omitted wire
field, while an absent `off` does not advertise disabling. Provider wire strings
are preserved. Speech models and their credentials do not enter this projection.

Native providers use only the product credential resolver; missing referenced
credentials or an unbound (null) reference make that provider unavailable.
The API-key execution port never invents a token to advertise unconfigured endpoints. No key, command or second writable model document is copied to Pi.
Legacy native `models.json` is read once for stable aliases: exact provider ID,
or a unique name/protocol/base URL match. A private `model-provider-bindings.json`
keeps that identity across rename/restart; it owns aliases only, not capabilities
or credentials. Ambiguous alias collisions fail rather than rebind a Thread.
Standalone Pi retains its native configuration when no product port is injected.

Managed Pi default reads/writes use the shared document and CAS. A null product
default remains null; the multi-engine Host also preserves this value rather than
marking its first catalog entry as default. Explicit
conversation and account choices keep their original owners.


The service tier shares this account authority and CAS record. A missing tier in a
legacy record inherits the Host default; explicit null means standard and must
survive reads, writes, reload and submission. Selecting model, effort or speed
pins the resolved model/effort/tier in that draft, and remembers the same personal
default for later conversations. Thread execution settings remain authoritative
for existing conversations; refreshing personal defaults never rewrites them.
Models without the selected tier resolve to standard through the Composer owner.

If neither personal nor Host data resolves a tier, submission leaves the wire
field absent. An unknown legacy/default choice must not be converted to standard.
