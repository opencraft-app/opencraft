package pulsar

import (
	"sync"
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud"

	"github.com/skipzhang/mono/infra_pulumi/pkg/config"
	"github.com/skipzhang/mono/infra_pulumi/pkg/stackctx"
)

type recordedResource struct {
	typ    string
	name   string
	inputs resource.PropertyMap
}

type mocks struct {
	mu        sync.Mutex
	resources []recordedResource
}

func (m *mocks) NewResource(args pulumi.MockResourceArgs) (string, resource.PropertyMap, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.resources = append(m.resources, recordedResource{typ: args.TypeToken, name: args.Name, inputs: args.Inputs})
	return args.Name + "-id", args.Inputs, nil
}

func (*mocks) Call(args pulumi.MockCallArgs) (resource.PropertyMap, error) {
	if args.Token == "tencentcloud:Tdmq/getProInstanceDetail:getProInstanceDetail" {
		return resource.NewPropertyMapFromMap(map[string]any{
			"id":        "pulsar-n57ovqb7r7gv",
			"clusterId": "pulsar-n57ovqb7r7gv",
			"clusterInfos": []any{map[string]any{
				"clusterId": "pulsar-n57ovqb7r7gv", "clusterName": "lightvela-pulsar-bj", "status": 1,
				"nodeDistributions": []any{map[string]any{"zoneId": "800008", "zoneName": "ap-beijing-8", "nodeCount": 2}},
			}},
			"clusterSpecInfos": []any{map[string]any{"specName": "PULSAR.P2.MINI1"}},
			"networkAccessPointInfos": []any{map[string]any{
				"instanceId": "pulsar-n57ovqb7r7gv", "routeType": 1,
				"vpcId": "vpc-21gzr2dc", "subnetId": "subnet-ieszm71b",
				"endpoint": "http://pulsar-n57ovqb7r7gv.example.internal:8080",
			}},
		}), nil
	}
	return args.Args, nil
}

func testInventory(enabled bool) *config.Inventory {
	inv := &config.Inventory{EnvName: "beijing-sandbox", Region: "ap-beijing", EnvShort: "bj8"}
	inv.Stacks.Pulsar = config.PulsarInventory{
		Enabled:              enabled,
		ExistingClusterID:    "pulsar-n57ovqb7r7gv",
		BrokerURL:            "http://pulsar-n57ovqb7r7gv.example.internal:8080",
		ExpectedClusterName:  "lightvela-pulsar-bj",
		ExpectedProductName:  "PULSAR.P2.MINI1",
		ExpectedZoneIDs:      []int{800008},
		ExpectedVPCID:        "vpc-21gzr2dc",
		ExpectedSubnetID:     "subnet-ieszm71b",
		Namespace:            "lightvela-platform",
		MessageTTLSeconds:    604800,
		RetentionMinutes:     1440,
		Topic:                "lightvela.referral.events.v1",
		DeadLetterTopic:      "lightvela.referral.events.v1-dlq",
		UserAuthProducerRole: "lightvela-user-auth-referral-producer",
		CTLProducerRole:      "lightvela-ctl-referral-producer",
		ReferralConsumerRole: "lightvela-referral-consumer",
		UserAuthSSMSecret:    "mono-beijing-sandbox-lightclaw-auth-secrets",
		CTLSSMSecret:         "mono-beijing-sandbox-ctl-runtime-secrets",
		ReferralSSMSecret:    "mono-beijing-sandbox-referral-runtime-secrets",
	}
	return inv
}

func runEnsure(t *testing.T, enabled bool) []recordedResource {
	t.Helper()
	m := &mocks{}
	err := pulumi.RunErr(func(ctx *pulumi.Context) error {
		provider, err := tencentcloud.NewProvider(ctx, "tencentcloud", &tencentcloud.ProviderArgs{
			Region: pulumi.StringPtr("ap-beijing"),
		})
		if err != nil {
			return err
		}
		return Ensure(&stackctx.Context{
			Pulumi:    ctx,
			Runtime:   &config.RuntimeConfig{},
			Inventory: testInventory(enabled),
			Provider:  provider,
		})
	}, pulumi.WithMocks("project", "stack", m))
	if err != nil {
		t.Fatal(err)
	}
	return m.resources
}

