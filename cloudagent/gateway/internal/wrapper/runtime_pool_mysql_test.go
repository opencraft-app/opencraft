package wrapper

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestNormalizeMySQLWarmRuntimePoolDSN(t *testing.T) {
	got := normalizeMySQLDSN("mysql://root:pass@127.0.0.1:3306/cloudagent_runtime_pool?charset=utf8mb4")
	want := "root:pass@tcp(127.0.0.1:3306)/cloudagent_runtime_pool?charset=utf8mb4&parseTime=true"
	if got != want {
		t.Fatalf("dsn mismatch\nwant: %s\n got: %s", want, got)
	}
}

func TestMySQLWarmRuntimePoolStoreLive(t *testing.T) {
	dsn := os.Getenv("CLOUDAGENT_LIVE_MYSQL_WARM_POOL_DSN")
	if dsn == "" {
		t.Skip("set CLOUDAGENT_LIVE_MYSQL_WARM_POOL_DSN to run")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	store, err := OpenMySQLWarmRuntimePoolStore(ctx, dsn)
	if err != nil {
		t.Fatalf("open mysql warm runtime pool store: %v", err)
	}
	defer store.Close()

	poolKey := "runtime_pool.test." + randomHex(8)
	item, ok, err := store.ReserveWarmRuntimeItem(ctx, WarmRuntimeReserveRequest{
		PoolKey:      poolKey,
		OwnerID:      "test-worker",
		DesiredReady: 1,
	})
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if !ok || item.ItemID == "" {
		t.Fatalf("expected reserved item, ok=%v item=%+v", ok, item)
	}
	_, ok, err = store.ReserveWarmRuntimeItem(ctx, WarmRuntimeReserveRequest{
		PoolKey:      poolKey,
		OwnerID:      "test-worker-2",
		DesiredReady: 1,
	})
	if err != nil {
		t.Fatalf("second reserve: %v", err)
	}
	if ok {
		t.Fatalf("second reserve should be capacity-gated")
	}
	host := validWarmRuntimeHost()
	if err := store.MarkWarmRuntimeItemReady(ctx, item.ItemID, host); err != nil {
		t.Fatalf("mark ready: %v", err)
	}
	claim, err := store.ClaimWarmRuntime(ctx, WarmRuntimeClaimRequest{
		PoolKey:    poolKey,
		OwnerID:    "gateway",
		SessionID:  "session_live_mysql_test",
		Generation: 1,
	})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if claim.ItemID != item.ItemID || claim.Fence <= 0 {
		t.Fatalf("unexpected claim: %+v", claim)
	}
	if _, err := store.ClaimWarmRuntime(ctx, WarmRuntimeClaimRequest{
		PoolKey:    poolKey,
		OwnerID:    "gateway-2",
		SessionID:  "session_live_mysql_test_2",
		Generation: 1,
	}); !errors.Is(err, ErrWarmRuntimePoolMiss) {
		t.Fatalf("second claim error = %v, want %v", err, ErrWarmRuntimePoolMiss)
	}
	if err := store.ConsumeWarmRuntime(ctx, claim); err != nil {
		t.Fatalf("consume: %v", err)
	}
}
