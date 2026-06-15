package dbconfig

import (
	"net"
	"os"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

// ResolveMySQLDSN prefers structured Kubernetes config over legacy full-DSN
// secrets. This keeps the database name/env-specific routing in cleartext
// ConfigMaps while leaving only credentials in Secrets.
func ResolveMySQLDSN() string {
	if dsn := structuredMySQLDSN(); dsn != "" {
		return dsn
	}
	if dsn := strings.TrimSpace(os.Getenv("LIGHTCLAW_MYSQL_DSN")); dsn != "" {
		return dsn
	}
	return strings.TrimSpace(os.Getenv("MYSQL_DSN"))
}

func structuredMySQLDSN() string {
	host := strings.TrimSpace(os.Getenv("MYSQL_HOST"))
	port := strings.TrimSpace(os.Getenv("MYSQL_PORT"))
	user := strings.TrimSpace(os.Getenv("LIGHTCLAW_AUTH_DB_USER"))
	password := os.Getenv("LIGHTCLAW_AUTH_DB_PASSWORD")
	dbName := strings.TrimSpace(os.Getenv("LIGHTCLAW_AUTH_DB"))
	if host == "" || port == "" || user == "" || password == "" || dbName == "" {
		return ""
	}
	cfg := mysql.NewConfig()
	cfg.User = user
	cfg.Passwd = password
	cfg.Net = "tcp"
	cfg.Addr = net.JoinHostPort(host, port)
	cfg.DBName = dbName
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	cfg.Params = map[string]string{
		"time_zone": "'+00:00'",
	}
	return cfg.FormatDSN()
}
