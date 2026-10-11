# custom/auto 新实例与恢复默认配置修复

## goal
平台 Hermes custom/auto 在新实例创建与恢复默认配置后显式声明图片能力。

## non_goals
- 镜像重建、存量批量修改、其他模型、音频、生产发布、合并 MR。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户收窄：“新建实例和恢复默认配置”；用户确认现有 Hermes “支持”能力字段。
- 用户最新授权：“那可以提mr 更新了是吧”；本次包含 commit、push、MR，外部需求单 unknown。

## interface_refs / data_structure_refs
- CTL renderHermesModelCommand 在 ACLI/harness 保存和切换模型后合并并回读 providers.custom.models.auto.supports_vision；兼容 legacy custom_providers。
- 前端 reset_to_platform_default 在重建 provider 后补齐该字段，清除旧主模型的顶层 supports_vision，保存回读失败进入既有配置/凭据回滚。
- 保持其他模型 metadata、其他配置和显式 agent/auxiliary 图片路由策略。

## history_context
- current_design_refs: docs/engineering/domains/agent-gateway-runtime.md；frontend/openspec/changes/2026-09-03-configured-model-provider-switch-design.md。
- relevant_evolution: 原实现 checkout 468da9350；MR 分支基于本地缓存 origin/master 3bc4384e5（2026-10-10），fetch 因 git.woa.com DNS 失败，未确认远端最新；Hermes 官方源码说明模型级字段与热读取；现有新建链路只传模型 ID/名称。
- superseded_refs: input 字段不能代替 Hermes supports_vision；镜像不属于本次修复面。

## acceptance
- 仅平台 custom/auto 补能力；创建 ACLI/harness、legacy、幂等、metadata 保留测试通过。
- 恢复默认后旧顶层 false 不覆盖能力；其他模型不声明；运行时丢字段触发回滚。
- 同步 OpenCraft Agent Console 生成副本并检查一致性。

## affected_paths
- ctl/pkg/instance/async.go、ctl/pkg/instance/auto_vision_test.go。
- frontend/src/pages/marketing/agent-model-config/hermes-model-config-command.ts 及对应 model-config-client.test.ts。
- opencraft/plugins/lightvela-hermes/src/upstream/mono2 对应生成文件与 UPSTREAM.json。
- docs/engineering/domains/agent-gateway-runtime.md。

## required_context
- frontend-product-surface、service-ctl、service-frontend、agent-gateway-runtime、control-plane-ops、site-environment-routing。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md、frontend/AGENTS.md、ctl/AGENTS.md | 写入和验证边界 | 按用户授权提交 MR，不发布，聚焦门禁 |
| docs/context/project/services/frontend.md、docs/context/project/services/ctl.md | 配置 authority | 两个入口分别修复 |
| docs/context/domains/agent-gateway-runtime.md、docs/context/domains/site-environment-routing.md | runtime 与端点归属 | 限定平台模型 |
| docs/context/flows/tapd-gongfeng-delivery.md、.agents/skills/gongfeng/SKILL.md | MR 交付边界 | 用户授权提交；现有连接发现 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 测试邻接 | 配置保存回读测试 |
| opencraft/AGENTS.md、opencraft/MONO2_MIGRATION.md、docs/context/project/upstream-subtrees.md | 副本边界 | 官方脚本同步，仅两个生成文件变化 |
| frontend/openspec/changes/2026-09-03-configured-model-provider-switch-design.md | 当前模型写入设计 | 不改变默认模型 ID |

## evidence
以下首先记录原实现 checkout 的验证；MR 分支复核见 validation。
- 首轮配置测试 93 passed；新增回滚/其他模型用例后 95 passed。
- 实际 Go 命令渲染源码自动提取至 /tmp/custom-auto-go-8ncjkh7c，用仓库 auto_vision_test.go 独立执行：ACLI、harness、legacy、scope 全部通过；不等于完整包编译。
- 默认 Go 缓存缺依赖；改用已有 /data/opencraft-migration-20261009/data/go/pkg/mod 离线缓存与 Go 1.26 后，相关 instance 包测试通过，go vet ./pkg/instance 通过；未更改 go.mod/go.work。
- 完整模型配置套件 7 files / 234 tests passed。
- 完整 instance 包测试仅 TestDestroyInstanceDoesNotRecordAcceptedEventWhenAlreadyDeleting 失败，报 rootless Docker not found。
- 显式跳过上述 Docker 用例后，go test ./pkg/instance 全部通过（5.600s）。
- OpenCraft 副本同步和 check 通过，130 文件闭包仅 helper 与 manifest 变化；插件 typecheck 通过。
- frontend check：171 current / 171 baseline / 0 new diagnostics。
- 文档校验 errors=0；OpenCraft 的筛选测试仅报告文件级通过，未作为本次 helper 行为验证证据。
- 后续本机真实 Hermes 0.21.0 验证：实际解释器 /usr/local/lib/hermes-agent/venv/bin/python，隔离 HERMES_HOME，直接运行 CTL helper 和前端完整 Python reset helper（含真实 RSA 凭据信封、配置/凭据 API），均真实保存回读成功。同一进程 load_config 在写入后失效缓存，decide_image_input_mode 返回 native。
- 真实 AIAgent._prepare_messages_for_non_vision_model 保留 image_url 部件，解码后的 PNG 字节与原文件一致；未调用线上模型 API，不作为网关端到端识图证据。本机 /root/.hermes/config.yaml 前后 SHA-256 一致。脚本 /tmp/custom-auto-local-hermes/verify.py，结果 /tmp/custom-auto-local-hermes/result.log。

## risks
- CLI 本身未提供已验证的 capability 参数，因此 CTL 用现有 Hermes load_config/save_config 在保存后补齐并回读；后续失败会使初始化失败而非静默报告成功。
- 完整 CTL 包门禁仍需 Docker 环境；实际运行实例与网关请求未验证。

## validation
- MR 分支配置套件重新执行：7 files / 234 tests passed。
- MR 分支 CTL 包测试因新主干 OpenTelemetry sdk/metric v1.39.0 缓存缺失，GOPROXY=off 无法解析，尚未编译；不沿用旧基线结果宣称新基线通过。
- 已有工蜂技能连接发现完成：默认及宿主配置无 gongfeng 连接；git.woa.com DNS 不可用。
- 前端 Turbopack build 长时间停在 compile，webpack 替代构建也未在验证窗口内完成，均已中止；完整 build 未通过验证，不作为发布证据。OpenCraft 整文件测试长时间无输出已中止；筛选运行只报告文件级通过，不作为功能证据。
- git diff --check、按实际 changed-file 的 docs-impact 校验通过；--staged 校验也执行，但无 staged 文件。

## decisions
- 镜像不动；能力落在模型级；不依赖未验证的 ACLI metadata 参数。

## scan_scope
- 仅相关配置写入、命令生成、测试与生成闭包。

## scan_output
- 测试日志 /tmp/custom-auto-*.log；不含真实凭据。

## handoff
- MR 分支 fix/custom-auto-vision-20261011，待本地提交、生成副本独立提交和 push；网络阻碍远端交付，不宣称 MR 已创建。验证缺口须在正常 CI 补齐。
