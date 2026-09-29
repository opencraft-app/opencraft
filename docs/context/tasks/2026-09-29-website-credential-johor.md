# sgprod 新山建站凭据跨地域修复与存量补发

## 目标
新购实例按实际 Sandbox 地域选取 TAT Command；盘点并补齐现网 Hermes 网站凭据和 Website Builder Skill，分别证明新购与存量业务闭环。

## 边界
仅 sgprod 新山/新加坡建站下发链路及经过实时 CTL↔Sandbox↔CVM 对账的生产实例；不修改其他业务凭据、不输出 token、不做跨环境批量假设。保留现有脏工作区，用独立 worktree 实现。

## context_receipt
已读 `AGENTS.md`、`ctl/AGENTS.md`、`sandbox/AGENTS.md`、`argocd/AGENTS.md`、`.ci/AGENTS.md`、`docs/context/domains/release-gitops.md`、`docs/context/domains/site-environment-routing.md`、`docs/context/project/services/ctl.md`；精确检索 `ctl/pkg/instance/async.go`、`sandbox/api-gin/tat.go`、两处 sgprod overlay。

## 门禁与验收
1. CTL 与 Sandbox 以持久化 Sandbox region 双重校验 CommandId；未知地域不签发。
2. Go 聚焦测试、服务编译、GitOps 渲染与 impact guard。
3. 代码/MR、构建镜像、GitOps/Argo 分层验收，不以 MR 合入代表发布。
4. 新机自动下发 TAT SUCCESS/0、文件 metadata、真实能力 200；存量按实时映射去重后批量补发，持久化状态并对账终态。
