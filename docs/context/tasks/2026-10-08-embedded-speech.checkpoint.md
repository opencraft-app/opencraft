## stage
源码、构建和本地验证完成；已获提交/MR及合入后上海发布授权。正在准备上海配置，尚未发布。

## verified
- 用户选择进程内缓存，并确认允许复用 VelaGW 现有管理 API。
- Gateway 用登录态内省得到用户 ID，以 name=default 获取/复用用户 Key。
- 缓存 TTL 60 秒、容量 4096、同用户并发合并；202 未就绪结果短时缓存。
- 音频通过有界流式 multipart 代理，不调用 ParseMultipartForm，不落盘。
- VelaGW 与 NewAPI 没有本轮源码变更。
- 中断恢复后重新运行 Service Gateway `go test -race ./...` 与 `go vet ./...`，全部通过。
- Voice/workbench typecheck，语音、听写和嵌入权限测试、平台边界、Web/embedded 构建通过。
- Chromium 使用合成麦克风，1280/390px × 浅/深色四组验证通过：正常写入、取消、换草稿、退出账号的迟到结果隔离。
- 文档检查 errors/warnings 为空、断链 0；身份/运行时 change-impact 已显式传入变更路径并通过。

## unverified
- 生产 Gateway 配置、Secret 投影及上线后的真实公共语音链路尚未验证。
- 真实 iPhone 麦克风权限/录音仍需实际设备验收；合成 Chromium 不是 Safari 实测。

## discard
- 新增 VelaGW 内部 Key API 的方案已撤销，文件及路由变更均已移除。
- 未配置语音服务时不回落到本地预览接口或浏览器系统识别。

## restore
- 主任务 `2026-10-08-embedded-speech.md`。
- 本 checkout `/data/mono2-newapi-hunyuan-asr-20261007`。
- 历史 ASR 发布任务与 release-gitops/release-rings 的旧 dirty 修改需保留，不能夹带本任务提交。
- 本地构建依赖已安装于当前 checkout；禁止借用其他 worktree node_modules。

## next_action
获得提交/发布授权后，按目标区域配置 speech control_url/traffic_url/admin_token_env，发布 Service Gateway 与 OpenCraft 嵌入产物，并实测公共转写。

## release_preparation
- 上海现有 Service Gateway 2/2 Ready，尚未修改 live。
- 工蜂 mcporter-internal 用已有受保护令牌完成只读认证，身份 skipzhang。
- SSM exporter 已生成独立的上海 speech SOPS Secret；仅投影管理令牌，未输出明文。
- 已补齐上海 config、KSOPS generator、release bundle 和 CI paths；需要验证后提交。

## delivery_preflight
- `.ci/frontend.yml` 已覆盖 voice/workbench 源码，自动运行 embedded-workbench 构建并打包至 frontend，无需另建流水线。
- Gateway base 增加 optional `VELAGW_SPEECH_ADMIN_TOKEN` Secret 投影，未配置 speech 的环境不会强制要求它。
- 生产启用仍需目标区域配置及对应 SOPS Secret，不能只更新镜像。