func findResource(t *testing.T, resources []recordedResource, typ, name string) recordedResource {
	t.Helper()
	for _, candidate := range resources {
		if candidate.typ == typ && candidate.name == name {
			return candidate
		}
	}
	t.Fatalf("resource %s %s not found", typ, name)
	return recordedResource{}
}

func TestEnsureRegistersPulsarChildResourcesWithoutManagingCluster(t *testing.T) {
	resources := runEnsure(t, true)
	for _, candidate := range resources {
		if candidate.typ == "tencentcloud:Tdmq/professionalCluster:ProfessionalCluster" {
			t.Fatal("existing P2 cluster must remain an external dependency")
		}
	}

	want := []struct{ typ, name string }{
		{"tencentcloud:Tdmq/namespace:Namespace", "referral-pulsar-namespace"},
		{"tencentcloud:Tdmq/topic:Topic", "referral-pulsar-topic"},
		{"tencentcloud:Tdmq/topic:Topic", "referral-pulsar-dlq-topic"},
		{"tencentcloud:Tdmq/role:Role", "referral-user-auth-producer-role"},
		{"tencentcloud:Tdmq/role:Role", "referral-ctl-producer-role"},
		{"tencentcloud:Tdmq/role:Role", "referral-consumer-role"},
		{"tencentcloud:Tdmq/namespaceRoleAttachment:NamespaceRoleAttachment", "referral-user-auth-producer-permission"},
		{"tencentcloud:Tdmq/namespaceRoleAttachment:NamespaceRoleAttachment", "referral-ctl-producer-permission"},
		{"tencentcloud:Tdmq/namespaceRoleAttachment:NamespaceRoleAttachment", "referral-consumer-permission"},
	}
	for _, item := range want {
		findResource(t, resources, item.typ, item.name)
	}

	namespace := findResource(t, resources, "tencentcloud:Tdmq/namespace:Namespace", "referral-pulsar-namespace")
	if got := namespace.inputs["clusterId"].StringValue(); got != "pulsar-n57ovqb7r7gv" {
		t.Fatalf("namespace clusterId = %q", got)
	}
	if got := namespace.inputs["msgTtl"].NumberValue(); got != 604800 {
		t.Fatalf("namespace msgTtl = %v", got)
	}

	topic := findResource(t, resources, "tencentcloud:Tdmq/topic:Topic", "referral-pulsar-topic")
	if got := topic.inputs["topicName"].StringValue(); got != "lightvela.referral.events.v1" {
		t.Fatalf("topicName = %q", got)
	}
	if got := topic.inputs["partitions"].NumberValue(); got != 0 {
		t.Fatalf("partitions = %v", got)
	}
	if got := topic.inputs["pulsarTopicType"].NumberValue(); got != 2 {
		t.Fatalf("pulsarTopicType = %v", got)
	}
	dlq := findResource(t, resources, "tencentcloud:Tdmq/topic:Topic", "referral-pulsar-dlq-topic")
	if got := dlq.inputs["topicName"].StringValue(); got != "lightvela.referral.events.v1-dlq" {
		t.Fatalf("DLQ topicName = %q", got)
	}

	permissions := map[string][]string{
		"referral-user-auth-producer-permission": {"produce"},
		"referral-ctl-producer-permission":       {"produce"},
		"referral-consumer-permission":           {"consume", "produce"},
	}
	for name, wantPermissions := range permissions {
		attachment := findResource(t, resources, "tencentcloud:Tdmq/namespaceRoleAttachment:NamespaceRoleAttachment", name)
		values := attachment.inputs["permissions"].ArrayValue()
		if len(values) != len(wantPermissions) {
			t.Fatalf("%s permissions = %v, want %v", name, values, wantPermissions)
		}
		for index, wantPermission := range wantPermissions {
			if values[index].StringValue() != wantPermission {
				t.Fatalf("%s permissions = %v, want %v", name, values, wantPermissions)
			}
		}
	}
}

func TestEnsureSkipsDisabledPulsar(t *testing.T) {
	resources := runEnsure(t, false)
	for _, candidate := range resources {
		if candidate.typ != "pulumi:providers:tencentcloud" {
			t.Fatalf("unexpected resource while disabled: %s %s", candidate.typ, candidate.name)
		}
	}
}
