# 进度

TDD/维护与验证规范已读；有界定位协议/原生helper/VoiceInputAction及现有桌面脚本。尚未录音，未改模型或认证。

已实现：真实native task ID/sequence/partial-final事件，顺序final账本；自然task final轮换request（AudioEngine保持），stop禁止新task，取消隔离旧epoch。Swift universal构建与共享生命周期诊断测试通过，未触发权限/录音。
Renderer默认final-only：不发布假设、不在录音中写草稿；会话完整收尾才交付一次。失败/取消不提交partial。Browser按真实result index消费同账本，final重发不追加重复；无身份interim接口移除。
Composer锁定录音中的编辑与原插入事务，空草稿也可在有模型时选择转写发送。只读输入的Enter由听写键盘owner处理，按钮Enter仍保留native激活语义；Esc/长按/旧草稿保护保留。
红绿：账本分段修订/重发、final不提前提交、未请求或不完整end拒绝、Browser final-only、只读键盘语义。聚焦通过；完整gate/签名客户端复验准备中。
首次签名桌面：监听保留原草稿/无临时装饰、只读、stop一次插入、取消/设置重启/无录音probe通过；发送脚本在截图阶段超时（未进入发送断言），原生自检冷启动3秒超时。自检预算改与probe相同10秒后通过；桌面串行、显示/聚焦自有窗口复验，不把超时归因为ASR结果错误。
最终：32项聚焦、1项原生生命周期自检、完整npm gate退出0。Swift universal/严格签名、无录音probe、两个签名桌面脚本（多片段final-only、原草稿保护/只读、取消/长按/Enter、明暗/窄窗、一次正文请求、设备设置重启）通过。文档/设计影响/diff检查通过。
根context仍历史schema/英文/预算/hex扫描问题（本Task无新增命中）；context-audit 33项通过。新预览从本次独立产物启动，不录音、不复制认证，不提交推送，旧窗口不热更新。
证据：/tmp/opencraft-session-{focused,native-lifecycle,gate-final,desktop-final,probe-desktop,context,docs}.log。真实语音识别、自然task终结与音频交接质量本轮未录音验证，不宣称与Codex服务的VAD边界或ASR精度相同。
