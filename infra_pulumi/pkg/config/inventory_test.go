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

func TestLoadBeijingSandboxPulsarInventory(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test file path")
	}
	path := filepath.Join(filepath.Dir(currentFile), "..", "..", "envs", "tencentcloud", "beijing-sandbox", "inventory.yaml")

	inventory, err := LoadInventory(path)
	if err != nil {
		t.Fatalf("LoadInventory(beijing-sandbox): %v", err)
	}
	pulsar := inventory.Stacks.Pulsar
	if !pulsar.Enabled || pulsar.ExistingClusterID != "pulsar-n57ovqb7r7gv" {
		t.Fatalf("unexpected Pulsar identity: %+v", pulsar)
	}
	if pulsar.ExpectedProductName != "PULSAR.P2.MINI1" || len(pulsar.ExpectedZoneIDs) != 1 || pulsar.ExpectedZoneIDs[0] != 800008 {
		t.Fatalf("unexpected Pulsar placement: %+v", pulsar)
	}
	if pulsar.ExpectedVPCID != "vpc-21gzr2dc" || pulsar.ExpectedSubnetID != "subnet-ieszm71b" {
		t.Fatalf("unexpected Pulsar network: %+v", pulsar)
	}
	if pulsar.Topic != "lightvela.referral.events.v1" || pulsar.MessageTTLSeconds != 604800 || pulsar.RetentionMinutes != 1440 {
		t.Fatalf("unexpected Pulsar messaging config: %+v", pulsar)
	}
	if pulsar.BrokerURL != "http://pulsar-n57ovqb7r7gv.eap-vle3kjgi.tdmq.ap-bj.qcloud.tencenttdmq.com:8080" {
		t.Fatalf("unexpected Pulsar broker URL: %q", pulsar.BrokerURL)
	}
}

func TestValidatePulsarInventoryRejectsUnsafeValues(t *testing.T) {
	valid := PulsarInventory{
		Enabled:              true,
		ExistingClusterID:    "pulsar-existing",
		BrokerURL:            "http://pulsar-existing.example.internal:8080",
		ExpectedClusterName:  "lightvela-pulsar-bj",
		ExpectedProductName:  "PULSAR.P2.MINI1",
		ExpectedZoneIDs:      []int{800008},
		ExpectedVPCID:        "vpc-existing",
		ExpectedSubnetID:     "subnet-existing",
		Namespace:            "lightvela-ref",
		MessageTTLSeconds:    604800,
		RetentionMinutes:     1440,
		RetentionSizeMB:      10240,
		Topic:                "lightvela.referral.events.v1",
		DeadLetterTopic:      "lightvela.referral.events.v1-dlq",
		UserAuthProducerRole: "auth-producer",
		CTLProducerRole:      "ctl-producer",
		ReferralConsumerRole: "referral-consumer",
		UserAuthSSMSecret:    "auth-secret",
		CTLSSMSecret:         "ctl-secret",
		ReferralSSMSecret:    "referral-secret",
	}
	tests := []struct {
		name   string
		mutate func(*PulsarInventory)
	}{
		{name: "missing cluster", mutate: func(v *PulsarInventory) { v.ExistingClusterID = "" }},
		{name: "invalid zone", mutate: func(v *PulsarInventory) { v.ExpectedZoneIDs = []int{0} }},
		{name: "invalid ttl", mutate: func(v *PulsarInventory) { v.MessageTTLSeconds = 0 }},
		{name: "negative retention", mutate: func(v *PulsarInventory) { v.RetentionSizeMB = -1 }},
		{name: "partial retention", mutate: func(v *PulsarInventory) { v.RetentionSizeMB = 0 }},
		{name: "retention below minimum", mutate: func(v *PulsarInventory) { v.RetentionSizeMB = 10239 }},
		{name: "namespace too long", mutate: func(v *PulsarInventory) { v.Namespace = "lightvela-platform" }},
		{name: "invalid namespace characters", mutate: func(v *PulsarInventory) { v.Namespace = "lightvela.ref" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			candidate := valid
			tt.mutate(&candidate)
			if err := validatePulsarInventory(candidate); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}
