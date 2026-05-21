package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultAddr          = ":8080"
	defaultMaxKeys       = 5000
	defaultMaxKeyBytes   = 5000
	defaultMaxValueBytes = 5000
	defaultRedisTimeout  = 2 * time.Second
)

type Config struct {
	Addr                 string
	RedisAddr            string
	RedisUsername        string
	RedisPassword        string
	RedisDB              int
	RedisTimeout         time.Duration
	InternalServiceToken string
	MaxKeysPerUser       int
	MaxKeyBytes          int
	MaxValueBytes        int
}

func FromEnv() (Config, error) {
	cfg := Config{
		Addr:           getEnv("VIBEBASE_ADDR", defaultAddr),
		RedisAddr:      strings.TrimSpace(os.Getenv("VIBEBASE_REDIS_ADDR")),
		RedisUsername:  strings.TrimSpace(os.Getenv("VIBEBASE_REDIS_USERNAME")),
		RedisPassword:  getEnv("VIBEBASE_REDIS_PASSWORD", os.Getenv("REDIS_PASSWORD")),
		RedisTimeout:   defaultRedisTimeout,
		MaxKeysPerUser: defaultMaxKeys,
		MaxKeyBytes:    defaultMaxKeyBytes,
		MaxValueBytes:  defaultMaxValueBytes,
	}
	cfg.InternalServiceToken = strings.TrimSpace(os.Getenv("VIBEBASE_INTERNAL_SERVICE_TOKEN"))
	if cfg.RedisAddr == "" {
		return Config{}, fmt.Errorf("VIBEBASE_REDIS_ADDR is required")
	}
	if cfg.InternalServiceToken == "" {
		return Config{}, fmt.Errorf("VIBEBASE_INTERNAL_SERVICE_TOKEN is required")
	}

	var err error
	if cfg.RedisDB, err = getInt("VIBEBASE_REDIS_DB", 0); err != nil {
		return Config{}, err
	}
	if cfg.MaxKeysPerUser, err = getInt("VIBEBASE_MAX_KEYS_PER_USER", defaultMaxKeys); err != nil {
		return Config{}, err
	}
	if cfg.MaxKeyBytes, err = getInt("VIBEBASE_MAX_KEY_BYTES", defaultMaxKeyBytes); err != nil {
		return Config{}, err
	}
	if cfg.MaxValueBytes, err = getInt("VIBEBASE_MAX_VALUE_BYTES", defaultMaxValueBytes); err != nil {
		return Config{}, err
	}
	if raw := strings.TrimSpace(os.Getenv("VIBEBASE_REDIS_TIMEOUT")); raw != "" {
		timeout, err := time.ParseDuration(raw)
		if err != nil {
			return Config{}, fmt.Errorf("VIBEBASE_REDIS_TIMEOUT: %w", err)
		}
		cfg.RedisTimeout = timeout
	}
	if cfg.MaxKeysPerUser <= 0 || cfg.MaxKeyBytes <= 0 || cfg.MaxValueBytes <= 0 || cfg.RedisTimeout <= 0 {
		return Config{}, fmt.Errorf("limits and timeouts must be positive")
	}
	return cfg, nil
}

func getEnv(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func getInt(key string, fallback int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return value, nil
}
