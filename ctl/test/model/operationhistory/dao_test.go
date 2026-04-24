//go:build integration

package operationhistory_test

import (
	"testing"
	"time"

	pctx "ctl/pkg/context"
	modelfactory "ctl/pkg/model/factory"
	"ctl/pkg/model/operationhistory"
	"ctl/pkg/resource"
	"ctl/test/testutil"
)

func TestOperationHistoryDAOListAndUpdate(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "..", "migrations")

	ctx := pctx.NewContext(nil).WithUserID("user-1")
	dao := modelfactory.DefaultDaoFactory.OperationHistoryDao(ctx)
	now := time.Now().Add(-time.Minute)

	records := []operationhistory.Entity{
		{
			OperationId:   "op-1",
			OperationType: operationhistory.OperationTypeCreate,
			InstanceId:    "ins-1",
			UserId:        "user-1",
			Status:        operationhistory.StatusCreated,
			CreatedAt:     now,
			UpdatedAt:     now,
		},
		{
			OperationId:   "op-2",
			OperationType: operationhistory.OperationTypePause,
			InstanceId:    "ins-1",
			UserId:        "user-1",
			Status:        operationhistory.StatusRunning,
			CreatedAt:     now.Add(time.Second),
			UpdatedAt:     now.Add(time.Second),
		},
		{
			OperationId:   "op-foreign",
			OperationType: operationhistory.OperationTypeCreate,
			InstanceId:    "ins-1",
			UserId:        "user-2",
			Status:        operationhistory.StatusCreated,
			CreatedAt:     now.Add(2 * time.Second),
			UpdatedAt:     now.Add(2 * time.Second),
		},
	}
	for _, record := range records {
		item := record
		if err := dao.Create(ctx, &item); err != nil {
			t.Fatalf("create operation history %s: %v", item.OperationId, err)
		}
	}

	items, total, err := dao.ListByInstanceID(ctx, "ins-1", "user-1", 1, 10)
	if err != nil {
		t.Fatalf("ListByInstanceID: %v", err)
	}
	if total != 2 || len(items) != 2 {
		t.Fatalf("unexpected list result total=%d len=%d items=%+v", total, len(items), items)
	}
	if items[0].OperationId != "op-2" || items[1].OperationId != "op-1" {
		t.Fatalf("unexpected operation order: %+v", items)
	}

	if err := dao.UpdateStatus(ctx, "op-1", operationhistory.StatusSuccess, ""); err != nil {
		t.Fatalf("UpdateStatus success: %v", err)
	}
	if err := dao.UpdateStatus(ctx, "op-2", operationhistory.StatusFailed, "sandbox failed"); err != nil {
		t.Fatalf("UpdateStatus failure: %v", err)
	}

	var updated []operationhistory.Entity
	if err := resource.GormDB.Table(operationhistory.TableName).
		Where("operation_id IN ?", []string{"op-1", "op-2"}).
		Order("operation_id ASC").
		Find(&updated).Error; err != nil {
		t.Fatalf("query updated operations: %v", err)
	}
	if len(updated) != 2 {
		t.Fatalf("unexpected updated rows: %+v", updated)
	}
	if updated[0].Status != operationhistory.StatusSuccess {
		t.Fatalf("unexpected op-1 status: %+v", updated[0])
	}
	if updated[1].Status != operationhistory.StatusFailed || updated[1].ErrorMessage != "sandbox failed" {
		t.Fatalf("unexpected op-2 status: %+v", updated[1])
	}
}
