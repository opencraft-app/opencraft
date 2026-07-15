package subscriptiongateway

import (
	"testing"
	"time"

	"ctl/pkg/resource"
	"ctl/test/testutil"
)

func TestDaoDeleteByUserID(t *testing.T) {
	originalDB := resource.GormDB
	t.Cleanup(func() {
		resource.GormDB = originalDB
	})

	testutil.NewSQLiteDB(t, &Entity{})
	dao := NewDao()
	userID := "usr_gateway_delete"
	if err := dao.Upsert(&Entity{
		UserID:         userID,
		Gateway:        GatewayAIGateway,
		SubscriptionID: "sub-legacy",
		PlanID:         "plan-legacy",
		Source:         SourceManual,
		LastObservedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("upsert gateway route: %v", err)
	}

	if err := dao.DeleteByUserID(userID); err != nil {
		t.Fatalf("DeleteByUserID: %v", err)
	}
	got, err := dao.GetByUserID(userID)
	if err != nil {
		t.Fatalf("GetByUserID after delete: %v", err)
	}
	if got != nil {
		t.Fatalf("expected route deleted, got %+v", got)
	}
}
