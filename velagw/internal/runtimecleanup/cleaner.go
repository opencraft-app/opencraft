package runtimecleanup

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/observability"
	mysql "github.com/go-sql-driver/mysql"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

var databaseNamePattern = regexp.MustCompile(`^newapi_[a-z0-9_]+$`)

type Target struct {
	CleanupID        string `json:"cleanup_id"`
	SetID            string `json:"set_id"`
	Attempt          int    `json:"attempt"`
	Source           string `json:"source"`
	Namespace        string `json:"namespace"`
	Fleet            string `json:"fleet"`
	ShardRef         string `json:"shard_ref"`
	DatabaseName     string `json:"database_name"`
	RedisDB          int    `json:"redis_db"`
	RedisDBStart     int    `json:"redis_db_start"`
	RedisDBLimit     int    `json:"redis_db_limit"`
	LeaseFingerprint string `json:"lease_fingerprint"`
	ClaimToken       string `json:"claim_token"`
	Capability       string `json:"cleanup_capability"`
}

type Config struct {
	ControlURL         string
	MySQLHost          string
	MySQLPort          string
	MySQLAdminUser     string
	MySQLAdminPassword string
	RedisHost          string
	RedisPort          string
	RedisPassword      string
	Target             Target
	ConnectionTimeout  time.Duration
	PollInterval       time.Duration
}

func ValidateTarget(target Target) error {
	if !databaseNamePattern.MatchString(target.DatabaseName) {
		return fmt.Errorf("unsafe set database name %q", target.DatabaseName)
	}
	if target.RedisDBLimit <= 0 || target.RedisDB < target.RedisDBStart || target.RedisDB >= target.RedisDBStart+target.RedisDBLimit {
		return fmt.Errorf("redis db %d is outside allowed range [%d,%d)", target.RedisDB, target.RedisDBStart, target.RedisDBStart+target.RedisDBLimit)
	}
	return nil
}

func LoadConfigFromEnv(getenv func(string) string) (Config, error) {
	if getenv == nil {
		return Config{}, fmt.Errorf("environment reader is required")
	}
	redisDB, err := strconv.Atoi(strings.TrimSpace(getenv("LLMGATEWAY_CLEANUP_REDIS_DB")))
	if err != nil {
		return Config{}, fmt.Errorf("parse cleanup redis db: %w", err)
	}
	redisStart, err := strconv.Atoi(strings.TrimSpace(getenv("LLMGATEWAY_CLEANUP_REDIS_DB_START")))
	if err != nil {
		return Config{}, fmt.Errorf("parse cleanup redis db start: %w", err)
	}
	redisLimit, err := strconv.Atoi(strings.TrimSpace(getenv("LLMGATEWAY_CLEANUP_REDIS_DB_LIMIT")))
	if err != nil {
		return Config{}, fmt.Errorf("parse cleanup redis db limit: %w", err)
	}
	attempt, err := strconv.Atoi(strings.TrimSpace(getenv("LLMGATEWAY_CLEANUP_ATTEMPT")))
	if err != nil {
		return Config{}, fmt.Errorf("parse cleanup attempt: %w", err)
	}
	password, err := url.QueryUnescape(getenv("REDIS_PASSWORD_ENCODED"))
	if err != nil {
		return Config{}, fmt.Errorf("decode redis password: %w", err)
	}
	cfg := Config{
		ControlURL: strings.TrimRight(getenv("LLMGATEWAY_CONTROL_URL"), "/"),
		MySQLHost:  getenv("MYSQL_HOST"), MySQLPort: getenv("MYSQL_PORT"),
		MySQLAdminUser: getenv("MYSQL_ADMIN_USER"), MySQLAdminPassword: getenv("MYSQL_ADMIN_PASSWORD"),
		RedisHost: getenv("REDIS_HOST"), RedisPort: getenv("REDIS_PORT"), RedisPassword: password,
		ConnectionTimeout: 2 * time.Minute, PollInterval: 2 * time.Second,
		Target: Target{
			CleanupID: getenv("LLMGATEWAY_CLEANUP_ID"), SetID: getenv("LLMGATEWAY_CLEANUP_SET_ID"), Attempt: attempt,
			Source: getenv("LLMGATEWAY_CLEANUP_SOURCE"), Namespace: getenv("LLMGATEWAY_CLEANUP_NAMESPACE"), Fleet: getenv("LLMGATEWAY_CLEANUP_FLEET"),
			ShardRef: getenv("LLMGATEWAY_CLEANUP_SHARD_REF"), DatabaseName: getenv("LLMGATEWAY_CLEANUP_DATABASE_NAME"),
			RedisDB: redisDB, RedisDBStart: redisStart, RedisDBLimit: redisLimit,
			LeaseFingerprint: getenv("LLMGATEWAY_CLEANUP_LEASE_FINGERPRINT"), ClaimToken: getenv("LLMGATEWAY_CLEANUP_CLAIM_TOKEN"),
			Capability: getenv("LLMGATEWAY_CLEANUP_CAPABILITY"),
		},
	}
	if err := ValidateTarget(cfg.Target); err != nil {
		return Config{}, err
	}
	if cfg.ControlURL == "" || cfg.MySQLHost == "" || cfg.MySQLAdminUser == "" || cfg.RedisHost == "" || cfg.Target.Capability == "" {
		return Config{}, fmt.Errorf("cleanup control, shard credentials and capability are required")
	}
	return cfg, nil
}

