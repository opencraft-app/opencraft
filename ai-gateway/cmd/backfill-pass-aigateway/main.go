package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/backfill/passsync"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/go-sql-driver/mysql"
	gormmysql "gorm.io/driver/mysql"
	"gorm.io/gorm"
)

func main() {
	var (
		ctlDSN       = flag.String("ctl-dsn", strings.TrimSpace(os.Getenv("CTL_MYSQL_DSN")), "CTL MySQL DSN（默认读取 CTL_MYSQL_DSN）")
		aiGatewayDSN = flag.String("ai-gateway-dsn", firstNonEmpty(
			strings.TrimSpace(os.Getenv("AI_GATEWAY_MIGRATE_DSN")),
			strings.TrimSpace(os.Getenv("DATABASE_URL")),
		), "AI Gateway MySQL DSN（默认读取 AI_GATEWAY_MIGRATE_DSN / DATABASE_URL）")
		userID = flag.String("user-id", "", "只回填指定 business user_id")
		limit  = flag.Int("limit", 0, "最多处理多少条 pass 记录（0 表示不限制）")
		dryRun = flag.Bool("dry-run", false, "预览模式，不实际写库")
	)
	flag.Parse()

	encryptionKey := strings.TrimSpace(os.Getenv("ENCRYPTION_KEY"))
	if len(encryptionKey) != 32 {
		log.Fatalf("ENCRYPTION_KEY 必须为 32 字节，当前长度=%d", len(encryptionKey))
	}
	if strings.TrimSpace(*ctlDSN) == "" {
		log.Fatal("必须通过 --ctl-dsn 或 CTL_MYSQL_DSN 指定 CTL 数据库")
	}
	if strings.TrimSpace(*aiGatewayDSN) == "" {
		log.Fatal("必须通过 --ai-gateway-dsn 或 AI_GATEWAY_MIGRATE_DSN / DATABASE_URL 指定 AI Gateway 数据库")
	}

	ctlDB, err := openMySQL(strings.TrimSpace(*ctlDSN))
	if err != nil {
		log.Fatalf("连接 CTL 数据库失败: %v", err)
	}
	aiGatewayDB, err := openMySQL(strings.TrimSpace(*aiGatewayDSN))
	if err != nil {
		log.Fatalf("连接 AI Gateway 数据库失败: %v", err)
	}

	keyRepo := repository.NewApiKeyRepo(aiGatewayDB)
	userRepo := repository.NewUserRepo(aiGatewayDB)
	subRepo := repository.NewSubscriptionRepo(aiGatewayDB)
	planRepo := repository.NewPlanRepo(aiGatewayDB)

	apiKeySvc := service.NewApiKeyService(keyRepo, userRepo, subRepo, planRepo, nil, 0)
	userSvc := service.NewUserService(userRepo, apiKeySvc, []byte(encryptionKey))
	planSvc := service.NewPlanService(planRepo)

	syncer := passsync.NewService(
		passsync.NewMySQLPassSource(ctlDB),
		passsync.NewAIUserManager(userSvc),
		passsync.NewAIAPIKeyManager(apiKeySvc),
		passsync.NewAIPlanLoader(planSvc),
		passsync.NewMySQLSubscriptionStore(aiGatewayDB),
		time.Now,
	)

	opts := passsync.SyncOptions{
		UserID: strings.TrimSpace(*userID),
		Limit:  *limit,
		DryRun: *dryRun,
	}
	summary, err := syncer.Run(context.Background(), opts)
	if err != nil {
		log.Fatalf("执行 backfill 失败: %v", err)
	}

	fmt.Printf("dry_run=%t\n", summary.DryRun)
	fmt.Printf("passes_seen=%d\n", summary.PassesSeen)
	fmt.Printf("users_ensured=%d\n", summary.UsersEnsured)
	fmt.Printf("users_already_present=%d\n", summary.UsersAlreadyPresent)
	fmt.Printf("api_keys_created=%d\n", summary.APIKeysCreated)
	fmt.Printf("api_keys_skipped=%d\n", summary.APIKeysSkipped)
	fmt.Printf("subscriptions_created=%d\n", summary.SubscriptionsCreated)
	fmt.Printf("subscriptions_skipped=%d\n", summary.SubscriptionsSkipped)
	fmt.Printf("failures=%d\n", summary.Failures)

	if summary.Failures > 0 {
		os.Exit(1)
	}
}

func openMySQL(dsn string) (*gorm.DB, error) {
	dsn = strings.TrimSpace(dsn)
	dsn = strings.TrimPrefix(dsn, "mysql://")
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	if cfg.Params == nil {
		cfg.Params = make(map[string]string)
	}
	cfg.Params["time_zone"] = "'+00:00'"

	db, err := gorm.Open(gormmysql.Open(cfg.FormatDSN()), &gorm.Config{
		NowFunc: func() time.Time { return time.Now().UTC() },
	})
	if err != nil {
		return nil, err
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(10)
	sqlDB.SetMaxIdleConns(5)
	sqlDB.SetConnMaxLifetime(5 * time.Minute)
	sqlDB.SetConnMaxIdleTime(1 * time.Minute)
	return db, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
