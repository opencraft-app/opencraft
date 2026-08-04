package config

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestLoadTokyoSandboxInventory(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test file path")
	}
	path := filepath.Join(filepath.Dir(currentFile), "..", "..", "envs", "tencentcloud", "tokyo-sandbox", "inventory.yaml")

	inventory, err := LoadInventory(path)
	if err != nil {
		t.Fatalf("LoadInventory(tokyo-sandbox): %v", err)
	}

	if inventory.EnvName != "tokyo-sandbox" || inventory.EnvShort != "jp1" {
		t.Fatalf("unexpected Tokyo identity: env=%q short=%q", inventory.EnvName, inventory.EnvShort)
	}
	if inventory.Region != "ap-tokyo" || inventory.ZonePrimary != "ap-tokyo-1" {
		t.Fatalf("unexpected Tokyo location: region=%q zone=%q", inventory.Region, inventory.ZonePrimary)
	}
	if inventory.Network.VpcCIDR != "10.64.0.0/12" {
		t.Fatalf("unexpected Tokyo VPC CIDR: %q", inventory.Network.VpcCIDR)
	}
	if inventory.Stacks.TKE.ClusterName != "tke-tokyo-sandbox" || inventory.Stacks.TKE.NodePoolName != "general-jp1" {
		t.Fatalf(
			"unexpected Tokyo TKE identity: cluster=%q node_pool=%q",
			inventory.Stacks.TKE.ClusterName,
			inventory.Stacks.TKE.NodePoolName,
		)
	}
	if inventory.Stacks.Redis.CtlMQ.RedisShardNum != 3 || inventory.Stacks.Redis.CtlMQ.RedisReplicasNum != 1 {
		t.Fatalf("unexpected ctl-mq Redis topology: %+v", inventory.Stacks.Redis.CtlMQ)
	}
	if inventory.Stacks.Redis.SandboxRoute.RedisShardNum != 8 || inventory.Stacks.Redis.SandboxRoute.RedisReplicasNum != 3 {
		t.Fatalf("unexpected sandbox-route Redis topology: %+v", inventory.Stacks.Redis.SandboxRoute)
	}
	if inventory.Stacks.Cynosdb.ExistingEndpoint != "10.79.192.15:3306" {
		t.Fatalf("unexpected CynosDB endpoint: %q", inventory.Stacks.Cynosdb.ExistingEndpoint)
	}
	if inventory.Stacks.Redis.CtlMQ.ExistingEndpoint != "10.79.192.2:6379" {
		t.Fatalf("unexpected ctl-mq Redis endpoint: %q", inventory.Stacks.Redis.CtlMQ.ExistingEndpoint)
	}
	if inventory.Stacks.Redis.SandboxRoute.ExistingEndpoint != "10.79.192.16:6379" {
		t.Fatalf("unexpected sandbox-route Redis endpoint: %q", inventory.Stacks.Redis.SandboxRoute.ExistingEndpoint)
	}
	if inventory.Domains.PublicAPI != "https://api-sandbox-jp-1.lightclaw.tech" {
		t.Fatalf("unexpected Tokyo public API domain: %q", inventory.Domains.PublicAPI)
	}
}
