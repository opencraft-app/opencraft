package notify

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/skipzhang/mono/infra_pulumi/pkg/config"
)

func validInventory() config.NotifyInventory {
	return config.NotifyInventory{
		Enabled:             true,
		DBUser:              "ctl_notify_reader",
		DBSecretName:        "notify-db-reader",
		DBHost:              "10.0.0.1",
		DBPort:              3306,
		RedisHost:           "10.0.0.2",
		RedisPort:           6379,
		SMSSDKAppID:         "1400000000",
		SMSSignName:         "test-sign",
		SMSTemplateID:       "1000000",
		VPCID:               "vpc-test",
		SubnetID:            "subnet-test",
		CLSLogsetID:         "logset-test",
		CLSTopicID:          "topic-test",
		SMSQPS:              15,
		SMSBurst:            15,
		ScanPageSize:        500,
		WorkerBatchSize:     200,
		WorkerMaxMessages:   10000,
		ScannerFunctionName: "notify-scanner",
		WorkerFunctionName:  "notify-worker",
		ExpiryWindowsDays:   "7,0",
		ScannerCron:         "0 0 9 * * * *",
		WorkerCron:          "0 */1 * * * * *",
	}
}

func TestValidateInventoryAcceptsProductionDefaults(t *testing.T) {
	if err := validateInventory("shprod", validInventory()); err != nil {
		t.Fatal(err)
	}
}

func TestValidateInventoryRejectsUnsafeLimits(t *testing.T) {
	inv := validInventory()
	inv.WorkerBatchSize = 201
	if err := validateInventory("shprod", inv); err == nil {
		t.Fatal("expected worker batch validation error")
	}
}

func TestValidateInventoryRejectsProductionAllowlist(t *testing.T) {
	inv := validInventory()
	inv.TestAllowlistEnabled = true
	if err := validateInventory("shprod", inv); err == nil {
		t.Fatal("production must not use a test allowlist")
	}
}

func TestValidateInventoryRequiresReaderSecret(t *testing.T) {
	inv := validInventory()
	inv.DBSecretName = ""
	if err := validateInventory("beijing-sandbox", inv); err == nil {
		t.Fatal("expected DB secret validation error")
	}
}

func TestValidateInventoryRequiresRuntimeIdentifiers(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*config.NotifyInventory)
	}{
		{"DB user", func(inv *config.NotifyInventory) { inv.DBUser = "" }},
		{"SMS app ID", func(inv *config.NotifyInventory) { inv.SMSSDKAppID = "" }},
		{"SMS sign", func(inv *config.NotifyInventory) { inv.SMSSignName = "" }},
		{"SMS template", func(inv *config.NotifyInventory) { inv.SMSTemplateID = "" }},
		{"scanner function", func(inv *config.NotifyInventory) { inv.ScannerFunctionName = "" }},
		{"worker function", func(inv *config.NotifyInventory) { inv.WorkerFunctionName = "" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			inv := validInventory()
			tt.mutate(&inv)
			if err := validateInventory("shprod", inv); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestTriggerImportIDMatchesProviderFormat(t *testing.T) {
	got := triggerImportID("lightvela-notify-worker-bj", "lightvela-notify-worker-timer")
	want := "lightvela-notify-worker-bj#default#lightvela-notify-worker-timer"
	if got != want {
		t.Fatalf("triggerImportID() = %q, want %q", got, want)
	}
}

func TestTriggerManagementCanBeDeferredUntilFunctionsExist(t *testing.T) {
	inv := validInventory()
	if shouldManageTriggers(inv) {
		t.Fatal("bootstrap inventory must omit trigger resources")
	}
	inv.ManageTriggers = true
	if !shouldManageTriggers(inv) {
		t.Fatal("managed inventory must register trigger resources")
	}
}

func TestRedisSecretUsesRuntimeCurrentVersion(t *testing.T) {
	if notifySecretVersionID != "SSM_Current" {
		t.Fatalf("notify secret version = %q, want SSM_Current", notifySecretVersionID)
	}
}

func TestRuntimePolicyRestrictsSecretReadsToNotifySecrets(t *testing.T) {
	document, err := buildRuntimePolicy(
		"ap-shanghai",
		"100012345678",
		"mono-shprod-notify-scan-probe-db",
		"mono-shprod-notify-redis",
	)
	if err != nil {
		t.Fatal(err)
	}

	var policy struct {
		Statement []struct {
			Action   []string `json:"action"`
			Resource []string `json:"resource"`
		} `json:"statement"`
	}
	if err := json.Unmarshal([]byte(document), &policy); err != nil {
		t.Fatalf("policy is not valid JSON: %v", err)
	}
	if len(policy.Statement) != 2 {
		t.Fatalf("statement count = %d, want 2", len(policy.Statement))
	}

	wantSecrets := []string{
		"qcs::ssm:ap-shanghai:uin/100012345678:secret/creatorUin/100012345678/mono-shprod-notify-scan-probe-db",
		"qcs::ssm:ap-shanghai:uin/100012345678:secret/creatorUin/100012345678/mono-shprod-notify-redis",
	}
	if !reflect.DeepEqual(policy.Statement[0].Action, []string{"name/ssm:GetSecretValue"}) {
		t.Fatalf("SSM actions = %#v", policy.Statement[0].Action)
	}
	if !reflect.DeepEqual(policy.Statement[0].Resource, wantSecrets) {
		t.Fatalf("SSM resources = %#v, want %#v", policy.Statement[0].Resource, wantSecrets)
	}
	if !reflect.DeepEqual(policy.Statement[1].Action, []string{"name/sms:SendSms"}) {
		t.Fatalf("SMS actions = %#v", policy.Statement[1].Action)
	}
	if !reflect.DeepEqual(policy.Statement[1].Resource, []string{"*"}) {
		t.Fatalf("SMS resources = %#v, want wildcard", policy.Statement[1].Resource)
	}
}
