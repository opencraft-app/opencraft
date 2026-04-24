//go:build integration

package instance_test

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"ctl/pkg/errcode"
	"ctl/pkg/model/factory"
	"ctl/pkg/model/instance"
	"ctl/pkg/resource"
	"ctl/test/testutil"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

func TestInstanceDAOIntegrationWithMigrations(t *testing.T) {
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
	otherCtx := testutil.NewContext(t, "user-2")
	dao := factory.DefaultDaoFactory.InstanceDao(ctx)

	entity := &instance.Entity{
		InstanceId: "integration-ins-1",
		UserId:     "user-1",
		SandboxId:  "integration-sandbox-1",
		Status:     instance.InstanceStatusCreating,
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := dao.Create(ctx, entity); err != nil {
		t.Fatalf("create instance: %v", err)
	}

	if _, err := dao.GetByInstanceID(otherCtx, entity.InstanceId); !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("expected tenant isolation error, got %v", err)
	}

	if err := dao.DeleteByID(ctx, entity.Id); err != nil {
		t.Fatalf("delete instance: %v", err)
	}

	if _, err := dao.GetByID(ctx, entity.Id); !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("expected deleted instance not found, got %v", err)
	}
}
