# VelaGWSet Provisioner 实施计划

## 1. Request fencing

- 扩展 `SetProvisionRequest`：backend、writer epoch、lifecycle revision、attempt、
  version、claim 和 Kubernetes evidence。
- 为 Memory/MySQL store 增加原子 claim、renew、release、fact commit 和 worker CAS。
- 新 internal API 只暴露 velagwset request；旧 set-manager API 只返回 llmfleet
  request。
- 将任意 status 更新限制在管理兼容路径；状态机只使用 fenced API。

## 2. Staged VelaGWSet

- 先写测试证明 replicas=0 时只创建 admin，不创建 traffic Service/Deployment/PDB。
- CRD 允许 0；status 增加 `AdminReady`，`Ready` 在 0 副本阶段保持 false。
- 从正数改为 0 时清理 traffic 子资源和 PDB。

## 3. Provisioner

- 新增 `internal/velagwset/provisioner` 和 `cmd/velagwset-provisioner`。
- pending/provisioning：Observe CR -> runtime Secret/bootstrap Job -> Managed admin ->
  materialized fact。
- configured：扩 generation 1 traffic -> 等待 Ready -> serving fact。
- 所有 Kubernetes 对象以 digest label + 完整 request annotation 幂等校验。

## 4. Worker handoff

- admin fact 成功后 CAS created -> configured。
- serving fact、runtime route 和 HA 投影成功后 CAS configured -> managed。
- admission 仍在 managed 后执行；managed 前不进入容量候选。

## 5. Deployment and E2E

- Dockerfile 和生产清单加入双副本 provisioner、最小 RBAC 和环境变量。
- OrbStack 证明：旧 manager 继续运行但看不到 velagwset request；新增 Set 只产生
  VelaGWSet，LLMFleet sets 不变化；重启 provisioner/controller 后可续跑。
- 全量 Go 测试、manifest 测试、OrbStack E2E 通过后再准备北京切换。
