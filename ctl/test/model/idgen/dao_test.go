//go:build integration

package idgen

import (
	"sync"
	"testing"

	"ctl/pkg/model/factory"
	"ctl/pkg/resource"
	"ctl/test/testutil"
)

func TestGenId(t *testing.T) {
	testutil.NewMySQLAutoMigrateDB(t)
	if err := resource.GormDB.Exec(`CREATE TABLE IF NOT EXISTS id_gen (
		name VARCHAR(255) PRIMARY KEY,
		max_id BIGINT NOT NULL
	)`).Error; err != nil {
		t.Fatalf("create id_gen table: %v", err)
	}
	dao := factory.DefaultDaoFactory.IdGenDao(testutil.NewContext(t, "user-1"))
	for i := 0; i < 10; i++ {
		id, err := dao.GenId("test")
		t.Log(id, err)
	}
}

func TestGenIdConcurrentFirstCreate(t *testing.T) {
	testutil.NewMySQLAutoMigrateDB(t)
	if err := resource.GormDB.Exec(`CREATE TABLE IF NOT EXISTS id_gen (
		name VARCHAR(255) PRIMARY KEY,
		max_id BIGINT NOT NULL
	)`).Error; err != nil {
		t.Fatalf("create id_gen table: %v", err)
	}
	dao := factory.DefaultDaoFactory.IdGenDao(testutil.NewContext(t, "user-1"))

	results := make(chan int64, 8)
	errs := make(chan error, 8)
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, err := dao.GenId("concurrent-first-create")
			if err != nil {
				errs <- err
				return
			}
			results <- id
		}()
	}
	wg.Wait()
	close(results)
	close(errs)

	for err := range errs {
		if err != nil {
			t.Fatalf("unexpected concurrent gen id error: %v", err)
		}
	}

	seen := make(map[int64]bool)
	for id := range results {
		if seen[id] {
			t.Fatalf("duplicated id: %d", id)
		}
		seen[id] = true
	}
	if len(seen) != 8 {
		t.Fatalf("expected 8 ids, got %d", len(seen))
	}
}
