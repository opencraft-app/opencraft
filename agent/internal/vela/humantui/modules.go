package humantui

import (
	"context"
	"errors"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/reactvaxis/nativemodule"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/humanim"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/humanplatform"
)

func registerModules(registry *nativemodule.Registry, platform *humanplatform.Client, messaging *humanim.Adapter) {
	registry.RegisterCall("platform.v1", "login", func(ctx context.Context, payload any) (any, error) {
		var input struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return platform.Login(ctx, input.Email, input.Password)
	})
	registry.RegisterCall("platform.v1", "register", func(ctx context.Context, payload any) (any, error) {
		var input map[string]any
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return platform.Register(ctx, input)
	})
	registry.RegisterCall("platform.v1", "restore", func(ctx context.Context, _ any) (any, error) {
		return platform.Restore(ctx)
	})
	registry.RegisterCall("platform.v1", "logout", func(ctx context.Context, _ any) (any, error) {
		return nil, platform.Logout(ctx)
	})
	registry.RegisterCall("platform.v1", "request", func(ctx context.Context, payload any) (any, error) {
		var request humanplatform.Request
		if err := decode(payload, &request); err != nil {
			return nil, err
		}
		return platform.Request(ctx, request)
	})

	registry.RegisterCall("messaging.v1", "connect", func(ctx context.Context, payload any) (any, error) {
		var input struct {
			LaunchID string `json:"launchId"`
		}
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return nil, messaging.Connect(ctx, input.LaunchID)
	})
	registry.RegisterCall("messaging.v1", "close", func(ctx context.Context, _ any) (any, error) {
		return nil, messaging.Close(ctx)
	})
	registry.RegisterCall("messaging.v1", "waitUntilReady", func(ctx context.Context, payload any) (any, error) {
		var input struct {
			TimeoutMS int `json:"timeoutMs"`
		}
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		if input.TimeoutMS <= 0 || input.TimeoutMS > 120_000 {
			return nil, errors.New("waitUntilReady timeoutMs 无效")
		}
		waitContext, cancel := context.WithTimeout(ctx, time.Duration(input.TimeoutMS)*time.Millisecond)
		defer cancel()
		return nil, messaging.WaitUntilReady(waitContext)
	})
	registry.RegisterCall("messaging.v1", "loadHistory", func(ctx context.Context, payload any) (any, error) {
		var input humanim.HistoryInput
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return messaging.LoadHistory(ctx, input)
	})
	registry.RegisterCall("messaging.v1", "loadMessagesByReferences", func(ctx context.Context, payload any) (any, error) {
		var input humanim.ReferencesInput
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return messaging.LoadMessagesByReferences(ctx, input)
	})
	registry.RegisterCall("messaging.v1", "loadMessageContext", func(ctx context.Context, payload any) (any, error) {
		var input humanim.ContextInput
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return messaging.LoadMessageContext(ctx, input)
	})
	registry.RegisterCall("messaging.v1", "listConversations", func(ctx context.Context, payload any) (any, error) {
		var input struct {
			GroupIDs []string `json:"groupIds"`
		}
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return messaging.ListConversations(ctx, input.GroupIDs)
	})
	registry.RegisterCall("messaging.v1", "setScope", func(ctx context.Context, payload any) (any, error) {
		var input humanim.ScopeInput
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return nil, messaging.SetScope(ctx, input)
	})
	registry.RegisterCall("messaging.v1", "markRead", func(ctx context.Context, payload any) (any, error) {
		var input struct {
			Channel humanim.Address `json:"channel"`
		}
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return nil, messaging.MarkRead(ctx, input.Channel)
	})
	registry.RegisterCall("messaging.v1", "sendText", func(ctx context.Context, payload any) (any, error) {
		var input humanim.SendTextInput
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return messaging.SendText(ctx, input)
	})
	registry.RegisterCall("messaging.v1", "sendTask", func(ctx context.Context, payload any) (any, error) {
		var input humanim.SendTaskInput
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return messaging.SendTask(ctx, input)
	})
	registry.RegisterCall("messaging.v1", "sendAttachment", func(ctx context.Context, payload any) (any, error) {
		var input humanim.SendAttachmentInput
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return messaging.SendAttachment(ctx, input)
	})
	registry.RegisterCall("messaging.v1", "searchMessages", func(ctx context.Context, payload any) (any, error) {
		var input humanim.SearchInput
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return messaging.Search(ctx, input)
	})
	registry.RegisterCall("messaging.v1", "setReaction", func(ctx context.Context, payload any) (any, error) {
		var input struct {
			MessageID  string `json:"messageId"`
			ReactionID string `json:"reactionId"`
			Active     bool   `json:"active"`
		}
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return nil, messaging.SetReaction(ctx, input.MessageID, input.ReactionID, input.Active)
	})
	registry.RegisterCall("messaging.v1", "revokeMessage", func(ctx context.Context, payload any) (any, error) {
		var input struct {
			MessageID string `json:"messageId"`
		}
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return messaging.Revoke(ctx, input.MessageID)
	})

	registry.RegisterTopic("messaging.v1", "messages", func(ctx context.Context, payload any, emit nativemodule.EmitFunc) error {
		return messaging.MessagesTopic(ctx, payload, humanim.EmitFunc(emit))
	})
	registry.RegisterTopic("messaging.v1", "lifecycle", func(ctx context.Context, payload any, emit nativemodule.EmitFunc) error {
		return messaging.LifecycleTopic(ctx, payload, humanim.EmitFunc(emit))
	})
	registry.RegisterTopic("messaging.v1", "conversations", func(ctx context.Context, payload any, emit nativemodule.EmitFunc) error {
		return messaging.ConversationsTopic(ctx, payload, humanim.EmitFunc(emit))
	})
}

func decode(value any, target any) error {
	contents, err := common.Marshal(value)
	if err != nil {
		return err
	}
	return common.Unmarshal(contents, target)
}
