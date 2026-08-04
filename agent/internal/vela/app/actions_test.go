//go:build darwin || linux

package app

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"velachat/agent/internal/vela/agentgateway"
	"velachat/agent/internal/vela/host"
	"velachat/agent/internal/vela/im"
)

func TestWriteHostFailureUsesOnlySafeAllowlistedFields(t *testing.T) {
	t.Parallel()

	var output bytes.Buffer
	writeHostFailure(&output, host.FailureReport{
		Scope:            host.FailureScopeMessage,
		Stage:            host.FailureStageServing,
		Attempt:          1,
		Code:             host.FailureCodeRuntimeDeliverFailed,
		Retryable:        true,
		MessageID:        "message_1",
		ConversationKind: im.ConversationC2C,
	})

	if got, want := output.String(),
		"Vela Agent Host failure: scope=message stage=serving code=runtime_deliver_failed retryable=true attempt=1 message_id=message_1 conversation_kind=c2c\n"; got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

func TestWriteHostFailureSanitizesUntrustedFields(t *testing.T) {
	t.Parallel()

	var output bytes.Buffer
	writeHostFailure(&output, host.FailureReport{
		Scope:            host.FailureScope("message\nAuthorization: secret"),
		Stage:            host.FailureStage("serving\nhttps://private.example"),
		Code:             host.FailureCode("raw secret"),
		Retryable:        true,
		Attempt:          7,
		MessageID:        "message\nAuthorization: secret",
		ConversationKind: im.ConversationType("c2c\nsecret"),
	})

	got := output.String()
	if strings.Count(got, "\n") != 1 ||
		strings.Contains(got, "Authorization") ||
		strings.Contains(got, "private.example") ||
		strings.Contains(got, "raw secret") ||
		!strings.HasPrefix(
			got,
			"Vela Agent Host failure: scope=session stage=serving code=serving_unknown retryable=true attempt=7 message_id=sha256:",
		) {
		t.Fatalf("unsafe failure output = %q", got)
	}
}

func TestBindingTransportPreservesHistoryCapability(t *testing.T) {
	t.Parallel()

	conversation, err := im.NewC2CConversation("human_1")
	if err != nil {
		t.Fatal(err)
	}
	next := &fakeHistoryBindingTransport{
		unread: []im.UnreadConversation{{
			Conversation: conversation,
			UnreadCount:  1,
		}},
		page: im.HistoryPage{
			NextCursor: "page-2",
		},
	}
	transport := &bindingTransport{next: next}
	unread, err := transport.UnreadConversations(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(unread) != 1 || unread[0].UnreadCount != 1 {
		t.Fatalf("unread = %#v", unread)
	}
	page, err := transport.History(
		context.Background(),
		im.HistoryRequest{Conversation: conversation},
	)
	if err != nil {
		t.Fatal(err)
	}
	if page.NextCursor != "page-2" {
		t.Fatalf("page = %#v", page)
	}
	if err := transport.MarkRead(
		context.Background(),
		conversation,
	); err != nil {
		t.Fatal(err)
	}
	if next.markReadCalls != 1 {
		t.Fatalf("mark read calls = %d", next.markReadCalls)
	}
}

func TestBindingTransportPublishesUnderlyingOptionalCapabilities(t *testing.T) {
	t.Parallel()

	slot := agentgateway.NewTransportSlot()
	next := &fakeRichBindingTransport{}
	transport := &bindingTransport{next: next, slot: slot}
	if err := transport.Start(context.Background(), im.Session{}); err != nil {
		t.Fatal(err)
	}
	current := slot.Current()
	if current != next {
		t.Fatalf("Gateway transport = %T, want underlying %T", current, next)
	}
	if _, ok := current.(im.HistoryTransport); !ok {
		t.Fatal("Gateway lost Tencent IM history capability")
	}
	if _, ok := current.(im.SearchTransport); !ok {
		t.Fatal("Gateway lost Tencent IM search capability")
	}
	if _, ok := current.(im.ReactionTransport); !ok {
		t.Fatal("Gateway lost Tencent IM reaction capability")
	}
	if _, ok := current.(im.AttachmentTransport); !ok {
		t.Fatal("Gateway lost Tencent IM attachment capability")
	}
	if err := transport.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if slot.Current() != nil {
		t.Fatal("Gateway retained closed Tencent IM transport")
	}
}

type fakeHistoryBindingTransport struct {
	unread        []im.UnreadConversation
	page          im.HistoryPage
	markReadCalls int
	events        chan im.Event
}

func (*fakeHistoryBindingTransport) Start(
	context.Context,
	im.Session,
) error {
	return nil
}

func (*fakeHistoryBindingTransport) SendText(
	context.Context,
	im.SendTextRequest,
) (im.SendReceipt, error) {
	return im.SendReceipt{}, nil
}

func (*fakeHistoryBindingTransport) SendCustom(
	context.Context,
	im.SendCustomRequest,
) (im.SendReceipt, error) {
	return im.SendReceipt{}, nil
}

func (f *fakeHistoryBindingTransport) Events() <-chan im.Event {
	return f.events
}

func (*fakeHistoryBindingTransport) Close(context.Context) error {
	return nil
}

func (f *fakeHistoryBindingTransport) UnreadConversations(
	context.Context,
) ([]im.UnreadConversation, error) {
	return f.unread, nil
}

func (f *fakeHistoryBindingTransport) History(
	context.Context,
	im.HistoryRequest,
) (im.HistoryPage, error) {
	return f.page, nil
}

func (f *fakeHistoryBindingTransport) MarkRead(
	context.Context,
	im.Conversation,
) error {
	f.markReadCalls++
	return nil
}

type fakeRichBindingTransport struct {
	fakeHistoryBindingTransport
}

func (*fakeRichBindingTransport) Search(
	context.Context,
	im.SearchRequest,
) (im.SearchPage, error) {
	return im.SearchPage{}, nil
}

func (*fakeRichBindingTransport) SetReaction(
	context.Context,
	im.MessageRef,
	string,
	bool,
) error {
	return nil
}

func (*fakeRichBindingTransport) SendAttachment(
	context.Context,
	im.SendAttachmentRequest,
) (im.SendAttachmentReceipt, error) {
	return im.SendAttachmentReceipt{}, nil
}
