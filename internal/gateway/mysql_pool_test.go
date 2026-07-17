package gateway

import (
	"database/sql"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

func TestConfigureMySQLPoolAppliesBoundedConnections(t *testing.T) {
	db, err := sql.Open("mysql", "root@tcp(127.0.0.1:1)/unused")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	configureMySQLPool(db, MySQLStoreOptions{MaxOpenConns: 12, MaxIdleConns: 3, ConnMaxLifetime: 4 * time.Minute, ConnMaxIdleTime: time.Minute})
	if got := db.Stats().MaxOpenConnections; got != 12 {
		t.Fatalf("max open connections = %d, want 12", got)
	}
}
