package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/lightclaw/tencent-rescue-exporter/internal/website"
	"github.com/redis/go-redis/v9"
)

func main() {
	deployer := website.NewDeployer()

	// Redis 初始化（主路径：BLPOP 即时通知）
	redisAddr := os.Getenv("REDIS_ADDR")
	if redisAddr == "" {
		redisAddr = "localhost:6379"
	}
	rdb := redis.NewClient(&redis.Options{
		Addr:         redisAddr,
		Password:     os.Getenv("REDIS_PASSWORD"),
		DB:           0,
		PoolSize:     20,
		MinIdleConns: 5,
		DialTimeout:  5 * time.Second,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 5 * time.Second,
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 验证 Redis 连接
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Printf("WARNING: Redis ping failed (%v), falling back to polling only", err)
		rdb = nil
		if os.Getenv("WEBSITE_REQUIRE_REDIS_LIMITER") == "true" {
			log.Fatal("website-deployer requires Redis for the global COS upload limiter")
		}
	} else {
		log.Printf("website-deployer connected to Redis at %s", redisAddr)
		deployer.SetRateLimitRedisClient(rdb)
	}
	deployer.SetInternalToken(os.Getenv("WEBSITE_INTERNAL_API_TOKEN"))

	// 并发控制
	concurrency := 10
	if v := os.Getenv("MAX_CONCURRENCY"); v != "" {
		if n, err := parseInt(v); err == nil && n > 0 {
			concurrency = n
		}
	}
	sem := make(chan struct{}, concurrency)

	// fallback 轮询间隔（即使有 Redis 也定期 fallback poll 以防消息丢失）
	fallbackInterval := 30 * time.Second
	if v := os.Getenv("POLL_INTERVAL_SECONDS"); v != "" {
		if d, err := time.ParseDuration(v + "s"); err == nil {
			fallbackInterval = d
		}
	}

	log.Printf("website-deployer starting: concurrency=%d, redis=%v, fallback_poll=%v",
		concurrency, rdb != nil, fallbackInterval)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	// fallback 轮询 ticker
	ticker := time.NewTicker(fallbackInterval)
	defer ticker.Stop()

	var wg sync.WaitGroup

	for {
		select {
		case <-stop:
			log.Println("website-deployer shutting down, waiting for in-flight operations...")
			wg.Wait()
			log.Println("website-deployer stopped")
			return

		case <-ticker.C:
			// fallback: poll HTTP API for any operations that weren't picked up via Redis
			ops, err := deployer.PollOperations()
			if err != nil {
				log.Printf("fallback poll error: %v", err)
				continue
			}
			for i := range ops {
				op := ops[i]
				wg.Add(1)
				sem <- struct{}{}
				go func() {
					defer wg.Done()
					defer func() { <-sem }()
					executeOperation(deployer, op)
				}()
			}

		default:
			// 主路径：Redis BLPOP（3秒超时，超时后继续 select 循环）
			if rdb != nil {
				result, err := rdb.BLPop(ctx, time.Second, "website:operations:pending").Result()
				if err == nil && len(result) == 2 {
					opID := result[1]
					wg.Add(1)
					sem <- struct{}{}
					go func() {
						defer wg.Done()
						defer func() { <-sem }()
						executeOperation(deployer, website.Operation{OperationID: opID})
					}()
				}
			} else {
				time.Sleep(1 * time.Second)
			}
		}
	}
}

func executeOperation(d *website.Deployer, op website.Operation) {
	claimed, ok, err := d.ClaimOperation(op.OperationID)
	if err != nil {
		log.Printf("claim operation %s failed: %v", op.OperationID, err)
		return
	}
	if !ok {
		return
	}
	log.Printf("executing operation %s (type=%s, site=%s)", claimed.OperationID, claimed.OperationType, claimed.SiteID)
	if err := d.Execute(*claimed); err != nil {
		log.Printf("execute operation %s failed: %v", claimed.OperationID, err)
	} else {
		log.Printf("operation %s completed", claimed.OperationID)
	}
}

func parseInt(s string) (int, error) {
	var n int
	_, err := fmt.Sscanf(s, "%d", &n)
	return n, err
}
