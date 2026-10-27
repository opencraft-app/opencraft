# Mac 原生语音输入

目标：Mac Electron 默认用 Speech framework，独立于模型与执行引擎，保持Composer瞬时文本事务/取消/草稿归属/迟到隔离。设备设置属于客户端。
非目标：不读认证、不调用微信/私有ASR、不下载语音模型、不自动录音、不提交发布，不承诺所有语言离线。

1. 原生SDK、平台IPC与设置入口核对 — 完成。
2. 原生process/renderer adapter的红绿生命周期测试 — 完成，聚焦20项通过。
3. Swift Speech/CoreAudio helper、设备设置和打包 — 完成，Mac universal helper、arm64 ad-hoc bundle签名校验通过。
4. 聚焦、完整gate、原生probe与签名桌面QA — 完成无录音/合成边界验收；真实麦克风识别仍待用户授权。

实际层次：客户端Main物理资源 → 平台语音插件 → Composer输入事务；设备/语言偏好归客户端profile，不归DSH。
验收：真实SDK/helper/preload无录音probe、合成interim/final、停止幂等、取消/重新开始、换草稿隔离、设置重启恢复。没有读取模型凭据，没有聊天模型推理。
根文档检查和正式设计影响检查通过；context catalog/26项测试中的4项仍受既有历史Task Pack schema、英文摘要、credit指令预算与旧长hex扫描影响，不扩大本任务清理。

Context route误匹配adapter→ctl，must_read已读但不触及桌面服务。读取：opencraft/AGENTS、maintenance/verification、platform architecture/build matrix、TDD/planning/UI规范。
失败检索：global.d.ts/desktop-path.ts/builtin-theme-pack猜测名不存在，改按既有preload与voice extension入口。不反复猜测。
Apple网页md抓取失败，使用当前Xcode SDK官方头文件验证接口。
