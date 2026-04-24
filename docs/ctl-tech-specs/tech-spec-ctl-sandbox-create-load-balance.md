---
title: 'CTL 创建 Sandbox 负载均衡选池'
slug: 'ctl-sandbox-create-load-balance'
created: '2026-03-31T00:00:00+08:00'
status: 'implementation-complete'
stepsCompleted: [1, 2, 3, 4]
tech_stack:
  - Go 1.24+
  - GORM
  - Redis (go-redis/v9)
  - sandbox internal API
  - zap
files_to_modify:
  - ctl/pkg/instance/logic.go
  - ctl/pkg/instance/async.go
  - ctl/pkg/instance/churn_guard.go
  - ctl/pkg/instance/logic_test.go
  - ctl/pkg/instance/async_integration_test.go
  - ctl/pkg/config/define.go
  - ctl/conf/server/common/server_conf.toml
  - ctl/conf/local/common/server_conf.toml
  - docs/developer-guide/sandbox-template.md
code_patterns:
  - '创建链路保持 API 入队、worker 真正调用 sandbox 的异步模式'
  - '候选池范围沿用 [api.instance].default_template_id + candidate_template_ids，不扫描全量 pools'
  - '已有 pool pressure 快照来自 bypass/Redis，创建链路优先只读已有快照，拿不到时按配置候选降级'
  - 'sandbox 创建失败时仅对可回退错误切换下一候选池，认证/限流/上下文取消类错误不回退'
  - '失败回退规则沿用 shouldFallbackToNextTemplate，不重新发明错误分类'
test_patterns:
  - 'logic 单测覆盖候选池排序、失败切换、非可回退错误中止'
  - 'async/integration 测试覆盖 worker 创建成功、重试成功、全量失败'
  - '现有 ctl 测试模式以 stub sandbox adapter + 数据库集成测试为主'
---

# Tech-Spec: CTL 创建 Sandbox 负载均衡选池

**Created:** 2026-03-31T00:00:00+08:00

## Overview

### Problem Statement

当前 `ctl` 在创建实例时，本质上仍按固定顺序尝试配置里的 candidate pool。这样会导致流量长期先压到某一个 pool，上游 `sandbox` 的库存压力分布不均；当首选 pool 抖动或库存不足时，也容易把失败集中放大。

同时，当前创建请求不需要让调用方理解 pool 语义。pool 选择应该完全由 `ctl` 根据自身配置和实时压力处理，而不是由 API 请求指定。

### Solution

在 `ctl` 创建 sandbox 的 worker 路径中，把“固定顺序尝试 pool”改成“基于配置候选池集合的负载均衡选择”。若能读到已有 `pool pressure` 快照，则对候选池做加权排序后依次尝试；若拿不到快照，则退化为配置候选池的默认顺序。单次创建在限定次数内自动切换到下一个候选池，最终仍只返回一次创建结果。

### Scope

**In Scope:**
- `ctl` 内部自行决定 sandbox 创建使用哪个候选 pool
- 候选范围只取配置中的 `default_template_id` 和 `candidate_template_ids`
- 利用现有 `pool pressure` 快照进行加权选择
- 创建失败后自动切换候选池，并限制最大尝试次数
- 删除/拒绝请求里指定 pool 的能力，不做兼容保留

**Out of Scope:**
- 扫描 `sandbox` 全量 pool 并动态纳管非配置池
- 修改 `sandbox` 服务的 pool 管理模型
- 引入新的持久化表或复杂的长期调度器
- 对外暴露新的 pool 选择 API

## Context for Development

### Codebase Patterns

- `ctl/pkg/instance/logic.go` 已有 `templateCandidates()` 和 `createSandboxWithFallback()`；当前问题不在“有没有候选池”，而在“候选顺序是固定的”。
- `ctl/pkg/instance/async.go` 的 `RunCreateInstanceTask()` 在 worker 中调用 `createSandboxWithFallback()`；这里是接入负载均衡选池的真正落点。
- `ctl/pkg/instance/churn_guard.go` 已经有 Redis `poolPressureSnapshot`、`candidatePoolIDsFromConfig()` 和 stale 判定逻辑，因此实现上应复用现有 snapshot，而不是再去同步扫 `sandbox`。
- `ctl/pkg/config/define.go` 的 `InstanceAPIConfig` 已承载 churn/pressure 配置；若需要最大尝试次数配置，应继续放在同一配置域中。
- `ctl/pkg/transport/instance.go` 当前 `CreateInstanceRequest` 只有 `timeout` 和 `soul_template_id`，并不存在 pool 指定入参；因此本需求在 API 层的工作重点是“保持不暴露该能力”，不是做兼容删除。
- `template` 在当前 CTL 语义里实际映射到 `sandbox pool.id`，这一点已经写在 `docs/developer-guide/sandbox-template.md`，所以本次命名可先沿用，避免大范围重命名。
- 当前已有 `shouldFallbackToNextTemplate()`，说明创建失败后切下一个候选池的错误分类规则已经存在，可以沿用并在此基础上增加“最大尝试次数”和“排序后的候选顺序”。

