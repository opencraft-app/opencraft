package collaborationbootstrap

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"reflect"
	"testing"
)

const legacyIdentityKeyHex = "2424242424242424242424242424242424242424242424242424242424242424"

type fakeDatabase struct {
	state  DatabaseState
	err    error
	writes []string
}

func (f *fakeDatabase) Inspect(context.Context, Config) (DatabaseState, error) {
	return f.state, f.err
}

func (f *fakeDatabase) CreateAccount(_ context.Context, _ Config, password string) error {
	if password == "" {
		return errors.New("empty password")
	}
	f.writes = append(f.writes, "account")
	return nil
}

func (f *fakeDatabase) ResetAccountPassword(_ context.Context, _ Config, password string) error {
	if password == "" {
		return errors.New("empty password")
	}
	f.writes = append(f.writes, "reset-password")
	return nil
}

func (f *fakeDatabase) CreateDatabase(context.Context, Config) error {
	f.writes = append(f.writes, "database")
	return nil
}

func (f *fakeDatabase) SetDatabasePrivileges(_ context.Context, _ Config, privileges []string) error {
	f.writes = append(f.writes, "privileges")
	f.state.Privileges = append([]string(nil), privileges...)
	return nil
}

type fakeSecrets struct {
	payload map[string]string
	exists  bool
	err     error
	writes  []string
}

func (f *fakeSecrets) Read(context.Context, string) (map[string]string, bool, error) {
	copyPayload := make(map[string]string, len(f.payload))
	for key, value := range f.payload {
		copyPayload[key] = value
	}
	return copyPayload, f.exists, f.err
}

func (f *fakeSecrets) Write(_ context.Context, _ string, payload map[string]string, create bool) error {
	f.payload = make(map[string]string, len(payload))
	for key, value := range payload {
		f.payload[key] = value
	}
	f.exists = true
	if create {
		f.writes = append(f.writes, "create-secret")
	} else {
		f.writes = append(f.writes, "update-secret")
	}
	return nil
}

type fakeGenerator struct {
	values []string
	index  int
}

func (f *fakeGenerator) Token(int) (string, error) {
	if f.index >= len(f.values) {
		return "", errors.New("generator exhausted")
	}
	value := f.values[f.index]
	f.index++
	return value, nil
}

func testConfig() Config {
	return Config{
		ClusterID:    "cynosdbmysql-test",
		Database:     "lightvela_collaboration",
		Account:      "collaboration_rw",
		AccountHost:  "%",
		EndpointHost: "10.0.0.10",
		EndpointPort: 3306,
		SecretName:   "mono-beijing-sandbox-collaboration-runtime-secrets",
	}
}

func generatedValues() []string {
	return []string{"database-password", "jwt-key", "gateway-token", legacyIdentityKeyHex, "im-callback"}
}

