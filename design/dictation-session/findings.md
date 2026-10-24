# 事实与不变量

- 当前Native桥接只有无身份interim/final，Swift isFinal直接terminal；这混淆片段确认与session终止。Composer监听期间反复替换临时文本，造成“历史”假象。
- 目标：同一物理Capture持有AudioEngine；每个真实SFSpeechRecognitionTask拥有独立utteranceId；final后明确切换识别request，未来PCM仅进当前request；停止会话只收尾，不再开启新task。音频不跨进renderer。
- 会话final账本拥有确认片段，临时结果不能替换确认片段；同ID最终修订覆盖自身不影响他段；end必须由stop产生并完整收尾。失败/取消不自动提交部分结果。
- Composer拥有插入事务、原草稿/选区与呈现；监听期间仅波形，最终拼接成功后提交一次。既有文本不参与ASR修订；Enter/send先收尾再编译。
- 原生task轮换的识别质量与系统自然终结行为需真录音验证；类型/probe/模拟不能证明ASR无误差或无音频边界延迟。
