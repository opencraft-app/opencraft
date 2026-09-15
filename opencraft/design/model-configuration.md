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

## 提交与应用

1. 在 OpenCraft 文件锁内校验 revision 和完整文档。
2. 写入私有临时文件并原子替换 models.json。
3. 串行将最新文档应用到引擎。
4. 独立报告 applied/failed；失败不撤销产品配置，界面提供重试应用。

读取时比较产品 revision 和凭据文件版本，必要时重新应用；不会把旧引擎响应写回仓库。坏 JSON、未知版本或非法字段报错，禁止清空重建。跨进程写入通过文件锁与 CAS 防止覆盖。文件替换保证读者不读到半份 JSON；不承诺断电级 fsync 持久性。

## 迁移与验证

首次初始化可从明确的旧 DSH 目录做一次性导入；先校验和备份，再转成产品结构。只导入相关 API Key 引用，保留旧文件。目标 models.json 已存在时不自动合并或覆盖；凭据引用冲突则中止。更换 preview profile 不改变产品模型目录。

自动化必须显式传入隔离的 modelStorageDirectory，桌面测试通过 OPENCRAFT_MODEL_STORAGE_DIRECTORY 指定；不得让测试写入真实用户文件。验证包含无引擎的仓库/替代引擎测试、引擎失败后配置保留、真实 DSH 跨运行目录重启恢复。会话历史和登录状态仍有各自的存储所有者，不在本次模型迁移中移动。
