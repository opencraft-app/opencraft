---
id: opencraft-desktop-resource-backend
type: task
scope: CTL 桌面资源准备与只读查询，为 OpenCraft 媒体接入提供后端基础。
triggers: ["desktop/resource", "桌面资源准备", "EnsureDesktopResource"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["ctl/pkg/instance/desktop_resource.go", "ctl/docs/cloud-desktop-resource.md"]
status: retired
reviewed_at: 2026-10-04
review_due: 2027-01-02
revision: 1.0.0
precedence: task
derived: false
---

## goal
把显式桌面准备与只读观察分开，后台持续推进准备，并隔离用户/机器改变后的旧状态。

## non_goals
- 不部署、重启、修改 GitOps 或运行真实 TAT，不启动当前机器桌面。
- 不以 VNC 代替约定的 WebRTC，不发布没有媒体/独占输入后端的可用入口。
- 不做未连接输入执行器的控制租约空壳，不变更 Ubuntu/TencentOS 包安装选择。

## requirement_ids / requirement_refs / requirement_excerpt
requirement_ids：当前会话“继续”（外部编号 unknown）；承接已完成插件框架，下一步接 CTL/TAT 后端。

## interface_refs / data_structure_refs
DesktopBackend / DesktopAttachment（OpenCraft）；CTL desktop session、Instance.UserId/SandboxId、TAT PTY/Exec adapter；新增资源 DTO 不返回旧 VNC 密码或地址。

## history_context
- current_design_refs：opencraft/docs/cloud-desktop-plugin.md、docs/engineering/domains/agent-gateway-runtime.md、ctl/docs/cloud-desktop-vnc-verification.md。
- relevant_evolution：本工作树 bbd7ffb83 + 前轮源码框架与 TencentOS 安装改动；尚无 WebRTC 后端。
- superseded_refs：旧 POST/GET desktop/session 保留兼容，但其 GET 会启动/心跳，不作为新资源观察契约。

## acceptance
- POST 明确启动且幂等；准备任务不被请求断开取消；GET 不运行 TAT、不启动资源、不心跳、不创建缓存。
- 当前用户归属与 Sandbox 变化不复用旧 Ready/密码；旧任务迟到不会写入新代次。
- 响应只包含资源 ID、编排代次、准备状态/进度，不包含媒体凭据、地址或原始错误。
- CTL logic/API 聚焦及 race 测试；不冒充真实云/公共网关验证。

## affected_paths
ctl/pkg/instance、transport、errcode、main/api、正式 Domain/Journey 与 OpenCraft desktop 说明。

## required_context / context_receipt
| 文件 | 原因与用途 |
|---|---|
| AGENTS.md、opencraft/AGENTS.md、ctl/AGENTS.md | 源码/权限/验证边界 |
| docs/context/project/services/ctl.md、docs/context/domains/agent-gateway-runtime.md | 路由实际命中；实例权威与网关分离 |
| OpenCraft maintenance SKILL.md + verification.md | 后台资源不属于页面，模拟不替代实际能力 |
| opencraft/docs/cloud-desktop-plugin.md、desktop.go、desktop_test.go | 真实框架与旧编排链路 |
| ctl/main/api/server.go、transport/instance.go、context/context.go | HTTP、序列化、后台身份上下文 |
| service-gateway/AGENTS.md、config_policy_test.go、shprod/config.yaml（只读） | 公共路径是显式 allowlist，不能未经许可改 GitOps |
| docs/context/project/adjacency/README.md | 无 CTL/OpenCraft 专用邻接卡；检查真实相邻 API 与安装测试，不泛读不相干卡 |

## decisions
- 本阶段的 generation_id 是 CTL 编排/绑定代次，不冒充媒体进程的物理 incarnation；媒体接入仍需验证自己的进程身份。
- 后台任务仅持已核验的用户/实例信息，不持 HTTP Bearer/Cookie。
- 新 API 先落 CTL 源码及测试；公共 Gateway 配置保持原样，需要另获发布授权。测试发现 JP/KR 实例前缀路由无精确 path_allow，不能假定所有环境都会阻止新路径。

## risks
已发出的 TAT/后台安装不能靠浏览器 abort 撤回；隔离迟到状态，但不声称分布式事务。跨 CTL 副本持久化/独占媒体仲裁仍待接入。

## validation / evidence
- CTL `go test -p 2 ./... -count=1 -timeout=180s`：最终源码 exit 0（含安装结束时间窗修复）。
- CTL `go test -race -p 2 ./pkg/instance ./main/api -run Desktop -count=1 -timeout=120s`：最终 exit 0；覆盖纯查询、取消/合并、后台安装、嵌套探测锁、换机迟到、账户变更、失败重试和 legacy Ready 凭据隔离。
- Gateway `go test -race -p 2 ./internal/gateway -run 'DesktopResource|DeployConfigsAllowOnlyFrontendInstanceRoutes' -count=1 -timeout=120s`：exit 0；实际配置五个环境 404、JP/KR 进入鉴权 401，合成精确 path_allow 的授权身份覆盖与 200/202 透传。
- Gateway 首轮测试失败暴露 JP/KR 的真实策略差异，及测试配置 Name/PathAllow 错误；已按源码修正，不改生产配置。
- 安装后命令断言先失败，揭示继承旧 pending-probe 窗口导致只探测不立即启动；已清除安装结束的旧启动时间窗，补具体启动命令回归。
- docs-impact（显式变更清单 + staged）：passed；正式文档 validator：exit 0、errors=[]；`git diff --check`：exit 0。
- 全仓 Context validator 仍报 5025 个既有字段/历史任务问题；本次 Task Pack 最初 source_of_truth 数组格式已修正，单独筛选该 Task Pack 的错误为 []。生成 catalog 已更新，不改无关历史任务。
- 当前 `opencraft-neutral-focus-20261004-preview.service` 仍 active，MainPID=2785955；没有重启/切换/真实 TAT/安装运行。

## scan_scope / scan_output
有界 CTL desktop/HTTP、Gateway allowlist、OpenCraft 桌面契约。未发现既有 WebRTC 运行服务。

## handoff
源码准备阶段完成，未部署；下一阶段媒体进程、信令、Conversation 授权映射及后端强制输入授权仍需实现。OpenCraft 没有注入真实 adapter，入口继续隐藏。

## checkpoint

### stage
桌面资源准备源码及测试完成，交接，不扩大到媒体或发布。

### verified
CTL 全量、桌面 race、Gateway 策略/合成路由 race、正式文档与 impact；旧 Ubuntu/TencentOS 安装分支和当前预览保持。

### unverified
真实 TAT/云端安装、WebRTC、输入设备、控制租约、跨 CTL 副本与重启持久性；公共新路径未发布。

### discard
不能将 prepared 当媒体就绪；不能将编排 generation 当物理 incarnation；不能将所有环境描述为精确白名单阻断。

### restore
源码 worktree 为 mono2-cloud-desktop-tencentos-20261004，仍 detached bbd7ffb83；保留此前 TencentOS 和插件框架改动，未提交。

### next_action
接真实媒体/输入执行器并实现授权 attachment 与控制仲裁，再做公共路由和真实客户端验收；不要先显示可用入口。
