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

type SessionRestoredEvent struct {
	ChannelAccountID       string
	ChannelType            string
	ExternalConversationID string
	ExternalMessageID      string
	ConversationID         string
	SessionKey             string
	ACPSessionID           string
	RuntimeChanged         bool
}

type SessionStoredEvent struct {
	ChannelAccountID       string
	ChannelType            string
	ExternalConversationID string
	ConversationID         string
	SessionKey             string
	ACPSessionID           string
	Operation              string
	Phase                  string
	Status                 string
}

type ChannelCallbacks interface {
	HandleCommand(text string) (CommandCallbackResult, bool)
	HandleACPError(stage CallbackStage, err error) (reply string, ok bool)
	HandleSessionRestored(event SessionRestoredEvent) (reply string, ok bool)
	HandleSessionStored(event SessionStoredEvent) (reply string, ok bool)
}

type DefaultChannelCallbacks struct{}

func (DefaultChannelCallbacks) HandleCommand(text string) (CommandCallbackResult, bool) {
	switch normalizeCommandText(text) {
	case "/reset":
		return CommandCallbackResult{
			Action: CommandActionReset,
			Reply:  resetSessionReply,
		}, true
	default:
		return CommandCallbackResult{}, false
	}
}

func (DefaultChannelCallbacks) HandleACPError(stage CallbackStage, err error) (string, bool) {
	if err == nil {
		return "", false
	}
	if isRuntimeOwnershipError(err) {
		return runtimeBusyReply, true
	}
	switch stage {
	case CallbackStageLoadSession, CallbackStageNewSession, CallbackStagePrompt, CallbackStageReset:
		return runtimeRecoveryFailedReply, true
	default:
		return "", false
	}
}

func (DefaultChannelCallbacks) HandleSessionRestored(event SessionRestoredEvent) (string, bool) {
	if !event.RuntimeChanged {
		return "", false
	}
	return sessionRestoredReply, true
}

func (DefaultChannelCallbacks) HandleSessionStored(event SessionStoredEvent) (string, bool) {
	if event.Operation != "storage" || event.Status != "done" {
		return "", false
	}
	return sessionStoredReply, true
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
