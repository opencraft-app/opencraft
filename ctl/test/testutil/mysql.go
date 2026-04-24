package testutil

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

type MySQLContainer struct {
	Container testcontainers.Container
	DSN       string
}

func StartMySQLContainer(t *testing.T) *MySQLContainer {
	t.Helper()

	ctx := context.Background()
	req := testcontainers.ContainerRequest{
		Image:        "mysql:8.0.36",
		ExposedPorts: []string{"3306/tcp"},
		Env: map[string]string{
			"MYSQL_ROOT_PASSWORD": "root",
			"MYSQL_DATABASE":      "ctl_test",
		},
		WaitingFor: wait.ForListeningPort("3306/tcp").WithStartupTimeout(90 * time.Second),
	}

	container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: req,
		Started:          true,
	})
	if err != nil {
		t.Fatalf("start mysql container: %v", err)
	}

	host, err := container.Host(ctx)
	if err != nil {
		_ = container.Terminate(ctx)
		t.Fatalf("resolve mysql host: %v", err)
	}

	port, err := container.MappedPort(ctx, "3306/tcp")
	if err != nil {
		_ = container.Terminate(ctx)
		t.Fatalf("resolve mysql port: %v", err)
	}

	cfg := mysql.NewConfig()
	cfg.User = "root"
	cfg.Passwd = "root"
	cfg.Net = "tcp"
	cfg.Addr = fmt.Sprintf("%s:%s", host, port.Port())
	cfg.DBName = "ctl_test"
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	cfg.MultiStatements = true
	cfg.Params = map[string]string{
		"charset":   "utf8mb4",
		"time_zone": "'+00:00'",
	}
	dsn := cfg.FormatDSN()
	waitForMySQL(t, dsn)

	return &MySQLContainer{
		Container: container,
		DSN:       dsn,
	}
}

func (c *MySQLContainer) Close(t *testing.T) {
	t.Helper()
	if c == nil || c.Container == nil {
		return
	}
	if err := c.Container.Terminate(context.Background()); err != nil {
		t.Fatalf("terminate mysql container: %v", err)
	}
}

func waitForMySQL(t *testing.T, dsn string) {
	t.Helper()

	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		db, err := sql.Open("mysql", dsn)
		if err == nil {
			err = db.Ping()
			_ = db.Close()
		}
		if err == nil {
			return
		}
		time.Sleep(2 * time.Second)
	}

	t.Fatalf("mysql not ready before timeout")
}
