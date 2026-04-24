//go:build integration

package userresourcequota_test

import (
	"database/sql"
	"path/filepath"
	"testing"

	"ctl/pkg/model/factory"
	"ctl/pkg/model/userresourcequota"
	"ctl/pkg/resource"
	"ctl/test/testutil"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

func TestUserResourceQuotaDAOIntegrationWithMigrations(t *testing.T) {
	container := testutil.StartMySQLContainer(t)
	defer container.Close(t)

	sqlDB, err := sql.Open("mysql", container.DSN)
	if err != nil {
		t.Fatalf("open mysql db: %v", err)
	}
	defer sqlDB.Close()

	testutil.ApplyMigrations(t, sqlDB, filepath.Join("..", "..", "..", "migrations"))

	gdb, err := gorm.Open(mysql.Open(container.DSN), &gorm.Config{})
	if err != nil {
		t.Fatalf("open gorm mysql db: %v", err)
	}
	resource.GormDB = gdb

	ctx := testutil.NewContext(t, "user-1")
	dao := factory.DefaultDaoFactory.UserResourceQuotaDao(ctx)

	if err := dao.Insert(&userresourcequota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 5,
		ResourceQuotaTotal:     5,
	}); err != nil {
		t.Fatalf("insert quota: %v", err)
	}

	ok, err := dao.AllocQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "", 3)
	if err != nil || !ok {
		t.Fatalf("alloc quota ok=%v err=%v", ok, err)
	}

	ok, err = dao.FreeQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "", 2)
	if err != nil || !ok {
		t.Fatalf("free quota ok=%v err=%v", ok, err)
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
}
