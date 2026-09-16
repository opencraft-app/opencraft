# 事实与边界

- 当前BrowserSpeech provider仅constructor检测，在Electron不能代表服务可用；Mac使用独立native port，不回退它。
- Native API：SpeechRecognition authorization、supportsOnDeviceRecognition、requiresOnDeviceRecognition、AVAudioEngine与CoreAudio具体设备UID。
- ComposerTransientTextInput已有generation/recognitionEpoch和提交边界，继续复用，不把late text插到新草稿。
- 原生probe/枚举不申请授权；只有用户启动语音时请求Speech/microphone，取消撤销逻辑owner并释放native资源。
- 用户补充层次归属遵循bb：客户端设备偏好、独立speech service、Composer文本消费分开。Mac native服务属于客户端桌面资源，不把客户端Mic路由到远端DSH/Agent Host，也不继承bb的Codex认证。
- TDD发现并修复：中文UTF-8分块损坏、exit早于stdout最终帧导致丢字、取消只kill未先释放native task、重复stop提前结束。这些不是模型参数workaround。
- 桌面初次失败为脚本将button内部再次查button；后续换草稿检查将placeholder文字误当内容。依据实际DOM修正测试，未放宽取消/迟到文本隔离断言。
- 实际Mac语言probe：supported/available/端侧支持为true，系统语音权限notDetermined，枚举4个输入设备；仅能力查询，不证明真实录音成功。日志不输出真实设备UID/名称或用户语音。
