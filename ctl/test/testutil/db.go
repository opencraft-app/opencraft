package testutil

import (
	"fmt"
	"strings"
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
	originalDB := resource.GormDB

	dsn := fmt.Sprintf("file:%d?mode=memory&cache=shared", time.Now().UnixNano())
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	// 逐个 migrate 而不是一次性传全部：MySQL 的索引名是表内唯一，SQLite 是全库唯一，
	// 所以多张表各自声明同名索引（如 pass 和 instance 都有 idx_user_id）在 MySQL 合法、
	// 在 SQLite 会撞。表本身先于索引创建，撞掉的只是索引，测试按主键/条件查询不受影响，
	// 因此这里只吞掉重名索引这一种错误，其余照旧 fatal。
	for _, m := range models {
		if err := db.AutoMigrate(m); err != nil {
			if strings.Contains(err.Error(), "already exists") {
				continue
			}
			t.Fatalf("auto migrate sqlite db: %v", err)
		}
	}

	resource.GormDB = db
	t.Cleanup(func() {
		resource.GormDB = originalDB
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	return db
}
