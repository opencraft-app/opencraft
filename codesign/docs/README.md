# Codesign 与平台交付知识

`codesign` 不是线上服务，而是受控平台接入的共置知识入口，保存流程、权限设计、审计元数据和已验证/未闭环结论。

## 权威入口

- [目录导航](../README.md)、[写作与安全约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- [发布与 GitOps 领域](../../docs/engineering/domains/release-gitops.md)

## 关键边界

可以记录 UIN、ProjectId、PolicyId、Deployment ID 和策略结构；不得提交密码、SecretId/SecretKey、API Token、cookie、kubeconfig 或可复用临时鉴权链接。外部平台实时状态必须现场查询，文档只保存可复用流程和时间点证据。

## 验证

每次更新必须明确“做了什么、为什么、实际结果、未闭环项”，并检查示例中没有敏感值。
