package collaborationbootstrap

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	databaseDSNKey = "database.dsn"
	jwtKey         = "jwt.key"
	gatewayKey     = "gateway.token"
	imSecretKey    = "im-secret.key"
	imIdentityKey  = "im-identity.key"
	imCallbackKey  = "im-callback.token"
)

var resourceNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,28}[A-Za-z0-9]$`)

const cynosDBPasswordSpecials = "~!#$%^*_-+=|\\(){}[];'<>.,"

type Config struct {
	ClusterID    string
	Database     string
	Account      string
	AccountHost  string
	EndpointHost string
	EndpointPort int
	SecretName   string
}

type IMMaterial struct {
	SecretKey string
}

type Options struct {
	Apply                      bool
	AllowDatabasePasswordReset bool
	AllowIMSecretRotation      bool
}

type DatabaseState struct {
	AccountExists            bool
	DatabaseExists           bool
	Privileges               []string
	UnexpectedPrivilegeScope bool
}

type DatabaseAdmin interface {
	Inspect(context.Context, Config) (DatabaseState, error)
	CreateAccount(context.Context, Config, string) error
	ResetAccountPassword(context.Context, Config, string) error
	CreateDatabase(context.Context, Config) error
	SetDatabasePrivileges(context.Context, Config, []string) error
}

type SecretStore interface {
	Read(context.Context, string) (map[string]string, bool, error)
	Write(context.Context, string, map[string]string, bool) error
}

type TokenGenerator interface {
	Token(int) (string, error)
}

type Change struct {
	Created bool
	Updated bool
	Applied bool
}

type Result struct {
	Secret     Change
	Account    Change
	Database   Change
	Privileges Change
	Applied    bool
}

func (r Result) Changed() bool {
	return r.Secret.Created || r.Secret.Updated || r.Account.Created || r.Account.Updated ||
		r.Database.Created || r.Database.Updated || r.Privileges.Created || r.Privileges.Updated
}

func RequiredSecretKeys() []string {
	return []string{databaseDSNKey, jwtKey, gatewayKey, imSecretKey, imIdentityKey, imCallbackKey}
}

func DatabasePrivileges() []string {
	return []string{
		"ALTER", "CREATE", "CREATE VIEW", "DELETE", "DROP", "INDEX", "INSERT",
		"REFERENCES", "SELECT", "SHOW VIEW", "TRIGGER", "UPDATE",
	}
}

func Run(
	ctx context.Context,
	database DatabaseAdmin,
	secrets SecretStore,
	generator TokenGenerator,
	config Config,
	im IMMaterial,
	options Options,
) (Result, error) {
	if database == nil || secrets == nil || generator == nil {
		return Result{}, fmt.Errorf("collaboration bootstrap dependencies are incomplete")
	}
	if err := validateConfig(config); err != nil {
		return Result{}, err
	}

	databaseState, err := database.Inspect(ctx, config)
	if err != nil {
		return Result{}, fmt.Errorf("inspect collaboration database target: %w", err)
	}
	payload, secretExists, err := secrets.Read(ctx, config.SecretName)
	if err != nil {
		return Result{}, fmt.Errorf("read collaboration SSM secret: %w", err)
	}
	if payload == nil {
		payload = map[string]string{}
	}

	result := Result{}
	password := ""
	secretCreate := false
	if secretExists {
		password, err = validateExistingSecret(config, payload, im, options)
		if err != nil {
			return Result{}, err
		}
		if !databaseState.AccountExists && !validCynosDBPassword(password) {
			password, err = newDatabasePassword(generator)
			if err != nil {
				return Result{}, err
			}
			payload[databaseDSNKey] = managedDSN(config, password)
			result.Secret.Updated = true
		}
		if strings.TrimSpace(im.SecretKey) != "" && payload[imSecretKey] != im.SecretKey {
			payload[imSecretKey] = im.SecretKey
			result.Secret.Updated = true
		}
	} else {
		if strings.TrimSpace(im.SecretKey) == "" {
			return Result{}, fmt.Errorf("IM secret key file is required before creating collaboration SSM")
		}
		if databaseState.AccountExists && !options.AllowDatabasePasswordReset {
			return Result{}, fmt.Errorf("database account exists without collaboration SSM; rerun with --allow-database-password-reset to recover")
		}
		payload, password, err = newSecretPayload(generator, config, im)
		if err != nil {
			return Result{}, err
		}
		secretCreate = true
		result.Secret.Created = true
	}

	if !databaseState.AccountExists {
		result.Account.Created = true
	} else if options.AllowDatabasePasswordReset {
		result.Account.Updated = true
	}
	if !databaseState.DatabaseExists {
		result.Database.Created = true
	}
	if databaseState.UnexpectedPrivilegeScope || !equalPrivileges(databaseState.Privileges, DatabasePrivileges()) {
		result.Privileges.Updated = true
	}
	if !options.Apply {
		return result, nil
	}

	if secretCreate {
		if err := secrets.Write(ctx, config.SecretName, payload, true); err != nil {
			return result, fmt.Errorf("create collaboration SSM secret: %w", err)
		}
		result.Secret.Applied = true
	} else if result.Secret.Updated {
		if err := secrets.Write(ctx, config.SecretName, payload, false); err != nil {
			return result, fmt.Errorf("update collaboration SSM secret: %w", err)
		}
		result.Secret.Applied = true
	}
	if result.Account.Created {
		if err := database.CreateAccount(ctx, config, password); err != nil {
			return result, fmt.Errorf("create collaboration database account: %w", err)
		}
		result.Account.Applied = true
	} else if result.Account.Updated {
		if err := database.ResetAccountPassword(ctx, config, password); err != nil {
			return result, fmt.Errorf("reset collaboration database account password: %w", err)
		}
		result.Account.Applied = true
	}
	if result.Database.Created {
		if err := database.CreateDatabase(ctx, config); err != nil {
			return result, fmt.Errorf("create collaboration database: %w", err)
		}
		result.Database.Applied = true
	}
	if result.Privileges.Updated {
		if err := database.SetDatabasePrivileges(ctx, config, DatabasePrivileges()); err != nil {
			return result, fmt.Errorf("set collaboration database privileges: %w", err)
		}
		result.Privileges.Applied = true
	}
	result.Applied = true
	return result, nil
}

func validateConfig(config Config) error {
	for label, value := range map[string]string{
		"cluster id": config.ClusterID, "database": config.Database, "account": config.Account,
		"account host": config.AccountHost, "endpoint host": config.EndpointHost, "SSM secret": config.SecretName,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("collaboration %s is required", label)
		}
	}
	if !resourceNamePattern.MatchString(config.Database) || !resourceNamePattern.MatchString(config.Account) {
		return fmt.Errorf("collaboration database and account names must use stable alphanumeric identifiers")
	}
	if config.AccountHost != "%" {
		return fmt.Errorf("collaboration account host must be %% for dynamic TKE clients")
	}
	if config.EndpointPort <= 0 || config.EndpointPort > 65535 {
		return fmt.Errorf("collaboration endpoint port is invalid")
	}
	return nil
}

func validateExistingSecret(config Config, payload map[string]string, im IMMaterial, options Options) (string, error) {
	for _, key := range RequiredSecretKeys() {
		if strings.TrimSpace(payload[key]) == "" {
			return "", fmt.Errorf("existing collaboration SSM is missing required key %s", key)
		}
	}
	if strings.TrimSpace(im.SecretKey) != "" && payload[imSecretKey] != im.SecretKey && !options.AllowIMSecretRotation {
		return "", fmt.Errorf("existing collaboration SSM contains a different IM secret; explicit rotation is required")
	}
	password, err := passwordFromManagedDSN(config, payload[databaseDSNKey])
	if err != nil {
		return "", fmt.Errorf("existing collaboration database.dsn is not managed by this target: %w", err)
	}
	return password, nil
}

func newSecretPayload(generator TokenGenerator, config Config, im IMMaterial) (map[string]string, string, error) {
	password, err := newDatabasePassword(generator)
	if err != nil {
		return nil, "", err
	}
	values := make([]string, 4)
	for index := range values {
		value, err := generator.Token(32)
		if err != nil {
			return nil, "", fmt.Errorf("generate collaboration secret material: %w", err)
		}
		if strings.TrimSpace(value) == "" {
			return nil, "", fmt.Errorf("generate collaboration secret material: empty token")
		}
		values[index] = value
	}
	return map[string]string{
		databaseDSNKey: managedDSN(config, password),
		jwtKey:         values[0], gatewayKey: values[1], imSecretKey: im.SecretKey,
		imIdentityKey: values[2], imCallbackKey: values[3],
	}, password, nil
}

func newDatabasePassword(generator TokenGenerator) (string, error) {
	value, err := generator.Token(32)
	if err != nil {
		return "", fmt.Errorf("generate collaboration database password: %w", err)
	}
	if len(value) < 8 || len(value) > 64 {
		return "", fmt.Errorf("generate collaboration database password: token length must be between 8 and 64 characters")
	}
	password := []byte(value)
	copy(password[:4], "Aa1_")
	if !validCynosDBPassword(string(password)) {
		return "", fmt.Errorf("generate collaboration database password: token contains unsupported characters")
	}
	return string(password), nil
}

func validCynosDBPassword(value string) bool {
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
		case strings.ContainsRune(cynosDBPasswordSpecials, char):
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

func managedDSN(config Config, password string) string {
	return config.Account + ":" + password + "@tcp(" + config.EndpointHost + ":" +
		strconv.Itoa(config.EndpointPort) + ")/" + config.Database + "?charset=utf8mb4&parseTime=true&loc=UTC"
}

func passwordFromManagedDSN(config Config, dsn string) (string, error) {
	prefix := config.Account + ":"
	suffix := "@tcp(" + config.EndpointHost + ":" + strconv.Itoa(config.EndpointPort) + ")/" +
		config.Database + "?charset=utf8mb4&parseTime=true&loc=UTC"
	if !strings.HasPrefix(dsn, prefix) || !strings.HasSuffix(dsn, suffix) {
		return "", fmt.Errorf("target account, endpoint or database differs")
	}
	password := strings.TrimSuffix(strings.TrimPrefix(dsn, prefix), suffix)
	if password == "" || strings.ContainsAny(password, "@:/?&") {
		return "", fmt.Errorf("managed password encoding is invalid")
	}
	return password, nil
}

func equalPrivileges(actual, expected []string) bool {
	normalize := func(values []string) []string {
		result := make([]string, 0, len(values))
		seen := map[string]struct{}{}
		for _, value := range values {
			value = strings.ToUpper(strings.TrimSpace(value))
			if value == "" {
				continue
			}
			if _, ok := seen[value]; ok {
				continue
			}
			seen[value] = struct{}{}
			result = append(result, value)
		}
		sort.Strings(result)
		return result
	}
	return strings.Join(normalize(actual), "\x00") == strings.Join(normalize(expected), "\x00")
}
