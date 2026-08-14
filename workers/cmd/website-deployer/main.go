package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/lightclaw/tencent-rescue-exporter/internal/website"
	"github.com/redis/go-redis/v9"
)

func main() {
	deployer, err := website.NewDeployer()
	if err != nil {
		log.Fatalf("website-deployer configuration error: %v", err)
	}

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

	// 验证 Redis 连接。
	//
	// Redis 承担两个职责：BLPOP 即时通知（可降级为轮询）和跨 Pod 的 COS 上传令牌桶
	// （无法降级——没有它多副本会把厂商配额打满）。因此默认 fail-closed，
	// 只有显式设置 WEBSITE_REQUIRE_REDIS_LIMITER=false 才允许无限流启动。
	if err := rdb.Ping(ctx).Err(); err != nil {
		if !allowRunWithoutRedisLimiter() {
			log.Fatalf("website-deployer requires Redis for the global COS upload limiter, ping failed: %v", err)
		}
		log.Printf("WARNING: Redis ping failed (%v); running WITHOUT the global COS upload limiter "+
			"because WEBSITE_REQUIRE_REDIS_LIMITER=false", err)
		rdb = nil
	} else {
		log.Printf("website-deployer connected to Redis at %s", redisAddr)
		deployer.SetRateLimitRedisClient(rdb)
	}

	internalToken := os.Getenv("WEBSITE_INTERNAL_API_TOKEN")
	if internalToken == "" {
		// ctl 的内部接口在token 为空时一律返回 401，此时 worker 无法完成任何操作。
		// 提前失败比反复claim 401 更容易定位配置缺失。
		log.Fatal("website-deployer requires WEBSITE_INTERNAL_API_TOKEN")
	}
	deployer.SetInternalToken(internalToken)

	// 并发控制。
	//
	// 制品 zip 流式写入临时文件再随机读取，峰值内存仅几 KB/部署，
	// 不再随 WEBSITE_MAX_ARTIFACT_BYTES 或并发数线性增长。
	// 默认 16 并发：内存已不是瓶颈，主要受 COS 上传配额和磁盘临时空间约束。
	// 环境变量 MAX_CONCURRENCY 可覆盖此默认值。
	concurrency := 200
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
	err = d.Execute(*claimed)
	switch {
	case err == nil:
		log.Printf("operation %s completed", claimed.OperationID)
	case errors.Is(err, website.ErrOperationFailedAndReported):
		// 操作失败但已成功登记，由 ctl 决定是否重试。
		log.Printf("operation %s failed (reported to ctl): %v", claimed.OperationID, err)
	default:
		// 连失败都没能上报：操作会留在 running 直到租约过期后被重新领取。
		log.Printf("operation %s left in-flight, failure report did not land: %v", claimed.OperationID, err)
	}
}

func parseInt(s string) (int, error) {
	var n int
	_, err := fmt.Sscanf(s, "%d", &n)
	return n, err
}

// allowRunWithoutRedisLimiter只有显式声明 false 时才放行无限流运行。
// 默认（未设置）视为「必须有限流」，避免新环境漏配就把 COS 配额打满。
func allowRunWithoutRedisLimiter() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("WEBSITE_REQUIRE_REDIS_LIMITER")), "false")
}
