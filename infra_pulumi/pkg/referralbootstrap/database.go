package referralbootstrap

import (
	"context"
	"fmt"
	"strings"

	"github.com/skipzhang/mono/infra_pulumi/pkg/collaborationbootstrap"
)

const (
	referralDBPasswordKey   = "REFERRAL_DB_PASSWORD"
	internalServiceTokenKey = "LIGHTCLAW_INTERNAL_SERVICE_TOKEN"
)

type DatabaseOptions struct {
	Apply                      bool
	AllowDatabasePasswordReset bool
	AllowInternalTokenChange   bool
}

type DatabaseResult struct {
	Secret     collaborationbootstrap.Change
	Account    collaborationbootstrap.Change
	Database   collaborationbootstrap.Change
	Privileges collaborationbootstrap.Change
	Applied    bool
}

func RunDatabase(
	ctx context.Context,
	database collaborationbootstrap.DatabaseAdmin,
	secrets SecretStore,
	generator collaborationbootstrap.TokenGenerator,
	internalServiceToken string,
	secretVersionID string,
	config collaborationbootstrap.Config,
	options DatabaseOptions,
) (DatabaseResult, error) {
	if database == nil || secrets == nil || generator == nil {
		return DatabaseResult{}, fmt.Errorf("referral database bootstrap dependencies are incomplete")
	}
	internalServiceToken = strings.TrimSpace(internalServiceToken)
	if internalServiceToken == "" {
		return DatabaseResult{}, fmt.Errorf("referral internal service token is required")
	}
	secretVersionID = strings.TrimSpace(secretVersionID)
	if secretVersionID == "" {
		return DatabaseResult{}, fmt.Errorf("referral SSM version ID is required")
	}
	state, err := database.Inspect(ctx, config)
	if err != nil {
		return DatabaseResult{}, fmt.Errorf("inspect referral database target: %w", err)
	}
	payload, exists, err := secrets.Read(ctx, config.SecretName, secretVersionID)
	if err != nil {
		return DatabaseResult{}, fmt.Errorf("read referral SSM secret: %w", err)
	}
	if payload == nil {
		payload = map[string]any{}
	}

	result := DatabaseResult{}
	password, passwordPresent, err := managedString(payload, referralDBPasswordKey)
	if err != nil {
		return result, err
	}
	if state.AccountExists && (!passwordPresent || !validDatabasePassword(password)) && !options.AllowDatabasePasswordReset {
		return result, fmt.Errorf("database account exists without a managed referral password; rerun with --allow-database-password-reset to recover")
	}
	passwordChanged := !passwordPresent || !validDatabasePassword(password)
	if passwordChanged {
		password, err = newDatabasePassword(generator)
		if err != nil {
			return result, err
		}
		payload[referralDBPasswordKey] = password
		result.Secret.Updated = true
	}
	currentInternalToken, tokenPresent, err := managedString(payload, internalServiceTokenKey)
	if err != nil {
		return result, err
	}
	if tokenPresent && currentInternalToken != internalServiceToken && !options.AllowInternalTokenChange {
		return result, fmt.Errorf("referral SSM contains a different internal token; rerun with --allow-internal-token-change to rotate")
	}
	if !tokenPresent || currentInternalToken != internalServiceToken {
		payload[internalServiceTokenKey] = internalServiceToken
		result.Secret.Updated = true
	}
	if !exists {
		result.Secret.Created = true
	}
	if !state.AccountExists {
		result.Account.Created = true
	} else if options.AllowDatabasePasswordReset && passwordChanged {
		result.Account.Updated = true
	}
	if !state.DatabaseExists {
		result.Database.Created = true
	}
	if state.UnexpectedPrivilegeScope || !samePrivileges(state.Privileges, collaborationbootstrap.DatabasePrivileges()) {
		result.Privileges.Updated = true
	}
	if !options.Apply {
		return result, nil
	}

	if result.Secret.Created || result.Secret.Updated {
		if err := secrets.Write(ctx, config.SecretName, secretVersionID, payload, !exists); err != nil {
			return result, fmt.Errorf("write referral SSM secret: %w", err)
		}
		result.Secret.Applied = true
	}
	if result.Account.Created {
		if err := database.CreateAccount(ctx, config, password); err != nil {
			return result, fmt.Errorf("create referral database account: %w", err)
		}
		result.Account.Applied = true
	} else if result.Account.Updated {
		if err := database.ResetAccountPassword(ctx, config, password); err != nil {
			return result, fmt.Errorf("reset referral database account password: %w", err)
		}
		result.Account.Applied = true
	}
	if result.Database.Created {
		if err := database.CreateDatabase(ctx, config); err != nil {
			return result, fmt.Errorf("create referral database: %w", err)
		}
		result.Database.Applied = true
	}
	if result.Privileges.Updated {
		if err := database.SetDatabasePrivileges(ctx, config, collaborationbootstrap.DatabasePrivileges()); err != nil {
			return result, fmt.Errorf("set referral database privileges: %w", err)
		}
		result.Privileges.Applied = true
	}
	result.Applied = true
	return result, nil
}

func managedString(payload map[string]any, key string) (string, bool, error) {
	raw, ok := payload[key]
	if !ok || raw == nil {
		return "", false, nil
	}
	value, ok := raw.(string)
	if !ok || strings.TrimSpace(value) == "" {
		return "", false, fmt.Errorf("SSM secret contains an invalid %s", key)
	}
	return value, true, nil
}

func newDatabasePassword(generator collaborationbootstrap.TokenGenerator) (string, error) {
	value, err := generator.Token(32)
	if err != nil {
		return "", fmt.Errorf("generate referral database password: %w", err)
	}
	if len(value) < 8 || len(value) > 64 {
		return "", fmt.Errorf("generate referral database password: token length must be between 8 and 64 characters")
	}
	password := []byte(value)
	copy(password[:4], "Aa1_")
	if !validDatabasePassword(string(password)) {
		return "", fmt.Errorf("generate referral database password: token contains unsupported characters")
	}
	return string(password), nil
}

func validDatabasePassword(value string) bool {
	if len(value) < 8 || len(value) > 64 {
		return false
	}
	lower, upper, digit, special := false, false, false, false
	for _, char := range value {
		switch {
		case char >= 'a' && char <= 'z':
			lower = true
		case char >= 'A' && char <= 'Z':
			upper = true
		case char >= '0' && char <= '9':
			digit = true
		case strings.ContainsRune("~!#$%^*_-+=|\\(){}[];'<>,.", char):
			special = true
		default:
			return false
		}
	}
	categories := 0
	for _, present := range []bool{lower, upper, digit, special} {
		if present {
			categories++
		}
	}
	return categories >= 3
}

func samePrivileges(actual, expected []string) bool {
	normalize := func(values []string) map[string]struct{} {
		result := make(map[string]struct{}, len(values))
		for _, value := range values {
			value = strings.ToUpper(strings.TrimSpace(value))
			if value != "" {
				result[value] = struct{}{}
			}
		}
		return result
	}
	a, e := normalize(actual), normalize(expected)
	if len(a) != len(e) {
		return false
	}
	for value := range e {
		if _, ok := a[value]; !ok {
			return false
		}
	}
	return true
}
