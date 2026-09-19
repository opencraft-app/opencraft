# 听写会话／识别片段重构

目标：BB式波形录音后一次写入；Codex式片段账本按身份合并final；原生识别task结束不等于录音session结束。
非目标：不复用Codex认证、不改DSH/模型，不自动录音、不保存音频，不提交推送、不覆盖已有预览。

1. 对照与所有权 — 完成；原生认真实际task生命周期为边界，不按文字长度/公共前缀猜分段。
2. 片段协议、final账本与原生task轮换 — 完成。
3. Composer保留原草稿/选区，只在收尾成功提交一次 — 完成。
4. 聚焦/完整gate、Swift构建、隔离签名客户端、真实无录音probe与新预览 — 完成；真录音未复验。

验收：32项聚焦、1项编译原生生命周期自检、完整npm gate、Swift universal与签名检查通过；两个签名桌面脚本通过多片段修订/重发、监听草稿不变、只读、停止一次写入、取消/换草稿、最终后一次正文推理、长按/Enter/明暗/窄窗、设备设置重启与无录音probe。
准确边界：原生自检只覆盖共享task生命周期，不证明SFSpeech识别质量或音频handoff无延迟；OS事件替身和本地正文端点明确隔离。未读取Codex认证、未提交推送，旧预览保持。
产物：apps/workbench-electron/release/dictation-session-20260915/mac-arm64/OpenCraft Preview.app。

路由session误匹配identity-access，must_read已读，不改认证服务。既有未提交代码与旧预览保持。
