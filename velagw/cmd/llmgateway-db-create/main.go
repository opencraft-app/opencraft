package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	mysql "github.com/go-sql-driver/mysql"

	"git.woa.com/wisp/mono2/llmgateway/internal/dbbootstrap"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	host, port := os.Getenv("MYSQL_HOST"), os.Getenv("MYSQL_PORT")
	user, password := os.Getenv("MYSQL_ADMIN_USER"), os.Getenv("MYSQL_ADMIN_PASSWORD")
	database := os.Getenv("MYSQL_DATABASE")
	if host == "" || port == "" || user == "" || database == "" {
		log.Fatal("MYSQL_HOST, MYSQL_PORT, MYSQL_ADMIN_USER, and MYSQL_DATABASE are required")
	}
	config := mysqlAdminConfig(host, port, user, password)
	if err := dbbootstrap.CreateDatabase(ctx, config.FormatDSN(), database); err != nil {
		log.Fatalf("create database: %v", err)
	}
	log.Printf("database bootstrap completed")
}

func mysqlAdminConfig(host, port, user, password string) *mysql.Config {
	return &mysql.Config{
		User: user, Passwd: password, Net: "tcp", Addr: host + ":" + port,
		Timeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second,
		AllowNativePasswords: true,
	}
}
