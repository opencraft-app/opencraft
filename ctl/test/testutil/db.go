package testutil

import (
	"fmt"
	"testing"
	"time"

	"ctl/pkg/resource"

	"go.uber.org/zap"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func NewSQLiteDB(t *testing.T, models ...interface{}) *gorm.DB {
	t.Helper()

	resource.ZapLogger = zap.NewNop()

	dsn := fmt.Sprintf("file:%d?mode=memory&cache=shared", time.Now().UnixNano())
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	if err := db.AutoMigrate(models...); err != nil {
		t.Fatalf("auto migrate sqlite db: %v", err)
	}

	resource.GormDB = db
	return db
}
