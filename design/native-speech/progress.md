# 进度

已读取TDD/planning与维护规范，并定位可信Main/preload、voice extension/settings注册和官方SDK。
目前未开始真实录音、未读凭据。原有未提交改动与旧预览保持。

已完成：独立Mac原生helper/可信IPC/平台provider、现有Composer事务接入、客户端设备与语言设置、隐私描述/entitlements/打包。
验证：完整npm gate退出0；聚焦20/20；renderer/host构建通过；签名bundle与helper严格校验通过；隔离签名桌面实际probe与合成识别事务/取消/草稿/偏好重启通过。
产物：apps/workbench-electron/release/native-speech-20260915/mac-arm64/OpenCraft Preview.app。
证据：/tmp/opencraft-native-speech-{gate,focused,package,desktop}.log，/tmp/opencraft-native-speech-desktop.png（合成设备设置截图）。
根门禁：documentation、设计影响映射、33项context-audit测试通过；catalog/26项context测试4项失败为历史baseline，本任务新Task Pack未引入命中。
待人工：真实系统授权、麦克风输入/中文识别、实际端侧及Apple服务可用性；用户未确认录音，因此未执行。ad-hoc预览不是notarized发行。
