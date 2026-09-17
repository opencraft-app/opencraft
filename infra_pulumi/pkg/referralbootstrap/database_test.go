package referralbootstrap

import (
	"context"
	"strings"
	"testing"

	"github.com/skipzhang/mono/infra_pulumi/pkg/collaborationbootstrap"
)

type fakeReferralDatabase struct {
	state collaborationbootstrap.DatabaseState
	calls []string
}

func (f *fakeReferralDatabase) Inspect(context.Context, collaborationbootstrap.Config) (collaborationbootstrap.DatabaseState, error) {
	return f.state, nil
}

func (f *fakeReferralDatabase) CreateAccount(context.Context, collaborationbootstrap.Config, string) error {
	f.calls = append(f.calls, "account")
	return nil
}

func (f *fakeReferralDatabase) ResetAccountPassword(context.Context, collaborationbootstrap.Config, string) error {
	f.calls = append(f.calls, "reset-password")
	return nil
}

func (f *fakeReferralDatabase) CreateDatabase(context.Context, collaborationbootstrap.Config) error {
	f.calls = append(f.calls, "database")
	return nil
}

func (f *fakeReferralDatabase) SetDatabasePrivileges(context.Context, collaborationbootstrap.Config, []string) error {
	f.calls = append(f.calls, "privileges")
	return nil
}

type fixedReferralGenerator struct{ values []string }

func (f *fixedReferralGenerator) Token(int) (string, error) {
	value := f.values[0]
	f.values = f.values[1:]
	return value, nil
}

func referralDatabaseConfig() collaborationbootstrap.Config {
	return collaborationbootstrap.Config{
		ClusterID: "cynosdbmysql-sg", Database: "lightvela_referral", Account: "referral",
		AccountHost: "%", EndpointHost: "10.15.192.12", EndpointPort: 3306,
		SecretName: "mono-sgprod-referral-runtime-secrets", Description: "LightVela Referral runtime",
	}
}

func TestRunDatabaseCreatesIsolatedDatabaseAndMergesReferralSecret(t *testing.T) {
	database := &fakeReferralDatabase{}
	secrets := &fakeSecrets{values: map[string]map[string]any{
		"mono-sgprod-referral-runtime-secrets": {tokenKey: "pulsar-token"},
	}}
	result, err := RunDatabase(t.Context(), database, secrets, &fixedReferralGenerator{values: []string{
		strings.Repeat("a", 64),
	}}, "shared-internal-token", "SSM_Current", referralDatabaseConfig(), DatabaseOptions{Apply: true})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Secret.Updated || !result.Secret.Applied || !result.Account.Created || !result.Database.Created || !result.Privileges.Updated {
		t.Fatalf("unexpected result: %+v", result)
	}
	if strings.Join(database.calls, ",") != "account,database,privileges" {
		t.Fatalf("database calls = %v", database.calls)
	}
	payload := secrets.values["mono-sgprod-referral-runtime-secrets"]
	if payload[tokenKey] != "pulsar-token" {
		t.Fatalf("Pulsar token was not preserved: %#v", payload)
	}
	password, ok := payload[referralDBPasswordKey].(string)
	if !ok || !strings.HasPrefix(password, "Aa1_") || len(password) != 64 {
		t.Fatalf("invalid generated database password shape")
	}
	if payload[internalServiceTokenKey] != "shared-internal-token" {
		t.Fatalf("CTL internal token was not copied exactly")
	}
}

func TestRunDatabaseDryRunDoesNotWriteOrCallCloudMutations(t *testing.T) {
	database := &fakeReferralDatabase{}
	secrets := &fakeSecrets{values: map[string]map[string]any{}}
	result, err := RunDatabase(t.Context(), database, secrets, &fixedReferralGenerator{values: []string{
		strings.Repeat("c", 64),
	}}, "shared-internal-token", "SSM_Current", referralDatabaseConfig(), DatabaseOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Applied || len(secrets.writes) != 0 || len(database.calls) != 0 {
		t.Fatalf("dry run mutated state: result=%+v writes=%v calls=%v", result, secrets.writes, database.calls)
	}
}

func TestRunDatabaseRejectsExistingAccountWithoutManagedPassword(t *testing.T) {
	database := &fakeReferralDatabase{state: collaborationbootstrap.DatabaseState{AccountExists: true}}
	secrets := &fakeSecrets{values: map[string]map[string]any{
		"mono-sgprod-referral-runtime-secrets": {tokenKey: "pulsar-token"},
	}}
	_, err := RunDatabase(t.Context(), database, secrets, &fixedReferralGenerator{values: []string{
		strings.Repeat("e", 64),
	}}, "shared-internal-token", "SSM_Current", referralDatabaseConfig(), DatabaseOptions{Apply: true})
	if err == nil || !strings.Contains(err.Error(), "--allow-database-password-reset") {
		t.Fatalf("error = %v", err)
	}
	if len(secrets.writes) != 0 || len(database.calls) != 0 {
		t.Fatalf("preflight failure mutated state")
	}
}

func TestRunDatabaseDoesNotResetExistingPasswordWhenOnlyInternalTokenIsMissing(t *testing.T) {
	database := &fakeReferralDatabase{state: collaborationbootstrap.DatabaseState{
		AccountExists: true, DatabaseExists: true, Privileges: collaborationbootstrap.DatabasePrivileges(),
	}}
	secrets := &fakeSecrets{values: map[string]map[string]any{
		"mono-sgprod-referral-runtime-secrets": {
			tokenKey:              "pulsar-token",
			referralDBPasswordKey: "Aa1_" + strings.Repeat("a", 60),
		},
	}}
	result, err := RunDatabase(t.Context(), database, secrets, &fixedReferralGenerator{values: []string{}},
		"shared-internal-token", "SSM_Current", referralDatabaseConfig(), DatabaseOptions{Apply: true, AllowDatabasePasswordReset: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.Account.Updated || strings.Contains(strings.Join(database.calls, ","), "reset-password") {
		t.Fatalf("unchanged database password was reset: result=%+v calls=%v", result, database.calls)
	}
	if !result.Secret.Updated || !result.Secret.Applied {
		t.Fatalf("missing internal token was not delivered: %+v", result)
	}
}

func TestRunDatabaseRejectsDifferentInternalTokenWithoutExplicitRotation(t *testing.T) {
	database := &fakeReferralDatabase{}
	secrets := &fakeSecrets{values: map[string]map[string]any{
		"mono-sgprod-referral-runtime-secrets": {
			referralDBPasswordKey:   "Aa1_" + strings.Repeat("a", 60),
			internalServiceTokenKey: "old-token",
		},
	}}
	_, err := RunDatabase(t.Context(), database, secrets, &fixedReferralGenerator{},
		"new-token", "SSM_Current", referralDatabaseConfig(), DatabaseOptions{Apply: true})
	if err == nil || !strings.Contains(err.Error(), "--allow-internal-token-change") {
		t.Fatalf("error = %v", err)
	}
	if len(secrets.writes) != 0 || len(database.calls) != 0 {
		t.Fatalf("token mismatch preflight mutated state")
	}
}
