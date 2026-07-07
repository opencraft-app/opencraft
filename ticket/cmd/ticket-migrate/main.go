package main

import (
	"errors"
	"log"
	"os"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/mysql"
	_ "github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/golang-migrate/migrate/v4/source/iofs"

	dbmysql "github.com/go-sql-driver/mysql"
	stdsql "database/sql"

	"git.woa.com/wisp/mono/ticket/migrations"
)

// 用法:
//   ticket-migrate up
//   ticket-migrate down
//   ticket-migrate version
//
// 读取 TICKET_MYSQL_DSN。骨架期与 subscription 保持同风格。
func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: ticket-migrate <up|down|version>")
	}
	cmd := os.Args[1]

	dsn := os.Getenv("TICKET_MYSQL_DSN")
	if dsn == "" {
		log.Fatal("TICKET_MYSQL_DSN is required")
	}
	if _, err := dbmysql.ParseDSN(dsn); err != nil {
		log.Fatalf("invalid dsn: %v", err)
	}

	db, err := stdsql.Open("mysql", dsn)
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
