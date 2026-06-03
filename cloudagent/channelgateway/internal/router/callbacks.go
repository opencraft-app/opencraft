package router

import "strings"

type CallbackStage string

const (
	CallbackStageLoadSession CallbackStage = "load_session"
	CallbackStageNewSession  CallbackStage = "new_session"
	CallbackStagePrompt      CallbackStage = "prompt"
	CallbackStageReset       CallbackStage = "reset"
)

type CommandAction string

const (
	CommandActionReset CommandAction = "reset"
)

type CommandCallbackResult struct {
	Action CommandAction
	Reply  string
}

type ChannelCallbacks interface {
	HandleCommand(text string) (CommandCallbackResult, bool)
	HandleACPError(stage CallbackStage, err error) (reply string, ok bool)
}

type DefaultChannelCallbacks struct{}

func (DefaultChannelCallbacks) HandleCommand(text string) (CommandCallbackResult, bool) {
	switch normalizeCommandText(text) {
	case "/reset":
		return CommandCallbackResult{
			Action: CommandActionReset,
			Reply:  "已重新创建云端会话。你可以继续发送消息。",
		}, true
	default:
		return CommandCallbackResult{}, false
	}
}

func (DefaultChannelCallbacks) HandleACPError(stage CallbackStage, err error) (string, bool) {
	if err == nil {
		return "", false
	}
	switch stage {
	case CallbackStageLoadSession, CallbackStageNewSession, CallbackStagePrompt, CallbackStageReset:
		return "云端会话恢复失败，请稍后重试。你也可以发送 /reset 重新创建会话。", true
	default:
		return "", false
	}
}

func normalizeCommandText(text string) string {
	text = strings.TrimSpace(text)
	text = strings.ReplaceAll(text, "／", "/")
	if text == "" {
		return ""
	}
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return ""
	}
	return strings.ToLower(fields[0])
}
