# 国内站 Skills 多 Bot Profile 隔离

## 适用范围

国内站 Skills/Discover、Installed 与 Experts 的实例技能命令。Bot 与 Hermes Profile 是不同标识；使用 `/bots` 返回的 `profile_id`，主 Bot 的公开别名为 `main`。SkillHub HTTP 搜索不依赖实例 Profile。
国际站 Skills/Experts 的既有命令包装路径不变。

## 命令契约

- `acli skills` 的 list、install、batch-install、uninstall 都带 `--agent <profile_id>`。缺少或非法 `profile_id` 时，前端不向实例下发技能命令，不能默认回退主 Bot。
- 兼容旧稳定 ACLI：命令同时设置 `ACLI_SYS_RUNTIME_HOME` 为 Hermes 根目录、`ACLI_RUNTIME_HOME` 为所选 Profile 目录。旧包的 list/uninstall 使用后者；新版由前者和 `--agent` 解析作用域。主 Bot 两者均指根目录。
- Hermes 原生、位于所选 Profile `skills/` 的技能通过 `acli skills uninstall <slug> --source local` 删除；不用前端拼接 `find/rm -rf`。卸载后重新读取所选 Profile 的技能列表确认结果。外部目录来源不在这个卸载目标内。
- 旧 ACLI 不支持 `batch-install --agent` 时，退回逐个 Profile-aware 安装；其它批量失败仍按现有失败路径处理。

## 验证边界

单测覆盖缺失 Profile、主/命名 Profile 命令、原生技能卸载与批量回退；新旧 ACLI 在隔离运行目录下分别卸载子 Profile 的同名技能，确认主目录文件保留。该设计不代表生产实例已升级、站点已发布。
