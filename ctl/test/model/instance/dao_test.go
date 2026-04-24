//go:build integration

package instance_test

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"ctl/pkg/errcode"
	"ctl/pkg/model/factory"
	"ctl/pkg/model/instance"
	"ctl/test/testutil"
)

func TestInstanceDAOCRUDAndTenantIsolation(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "..", "migrations")

	ownerCtx := testutil.NewContext(t, "user-1")
	otherCtx := testutil.NewContext(t, "user-2")
	dao := factory.DefaultDaoFactory.InstanceDao(ownerCtx)

	first := &instance.Entity{
		InstanceId: "ins-1",
		UserId:     "user-1",
		SandboxId:  "sandbox-1",
		Status:     instance.InstanceStatusCreating,
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	second := &instance.Entity{
		InstanceId: "ins-2",
		UserId:     "user-1",
		SandboxId:  "sandbox-2",
		Status:     instance.InstanceStatusRunning,
		TimeoutAt:  time.Now().Add(2 * time.Hour),
	}
	foreign := &instance.Entity{
		InstanceId: "ins-3",
		UserId:     "user-2",
		SandboxId:  "sandbox-3",
		Status:     instance.InstanceStatusRunning,
		TimeoutAt:  time.Now().Add(3 * time.Hour),
	}

	for _, entity := range []*instance.Entity{first, second, foreign} {
		if err := dao.Create(ownerCtx, entity); err != nil {
			t.Fatalf("create instance %s: %v", entity.InstanceId, err)
		}
	}
	if foreign.UserId != "user-1" {
		t.Fatalf("create should bind user id from context, got %s", foreign.UserId)
	}

	got, err := dao.GetByInstanceID(ownerCtx, "ins-1")
	if err != nil {
		t.Fatalf("get by instance id: %v", err)
	}
	if got.UserId != "user-1" {
		t.Fatalf("unexpected user id: %s", got.UserId)
	}

	if _, err := dao.GetByInstanceID(otherCtx, "ins-1"); !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("expected tenant isolation error, got %v", err)
	}

	if err := dao.UpdateStatus(ownerCtx, first.Id, instance.InstanceStatusRunning); err != nil {
		t.Fatalf("update status: %v", err)
	}
	if err := dao.UpdateTimeoutAt(ownerCtx, first.Id, time.Now().Add(4*time.Hour)); err != nil {
		t.Fatalf("update timeout: %v", err)
	}
	if err := dao.UpdateStatus(otherCtx, first.Id, instance.InstanceStatusDeleted); !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("expected tenant isolation on update, got %v", err)
	}

	list, total, err := dao.ListByUserID(ownerCtx, "user-1", 1, 10)
	if err != nil {
		t.Fatalf("list by user id: %v", err)
	}
	if total != 3 || len(list) != 3 {
		t.Fatalf("unexpected list result total=%d len=%d", total, len(list))
	}

	if err := dao.DeleteByID(ownerCtx, second.Id); err != nil {
		t.Fatalf("delete by id: %v", err)
	}
	if _, err := dao.GetByID(ownerCtx, second.Id); !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("expected deleted instance not found, got %v", err)
	}
}

func TestInstanceDAOCreateValidationAndPageSizeCap(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	dao := factory.DefaultDaoFactory.InstanceDao(ctx)

	if err := dao.Create(ctx, &instance.Entity{
		InstanceId: "",
		SandboxId:  "sandbox-1",
		Status:     instance.InstanceStatusCreating,
		TimeoutAt:  time.Now().Add(time.Hour),
	}); err == nil {
		t.Fatal("expected empty instance id validation error")
	}

	if err := dao.Create(ctx, &instance.Entity{
		InstanceId: "ins-empty-sandbox",
		SandboxId:  "",
		Status:     instance.InstanceStatusCreating,
		TimeoutAt:  time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("empty sandbox id should be allowed before sandbox creation: %v", err)
	}

	for i := 0; i < 120; i++ {
		entity := &instance.Entity{
			InstanceId: fmt.Sprintf("ins-%03d", i),
			SandboxId:  fmt.Sprintf("sandbox-%03d", i),
			Status:     instance.InstanceStatusCreating,
			TimeoutAt:  time.Now().Add(time.Hour),
		}
		if err := dao.Create(ctx, entity); err != nil {
			t.Fatalf("seed instances: %v", err)
		}
	}

	list, total, err := dao.ListByUserID(ctx, "user-1", 1, 1000)
	if err != nil {
		t.Fatalf("list with capped page size: %v", err)
	}
	if total != 121 {
		t.Fatalf("unexpected total: %d", total)
	}
	if len(list) != 100 {
		t.Fatalf("expected capped result size 100, got %d", len(list))
	}
}

func TestInstanceDAOTransitionStatusUsesCAS(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	dao := factory.DefaultDaoFactory.InstanceDao(ctx)

	entity := &instance.Entity{
		InstanceId: "ins-cas",
		SandboxId:  "sandbox-cas",
		Status:     instance.InstanceStatusRunning,
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := dao.Create(ctx, entity); err != nil {
		t.Fatalf("create instance: %v", err)
	}

	if err := dao.TransitionStatus(ctx, entity.Id,
		[]string{instance.InstanceStatusRunning, instance.InstanceStatusPaused},
		instance.InstanceStatusDeleting); err != nil {
		t.Fatalf("first transition should succeed: %v", err)
	}

	if err := dao.TransitionStatus(ctx, entity.Id,
		[]string{instance.InstanceStatusRunning, instance.InstanceStatusPaused},
		instance.InstanceStatusDeleting); !errors.Is(err, errcode.ErrInstanceStatusInvalid) {
		t.Fatalf("second transition should fail with status invalid, got %v", err)
	}
}
