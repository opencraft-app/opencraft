package shardmanager

import (
	"context"
	"errors"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/internal/setmanager"
)

type recordingControl struct {
	projections []ShardProjection
	failures    map[string]error
}

func (c *recordingControl) ObserveShard(_ context.Context, projection ShardProjection) error {
	c.projections = append(c.projections, projection)
	return c.failures[projection.ID]
}

func TestProjectFleetShardsIncludesRuntimeCapacity(t *testing.T) {
	var fleet setmanager.LLMFleet
	fleet.Spec.NewAPI.DatabasePool.Admin = setmanager.LLMFleetDatabasePool{
		MaxOpenConns: 32, MaxIdleConns: 2, MaxLifetimeSeconds: 60,
	}
	fleet.Spec.NewAPI.DatabasePool.Traffic = setmanager.LLMFleetDatabasePool{
		MaxOpenConns: 24, MaxIdleConns: 2, MaxLifetimeSeconds: 90,
	}
	fleet.Spec.NewAPI.SubscriptionWriteConcurrency = 8
	fleet.Spec.Shards = []setmanager.LLMFleetShard{{
		Name: "shard-a", MySQLHost: "mysql.internal", MySQLPort: "3306",
		RedisHost: "redis.internal", RedisPort: "6379", SecretName: "newapi-shard-a",
		Status: "active", MaxSets: 16, RedisDBStart: 256, RedisDBLimit: 512,
	}}
	control := &recordingControl{}

	if err := ProjectFleetShards(t.Context(), control, fleet); err != nil {
		t.Fatal(err)
	}
	if len(control.projections) != 1 {
		t.Fatalf("projections = %d, want 1", len(control.projections))
	}
	got := control.projections[0]
	if got.ID != "shard-a" || got.Endpoint != "mysql.internal:3306" || got.RedisEndpoint != "redis.internal:6379" {
		t.Fatalf("projection = %+v", got)
	}
	if got.RedisDBStart != 256 || got.RedisDBLimit != 512 || got.MaxSets != 16 {
		t.Fatalf("capacity projection = %+v", got)
	}
	if got.AdminSQLMaxOpenConns != 32 || got.TrafficSQLMaxOpenConns != 24 || got.SubscriptionWriteConcurrency != 8 {
		t.Fatalf("runtime projection = %+v", got)
	}
}

func TestProjectFleetShardsContinuesAfterOneObservationFails(t *testing.T) {
	fleet := setmanager.LLMFleet{}
	fleet.Spec.Shards = []setmanager.LLMFleetShard{
		{Name: "shard-a"},
		{Name: "shard-b"},
	}
	control := &recordingControl{
		failures: map[string]error{"shard-a": errors.New("immutable drift")},
	}

	err := ProjectFleetShards(t.Context(), control, fleet)
	if err == nil {
		t.Fatal("expected aggregated observation error")
	}
	if len(control.projections) != 2 || control.projections[1].ID != "shard-b" {
		t.Fatalf("projections = %+v, want both Shards observed", control.projections)
	}
}
