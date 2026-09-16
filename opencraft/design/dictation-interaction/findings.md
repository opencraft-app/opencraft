# 源码事实与不变量

- Codex恢复源码format-duration-to-minutes-seconds.js：RecordingWaveformControls、DictationRecordingBar使用ComposerFooter、button-composer token、波形/时长，stop(insert)与stop(send)不同；处理中非重复停止。get-local-conversation-id.js显式voiceFooter；get-model-picker-power-slider-impl.js发送按当前听写状态编译为stop(send)。恢复源码不是完整官方源码，不推断BB共用代码。
- BB HEAD62fe3bc46：VoiceRecordingBar的ghost取消、波形与确认；PromptBoxInternal标准动作保持挂载但inert/aria-hidden和原位180ms退场，Escape取消。普通与语音操作不是并列追加。
- 不变量：输入文本、呈现与结束动作归同一瞬时输入事务，失去草稿/View归属时同时释放；已释放事务不能更新新Footer。
- Composer拥有几何/密度、呈现模式、提交编译和标准控件；语音插件提供状态/采样/停止完成，不拥有控制器。Main/native helper独占物理音频，renderer仅消费数值采样；无二次录音。
- 停止写入只完成识别；确认发送/Enter必须先等待最终文本，且取消/目标变化/卸载不能迟到发送；处理中不重复请求。现有程序化提交瞬时文本语义保留。
