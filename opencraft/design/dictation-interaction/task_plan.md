# Composer 听写交互整改

目标：深入复用Codex恢复源码的语音Footer/停止写入与转写发送语义，对照BB互斥工具栏与可访问性；沿用我们的主题控件及原生Speech。
非目标：不更换识别引擎、不复用Codex认证、不自动录音、不提交推送、不覆盖旧预览。

1. 源码对照与所有权不变量 — 完成。
2. Composer瞬时输入拥有语音呈现，原生音量采样与停止完成事务 — 完成。
3. 原位Footer/真实波形/时长/停止写入、确认发送与键盘生命周期 — 完成；原生层输出真实音量，合成音量驱动真实组件验收通过，未启动真麦克风。
4. 类型/测试/gate、隔离签名客户端交互验收、新预览 — 完成；最终完整npm gate退出0，26项聚焦通过，独立新预览已启动。

最终签名产物：release/dictation-interaction-20260915-final/mac-arm64/OpenCraft Preview.app。
实机组件验收：原位互斥/编辑器身份、停止写入、处理中取消、真实pointer长按释放、Escape、应用Appearance明暗、760px窗口几何、Enter等final后一次正文推理、取消发送与换草稿无迟到请求。OS识别替身与本地DSH端点明确隔离；实际无录音probe/设置重启通过。真录音与端侧识别未复验。

失败查询：本checkout无ref/codex，实际恢复源在/Users/skipzhang/mono2/ref/codex；composer.scss/composer-actions.test.ts不存在，改有界文件列表和现有app.scss/core测试。
Context router无匹配；不生成graphify（无现图，不扩大为全仓建图）。相关adjacency前端卡已读，邻居核对本服务responsive-footer测试/打包配置，不触及frontend生成物。
