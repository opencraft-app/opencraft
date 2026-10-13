# Hermes 镜像 CI 安装器源码对齐

## goal
修复 Hermes CVM 镜像 CI 在 COS DeepSeek Harness 安装器严格字节校验处失败。

## non_goals
不覆盖现网 COS 安装器，不跳过字节校验，不批准镜像后的环境 rollout，不修补用户 VM。

## requirement_refs / requirement_excerpt
当前会话：用户请求启动 Hermes 镜像 CI，得知 COS 安装器与 master 不一致后要求“修复看看？”。

## interface_refs
`.ci/hermes-image.yml` → `images/helpers/verify-deepseek-harness-cos-installer.sh` → `images/helpers/install-deepseek-harness.sh`。
安装器保留 npm integrity 快照、失败回滚、Web profile 并发修改检测和原生浏览器鉴权边界。

## history_context
master 的安装器仍为固定 DSH 兼容版；COS 文件 Last-Modified 为 2026-10-01T12:18:23Z，包含解析 latest 后固化快照、原生浏览器认证桥接、用户插件构建产物恢复与幂等 HMR 修补。
Hermes 流水线 #29 已在此校验失败；构建池 cn-pool 在线，因此不是排队导致该轮失败。

## acceptance
安装器与 COS 字节一致；严格 verifier 正例和不一致负例通过；安装/回滚、认证边界和插件保留测试通过。

## affected_paths
- images/helpers/install-deepseek-harness.sh
- images/tests/test-deepseek-harness-installer.sh
- images/tests/test-deepseek-harness-standalone-contract.sh
- images/tests/test-deepseek-harness-browser-bootstrap.sh
- images/tests/test-deepseek-harness-plugin-payload.sh
- images/README.md

## context_receipt
- AGENTS.md：授权、凭据和隔离工作边界。
- .ci/AGENTS.md、release-gitops domain、CI service context：源码与构建/发布结果区分。
- argocd-ci-secrets adjacency：检查 CI 邻居与 verifier 负例。
- images/README.md、安装器回归测试：快照、回滚、用户插件和认证不变量。
- devops-pipeline/SKILL.md、build-start/startup-info reference：完整构建参数确认与人工 release gate。

## evidence
原 master SHA256 535db778f93dbccadb7265f36eb40408ffffa62a1072b3d0bfa52184b0b2eee3。
COS 及修复源码 SHA256 b25ea3b700989ed5f276360121221167a95e31c1c983f010e0d7225f3a1afda8；62779 bytes。
线上 COS 未写入；修复把当前部署的源码与其既有行为纳入 Git 和回归测试。

## validation
- bash -n：安装器和受影响测试通过。
- test-deepseek-harness-installer.sh：安装、回滚、完整性、并发和用户数据边界通过。
- test-deepseek-harness-browser-bootstrap.sh：可信 loopback 文档导航可换原生 cookie；远端、错误 Host、错误 forwarded host/protocol、API、token query、跨域 origin、iframe 和非导航均不走 bootstrap；幂等通过。
- test-deepseek-harness-plugin-payload.sh：仅恢复未变化自定义插件的缺失构建输出；不覆盖新文件，不恢复管理插件或变更依赖，不复制符号链接。
- standalone-contract、release-retention、COS verifier 正负例通过。
- node frontend/scripts/generate-deepseek-harness-runtime-assets.mjs --check 通过。
- live COS verifier 通过；git diff --check 通过。

## risks
此次验证覆盖源码一致性及隔离安装测试，不替代真实 CVM 镜像构建。源安装器字节保持与现网一致，因此后续仍须同步管理源码和 COS 发布。

## handoff
修复已准备供 MR 评审，未执行新的镜像构建或批准各环境 rollout。
