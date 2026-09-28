package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

type Config struct {
	Enabled               bool
	ProcessingEnabled     bool
	Addr                  string
	MySQLDSN              string
	PublicBaseURL         string
	PulsarURL             string
	PulsarToken           string
	PulsarTopic           string
	PulsarDeadLetterTopic string
	PulsarSubscription    string
	CTLBaseURL            string
	CTLInternalToken      string
	WorkerPollInterval    time.Duration
	WorkerBatchSize       int
	RewardLeaseDuration   time.Duration
	Campaign              CampaignConfig
}

type CampaignConfig struct {
	ID                   string
	Name                 string
	Status               string
	StartsAt             time.Time
	EndsAt               time.Time
	InviterCredit        int64
	InviteeCredit        int64
	VestingDays          int
	PendingTTLDays       int
	MaxRewardsPerInviter int
	BudgetCredit         int64
}

func Load() (Config, error) {
	cfg := Config{
		Enabled:               boolEnv("REFERRAL_ENABLED", false),
		ProcessingEnabled:     boolEnv("REFERRAL_PROCESSING_ENABLED", false),
		Addr:                  envOrDefault("REFERRAL_ADDR", ":8080"),
		MySQLDSN:              strings.TrimSpace(os.Getenv("REFERRAL_MYSQL_DSN")),
		PublicBaseURL:         strings.TrimRight(envOrDefault("REFERRAL_PUBLIC_BASE_URL", "https://lightvela.com"), "/"),
		PulsarURL:             strings.TrimSpace(os.Getenv("REFERRAL_PULSAR_URL")),
		PulsarToken:           strings.TrimSpace(os.Getenv("REFERRAL_PULSAR_TOKEN")),
		PulsarTopic:           strings.TrimSpace(os.Getenv("REFERRAL_PULSAR_TOPIC")),
		PulsarDeadLetterTopic: strings.TrimSpace(os.Getenv("REFERRAL_PULSAR_DLQ_TOPIC")),
		PulsarSubscription:    envOrDefault("REFERRAL_PULSAR_SUBSCRIPTION", "lightvela-referral-worker"),
		CTLBaseURL:            strings.TrimRight(strings.TrimSpace(os.Getenv("CTL_INTERNAL_BASE_URL")), "/"),
		CTLInternalToken:      strings.TrimSpace(os.Getenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN")),
		WorkerPollInterval:    durationEnv("REFERRAL_WORKER_POLL_INTERVAL", 10*time.Second),
		WorkerBatchSize:       intEnv("REFERRAL_WORKER_BATCH_SIZE", 50),
		RewardLeaseDuration:   durationEnv("REFERRAL_REWARD_LEASE_DURATION", 30*time.Second),
		Campaign: CampaignConfig{
			ID: strings.TrimSpace(os.Getenv("REFERRAL_CAMPAIGN_ID")), Name: strings.TrimSpace(os.Getenv("REFERRAL_CAMPAIGN_NAME")),
			Status:        envOrDefault("REFERRAL_CAMPAIGN_STATUS", "active"),
			InviterCredit: int64Env("REFERRAL_INVITER_CREDIT", 500), InviteeCredit: int64Env("REFERRAL_INVITEE_CREDIT", 500),
			VestingDays:    intEnv("REFERRAL_VESTING_DAYS", 0),
			PendingTTLDays: intEnv("REFERRAL_PENDING_TTL_DAYS", 90), MaxRewardsPerInviter: intEnv("REFERRAL_MAX_REWARDS_PER_INVITER", 50),
			BudgetCredit: int64Env("REFERRAL_BUDGET_CREDIT", 0),
		},
	}
	cfg.Campaign.StartsAt = timeEnv("REFERRAL_CAMPAIGN_STARTS_AT")
	cfg.Campaign.EndsAt = timeEnv("REFERRAL_CAMPAIGN_ENDS_AT")
	if cfg.MySQLDSN == "" {
		cfg.MySQLDSN = buildMySQLDSN(
			envOrDefault("REFERRAL_DB_USER", "referral"),
			strings.TrimSpace(os.Getenv("REFERRAL_DB_PASSWORD")),
			envOrDefault("MYSQL_HOST", "127.0.0.1"),
			envOrDefault("MYSQL_PORT", "3306"),
			strings.TrimSpace(os.Getenv("REFERRAL_DB")),
		)
	}
	if cfg.Enabled && cfg.MySQLDSN == "" {
		return Config{}, fmt.Errorf("REFERRAL_MYSQL_DSN is required when referral is enabled")
	}
	if cfg.Enabled {
		for key, value := range map[string]string{
			"CTL_INTERNAL_BASE_URL":            cfg.CTLBaseURL,
			"LIGHTCLAW_INTERNAL_SERVICE_TOKEN": cfg.CTLInternalToken,
		} {
			if value == "" {
				return Config{}, fmt.Errorf("%s is required when referral is enabled", key)
			}
		}
	}
	if cfg.WorkerBatchSize <= 0 || cfg.WorkerBatchSize > 200 {
		return Config{}, fmt.Errorf("REFERRAL_WORKER_BATCH_SIZE must be between 1 and 200")
	}
	if cfg.ProcessingEnabled {
		for key, value := range map[string]string{
			"REFERRAL_PULSAR_URL":              cfg.PulsarURL,
			"REFERRAL_PULSAR_TOKEN":            cfg.PulsarToken,
			"REFERRAL_PULSAR_TOPIC":            cfg.PulsarTopic,
			"CTL_INTERNAL_BASE_URL":            cfg.CTLBaseURL,
			"LIGHTCLAW_INTERNAL_SERVICE_TOKEN": cfg.CTLInternalToken,
		} {
			if value == "" {
				return Config{}, fmt.Errorf("%s is required when referral processing is enabled", key)
			}
		}
	}
	return cfg, nil
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func boolEnv(key string, fallback bool) bool {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseBool(raw)
	return err == nil && value
}

func intEnv(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}

func int64Env(key string, fallback int64) int64 {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return fallback
	}
	return value
}

func timeEnv(key string) time.Time {
	value, err := time.Parse(time.RFC3339, strings.TrimSpace(os.Getenv(key)))
	if err != nil {
		return time.Time{}
	}
	return value.UTC()
}

func durationEnv(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func buildMySQLDSN(user, password, host, port, database string) string {
	if strings.TrimSpace(user) == "" || strings.TrimSpace(password) == "" || strings.TrimSpace(database) == "" {
		return ""
	}
	cfg := mysql.NewConfig()
	cfg.User = strings.TrimSpace(user)
	cfg.Passwd = password
	cfg.Net = "tcp"
	cfg.Addr = fmt.Sprintf("%s:%s", strings.TrimSpace(host), strings.TrimSpace(port))
	cfg.DBName = strings.TrimSpace(database)
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	cfg.Params = map[string]string{"time_zone": "'+00:00'"}
	return cfg.FormatDSN()
}
