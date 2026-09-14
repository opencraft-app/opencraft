package referralbootstrap

import (
	"context"
	"strings"
	"testing"

	tcerr "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
	ssm "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/ssm/v20190923"

	"github.com/skipzhang/mono/infra_pulumi/pkg/config"
)

type fakeRoles map[string]string

func (f fakeRoles) TokenForRole(_ context.Context, clusterID, roleName string) (string, error) {
	if clusterID != "pulsar-cluster" {
		return "", context.Canceled
	}
	return f[roleName], nil
}

type fakeSecrets struct {
	values map[string]map[string]any
	writes []string
}

func (f *fakeSecrets) Read(_ context.Context, name string) (map[string]any, bool, error) {
	value, ok := f.values[name]
	if !ok {
		return map[string]any{}, false, nil
	}
	copyValue := make(map[string]any, len(value))
	for key, item := range value {
		copyValue[key] = item
	}
	return copyValue, true, nil
}

func (f *fakeSecrets) Write(_ context.Context, name string, payload map[string]any, create bool) error {
	if create && name != "referral-secret" {
		return context.Canceled
	}
	f.values[name] = payload
	f.writes = append(f.writes, name)
	return nil
}

func bootstrapInventory() *config.Inventory {
	inventory := &config.Inventory{EnvName: "beijing-sandbox", Region: "ap-beijing"}
	inventory.Stacks.Pulsar = config.PulsarInventory{
		Enabled: true, ExistingClusterID: "pulsar-cluster",
		UserAuthProducerRole: "auth-role", CTLProducerRole: "ctl-role", ReferralConsumerRole: "referral-role",
		UserAuthSSMSecret: "auth-secret", CTLSSMSecret: "ctl-secret", ReferralSSMSecret: "referral-secret",
	}
	return inventory
}

func TestRunMergesTokensAndCreatesOnlyReferralSecret(t *testing.T) {
	secrets := &fakeSecrets{values: map[string]map[string]any{
		"auth-secret": {"AUTH_EXISTING": "keep"},
		"ctl-secret":  {"CTL_EXISTING": jsonNumberForTest("42")},
	}}
	results, err := Run(t.Context(), bootstrapInventory(), fakeRoles{
		"auth-role": "auth-token", "ctl-role": "ctl-token", "referral-role": "referral-token",
	}, secrets, Options{Apply: true})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(results) != 3 || len(secrets.writes) != 3 {
		t.Fatalf("results=%d writes=%v", len(results), secrets.writes)
	}
	if !results[2].Created || results[0].Created || results[1].Created {
		t.Fatalf("unexpected create results: %+v", results)
	}
	if secrets.values["auth-secret"]["AUTH_EXISTING"] != "keep" || secrets.values["auth-secret"][tokenKey] != "auth-token" {
		t.Fatalf("auth secret was not merged: %#v", secrets.values["auth-secret"])
	}
	if secrets.values["ctl-secret"]["CTL_EXISTING"].(jsonNumber).String() != "42" {
		t.Fatalf("non-string JSON value was not preserved: %#v", secrets.values["ctl-secret"])
	}
}

func TestRunPreflightsAllSecretsBeforeWriting(t *testing.T) {
	secrets := &fakeSecrets{values: map[string]map[string]any{
		"auth-secret": {tokenKey: "old-token"},
		"ctl-secret":  {},
	}}
	_, err := Run(t.Context(), bootstrapInventory(), fakeRoles{
		"auth-role": "new-token", "ctl-role": "ctl-token", "referral-role": "referral-token",
	}, secrets, Options{Apply: true})
	if err == nil || !strings.Contains(err.Error(), "--allow-token-change") {
		t.Fatalf("Run error=%v, want rotation guard", err)
	}
	if len(secrets.writes) != 0 {
		t.Fatalf("preflight failure caused partial writes: %v", secrets.writes)
	}
}

func TestRunIsIdempotentWhenTokensAlreadyMatch(t *testing.T) {
	secrets := &fakeSecrets{values: map[string]map[string]any{
		"auth-secret":     {tokenKey: "auth-token"},
		"ctl-secret":      {tokenKey: "ctl-token"},
		"referral-secret": {tokenKey: "referral-token"},
	}}
	results, err := Run(t.Context(), bootstrapInventory(), fakeRoles{
		"auth-role": "auth-token", "ctl-role": "ctl-token", "referral-role": "referral-token",
	}, secrets, Options{Apply: true})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(secrets.writes) != 0 {
		t.Fatalf("idempotent run wrote secrets: %v", secrets.writes)
	}
	for _, result := range results {
		if result.Created || result.Updated {
			t.Fatalf("unexpected mutation result: %+v", result)
		}
	}
}

func TestRunRejectsOneTokenReturnedForDifferentRoles(t *testing.T) {
	secrets := &fakeSecrets{values: map[string]map[string]any{
		"auth-secret": {},
		"ctl-secret":  {},
	}}
	_, err := Run(t.Context(), bootstrapInventory(), fakeRoles{
		"auth-role": "shared-token", "ctl-role": "shared-token", "referral-role": "referral-token",
	}, secrets, Options{Apply: true})
	if err == nil || !strings.Contains(err.Error(), "unexpectedly share one token") {
		t.Fatalf("Run error=%v, want duplicate-token rejection", err)
	}
	if len(secrets.writes) != 0 {
		t.Fatalf("duplicate-token preflight caused writes: %v", secrets.writes)
	}
}

func TestRunDryRunReportsWithoutWriting(t *testing.T) {
	secrets := &fakeSecrets{values: map[string]map[string]any{
		"auth-secret": {},
		"ctl-secret":  {},
	}}
	results, err := Run(t.Context(), bootstrapInventory(), fakeRoles{
		"auth-role": "auth-token", "ctl-role": "ctl-token", "referral-role": "referral-token",
	}, secrets, Options{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(secrets.writes) != 0 {
		t.Fatalf("dry run wrote secrets: %v", secrets.writes)
	}
	for _, result := range results {
		if !result.Updated || result.Applied {
			t.Fatalf("unexpected dry-run result: %+v", result)
		}
	}
}

func TestTencentSecretStoreRecognizesBothSecretNotFoundCodes(t *testing.T) {
	for _, code := range []string{ssm.RESOURCENOTFOUND, ssm.RESOURCENOTFOUND_SECRETNOTEXIST} {
		t.Run(code, func(t *testing.T) {
			err := tcerr.NewTencentCloudSDKError(code, "secret not found", "request-id")
			if !isSecretNotFoundError(err) {
				t.Fatalf("error code %q should be treated as a missing secret", code)
			}
		})
	}
	if isSecretNotFoundError(context.Canceled) {
		t.Fatal("unrelated error must not be treated as a missing secret")
	}
}

// Keep JSON-number preservation in the fake without importing implementation details.
type jsonNumber string

func (n jsonNumber) String() string { return string(n) }

func jsonNumberForTest(value string) jsonNumber { return jsonNumber(value) }
