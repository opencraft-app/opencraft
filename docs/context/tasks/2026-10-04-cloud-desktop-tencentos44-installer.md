---
id: cloud-desktop-tencentos44-installer
type: task
scope: CTL 云桌面按需安装适配 TencentOS Server 4.4；不实装或部署。
triggers: ["TencentOS 4.4", "云桌面安装脚本", "renderDesktopInstallCommand"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - ctl/pkg/instance/desktop.go
  - ctl/pkg/instance/desktop_install_packages.go
status: retired
reviewed_at: 2026-10-04
review_due: 2027-01-02
revision: 1.0.0
precedence: task
derived: false
---

# 云桌面按需安装：TencentOS 4.4

## goal
使 CTL 的云桌面按需安装脚本明确支持 TencentOS Server 4.4，保留现有 Ubuntu/Debian 安装分支。

## non_goals
- 不扩展 Ubuntu 专用的 images/build.sh，不安装或启动当前机器的桌面。
- 不实现 WebRTC，不变更会话、鉴权、TAT、端口、回收或 OpenCraft UI。
- 不部署、重启预览、提交或推送；不改动 /data/mono2 的既有脏工作树。

## requirement_refs
用户：改造一下这个脚本，适配一下 TencentOS 4.4。承接云桌面图形环境准备的评估。

## interface_refs / data_structure_refs
- ctl/pkg/instance/desktop.go：renderDesktopInstallCommand、安装进度 marker、4 个 systemd unit。
- agentuser 和 /home/agentuser 为既有 TAT/桌面契约；不自动创建用户或回退 root 会话。

## history_context
- current_design_refs：docs/engineering/domains/agent-gateway-runtime.md 的 CTL Desktop provision 语义。
- relevant_evolution：origin/master@bbd7ffb83 已有复用主 sandbox 的按需 apt 安装；当前 /data/mono2 的旧工作树没有这套源码。
- 在独立 worktree /data/mono2-cloud-desktop-tencentos-20261004 实现，不覆盖其它任务。
- superseded_refs：无；未使用旧工作树缺失的云桌面实现推断现状。

## acceptance
- Ubuntu/Debian 使用既有 apt 包；只在 ID=tencentos、VERSION_ID=4.4 时使用 dnf。
- 包缺失/仓库不可用、未知系统、权限不足、服务文件写入失败均不得报安装完成。
- 使用原生 BaseOS/AppStream/EPOL；不添加外部 EPEL、不关闭 SELinux/防火墙。
- 包安装模拟执行、Bash 语法、既有桌面回归与文档影响门禁通过；真机安装单独列为未验证。

## affected_paths
- ctl/pkg/instance/desktop.go
- ctl/pkg/instance/desktop_install_packages.go
- ctl/pkg/instance/desktop_install_packages_test.go
- ctl/pkg/instance/desktop_test.go
- ctl/docs/cloud-desktop-vnc-verification.md
- docs/engineering/domains/agent-gateway-runtime.md

## required_context / context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md、ctl/AGENTS.md | 仓库与服务约束 | 隔离改动、验证与权限边界 |
| docs/context/project/services/ctl.md | 路由 must_read | CTL 与 Sandbox 的执行归属 |
| docs/context/domains/agent-gateway-runtime.md | 路由 must_read | 运行时领域不变量 |
| docs/context/project/adjacency/argocd-ci-secrets.md、.ci/ctl.yml | 相邻交付入口 | 源码修改不代表发布 |
| images/README.md | 相邻镜像契约 | 保持 Ubuntu 镜像专用 |
| docs/engineering/domains/agent-gateway-runtime.md | 正式设计 | 同步安装分支与失败语义 |
| ctl/docs/cloud-desktop-vnc-verification.md | 验收邻居 | 补充 TencentOS 前置条件 |

## evidence
- /etc/os-release：ID=tencentos、VERSION_ID=4.4；x86_64，dnf 4.16.2。
- dnf --cacheonly list --available：Xvfb/dbus/中文字体在 AppStream；XFCE/x11vnc/novnc/python3-websockify 在 EPOL。
- dnf --cacheonly repoquery --list：/usr/share/novnc/vnc.html、/usr/bin/websockify、/usr/bin/startxfce4。
- dnf --cacheonly provides /usr/bin/dbus-run-session：dbus-daemon（AppStream）。

## risks
- 未实装、未启动图形服务；仓库可用不等于真机桌面验收通过。
- 目标必须预置 agentuser、匹配 home、非交互 sudo 和运行中的 systemd。
- 当前开发机器 getent passwd agentuser 无结果；后续试装前需先确认运行账户接入，不可直接认为当前机器已具备桌面前提。
- 旧的包/服务版本可能变化；安装后验证 unit 实际使用的文件，不猜替代路径。

## validation
- GOPATH=/root/go GOCACHE=/root/.cache/go-build /data/go/bin/go test -p 2 ./pkg/instance -count=1：通过（31.812s）。
- go test ./pkg/instance -run TestDesktopInstallScript -v -count=1：21 个模拟场景与内外两段 Bash 语法通过。
- go vet -p 2 ./pkg/instance：通过；gofmt -l 与 git diff --check 无输出。
- validate_documentation.py --repo . --format json：无错误、无坏链接。
- validate_change_impact.py 按实际 7 个变更路径检查：agent-gateway-runtime 映射通过，仍提示正式合并需领域 Owner 审阅。
- validate_change_impact.py --staged：通过但 staged 为空，以上显式变更路径检查才是本次有效检查。
- 仓库级 validate_context --build-catalog 存在旧任务文档 schema 缺失等问题；Context 的 26 项测试中 4 项失败。context-audit 的 33 项测试通过，证据采集也完成，但不替代 Context 契约检查。未修改无关旧文档，不声称全部仓库门禁通过。
- build-catalog 带来的旧条目生成漂移已撤回（只撤回本轮生成物）；没有留下与本次安装脚本无关的目录生成变更。
- 最终只读 Context 校验：本任务文档错误为 0；仓库其余既有错误 5026 项。失败的 4 项 Context 测试为治理资产完整性、中文文档、服务 Context 预算与全仓契约验证。
- 首次扩展失败检查后，模拟测试的 heredoc 提取锚点未同步，出现一次失败；修正测试锚点后已重跑全量包测试和模拟场景，以上为最新结果。

## decisions
将发行版差异限制在包安装片段；公共 unit、用户身份和 CTL 进度协议不分叉。

## scan_scope / scan_output
有界扫描 ctl/pkg/instance、ctl/docs、images/README.md 与已路由设计文件；没有扫描或输出凭据。

## handoff
源码与测试完成，变更保留在独立工作树；没有实装、重启、部署或提交。真机图形验收需另获执行确认并选择测试实例。

## checkpoint
### stage
实现完成，已通过包测试、静态检查、文档链接和实际变更影响检查；等待交接。
### verified
TencentOS 原生 EPOL 有所需 XFCE/VNC 包；Go 1.26 下包测试和模拟安装通过。
### unverified
实际安装与桌面连接尚未验证。
### discard
无需给整个 Ubuntu 镜像流水线增加 TencentOS 分支。
### restore
在上述独立工作树续接，保留原脏工作树。
### next_action
交接独立工作树中的修改；真机安装/连接验收另行确认。
