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

reasoning 保持已有不变量：无能力不发送档位，有能力的默认必须属于支持集合；`none` 只在明确支持时有效。选择、展示和编译共享解析，不用首档位充当缺失默认。

## 提交与应用

1. 在 OpenCraft 文件锁内校验 revision 和完整文档。
2. 写入私有临时文件并原子替换 models.json。
3. 串行将最新文档应用到引擎。
4. 独立报告 applied/failed；失败不撤销产品配置，界面提供重试应用。

读取时比较产品 revision 和凭据文件版本，必要时重新应用；不会把旧引擎响应写回仓库。坏 JSON、未知版本或非法字段报错，禁止清空重建。跨进程写入通过文件锁与 CAS 防止覆盖。文件替换保证读者不读到半份 JSON；不承诺断电级 fsync 持久性。

## 迁移与验证

首次初始化可从明确的旧 DSH 目录做一次性导入；先校验和备份，再转成产品结构。只导入相关 API Key 引用，保留旧文件。目标 models.json 已存在时不自动合并或覆盖；凭据引用冲突则中止。更换 preview profile 不改变产品模型目录。

自动化必须显式传入隔离的 modelStorageDirectory，桌面测试通过 OPENCRAFT_MODEL_STORAGE_DIRECTORY 指定；不得让测试写入真实用户文件。验证包含无引擎的仓库/替代引擎测试、引擎失败后配置保留、真实 DSH 跨运行目录重启恢复。会话历史和登录状态仍有各自的存储所有者，不在本次模型迁移中移动。
