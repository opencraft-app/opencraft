//go:build integration

package instance_test

import (
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	psandbox "ctl/pkg/adapter/sandbox"
	"ctl/pkg/config"
	instancelogic "ctl/pkg/instance"
	modelfactory "ctl/pkg/model/factory"
	modelinstance "ctl/pkg/model/instance"
	quota "ctl/pkg/model/userresourcequota"
	"ctl/pkg/resource"
	"ctl/pkg/transport"
	"ctl/test/testutil"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

func TestCreateInstanceConcurrentRequestsSucceedWithPendingSandboxIDs(t *testing.T) {
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

	var sandboxCounter atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/sandboxes" {
			id := sandboxCounter.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"sandboxID":"sbx-concurrent-` + itoa(id) + `","templateID":"tpl-integration","envdVersion":"1.0.0"}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	ctx := testutil.NewContext(t, "user-1")
	testutil.SeedActivePass(t, ctx)
	quotaDao := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx)
	if err := quotaDao.DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 20,
		ResourceQuotaTotal:     20,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	adapter := psandbox.NewSandboxAdapter(&config.SandboxConfig{
		BaseURL:       server.URL,
		Timeout:       5,
		MaxRetries:    0,
		RetryInterval: 1,
	}, resource.ZapLogger)
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		quotaDao,
		adapter,
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		resource.ZapLogger,
		"tpl-integration",
	)

	var wg sync.WaitGroup
	errCh := make(chan error, 20)
	respCh := make(chan *transport.InstanceResponse, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
			if err != nil {
				errCh <- err
				return
			}
			respCh <- resp
		}()
	}
	wg.Wait()
	close(errCh)
	close(respCh)

	for err := range errCh {
		t.Fatalf("concurrent create failed: %v", err)
	}

	seen := make(map[string]struct{}, 20)
	for resp := range respCh {
		if _, exists := seen[resp.SandboxID]; exists {
			t.Fatalf("duplicate sandbox id: %s", resp.SandboxID)
		}
		seen[resp.SandboxID] = struct{}{}
	}
	if len(seen) != 20 {
		t.Fatalf("expected 20 created instances, got %d", len(seen))
	}

	quotaEntity, err := quotaDao.SelectQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "")
	if err != nil {
		t.Fatalf("select quota: %v", err)
	}
	if quotaEntity.ResourceQuotaAvailable != 0 {
		t.Fatalf("expected quota to be exhausted after 20 creates, got %d", quotaEntity.ResourceQuotaAvailable)
	}

	entities, total, err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).ListByUserID(ctx, ctx.GetUserID(), 1, 25)
	if err != nil {
		t.Fatalf("list instances: %v", err)
	}
	if total != 20 || len(entities) != 20 {
		t.Fatalf("expected 20 persisted instances, total=%d len=%d", total, len(entities))
	}
	for _, entity := range entities {
		if entity.Status != modelinstance.InstanceStatusRunning {
			t.Fatalf("expected running instance, got %s", entity.Status)
		}
	}
}

func itoa(v int64) string {
	return fmt.Sprintf("%d", v)
}
