package runtimecfg

import (
	"fmt"
	"os"
	"time"

	"github.com/go-sql-driver/mysql"
)

// MySQLDSNFromEnv returns an explicit MYSQL_DSN when present, otherwise it
// assembles one from the split MYSQL_* runtime variables used by workload
// manifests.
func MySQLDSNFromEnv() string {
	if dsn := os.Getenv("MYSQL_DSN"); dsn != "" {
		return normalizeMySQLDSN(dsn)
	}
	host := os.Getenv("MYSQL_HOST")
	user := os.Getenv("MYSQL_USER")
	password := os.Getenv("MYSQL_PASSWORD")
	db := os.Getenv("MYSQL_DB")
	if host == "" || user == "" || db == "" {
		return ""
	}
	port := os.Getenv("MYSQL_PORT")
	if port == "" {
		port = "3306"
	}
	cfg := mysql.NewConfig()
	cfg.User = user
	cfg.Passwd = password
	cfg.Net = "tcp"
	cfg.Addr = fmt.Sprintf("%s:%s", host, port)
	cfg.DBName = db
	return normalizeConfig(cfg)
}

func normalizeMySQLDSN(dsn string) string {
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		return dsn
	}
	return normalizeConfig(cfg)
}

func normalizeConfig(cfg *mysql.Config) string {
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	if cfg.Params == nil {
		cfg.Params = make(map[string]string)
	}
	cfg.Params["time_zone"] = "'+00:00'"
	return cfg.FormatDSN()
}
