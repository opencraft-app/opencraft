package dbbootstrap

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"regexp"
	"strings"

	mysql "github.com/go-sql-driver/mysql"
	"gopkg.in/yaml.v3"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

type Config struct {
	Control ControlConfig `yaml:"control"`
	Shards  []ShardConfig `yaml:"shards"`
}

type ControlConfig struct {
	AdminDSN    string `yaml:"admin_dsn"`
	Database    string `yaml:"database"`
	AppUser     string `yaml:"app_user"`
	AppPassword string `yaml:"app_password"`
}

type ShardConfig struct {
	ID                  string   `yaml:"id"`
	Name                string   `yaml:"name"`
	AdminDSN            string   `yaml:"admin_dsn"`
	Endpoint            string   `yaml:"endpoint"`
	AppUser             string   `yaml:"app_user"`
	AppPassword         string   `yaml:"app_password"`
	DatabasePattern     string   `yaml:"database_pattern"`
	InitialDatabases    []string `yaml:"initial_databases"`
	MaxConnections      int      `yaml:"max_connections"`
	ReservedConnections int      `yaml:"reserved_connections"`
	WarnRatio           float64  `yaml:"warn_ratio"`
	CriticalRatio       float64  `yaml:"critical_ratio"`
	Status              string   `yaml:"status"`
}

type Plan struct {
	ControlStatements []string
	ShardStatements   map[string][]string
	Shards            []gateway.Shard
}

var (
	identifierRE = regexp.MustCompile(`^[A-Za-z0-9_]+$`)
	patternRE    = regexp.MustCompile(`^[A-Za-z0-9_%]+$`)
)