func validIdentityKey() string {
	raw, err := hex.DecodeString(legacyIdentityKeyHex)
	if err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func TestRunDryRunPlansAllResourcesWithoutWriting(t *testing.T) {
	database := &fakeDatabase{}
	secrets := &fakeSecrets{}
	result, err := Run(t.Context(), database, secrets, &fakeGenerator{values: generatedValues()}, testConfig(), IMMaterial{SecretKey: "im-secret"}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Secret.Created || !result.Account.Created || !result.Database.Created || !result.Privileges.Updated {
		t.Fatalf("dry-run result = %+v", result)
	}
	if result.Applied || len(database.writes) != 0 || len(secrets.writes) != 0 {
		t.Fatalf("dry-run caused writes: result=%+v db=%v secrets=%v", result, database.writes, secrets.writes)
	}
}

func TestRunApplyWritesRecoverableOrderAndCompleteSecret(t *testing.T) {
	database := &fakeDatabase{}
	secrets := &fakeSecrets{}
	result, err := Run(t.Context(), database, secrets, &fakeGenerator{values: generatedValues()}, testConfig(), IMMaterial{SecretKey: "im-secret"}, Options{Apply: true})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Applied || !reflect.DeepEqual(secrets.writes, []string{"create-secret"}) || !reflect.DeepEqual(database.writes, []string{"account", "database", "privileges"}) {
		t.Fatalf("unexpected write order: result=%+v secrets=%v db=%v", result, secrets.writes, database.writes)
	}
	for _, key := range RequiredSecretKeys() {
		if secrets.payload[key] == "" {
			t.Errorf("secret key %q is missing", key)
		}
	}
	if got := secrets.payload["database.dsn"]; got != "collaboration_rw:Aa1_base-password@tcp(10.0.0.10:3306)/lightvela_collaboration?charset=utf8mb4&parseTime=true&loc=UTC" {
		t.Fatalf("database.dsn = %q", got)
	}
	identity, err := base64.RawURLEncoding.DecodeString(secrets.payload[imIdentityKey])
	if err != nil || len(identity) != 32 {
		t.Fatalf("%s must decode to 32 bytes: len=%d err=%v", imIdentityKey, len(identity), err)
	}
}

func TestRunCanonicalizesLegacyHexIdentityKey(t *testing.T) {
	config := testConfig()
	payload := map[string]string{
		"database.dsn": "collaboration_rw:existing-password@tcp(10.0.0.10:3306)/lightvela_collaboration?charset=utf8mb4&parseTime=true&loc=UTC",
		"jwt.key":      "jwt", "gateway.token": "gateway", "im-secret.key": "im-secret",
		"im-identity.key": legacyIdentityKeyHex, "im-callback.token": "callback",
	}
	database := &fakeDatabase{state: DatabaseState{AccountExists: true, DatabaseExists: true, Privileges: DatabasePrivileges()}}
	secrets := &fakeSecrets{payload: payload, exists: true}
	result, err := Run(t.Context(), database, secrets, &fakeGenerator{}, config, IMMaterial{SecretKey: "im-secret"}, Options{Apply: true})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Secret.Updated || !result.Secret.Applied || !reflect.DeepEqual(secrets.writes, []string{"update-secret"}) {
		t.Fatalf("legacy identity key was not repaired: result=%+v writes=%v", result, secrets.writes)
	}
	if got := secrets.payload[imIdentityKey]; got != validIdentityKey() {
		t.Fatalf("canonical identity key = %q", got)
	}
}

func TestRunRejectsInvalidIdentityKeyWithoutWriting(t *testing.T) {
	config := testConfig()
	payload := map[string]string{
		"database.dsn": "collaboration_rw:existing-password@tcp(10.0.0.10:3306)/lightvela_collaboration?charset=utf8mb4&parseTime=true&loc=UTC",
		"jwt.key":      "jwt", "gateway.token": "gateway", "im-secret.key": "im-secret",
		"im-identity.key": "not-a-valid-key", "im-callback.token": "callback",
	}
	database := &fakeDatabase{state: DatabaseState{AccountExists: true, DatabaseExists: true, Privileges: DatabasePrivileges()}}
	secrets := &fakeSecrets{payload: payload, exists: true}
	_, err := Run(t.Context(), database, secrets, &fakeGenerator{}, config, IMMaterial{SecretKey: "im-secret"}, Options{Apply: true})
	if err == nil {
		t.Fatal("invalid identity key was accepted")
	}
	if len(database.writes) != 0 || len(secrets.writes) != 0 {
		t.Fatalf("invalid identity key caused writes: db=%v secrets=%v", database.writes, secrets.writes)
	}
}

func TestRunRepairsInvalidOrphanSecretPasswordBeforeCreatingAccount(t *testing.T) {
	config := testConfig()
	secrets := &fakeSecrets{exists: true, payload: map[string]string{
		"database.dsn": "collaboration_rw:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef@tcp(10.0.0.10:3306)/lightvela_collaboration?charset=utf8mb4&parseTime=true&loc=UTC",
		"jwt.key":      "jwt", "gateway.token": "gateway", "im-secret.key": "im-secret",
		"im-identity.key": validIdentityKey(), "im-callback.token": "callback",
	}}
	database := &fakeDatabase{}
	result, err := Run(t.Context(), database, secrets, &fakeGenerator{values: []string{"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"}}, config, IMMaterial{SecretKey: "im-secret"}, Options{Apply: true})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Secret.Updated || !result.Secret.Applied || !result.Account.Created || !result.Account.Applied {
		t.Fatalf("recovery result = %+v", result)
	}
	if !reflect.DeepEqual(secrets.writes, []string{"update-secret"}) || !reflect.DeepEqual(database.writes, []string{"account", "database", "privileges"}) {
		t.Fatalf("recovery writes: secrets=%v db=%v", secrets.writes, database.writes)
	}
	if got := secrets.payload["database.dsn"]; got != "collaboration_rw:Aa1_ba9876543210fedcba9876543210fedcba9876543210fedcba9876543210@tcp(10.0.0.10:3306)/lightvela_collaboration?charset=utf8mb4&parseTime=true&loc=UTC" {
		t.Fatalf("recovered database.dsn = %q", got)
	}
}

func TestRunExistingMatchingStateIsIdempotent(t *testing.T) {
	config := testConfig()
	payload := map[string]string{
		"database.dsn": "collaboration_rw:existing-password@tcp(10.0.0.10:3306)/lightvela_collaboration?charset=utf8mb4&parseTime=true&loc=UTC",
		"jwt.key":      "jwt", "gateway.token": "gateway", "im-secret.key": "im-secret",
		"im-identity.key": validIdentityKey(), "im-callback.token": "callback",
	}
	database := &fakeDatabase{state: DatabaseState{AccountExists: true, DatabaseExists: true, Privileges: DatabasePrivileges()}}
	secrets := &fakeSecrets{payload: payload, exists: true}
	result, err := Run(t.Context(), database, secrets, &fakeGenerator{}, config, IMMaterial{SecretKey: "im-secret"}, Options{Apply: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.Changed() || len(database.writes) != 0 || len(secrets.writes) != 0 {
		t.Fatalf("idempotent run changed state: result=%+v db=%v secrets=%v", result, database.writes, secrets.writes)
	}
}

func TestRunRejectsForeignSecretBeforeAnyWrite(t *testing.T) {
	secrets := &fakeSecrets{exists: true, payload: map[string]string{
		"database.dsn": "other:password@tcp(10.0.0.10:3306)/other_database?parseTime=true",
		"jwt.key":      "jwt", "gateway.token": "gateway", "im-secret.key": "im-secret",
		"im-identity.key": validIdentityKey(), "im-callback.token": "callback",
	}}
	database := &fakeDatabase{}
	_, err := Run(t.Context(), database, secrets, &fakeGenerator{}, testConfig(), IMMaterial{SecretKey: "im-secret"}, Options{Apply: true})
	if err == nil {
		t.Fatal("foreign DSN was accepted")
	}
	if len(database.writes) != 0 || len(secrets.writes) != 0 {
		t.Fatalf("preflight failure wrote state: db=%v secret=%v", database.writes, secrets.writes)
	}
}

func TestRunRefusesOrphanAccountWithoutExplicitPasswordRotation(t *testing.T) {
	database := &fakeDatabase{state: DatabaseState{AccountExists: true}}
	secrets := &fakeSecrets{}
	_, err := Run(t.Context(), database, secrets, &fakeGenerator{values: generatedValues()}, testConfig(), IMMaterial{SecretKey: "im-secret"}, Options{Apply: true})
	if err == nil {
		t.Fatal("orphan account should require explicit password rotation")
	}
	if len(database.writes) != 0 || len(secrets.writes) != 0 {
		t.Fatalf("orphan account failure wrote state: db=%v secret=%v", database.writes, secrets.writes)
	}
}

func TestRunCanRecoverOrphanAccountWithExplicitPasswordRotation(t *testing.T) {
	database := &fakeDatabase{state: DatabaseState{AccountExists: true}}
	secrets := &fakeSecrets{}
	_, err := Run(t.Context(), database, secrets, &fakeGenerator{values: generatedValues()}, testConfig(), IMMaterial{SecretKey: "im-secret"}, Options{Apply: true, AllowDatabasePasswordReset: true})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(secrets.writes, []string{"create-secret"}) || !reflect.DeepEqual(database.writes, []string{"reset-password", "database", "privileges"}) {
		t.Fatalf("unexpected recovery writes: secrets=%v db=%v", secrets.writes, database.writes)
	}
}

func TestRunRequiresIMSecretBeforePlanningNewSecret(t *testing.T) {
	database := &fakeDatabase{}
	secrets := &fakeSecrets{}
	_, err := Run(t.Context(), database, secrets, &fakeGenerator{values: generatedValues()}, testConfig(), IMMaterial{}, Options{})
	if err == nil {
		t.Fatal("missing IM secret was accepted")
	}
	if len(database.writes) != 0 || len(secrets.writes) != 0 {
		t.Fatalf("missing IM secret caused writes: db=%v secret=%v", database.writes, secrets.writes)
	}
}

func TestRunExplicitRotationsUpdateOnlyRequestedCredentials(t *testing.T) {
	payload := map[string]string{
		"database.dsn": "collaboration_rw:existing-password@tcp(10.0.0.10:3306)/lightvela_collaboration?charset=utf8mb4&parseTime=true&loc=UTC",
		"jwt.key":      "jwt", "gateway.token": "gateway", "im-secret.key": "old-im-secret",
		"im-identity.key": validIdentityKey(), "im-callback.token": "callback",
	}
	database := &fakeDatabase{state: DatabaseState{AccountExists: true, DatabaseExists: true, Privileges: DatabasePrivileges()}}
	secrets := &fakeSecrets{payload: payload, exists: true}
	result, err := Run(t.Context(), database, secrets, &fakeGenerator{}, testConfig(), IMMaterial{SecretKey: "new-im-secret"}, Options{
		Apply: true, AllowDatabasePasswordReset: true, AllowIMSecretRotation: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Secret.Updated || !result.Secret.Applied || !result.Account.Updated || !result.Account.Applied {
		t.Fatalf("rotation result = %+v", result)
	}
	if !reflect.DeepEqual(secrets.writes, []string{"update-secret"}) || !reflect.DeepEqual(database.writes, []string{"reset-password"}) {
		t.Fatalf("rotation writes: secrets=%v db=%v", secrets.writes, database.writes)
	}
	if secrets.payload["im-secret.key"] != "new-im-secret" || secrets.payload["jwt.key"] != "jwt" || secrets.payload["im-identity.key"] != validIdentityKey() {
		t.Fatalf("rotation changed unrelated keys: %#v", secrets.payload)
	}
}

func TestRunRepairsPrivilegesWhenScopeIsWiderThanTargetDatabase(t *testing.T) {
	database := &fakeDatabase{state: DatabaseState{
		AccountExists: true, DatabaseExists: true, Privileges: DatabasePrivileges(), UnexpectedPrivilegeScope: true,
	}}
	secrets := &fakeSecrets{exists: true, payload: map[string]string{
		"database.dsn": "collaboration_rw:existing-password@tcp(10.0.0.10:3306)/lightvela_collaboration?charset=utf8mb4&parseTime=true&loc=UTC",
		"jwt.key":      "jwt", "gateway.token": "gateway", "im-secret.key": "im-secret",
		"im-identity.key": validIdentityKey(), "im-callback.token": "callback",
	}}
	result, err := Run(t.Context(), database, secrets, &fakeGenerator{}, testConfig(), IMMaterial{SecretKey: "im-secret"}, Options{Apply: true})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Privileges.Updated || !reflect.DeepEqual(database.writes, []string{"privileges"}) {
		t.Fatalf("wide privileges were not repaired: result=%+v writes=%v", result, database.writes)
	}
}
