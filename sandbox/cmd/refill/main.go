package main

import (
	"context"
	"flag"
	"log"
	"time"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/logging"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/runtimecfg"
	"cvm-mock-e2b/internal/service"
	"cvm-mock-e2b/internal/store"
)

func main() {
	cleanup, err := logging.Init("refill")
	if err != nil {
		log.Fatalf("init logging: %v", err)
	}
	defer cleanup()

	poolID := flag.String("pool", "", "pool id to refill (required)")
	count := flag.Int("count", 1, "number of instances to create")
	flag.Parse()
	if *poolID == "" {
		log.Fatalf("pool is required")
	}

	var backend store.Store
	if dsn := runtimecfg.MySQLDSNFromEnv(); dsn != "" {
		mysqlStore, err := store.NewMySQLStore(dsn)
		if err != nil {
			log.Fatalf("init mysql store: %v", err)
		}
		backend = mysqlStore
		log.Printf("using MySQL backend")
	} else {
		backend = store.NewMemoryStore()
		log.Printf("using in-memory backend")
	}

	svc := service.NewService(backend)
	ctx := context.Background()
	pool, err := svc.GetPool(ctx, *poolID)
	if err != nil {
		log.Fatalf("get pool: %v", err)
	}

	cp, err := provider.ResolveFromEnv()
	if err != nil {
		log.Fatalf("init provider: %v", err)
	}
	cloudIDs := make([]string, 0, *count)
	addresses := make([]string, 0, *count)
	success := 0
	for i := 0; i < *count; i++ {
		cid, addr, err := cp.CreateInstance(ctx, pool)
		if err != nil {
			log.Printf("create instance via provider failed: %v", err)
			if _, ferr := svc.AddFailedInstance(ctx, pool.ID, cid, addr); ferr != nil {
				log.Printf("record failed instance: %v", ferr)
			}
			continue
		}
		cloudIDs = append(cloudIDs, cid)
		addresses = append(addresses, addr)
		success++
	}
	consumeRefill(ctx, svc, pool, success, addresses, cloudIDs, cp.VerifyInstance)
	// best-effort wait for logs to flush
	time.Sleep(50 * time.Millisecond)
}

func consumeRefill(ctx context.Context, svc *service.Service, pool core.Pool, success int, addresses []string, cloudIDs []string, verify service.InstanceVerifier) {
	if success <= 0 {
		log.Printf("no successful instances created, nothing to refill")
		return
	}
	insts, err := svc.RefillVerified(ctx, pool.ID, success, addresses, cloudIDs, verify)
	if err != nil {
		log.Fatalf("persist refill: %v", err)
	}
	log.Printf("refilled %d instances into pool %s", len(insts), pool.ID)
	for _, inst := range insts {
		log.Printf("instance id=%s cloud_id=%s addr=%s state=%s", inst.ID, inst.CloudID, inst.Address, inst.State)
	}
}
