package dbbootstrap

import (
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

func TestBuildPlanCreatesControlAndShardStatements(t *testing.T) {
	cfg := Config{
		Control: ControlConfig{
			Database:    "llmgateway",
			AppUser:     "llmgateway_app",
			AppPassword: "control'pass",
		},
		Shards: []ShardConfig{
			{
				ID:                  "shard-a",
				Name:                "Shard A",
				Endpoint:            "cdb-a.internal:3306",
				AppUser:             "newapi_app",
				AppPassword:         "newapi-pass",
				DatabasePattern:     "newapi_%",
				InitialDatabases:    []string{"newapi_set_a"},
				MaxConnections:      1000,
				ReservedConnections: 100,
			},
		},
	}

	plan, err := BuildPlan(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.ControlStatements) != 3 {
		t.Fatalf("control statement count=%d want 3", len(plan.ControlStatements))
	}
	if got := plan.ControlStatements[0]; got != "CREATE DATABASE IF NOT EXISTS `llmgateway` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" {
		t.Fatalf("unexpected create database statement: %s", got)
	}
	if got := plan.ControlStatements[1]; got != "CREATE USER IF NOT EXISTS 'llmgateway_app'@'%' IDENTIFIED BY 'control\\'pass'" {
		t.Fatalf("unexpected create user statement: %s", got)
	}
	if len(plan.ShardStatements["shard-a"]) != 3 {
		t.Fatalf("shard statement count=%d want 3", len(plan.ShardStatements["shard-a"]))
	}
	if got := plan.ShardStatements["shard-a"][1]; got != "GRANT ALL PRIVILEGES ON `newapi\\_%`.* TO 'newapi_app'@'%'" {
		t.Fatalf("unexpected shard grant statement: %s", got)
	}
	if got := plan.ShardStatements["shard-a"][2]; got != "CREATE DATABASE IF NOT EXISTS `newapi_set_a` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" {
		t.Fatalf("unexpected initial database statement: %s", got)
	}
	if len(plan.Shards) != 1 || plan.Shards[0].ID != "shard-a" || plan.Shards[0].Kind != gateway.ShardKindMySQL {
		t.Fatalf("unexpected shard seed: %+v", plan.Shards)
	}
	if plan.Shards[0].WarnRatio != 0.7 || plan.Shards[0].CriticalRatio != 0.85 {
		t.Fatalf("unexpected default ratios: %+v", plan.Shards[0])
	}
}

func TestBuildPlanRejectsUnsafeIdentifiers(t *testing.T) {
	_, err := BuildPlan(Config{
		Control: ControlConfig{
			Database:    "llmgateway;drop",
			AppUser:     "llmgateway_app",
			AppPassword: "pw",
		},
	})
	if err == nil {
		t.Fatal("expected invalid database error")
	}
}

func TestAppDSNUsesAppUserAndDatabase(t *testing.T) {
	got, err := AppDSN("root:rootpass@tcp(10.0.0.1:3306)/", "llmgateway", "app", "app-pass")
	if err != nil {
		t.Fatal(err)
	}
	want := "app:app-pass@tcp(10.0.0.1:3306)/llmgateway?parseTime=true&loc=UTC"
	if got != want {
		t.Fatalf("dsn=%q want %q", got, want)
	}
}

func TestSeedShardsUpsertsMemoryStore(t *testing.T) {
	store := gateway.NewMemoryStore()
	shards := []gateway.Shard{
		{ID: "shard-a", Name: "old", Kind: gateway.ShardKindMySQL, Endpoint: "old:3306", Status: gateway.ShardStatusActive},
		{ID: "shard-a", Name: "new", Kind: gateway.ShardKindMySQL, Endpoint: "new:3306", Status: gateway.ShardStatusActive, MaxConnections: 1000},
	}

	if err := SeedShards(t.Context(), store, shards); err != nil {
		t.Fatal(err)
	}
	got, ok, err := store.GetShard(t.Context(), "shard-a")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("shard not found")
	}
	if got.Name != "new" || got.Endpoint != "new:3306" || got.MaxConnections != 1000 {
		t.Fatalf("unexpected shard after upsert: %+v", got)
	}
}