### Files to Reference

| File | Purpose |
| ---- | ------- |
| `ctl/pkg/instance/logic.go` | 候选池聚合、fallback 逻辑、错误分类入口 |
| `ctl/pkg/instance/async.go` | worker create 主链路、最终成功/失败 metric |
| `ctl/pkg/instance/churn_guard.go` | 读取候选池 pressure snapshot 的现成数据结构和来源 |
| `ctl/pkg/config/define.go` | `api.instance` 配置承载位置，适合新增最大尝试次数等参数 |
| `ctl/pkg/instance/logic_test.go` | 现有 create fallback 顺序测试，可扩展为 weighted order/attempt limit 测试 |
| `ctl/pkg/instance/async_integration_test.go` | worker 路径集成测试，覆盖首池失败后切换成功等场景 |
| `docs/developer-guide/sandbox-template.md` | template 与 sandbox pool 的映射约束 |

### Technical Decisions

- pool 选择完全由 `ctl` 内部处理；调用方不能指定 pool。
- 候选池仅来自现有配置，避免误用其他业务线或实验 pool。
- 若有 pressure snapshot，则按压力做加权/排序；若没有，则降级为配置顺序，不能因为快照缺失而阻断创建。
- 创建失败后自动切换候选池，但要限制最大尝试次数，避免一次请求打穿全部候选池并放大上游压力。
- 不保留旧的“请求可指定 pool”兼容接口，因为当前无人使用，直接收敛到单一实现。
- 结合现状，优先做法是新增一个“根据 snapshot 生成本次有序候选池列表”的纯函数，再让 `createSandboxWithFallback()` 消费该结果；不要把选池算法散落到 API 和 worker 两侧。
- 由于 `CreateInstanceRequest` 当前并无 pool 字段，`ctl/pkg/transport/instance.go` 大概率无需改动；除非实现阶段发现其他入口意外暴露了 pool 语义。

## Implementation Plan

### Tasks

- [x] Task 1: 为 create 选池增加显式配置边界
  - File: `ctl/pkg/config/define.go`
  - Action: 在 `InstanceAPIConfig` 中新增 create 选池最大尝试次数配置，例如 `create_pool_max_attempts`，并约定 `<=0` 时按候选池数量兜底。
  - Notes: 不新增新的候选池来源配置；候选池仍严格来自 `default_template_id + candidate_template_ids`。

- [x] Task 2: 在 instance 领域实现“基于 pressure snapshot 的候选池排序”纯函数
  - File: `ctl/pkg/instance/churn_guard.go`
  - Action: 基于现有 `poolPressureSnapshot`、`poolPressurePoolSnapshot` 和 stale 判定，新增只读 helper，从 Redis 快照中提取当前候选池的压力信息，并输出按权重排序后的候选池列表。
  - Notes: 只使用配置候选池；排序优先体现 `clean` 更高、`creating/dry/resetting` 更低、`paused/broken` 池靠后。快照不存在、过期、缺少部分池数据时必须可降级。

- [x] Task 3: 重构 sandbox 创建 fallback 入口，消费“排序结果 + 最大尝试次数”
  - File: `ctl/pkg/instance/logic.go`
  - Action: 将 `createSandboxWithFallback()` 从“固定遍历 templateCandidates”改为接收本次已排序候选列表，并在循环中裁剪到最大尝试次数。
  - Notes: 继续沿用 `shouldFallbackToNextTemplate()` 做可回退错误判定；失败信息中保留每次尝试的 pool/template 与错误摘要，便于排障。

- [x] Task 4: 在 worker create 主链路接入负载均衡选池
  - File: `ctl/pkg/instance/async.go`
  - Action: 在 `RunCreateInstanceTask()` 中，先取配置候选池，再读取/计算本次有序候选池列表，然后调用重构后的 `createSandboxWithFallback()`。
  - Notes: API 同步入口不提前决定 pool，避免 enqueue 时固化瞬时顺序；成功 metric 继续打实际成功的 `sandboxResp.TemplateID`。

