package database

import (
	"testing"

	"git.woa.com/wisp/mono2/collaboration/internal/config"
)

func TestMySQLPlatformDoesNotClaimPhysicalShardingOrTransactionalDDL(t *testing.T) {
	adapter, err := AdapterFor(config.DatabaseDriver("mysql"))
	if err != nil {
		t.Fatal(err)
	}
	caps := adapter.Capabilities()
	if caps.PhysicalSharding || caps.RequiresProxyAudit || caps.TransactionalDDL {
		t.Fatal("ordinary MySQL must not claim TDSQL proxy or transactional DDL capabilities")
	}
}
