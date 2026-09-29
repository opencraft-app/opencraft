package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/mysql"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "github.com/golang-migrate/migrate/v4/source/iofs"

	stdsql "database/sql"
	dbmysql "github.com/go-sql-driver/mysql"

	"git.woa.com/wisp/mono/ticket/migrations"
)

// 用法:
//
//	ticket-migrate up
//	ticket-migrate down
//	ticket-migrate version
//
// 读取 TICKET_MYSQL_DSN。骨架期与 subscription 保持同风格。
func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: ticket-migrate <up|down|version>")
	}
	cmd := os.Args[1]

	migrationConnectionDSN, err := migrationDSNFromEnv()
	if err != nil {
		log.Fatalf("invalid dsn: %v", err)
	}

	db, err := stdsql.Open("mysql", migrationConnectionDSN)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	drv, err := mysql.WithInstance(db, &mysql.Config{})
	if err != nil {
		log.Fatalf("mysql driver: %v", err)
	}

	src, err := iofs.New(migrations.Files, ".")
	if err != nil {
		log.Fatalf("iofs source: %v", err)
	}

	m, err := migrate.NewWithInstance("iofs", src, "mysql", drv)
	if err != nil {
		log.Fatalf("migrate init: %v", err)
	}

	switch cmd {
	case "up":
		if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
			log.Fatalf("migrate up: %v", err)
		}
		log.Println("migrate up: ok")
	case "down":
		if err := m.Down(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
			log.Fatalf("migrate down: %v", err)
		}
		log.Println("migrate down: ok")
	case "version":
		v, dirty, err := m.Version()
		if err != nil {
			log.Fatalf("version: %v", err)
		}
		log.Printf("version=%d dirty=%v", v, dirty)
	default:
		log.Fatalf("unknown command: %s", cmd)
	}
}

// migrationDSN enables multi-statement SQL only for the migration process.
// The initial ticket schema contains several CREATE TABLE statements per file.
func migrationDSN(dsn string) (string, error) {
	cfg, err := dbmysql.ParseDSN(dsn)
	if err != nil {
		return "", err
	}
	cfg.MultiStatements = true
	return cfg.FormatDSN(), nil
}

// migrationDSNFromEnv uses a full DSN when supplied, otherwise the same split
// environment inputs as the ticket server. This keeps bootstrap jobs secret-safe.
func migrationDSNFromEnv() (string, error) {
	if dsn := strings.TrimSpace(os.Getenv("TICKET_MYSQL_DSN")); dsn != "" {
		return migrationDSN(dsn)
	}
	user := strings.TrimSpace(os.Getenv("TICKET_DB_USER"))
	password := os.Getenv("TICKET_DB_PASSWORD")
	host := strings.TrimSpace(os.Getenv("MYSQL_HOST"))
	port := strings.TrimSpace(os.Getenv("MYSQL_PORT"))
	database := strings.TrimSpace(os.Getenv("TICKET_DB"))
	if user == "" || password == "" || host == "" || port == "" || database == "" {
		return "", fmt.Errorf("TICKET_MYSQL_DSN or complete ticket DB environment is required")
	}
	cfg := dbmysql.NewConfig()
	cfg.User = user
	cfg.Passwd = password
	cfg.Net = "tcp"
	cfg.Addr = host + ":" + port
	cfg.DBName = database
	cfg.ParseTime = true
	cfg.MultiStatements = true
	return cfg.FormatDSN(), nil
}
