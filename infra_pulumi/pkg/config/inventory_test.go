package config

import (
	"path/filepath"
	"reflect"
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

func TestLoadJohorSandboxNetworkInventory(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test file path")
	}
	path := filepath.Join(filepath.Dir(currentFile), "..", "..", "envs", "tencentcloud", "sgprod-johor-sandbox-network", "inventory.yaml")

	inventory, err := LoadInventory(path)
	if err != nil {
		t.Fatalf("LoadInventory(sgprod-johor-sandbox-network): %v", err)
	}

	if inventory.Profile != ProfileSandboxNetwork {
		t.Fatalf("profile = %q, want %q", inventory.Profile, ProfileSandboxNetwork)
	}
	if inventory.Region != "ap-johorbahru" || inventory.Network.VpcCIDR != "10.80.0.0/12" {
		t.Fatalf("unexpected Johor placement: region=%q cidr=%q", inventory.Region, inventory.Network.VpcCIDR)
	}
	if got := inventory.Network.SandboxPoolSubnetKeys; !reflect.DeepEqual(got, []string{"pool-a", "pool-b"}) {
		t.Fatalf("pool subnet keys = %#v", got)
	}
	if inventory.Stacks.Networking.SecondaryNATEnabled() {
		t.Fatal("Johor network-only stack must not create an idle secondary NAT")
	}
	if len(inventory.Stacks.Networking.PrimaryEIPs) != 5 {
		t.Fatalf("primary EIP count = %d, want 5", len(inventory.Stacks.Networking.PrimaryEIPs))
	}
	if len(inventory.Stacks.Security.SandboxSG.Ingress) != 0 {
		t.Fatalf("Johor TAT-only SG ingress = %#v, want empty", inventory.Stacks.Security.SandboxSG.Ingress)
	}
}

func TestValidateSandboxNetworkProfileDoesNotRequireTKE(t *testing.T) {
	secondaryNAT := false
	inv := &Inventory{Profile: ProfileSandboxNetwork, EnvName: "jhb", Region: "ap-johorbahru", EnvShort: "jhb"}
	inv.Network.VpcCIDR = "10.80.0.0/12"
	inv.Network.SupportSubnetKey = "support"
	inv.Network.SandboxPoolSubnetKeys = []string{"pool-a"}
	inv.Stacks.Networking.PrimaryNATGatewayName = "sandbox-jhb-nat"
	inv.Stacks.Networking.ManageSecondaryNAT = &secondaryNAT
	inv.Stacks.Networking.RouteTableName = "sandbox-jhb-egress"
	inv.Stacks.Networking.PrimaryEIPs = map[string]EIPBandwidth{"eip-1": {Bandwidth: 200}}
	inv.Stacks.Networking.SNATSubnets = map[string]SNATSubnetEntry{
		"pool-a":  {AvailabilityZone: "ap-johorbahru-1", Description: "pool-a"},
		"support": {AvailabilityZone: "ap-johorbahru-1", Description: "support"},
	}
	inv.Stacks.Security.SandboxSG.SecurityGroupName = "sandbox-jhb-isolated"
	inv.Stacks.Security.SandboxSG.Egress = []string{"ACCEPT#0.0.0.0/0#ALL#ALL"}

	if err := ValidateInventory(inv); err != nil {
		t.Fatalf("network-only inventory unexpectedly requires full platform fields: %v", err)
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

func TestLoadShprodManagedPulsarInventory(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test file path")
	}
	path := filepath.Join(filepath.Dir(currentFile), "..", "..", "envs", "tencentcloud", "shprod", "inventory.yaml")

	inventory, err := LoadInventory(path)
	if err != nil {
		t.Fatalf("LoadInventory(shprod): %v", err)
	}
	pulsar := inventory.Stacks.Pulsar
	if !pulsar.Enabled || !pulsar.ManageCluster || pulsar.ExistingClusterID != "pulsar-vje938a9pgq4" {
		t.Fatalf("unexpected managed Pulsar identity: %+v", pulsar)
	}
	if pulsar.BrokerURL != "http://pulsar-vje938a9pgq4.eap-tiu5h8jq.tdmq-pulsar.ap-sh.qcloud.tencenttdmq.com:8080" {
		t.Fatalf("unexpected managed Pulsar broker URL: %q", pulsar.BrokerURL)
	}
	if pulsar.ExpectedClusterName != "lightvela-pulsar-sh" || pulsar.ExpectedProductName != "PULSAR.P2.MINI1" {
		t.Fatalf("unexpected managed Pulsar cluster: %+v", pulsar)
	}
	if pulsar.PurchaseMonths != 1 || pulsar.AutoRenewFlag != 1 || pulsar.StorageSizeGB != 0 {
		t.Fatalf("unexpected managed Pulsar purchase: %+v", pulsar)
	}
	if pulsar.ExpectedVPCID != "vpc-2y7p1lk6" || pulsar.ExpectedSubnetID != "subnet-38xcw327" {
		t.Fatalf("unexpected managed Pulsar network: %+v", pulsar)
	}
}

func TestLoadSgprodReferralFoundationInventory(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test file path")
	}
	path := filepath.Join(filepath.Dir(currentFile), "..", "..", "envs", "tencentcloud", "sgprod", "inventory.yaml")

	inventory, err := LoadInventory(path)
	if err != nil {
		t.Fatalf("LoadInventory(sgprod): %v", err)
	}
	pulsar := inventory.Stacks.Pulsar
	if !pulsar.Enabled || !pulsar.ManageCluster || pulsar.ExistingClusterID != "pulsar-7j4z44nzn3za" ||
		pulsar.BrokerURL != "http://pulsar-7j4z44nzn3za.eap-nzekhasa.tdmq.ap-sg.qcloud.tencenttdmq.com:8080" {
		t.Fatalf("unexpected managed Pulsar foundation: %+v", pulsar)
	}
	if pulsar.ExpectedClusterName != "lightvela-pulsar-sg" || pulsar.ExpectedProductName != "PULSAR.P2.MINI1" {
		t.Fatalf("unexpected managed Pulsar cluster: %+v", pulsar)
	}
	if pulsar.PurchaseMonths != 1 || pulsar.AutoRenewFlag != 1 || pulsar.StorageSizeGB != 0 {
		t.Fatalf("unexpected managed Pulsar purchase policy: %+v", pulsar)
	}
	if len(pulsar.ExpectedZoneIDs) != 1 || pulsar.ExpectedZoneIDs[0] != 900002 ||
		pulsar.ExpectedVPCID != "vpc-253zjh0f" || pulsar.ExpectedSubnetID != "subnet-ounkj91k" {
		t.Fatalf("unexpected managed Pulsar placement: %+v", pulsar)
	}
	if pulsar.UserAuthSSMVersionID != "auth-federation-sg-20260824-2035" ||
		pulsar.CTLSSMVersionID != "v5" || pulsar.ReferralSSMVersionID != "SSM_Current" {
		t.Fatalf("unexpected SSM version mapping: %+v", pulsar)
	}
	referral := inventory.Stacks.Referral
	if !referral.Enabled || referral.ExistingClusterID != "cynosdbmysql-jwe6dqjx" ||
		referral.ExistingEndpoint != "10.15.192.12:3306" || referral.Database != "lightvela_referral" ||
		referral.Account != "referral" || referral.AccountHost != "%" ||
		referral.SSMSecretName != "mono-sgprod-referral-runtime-secrets" ||
		referral.SSMVersionID != "SSM_Current" ||
		referral.InternalServiceTokenSourceSSM != "mono-sgprod-ctl-runtime-secrets" ||
		referral.InternalServiceTokenVersionID != "v5" {
		t.Fatalf("unexpected Referral database foundation: %+v", referral)
	}
}

