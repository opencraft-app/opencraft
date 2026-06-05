package router

const (
	unsupportedMessageReply    = "暂时只支持文本消息。"
	resetSessionReply          = "已重新创建云端会话。你可以继续发送消息。"
	runtimeRecoveryFailedReply = "云端会话恢复失败，请稍后重试。你也可以发送 /reset 重新创建会话。"
	sessionRestoredReply       = "睡醒了。"
	sessionStoredReply         = "睡着了。"
	taskCancelledReply         = "当前任务已取消。"
	taskEndedReply             = "任务已结束。"
)
