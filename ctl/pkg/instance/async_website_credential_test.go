package instance

import (
	"context"
	"errors"
	"testing"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	taskcommon "ctl/pkg/taskruntime/common"
	"ctl/pkg/websiteauth"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

type destroyCredentialInstanceDAO struct {
	modelinstance.Dao
	entity *modelinstance.Entity
	err    error
}

func (d *destroyCredentialInstanceDAO) GetByInstanceID(pctx.Context, string) (*modelinstance.Entity, error) {
	return d.entity, d.err
}

type destroyCredentialSandbox struct {
	psandbox.Adapter
	deleteErr error
}

func (s *destroyCredentialSandbox) DeleteSandbox(context.Context, string) error {
	return s.deleteErr
}

type destroyCredentialStore struct {
	revokedInstanceIDs []string
	revokeErr          error
}

func (*destroyCredentialStore) Issue(context.Context, string, string) (string, websiteauth.Binding, error) {
	panic("unexpected Issue")
}

func (*destroyCredentialStore) Validate(context.Context, string) (*websiteauth.Binding, error) {
	panic("unexpected Validate")
}

func (*destroyCredentialStore) Revoke(context.Context, string, string) error {
	panic("unexpected Revoke")
}

func (s *destroyCredentialStore) RevokeInstance(_ context.Context, instanceID string) error {
	s.revokedInstanceIDs = append(s.revokedInstanceIDs, instanceID)
	return s.revokeErr
}

func TestDestroyTaskRevokesWebsiteCredentialWhenInstanceIsAlreadyDestroyed(t *testing.T) {
	store := &destroyCredentialStore{}
	l := &logic{
		instanceDao:            &destroyCredentialInstanceDAO{err: errcode.ErrInstanceNotFound},
		websiteCredentialStore: store,
		logger:                 zap.NewNop(),
	}
	ctx := pctx.NewContext(context.Background()).WithUserID("user-1")

	if err := l.RunDestroyInstanceTask(ctx, &DestroyInstanceTaskPayload{InstanceID: "ins-1"}); err != nil {
		t.Fatalf("RunDestroyInstanceTask: %v", err)
	}
	if len(store.revokedInstanceIDs) != 1 || store.revokedInstanceIDs[0] != "ins-1" {
		t.Fatalf("revoked instances = %#v, want [ins-1]", store.revokedInstanceIDs)
	}
}

func TestDestroyTaskDoesNotRevokeWebsiteCredentialBeforeSandboxDeletionSucceeds(t *testing.T) {
	store := &destroyCredentialStore{}
	l := &logic{
		instanceDao: &destroyCredentialInstanceDAO{entity: &modelinstance.Entity{
			InstanceId: "ins-1",
			SandboxId:  "sbx-1",
			Status:     modelinstance.InstanceStatusDeleting,
		}},
		sandboxAdapter:         &destroyCredentialSandbox{deleteErr: errors.New("sandbox unavailable")},
		websiteCredentialStore: store,
		logger:                 zap.NewNop(),
	}
	ctx := pctx.NewContext(context.Background()).WithUserID("user-1")

	if err := l.RunDestroyInstanceTask(ctx, &DestroyInstanceTaskPayload{InstanceID: "ins-1"}); err == nil {
		t.Fatal("RunDestroyInstanceTask succeeded, want sandbox error")
	}
	if len(store.revokedInstanceIDs) != 0 {
		t.Fatalf("revoked instances = %#v, want none", store.revokedInstanceIDs)
	}
}

func TestDestroyTaskDoesNotFailAfterCredentialCleanupError(t *testing.T) {
	store := &destroyCredentialStore{revokeErr: errors.New("Redis unavailable")}
	core, logs := observer.New(zap.WarnLevel)
	l := &logic{
		instanceDao:            &destroyCredentialInstanceDAO{err: errcode.ErrInstanceNotFound},
		websiteCredentialStore: store,
		logger:                 zap.New(core),
	}
	ctx := pctx.NewContext(context.Background()).WithUserID("user-1")

	err := l.RunDestroyInstanceTask(ctx, &DestroyInstanceTaskPayload{InstanceID: "ins-1"})
	if err != nil {
		t.Fatalf("RunDestroyInstanceTask must preserve successful destruction: %v", err)
	}
	if len(store.revokedInstanceIDs) != 1 || store.revokedInstanceIDs[0] != "ins-1" {
		t.Fatalf("revoked instances = %#v, want [ins-1]", store.revokedInstanceIDs)
	}
	if logs.FilterMessage("revoke website credentials after instance destruction failed").Len() != 1 {
		t.Fatalf("warning logs = %#v", logs.All())
	}
}

func TestPassDestroyTaskRevokesWebsiteCredentialAfterIdempotentSuccess(t *testing.T) {
	store := &destroyCredentialStore{}
	l := &logic{
		instanceDao:            &destroyCredentialInstanceDAO{err: errcode.ErrInstanceNotFound},
		websiteCredentialStore: store,
		logger:                 zap.NewNop(),
	}
	ctx := pctx.NewContext(context.Background()).WithUserID("user-1")

	err := l.RunDestroyInstanceForPassTask(ctx, "task-1", &taskcommon.DestroyInstanceForPassTaskPayload{
		InstanceID:  "ins-1",
		PassID:      "pass-1",
		TradeFlowID: 1,
	})
	if err != nil {
		t.Fatalf("RunDestroyInstanceForPassTask: %v", err)
	}
	if len(store.revokedInstanceIDs) != 1 || store.revokedInstanceIDs[0] != "ins-1" {
		t.Fatalf("revoked instances = %#v, want [ins-1]", store.revokedInstanceIDs)
	}
}

func TestPassDestroyTaskDoesNotFailAfterCredentialCleanupError(t *testing.T) {
	store := &destroyCredentialStore{revokeErr: errors.New("Redis unavailable")}
	core, logs := observer.New(zap.WarnLevel)
	l := &logic{
		instanceDao:            &destroyCredentialInstanceDAO{err: errcode.ErrInstanceNotFound},
		websiteCredentialStore: store,
		logger:                 zap.New(core),
	}
	ctx := pctx.NewContext(context.Background()).WithUserID("user-1")

	err := l.RunDestroyInstanceForPassTask(ctx, "task-1", &taskcommon.DestroyInstanceForPassTaskPayload{
		InstanceID:  "ins-1",
		PassID:      "pass-1",
		TradeFlowID: 1,
	})
	if err != nil {
		t.Fatalf("RunDestroyInstanceForPassTask must preserve successful destruction: %v", err)
	}
	if len(store.revokedInstanceIDs) != 1 || store.revokedInstanceIDs[0] != "ins-1" {
		t.Fatalf("revoked instances = %#v, want [ins-1]", store.revokedInstanceIDs)
	}
	if logs.FilterMessage("revoke website credentials after instance destruction failed").Len() != 1 {
		t.Fatalf("warning logs = %#v", logs.All())
	}
}