func TestValidateReferralInventoryRejectsIncompleteTarget(t *testing.T) {
	valid := ReferralInventory{
		Enabled: true, ExistingClusterID: "cynosdbmysql-existing", ExistingEndpoint: "10.0.0.10:3306",
		Database: "lightvela_referral", Account: "referral", AccountHost: "%",
		SSMSecretName:                 "referral-secret",
		SSMVersionID:                  "SSM_Current",
		InternalServiceTokenSourceSSM: "ctl-secret",
		InternalServiceTokenVersionID: "v5",
	}
	tests := []struct {
		name   string
		mutate func(*ReferralInventory)
	}{
		{name: "missing cluster", mutate: func(v *ReferralInventory) { v.ExistingClusterID = "" }},
		{name: "missing endpoint", mutate: func(v *ReferralInventory) { v.ExistingEndpoint = "" }},
		{name: "invalid endpoint", mutate: func(v *ReferralInventory) { v.ExistingEndpoint = "10.0.0.10" }},
		{name: "missing database", mutate: func(v *ReferralInventory) { v.Database = "" }},
		{name: "missing account", mutate: func(v *ReferralInventory) { v.Account = "" }},
		{name: "unsafe host", mutate: func(v *ReferralInventory) { v.AccountHost = "localhost" }},
		{name: "missing secret", mutate: func(v *ReferralInventory) { v.SSMSecretName = "" }},
		{name: "missing secret version", mutate: func(v *ReferralInventory) { v.SSMVersionID = "" }},
		{name: "missing token source", mutate: func(v *ReferralInventory) { v.InternalServiceTokenSourceSSM = "" }},
		{name: "missing token version", mutate: func(v *ReferralInventory) { v.InternalServiceTokenVersionID = "" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			candidate := valid
			tt.mutate(&candidate)
			if err := validateReferralInventory(candidate); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestLoadBeijingSandboxCollaborationInventory(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test file path")
	}
	path := filepath.Join(filepath.Dir(currentFile), "..", "..", "envs", "tencentcloud", "beijing-sandbox", "inventory.yaml")
	inventory, err := LoadInventory(path)
	if err != nil {
		t.Fatal(err)
	}
	value := inventory.Stacks.Collaboration
	if !value.Enabled || value.ExistingClusterID != "cynosdbmysql-3dh7jyee" || value.Database != "lightvela_collaboration" || value.Account != "collaboration_rw" || value.AccountHost != "%" {
		t.Fatalf("unexpected Collaboration database inventory: %+v", value)
	}
	if value.ExistingEndpoint != "10.15.224.4:3306" || value.SSMSecretName != "mono-beijing-sandbox-collaboration-runtime-secrets" {
		t.Fatalf("unexpected Collaboration delivery inventory: %+v", value)
	}
	if value.Namespace != "lightvela-collaboration" || value.NodePool != "general-bj8" {
		t.Fatalf("unexpected Collaboration workload inventory: %+v", value)
	}
}

func TestValidateCollaborationInventoryRejectsIncompleteTarget(t *testing.T) {
	valid := CollaborationInventory{
		Enabled: true, ExistingClusterID: "cynosdbmysql-existing", ExistingEndpoint: "10.0.0.10:3306",
		Database: "lightvela_collaboration", Account: "collaboration_rw", AccountHost: "%",
		SSMSecretName: "collaboration-secret", Namespace: "lightvela-collaboration", NodePool: "general-bj8",
	}
	tests := []struct {
		name   string
		mutate func(*CollaborationInventory)
	}{
		{name: "missing cluster", mutate: func(v *CollaborationInventory) { v.ExistingClusterID = "" }},
		{name: "missing endpoint", mutate: func(v *CollaborationInventory) { v.ExistingEndpoint = "" }},
		{name: "invalid endpoint", mutate: func(v *CollaborationInventory) { v.ExistingEndpoint = "10.0.0.10" }},
		{name: "missing database", mutate: func(v *CollaborationInventory) { v.Database = "" }},
		{name: "missing account", mutate: func(v *CollaborationInventory) { v.Account = "" }},
		{name: "unsafe host", mutate: func(v *CollaborationInventory) { v.AccountHost = "0.0.0.0" }},
		{name: "missing secret", mutate: func(v *CollaborationInventory) { v.SSMSecretName = "" }},
		{name: "missing namespace", mutate: func(v *CollaborationInventory) { v.Namespace = "" }},
		{name: "missing node pool", mutate: func(v *CollaborationInventory) { v.NodePool = "" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			candidate := valid
			tt.mutate(&candidate)
			if err := validateCollaborationInventory(candidate); err == nil {
				t.Fatal("expected validation error")
			}
		})
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
		UserAuthSSMVersionID: "SSM_Current",
		CTLSSMSecret:         "ctl-secret",
		CTLSSMVersionID:      "SSM_Current",
		ReferralSSMSecret:    "referral-secret",
		ReferralSSMVersionID: "SSM_Current",
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

func TestValidateManagedPulsarInventory(t *testing.T) {
	managed := PulsarInventory{
		Enabled: true, ManageCluster: true,
		ExpectedClusterName: "lightvela-pulsar-sh", ExpectedProductName: "PULSAR.P2.MINI1",
		ExpectedZoneIDs: []int{200005}, ExpectedVPCID: "vpc-shprod", ExpectedSubnetID: "subnet-shprod",
		PurchaseMonths: 1,
		Namespace:      "lightvela-ref", MessageTTLSeconds: 604800,
		RetentionMinutes: 1440, RetentionSizeMB: 10240,
		Topic: "lightvela.referral.events.v1", DeadLetterTopic: "lightvela.referral.events.v1-dlq",
		UserAuthProducerRole: "auth-producer", CTLProducerRole: "ctl-producer", ReferralConsumerRole: "referral-consumer",
		UserAuthSSMSecret: "auth-secret", CTLSSMSecret: "ctl-secret", ReferralSSMSecret: "referral-secret",
		UserAuthSSMVersionID: "SSM_Current", CTLSSMVersionID: "SSM_Current", ReferralSSMVersionID: "SSM_Current",
	}
	if err := validatePulsarInventory(managed); err != nil {
		t.Fatalf("valid managed Pulsar inventory rejected: %v", err)
	}
	for _, mutate := range []func(*PulsarInventory){
		func(v *PulsarInventory) { v.ExistingClusterID = "pulsar-existing" },
		func(v *PulsarInventory) { v.BrokerURL = "http://existing" },
		func(v *PulsarInventory) { v.PurchaseMonths = 0 },
		func(v *PulsarInventory) { v.AutoRenewFlag = 2 },
		func(v *PulsarInventory) { v.StorageSizeGB = -1 },
	} {
		candidate := managed
		mutate(&candidate)
		if err := validatePulsarInventory(candidate); err == nil {
			t.Fatal("expected managed Pulsar validation error")
		}
	}
}