- [x] Task 5: 更新运行配置与文档，明确“调用方不能指定 pool，ctl 自行负载均衡”
  - File: `ctl/conf/server/common/server_conf.toml`
  - Action: 增加新配置项示例与默认值。
  - File: `ctl/conf/local/common/server_conf.toml`
  - Action: 保持本地配置结构一致，避免本地解析缺字段。
  - File: `docs/developer-guide/sandbox-template.md`
  - Action: 补充说明 CTL 现在会在配置候选池集合内按 pressure 做负载均衡，而不是固定先打 default pool。
  - Notes: 文档里继续强调不扫描全量 pool，也不支持调用方指定 pool。

- [x] Task 6: 补齐单元测试和集成测试
  - File: `ctl/pkg/instance/logic_test.go`
  - Action: 把现有 fallback 顺序测试扩展为覆盖 weighted 排序、快照缺失降级、不可回退错误中止、达到尝试上限即停止。
  - File: `ctl/pkg/instance/async_integration_test.go`
  - Action: 增加 worker 路径测试，验证首池失败后按新顺序切换成功，以及达到上限后实例最终失败。
  - Notes: 继续使用现有 sandbox adapter stub，不引入真实 sandbox 依赖。

### Acceptance Criteria

- [ ] AC 1: Given `ctl` 配置了多个 candidate pool，When 用户调用 `POST /v1/instances`，Then 请求体中不存在也不接受指定 pool 的字段，pool 仅由 `ctl` 在配置候选集合内自行决定。
- [ ] AC 2: Given 候选池存在可用的 pressure snapshot，When worker 执行创建，Then `ctl` 会基于 snapshot 对候选池做负载均衡排序，而不是固定先打到配置中的第一个池子。
- [ ] AC 3: Given 候选池没有可用 snapshot、snapshot 已过期，或 snapshot 仅覆盖部分候选池，When worker 执行创建，Then `ctl` 仍能在配置候选池集合内生成可用顺序并继续创建，不因快照缺失直接失败。
- [ ] AC 4: Given 首个候选池创建失败且错误属于 `shouldFallbackToNextTemplate()` 定义的可回退类型，When 当前尝试次数尚未超过上限，Then `ctl` 会自动切换到下一个候选池继续尝试。
- [ ] AC 5: Given 创建失败属于上下文取消、认证失败、限流或其他不可回退错误，When worker 收到错误，Then `ctl` 不会继续切换其他候选池，而是立即结束并返回失败。
- [ ] AC 6: Given 候选池连续失败且达到最大尝试次数，When worker 结束，Then 实例最终标记为 `Failed`，quota 正常回滚，并在错误信息中保留已尝试池子的失败摘要。
- [ ] AC 7: Given 某个候选池在 pressure snapshot 中处于 paused、broken 或 clean 明显不足的高压状态，When 仍有其他更健康的候选池存在，Then 该池在本次排序中应被后置，而不是稳定排在首位。

## Additional Context

### Dependencies

- 依赖现有 `sandboxAdapter.CreateSandbox` 能按 `TemplateID` 指向指定 pool 创建。
- 依赖 `churn_guard` 已刷新到 Redis 的 pool pressure snapshot；若无数据，策略必须可降级。
- 依赖现有 `shouldFallbackToNextTemplate()` 错误分类保持稳定，否则自动切池语义会变化。
- 依赖 `ctl` 配置里的 `default_template_id` / `candidate_template_ids` 正确维护，这仍然是唯一候选池 source of truth。

### Testing Strategy

- 为选池函数写纯单元测试，验证不同 pressure 组合下的排序与尝试上限裁剪。
- 复用 `logic_test.go` 中的 `sandboxAdapterStub`，验证 create 请求的 `TemplateID` 顺序符合预期。
- 在 `async_integration_test.go` 增加“首池失败、次池成功”与“超过尝试上限失败”路径。
- 手动验证时应重点检查日志里记录的尝试顺序，确认实际命中的是排序后的 pool，而不是配置首项。
- 若实现落地到测试环境，建议额外观察 create success/fail metric 标签是否仍然是最终成功的实际 pool/template。

### Notes

- 当前代码里的 `template` 命名与真实 `pool` 语义不完全一致；本次 spec 默认先沿用命名，避免改动范围过大。
- 若后续实现发现需要把“最大尝试次数”做成配置项，应优先放在 `api.instance` 下，并默认不超过候选池数量。
- 当前 `uniqueNonEmptyStrings()` 会排序字符串；如果直接复用于创建候选池顺序，可能把配置顺序抹平。实现时需要明确哪些地方允许排序、哪些地方必须保留原始配置顺序作为降级顺序。
- 如果 snapshot 只包含部分候选池，推荐策略是“有快照的先按权重排序，缺快照的尾部按配置顺序补齐”，而不是直接丢掉这些候选池。
