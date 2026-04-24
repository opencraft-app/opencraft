//go:build integration

package userresourcequota_test

import (
	"testing"

	"ctl/pkg/model/factory"
	"ctl/pkg/model/userresourcequota"
	"ctl/test/testutil"
)

func TestUserResourceQuotaDAOAtomicOperations(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	dao := factory.DefaultDaoFactory.UserResourceQuotaDao(ctx)

	entity := &userresourcequota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 5,
		ResourceQuotaTotal:     5,
	}
	if err := dao.Insert(entity); err != nil {
		t.Fatalf("insert quota: %v", err)
	}

	ok, err := dao.AllocQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "", 2)
	if err != nil || !ok {
		t.Fatalf("alloc quota ok=%v err=%v", ok, err)
	}

	ok, err = dao.AllocQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "", 4)
	if err != nil {
		t.Fatalf("alloc over quota err=%v", err)
	}
	if ok {
		t.Fatalf("alloc over quota should fail")
	}

	ok, err = dao.FreeQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "", 1)
	if err != nil || !ok {
		t.Fatalf("free quota ok=%v err=%v", ok, err)
	}

	ok, err = dao.FreeQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "", 2)
	if err != nil {
		t.Fatalf("free over total err=%v", err)
	}
	if ok {
		t.Fatalf("free over total should fail")
	}

	if ok, err = dao.AllocQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "", 0); err == nil || ok {
		t.Fatalf("alloc zero should fail with validation error, ok=%v err=%v", ok, err)
	}
	if ok, err = dao.FreeQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "", -1); err == nil || ok {
		t.Fatalf("free negative should fail with validation error, ok=%v err=%v", ok, err)
	}

	quota, err := dao.SelectQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "")
	if err != nil {
		t.Fatalf("select quota: %v", err)
	}
	if quota == nil || quota.ResourceQuotaAvailable != 4 {
		t.Fatalf("unexpected quota state: %+v", quota)
	}

	if err := dao.Insert(&userresourcequota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OTHER_RESOURCE",
		ResourceKey:            "region-ap",
		ResourceQuotaAvailable: 1,
		ResourceQuotaTotal:     2,
	}); err != nil {
		t.Fatalf("insert second quota: %v", err)
	}

	quotas, err := dao.SelectQuotasByResourceNameKeyPairs(ctx.GetUserID(), []*userresourcequota.ResourceNameKeyPair{
		{ResourceName: "OPENCLAW_INSTANCE", ResourceKey: ""},
		{ResourceName: "OTHER_RESOURCE", ResourceKey: "region-ap"},
	})
	if err != nil {
		t.Fatalf("select quotas by pairs: %v", err)
	}
	if len(quotas) != 2 {
		t.Fatalf("unexpected pair query result len=%d", len(quotas))
	}

	if err := dao.DeleteQuota(ctx.GetUserID(), "OTHER_RESOURCE", "region-ap"); err != nil {
		t.Fatalf("delete quota: %v", err)
	}
	deleted, err := dao.SelectQuota(ctx.GetUserID(), "OTHER_RESOURCE", "region-ap")
	if err != nil {
		t.Fatalf("select deleted quota: %v", err)
	}
	if deleted != nil {
		t.Fatalf("expected quota to be deleted")
	}
}
