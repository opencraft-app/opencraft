# 修复系统预置 Skills 来源误标 - 验证报告

## 结果

- 国内站 SkillHub 已安装响应的 item 或 instance 明确返回 `source: builtin` 时，保留为 Hermes 系统预置来源。
- SkillHub 记录与 Hermes 清单合并时，Hermes 的 `builtin` 判定覆盖市场来源展示，最终显示“系统预置”且不可删除。
- 普通 SkillHub 记录仍显示 SkillHub，并保持原有卸载能力；搜索与安装流程未改动。

## 变更

- 修正 SkillHub installed item/instance 的来源映射与卸载能力。
- 修正 registry/Hermes 合并后的 builtin 权威性和 Installed 来源徽标优先级。
- 新增 parser、merge、UI 回归测试，并同步站点路由正式设计文档。
- 迁移 6 个因新增代码行而变化的既有 TypeScript baseline 位置；错误码、指纹与数量不变，未吸收新诊断。

## 验证

- 定向 Vitest：2 个文件、104 个测试通过。
- `pnpm i18n:check`：通过。
- `pnpm check`：通过，0 个新增 TypeScript 诊断；保留 48 个既有 i18n 告警。
- `git diff --check`：通过。
- 文档校验：通过，0 errors、0 warnings、0 broken first-party links。
- 仅暂存本次补丁的 change-impact 校验：通过，正式设计文档映射已满足。

## 未覆盖边界

- 未连接真实生产 Agent/ACLI 响应做浏览器回归；当前证据覆盖数据解析、来源合并和组件删除入口。
- 源码变更尚未 commit、push、创建 MR、发布或证明生产生效。
