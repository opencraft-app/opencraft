package main

import (
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"cvm-mock-e2b/internal/runtimecfg"
	"cvm-mock-e2b/internal/service"
	"cvm-mock-e2b/internal/store"
)

// Config holds runtime configuration for the gin API adapter.
type Config struct {
	Addr             string        // listen address, e.g. :8081
	ReadTimeout      time.Duration // server read timeout
	WriteTimeout     time.Duration // server write timeout
	MySQLDSN         string        // optional DSN; if empty falls back to in-memory store
	RedisAddr        string        // redis address for route rules
	RedisPassword    string        // redis password for route rules
	RedisDB          int           // redis db index
	RedisRoutePrefix string        // redis key prefix for routes
	AuthServiceURL   string        // user-auth base url for session introspection
	CloudPauseResume bool          // when true, pause/resume call cloud Stop/Start; defaults on for billing lifecycle isolation
}

func loadConfig() Config {
	addr := os.Getenv("API_ADDR")
	if addr == "" {
		addr = ":8081"
	}
	rt := 15 * time.Second
	wt := 15 * time.Second
	dsn := runtimecfg.MySQLDSNFromEnv()
	if dsn == "" {
		log.Printf("[config] MYSQL runtime config not set, using in-memory store for gin API")
	}
	redisAddr := getenv("REDIS_ADDR", "127.0.0.1:6379")
	redisPassword := getenv("REDIS_PASSWORD", "")
	redisDB := getenvInt("REDIS_DB", 0)
	redisPrefix := getenv("REDIS_ROUTE_PREFIX", "route:sandbox:")
	return Config{
		Addr:             addr,
		ReadTimeout:      rt,
		WriteTimeout:     wt,
		MySQLDSN:         dsn,
		RedisAddr:        redisAddr,
		RedisPassword:    redisPassword,
		RedisDB:          redisDB,
		RedisRoutePrefix: redisPrefix,
		AuthServiceURL:   getenv("AUTH_SERVICE_URL", "http://lightclaw-auth.user-auth.svc.cluster.local"),
		CloudPauseResume: getenvBool("SANDBOX_ENABLE_CLOUD_PAUSE_RESUME", true),
	}
}

// buildService picks store based on env and reuses existing domain logic.
func buildService(cfg Config) (*service.Service, error) {
	var st store.Store
	if cfg.MySQLDSN != "" {
		mysqlStore, err := store.NewMySQLStore(cfg.MySQLDSN)
		if err != nil {
			return nil, err
		}
		st = mysqlStore
	} else {
		st = store.NewMemoryStore()
	}
	return service.NewService(st), nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func getenvInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if val, err := strconv.Atoi(v); err == nil {
			return val
		}
	}
	return def
}

func getenvBool(k string, def bool) bool {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return def
	}
	switch strings.ToLower(v) {
	case "1", "true", "t", "yes", "y", "on":
		return true
	case "0", "false", "f", "no", "n", "off":
		return false
	default:
		return def
	}
}