func LoadConfig(path string) (Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func BuildPlan(cfg Config) (Plan, error) {
	controlDB, err := quoteIdentifier(cfg.Control.Database)
	if err != nil {
		return Plan{}, fmt.Errorf("control database: %w", err)
	}
	if strings.TrimSpace(cfg.Control.AppUser) == "" {
		return Plan{}, fmt.Errorf("control app user is required")
	}
	plan := Plan{
		ControlStatements: []string{
			createDatabaseSQL(controlDB),
			createUserSQL(cfg.Control.AppUser, cfg.Control.AppPassword),
			fmt.Sprintf("GRANT ALL PRIVILEGES ON %s.* TO %s", controlDB, quoteUserHost(cfg.Control.AppUser)),
		},
		ShardStatements: map[string][]string{},
	}
	for _, cfgShard := range cfg.Shards {
		shard, statements, err := buildShard(cfgShard)
		if err != nil {
			return Plan{}, err
		}
		plan.Shards = append(plan.Shards, shard)
		plan.ShardStatements[shard.ID] = statements
	}
	return plan, nil
}

func buildShard(cfg ShardConfig) (gateway.Shard, []string, error) {
	id := strings.TrimSpace(cfg.ID)
	if id == "" {
		return gateway.Shard{}, nil, fmt.Errorf("shard id is required")
	}
	if strings.TrimSpace(cfg.AppUser) == "" {
		return gateway.Shard{}, nil, fmt.Errorf("shard %s app user is required", id)
	}
	pattern := strings.TrimSpace(cfg.DatabasePattern)
	if pattern == "" {
		pattern = "newapi_%"
	}
	quotedPattern, err := quoteDatabasePattern(pattern)
	if err != nil {
		return gateway.Shard{}, nil, fmt.Errorf("shard %s database pattern: %w", id, err)
	}
	statements := []string{
		createUserSQL(cfg.AppUser, cfg.AppPassword),
		fmt.Sprintf("GRANT ALL PRIVILEGES ON %s.* TO %s", quotedPattern, quoteUserHost(cfg.AppUser)),
	}
	for _, database := range cfg.InitialDatabases {
		quotedDatabase, err := quoteIdentifier(database)
		if err != nil {
			return gateway.Shard{}, nil, fmt.Errorf("shard %s initial database %q: %w", id, database, err)
		}
		statements = append(statements, createDatabaseSQL(quotedDatabase))
	}
	status := strings.TrimSpace(cfg.Status)
	if status == "" {
		status = gateway.ShardStatusActive
	}
	warnRatio := cfg.WarnRatio
	if warnRatio == 0 {
		warnRatio = 0.7
	}
	criticalRatio := cfg.CriticalRatio
	if criticalRatio == 0 {
		criticalRatio = 0.85
	}
	name := strings.TrimSpace(cfg.Name)
	if name == "" {
		name = id
	}
	return gateway.Shard{
		ID:                  id,
		Name:                name,
		Kind:                gateway.ShardKindMySQL,
		Endpoint:            strings.TrimSpace(cfg.Endpoint),
		Status:              status,
		MaxConnections:      cfg.MaxConnections,
		ReservedConnections: cfg.ReservedConnections,
		WarnRatio:           warnRatio,
		CriticalRatio:       criticalRatio,
	}, statements, nil
}

func AppDSN(adminDSN string, database string, appUser string, appPassword string) (string, error) {
	cfg, err := mysql.ParseDSN(adminDSN)
	if err != nil {
		return "", err
	}
	cfg.User = appUser
	cfg.Passwd = appPassword
	cfg.DBName = database
	cfg.ParseTime = true
	cfg.Loc = nil
	if cfg.Params == nil {
		cfg.Params = map[string]string{}
	}
	cfg.Params["loc"] = "UTC"
	return cfg.FormatDSN(), nil
}

func SeedShards(ctx context.Context, store gateway.Store, shards []gateway.Shard) error {
	for _, shard := range shards {
		if err := store.SaveShard(ctx, shard); err != nil {
			return fmt.Errorf("save shard %s: %w", shard.ID, err)
		}
	}
	return nil
}

func Run(ctx context.Context, cfg Config) error {
	plan, err := BuildPlan(cfg)
	if err != nil {
		return err
	}
	if err := executeStatements(ctx, cfg.Control.AdminDSN, plan.ControlStatements); err != nil {
		return fmt.Errorf("bootstrap control mysql: %w", err)
	}
	for _, shard := range cfg.Shards {
		if err := executeStatements(ctx, shard.AdminDSN, plan.ShardStatements[shard.ID]); err != nil {
			return fmt.Errorf("bootstrap shard %s mysql: %w", shard.ID, err)
		}
	}
	appDSN, err := AppDSN(cfg.Control.AdminDSN, cfg.Control.Database, cfg.Control.AppUser, cfg.Control.AppPassword)
	if err != nil {
		return fmt.Errorf("build control app dsn: %w", err)
	}
	store, err := gateway.NewMySQLStore(ctx, appDSN)
	if err != nil {
		return fmt.Errorf("open control app store: %w", err)
	}
	defer store.Close()
	return SeedShards(ctx, store, plan.Shards)
}

func executeStatements(ctx context.Context, dsn string, statements []string) error {
	if strings.TrimSpace(dsn) == "" {
		return fmt.Errorf("admin dsn is required")
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := db.PingContext(ctx); err != nil {
		return err
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("execute %q: %w", statement, err)
		}
	}
	return nil
}

func createDatabaseSQL(quotedDatabase string) string {
	return fmt.Sprintf("CREATE DATABASE IF NOT EXISTS %s CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci", quotedDatabase)
}

func createUserSQL(user string, password string) string {
	return fmt.Sprintf("CREATE USER IF NOT EXISTS %s IDENTIFIED BY %s", quoteUserHost(user), quoteString(password))
}

func quoteIdentifier(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !identifierRE.MatchString(value) {
		return "", fmt.Errorf("must match %s", identifierRE.String())
	}
	return "`" + value + "`", nil
}

func quoteDatabasePattern(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !patternRE.MatchString(value) {
		return "", fmt.Errorf("must match %s", patternRE.String())
	}
	value = strings.ReplaceAll(value, "_", `\_`)
	return "`" + value + "`", nil
}

func quoteUserHost(user string) string {
	return quoteString(user) + "@" + quoteString("%")
}

func quoteString(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `\'`) + "'"
}