func Run(ctx context.Context, cfg Config) (err error) {
	ctx, span := otel.Tracer(observability.ScopeSetLifecycle).Start(ctx, "llmgateway.set.runtime_cleanup",
		trace.WithAttributes(
			attribute.String("llmgateway.set.id", cfg.Target.SetID),
			attribute.String("llmgateway.shard.id", cfg.Target.ShardRef),
			attribute.String("llmgateway.run.id", cfg.Target.CleanupID),
			attribute.Int("llmgateway.attempt", cfg.Target.Attempt),
			attribute.String("db.namespace", cfg.Target.DatabaseName),
			attribute.Int("llmgateway.redis.db", cfg.Target.RedisDB),
		),
	)
	defer func() { observability.FinishSpan(span, err, "set_runtime_cleanup_failed", nil) }()
	if err := ValidateTarget(cfg.Target); err != nil {
		return err
	}
	if err := authorize(ctx, cfg); err != nil {
		return err
	}
	mysqlCfg := mysql.NewConfig()
	mysqlCfg.User = cfg.MySQLAdminUser
	mysqlCfg.Passwd = cfg.MySQLAdminPassword
	mysqlCfg.Net = "tcp"
	mysqlCfg.Addr = cfg.MySQLHost + ":" + defaultPort(cfg.MySQLPort, "3306")
	mysqlCfg.ParseTime = true
	db, err := sql.Open("mysql", mysqlCfg.FormatDSN())
	if err != nil {
		return err
	}
	defer db.Close()
	if err := waitForNoConnections(ctx, db, cfg.Target.DatabaseName, cfg.ConnectionTimeout, cfg.PollInterval); err != nil {
		return err
	}
	redisClient := redis.NewClient(&redis.Options{
		Addr: cfg.RedisHost + ":" + defaultPort(cfg.RedisPort, "6379"), Password: cfg.RedisPassword, DB: cfg.Target.RedisDB,
	})
	defer redisClient.Close()
	if err := redisClient.FlushDB(ctx).Err(); err != nil {
		return fmt.Errorf("flush redis db %d: %w", cfg.Target.RedisDB, err)
	}
	if size, err := redisClient.DBSize(ctx).Result(); err != nil {
		return fmt.Errorf("verify redis db %d: %w", cfg.Target.RedisDB, err)
	} else if size != 0 {
		return fmt.Errorf("redis db %d still contains %d keys", cfg.Target.RedisDB, size)
	}
	if err := authorize(ctx, cfg); err != nil {
		return fmt.Errorf("reauthorize before dropping database: %w", err)
	}
	if _, err := db.ExecContext(ctx, "DROP DATABASE IF EXISTS `"+cfg.Target.DatabaseName+"`"); err != nil {
		return fmt.Errorf("drop database %s: %w", cfg.Target.DatabaseName, err)
	}
	return nil
}

func authorize(ctx context.Context, cfg Config) error {
	body := map[string]any{
		"cleanup_id": cfg.Target.CleanupID, "set_id": cfg.Target.SetID, "attempt": cfg.Target.Attempt,
		"source": cfg.Target.Source, "namespace": cfg.Target.Namespace, "fleet": cfg.Target.Fleet,
		"shard_ref": cfg.Target.ShardRef, "database_name": cfg.Target.DatabaseName, "redis_db": strconv.Itoa(cfg.Target.RedisDB),
		"redis_db_start": cfg.Target.RedisDBStart, "redis_db_limit": cfg.Target.RedisDBLimit,
		"lease_fingerprint": cfg.Target.LeaseFingerprint, "claim_token": cfg.Target.ClaimToken,
		"cleanup_capability": cfg.Target.Capability,
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.ControlURL+"/api/internal/runtime-cleanups/authorize", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("authorize runtime cleanup: %w", err)
	}
	defer resp.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("authorize runtime cleanup status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(responseBody)))
	}
	return nil
}

func waitForNoConnections(ctx context.Context, db *sql.DB, database string, timeout, poll time.Duration) error {
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	if poll <= 0 {
		poll = 2 * time.Second
	}
	deadline := time.Now().Add(timeout)
	consecutiveZero := 0
	for {
		var active int
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.processlist WHERE DB = ? AND ID <> CONNECTION_ID()`, database).Scan(&active); err != nil {
			return fmt.Errorf("inspect database connections: %w", err)
		}
		if active == 0 {
			consecutiveZero++
			if consecutiveZero >= 3 {
				return nil
			}
		} else {
			consecutiveZero = 0
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("database %s still has %d active connections", database, active)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(poll):
		}
	}
}

func defaultPort(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return strings.TrimSpace(value)
}
