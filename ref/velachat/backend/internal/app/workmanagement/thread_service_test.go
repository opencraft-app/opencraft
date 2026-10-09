package workmanagement

import (
	"context"
	"testing"
	"time"

	workport "chatserver/internal/ports/work"
)

type fakeThreadRepository struct {
	workport.Repository
	ensureDraft      workport.ThreadDraft
	ensureMutation   workport.Mutation
	registerDraft    workport.ThreadReplyDraft
	registerMutation workport.Mutation
	readRefID        string
}

func (repository *fakeThreadRepository) EnsureThread(
	_ context.Context,
	mutation workport.Mutation,
	_ string,
	draft workport.ThreadDraft,
) (workport.MessageThread, error) {
	repository.ensureMutation = mutation
	repository.ensureDraft = draft
	return workport.MessageThread{
		ID: draft.ID, ServerID: mutation.ServerID,
		ChannelID: draft.ChannelID, RootMessageRef: draft.RootMessageRef,
		CreatedAt: mutation.Now,
	}, nil
}

func (repository *fakeThreadRepository) RegisterThreadReply(
	_ context.Context,
	mutation workport.Mutation,
	_, _ string,
	draft workport.ThreadReplyDraft,
) (workport.ThreadReplyReference, error) {
	repository.registerMutation = mutation
	repository.registerDraft = draft
	return workport.ThreadReplyReference{
		ID: draft.ID, ThreadID: draft.ThreadID,
		MessageRef: draft.MessageRef, CreatedAt: mutation.Now,
	}, nil
}

func (repository *fakeThreadRepository) MarkThreadRead(
	_ context.Context,
	_ workport.Mutation,
	_, _, lastReadRefID string,
) error {
	repository.readRefID = lastReadRefID
	return nil
}

func TestEnsureThreadRequiresTencentHoppingCoordinates(t *testing.T) {
	repository := &fakeThreadRepository{}
	service, err := NewService(
		repository,
		&fixedIDs{values: []string{
			"01987be5-3d67-7a10-8ee0-3e1f932b52de",
		}},
		fixedClock{now: time.Date(2026, 7, 31, 8, 0, 0, 0, time.UTC)},
	)
	if err != nil {
		t.Fatal(err)
	}
	sequence := int64(42)
	timestamp := int64(1_785_484_800)
	value, err := service.EnsureThread(context.Background(), EnsureThreadCommand{
		AccountID:      "01987be5-3d67-7a10-8ee0-3e1f932b52dc",
		ServerID:       "01987be5-3d67-7a10-8ee0-3e1f932b52db",
		ChannelID:      "01987be5-3d67-7a10-8ee0-3e1f932b52da",
		IdempotencyKey: "thread-ensure-1",
		RootMessageRef: workport.MessageRef{
			Kind: "group", MessageID: "tencent-root-1",
			Sequence: &sequence, Timestamp: &timestamp,
		},
	})
	if err != nil {
		t.Fatalf("EnsureThread() error = %v", err)
	}
	if value.ID != repository.ensureDraft.ID ||
		repository.ensureMutation.RequestHash == [32]byte{} {
		t.Fatalf("value = %#v mutation = %#v", value, repository.ensureMutation)
	}

	_, err = service.EnsureThread(context.Background(), EnsureThreadCommand{
		AccountID:      "01987be5-3d67-7a10-8ee0-3e1f932b52dc",
		ServerID:       "01987be5-3d67-7a10-8ee0-3e1f932b52db",
		ChannelID:      "01987be5-3d67-7a10-8ee0-3e1f932b52da",
		IdempotencyKey: "thread-ensure-2",
		RootMessageRef: workport.MessageRef{
			Kind: "group", MessageID: "missing-sequence",
		},
	})
	if err == nil {
		t.Fatal("EnsureThread() without sequence must fail")
	}
}

func TestRegisterReplyAndMarkReadBuildIndependentMutations(t *testing.T) {
	repository := &fakeThreadRepository{}
	service, err := NewService(
		repository,
		&fixedIDs{values: []string{
			"01987be5-3d67-7a10-8ee0-3e1f932b52df",
		}},
		fixedClock{now: time.Date(2026, 7, 31, 8, 1, 0, 0, time.UTC)},
	)
	if err != nil {
		t.Fatal(err)
	}
	sequence := int64(43)
	timestamp := int64(1_785_484_860)
	reply, err := service.RegisterThreadReply(
		context.Background(),
		RegisterThreadReplyCommand{
			AccountID:      "01987be5-3d67-7a10-8ee0-3e1f932b52dc",
			ServerID:       "01987be5-3d67-7a10-8ee0-3e1f932b52db",
			ChannelID:      "01987be5-3d67-7a10-8ee0-3e1f932b52da",
			ThreadID:       "01987be5-3d67-7a10-8ee0-3e1f932b52d9",
			IdempotencyKey: "thread-reply-1",
			MessageRef: workport.MessageRef{
				Kind: "group", MessageID: "tencent-reply-1",
				Sequence: &sequence, Timestamp: &timestamp,
			},
		},
	)
	if err != nil {
		t.Fatalf("RegisterThreadReply() error = %v", err)
	}
	if reply.ID != repository.registerDraft.ID ||
		repository.registerMutation.RequestHash == [32]byte{} {
		t.Fatalf("reply = %#v mutation = %#v", reply, repository.registerMutation)
	}
	if err := service.MarkThreadRead(
		context.Background(),
		"01987be5-3d67-7a10-8ee0-3e1f932b52dc",
		"01987be5-3d67-7a10-8ee0-3e1f932b52db",
		"01987be5-3d67-7a10-8ee0-3e1f932b52da",
		"01987be5-3d67-7a10-8ee0-3e1f932b52d9",
		reply.ID,
		"thread-read-1",
	); err != nil {
		t.Fatalf("MarkThreadRead() error = %v", err)
	}
	if repository.readRefID != reply.ID {
		t.Fatalf("last read ref = %q", repository.readRefID)
	}
}
