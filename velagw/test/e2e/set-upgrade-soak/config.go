package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type config struct {
	Namespace          string
	Fleet              string
	Source             string
	TargetSetID        string
	TargetImage        string
	ControlURL         string
	TrafficURL         string
	MockURL            string
	PacerPublicURL     string
	PacerListenAddress string
	AdminToken         string
	InternalToken      string
	Model              string
	UpstreamModel      string
	UpstreamKey        string
	BundleID           string
	RunID              string
	Generations        int
	Users              int
	SSEUsers           int
	UserConcurrency    int
	NormalInterval     time.Duration
	SSEDuration        time.Duration
	MinimumSSEDuration time.Duration
	NormalSuccessRate  float64
	SSESuccessRate     float64
	Warmup             time.Duration
	DrainTimeout       time.Duration
	RollbackWindow     time.Duration
	ManagerJobTimeout  time.Duration
	ManagerCronJob     string
	ManagerProbeModel  string
	MaxLoadSets        int
	Quota              int64
	ReportPath         string
}

func loadConfig() (config, error) {
	cfg := config{
		Namespace:          envString("POD_NAMESPACE", serviceAccountNamespace()),
		Fleet:              envString("LLMGATEWAY_SOAK_FLEET", "fleet-demo"),
		Source:             envString("LLMGATEWAY_SOAK_SOURCE", "kro"),
		TargetSetID:        strings.TrimSpace(os.Getenv("LLMGATEWAY_SOAK_TARGET_SET")),
		TargetImage:        strings.TrimSpace(os.Getenv("LLMGATEWAY_SOAK_TARGET_IMAGE")),
		ControlURL:         trimURL(envString("LLMGATEWAY_CONTROL_URL", "http://llmgateway-control:18080")),
		TrafficURL:         trimURL(envString("LLMGATEWAY_TRAFFIC_URL", "http://llmgateway-traffic:18080")),
		MockURL:            trimURL(envString("LLMGATEWAY_SOAK_MOCK_URL", "http://llmgateway-e2e-mock-openai:8080")),
		PacerPublicURL:     trimURL(envString("LLMGATEWAY_SOAK_PACER_URL", "http://llmgateway-upgrade-soak-pacer:18090")),
		PacerListenAddress: envString("LLMGATEWAY_SOAK_PACER_LISTEN", ":18090"),
		AdminToken:         strings.TrimSpace(os.Getenv("LLMGATEWAY_ADMIN_TOKEN")),
		InternalToken:      strings.TrimSpace(os.Getenv("LLMGATEWAY_INTERNAL_TOKEN")),
		Model:              envString("LLMGATEWAY_SOAK_MODEL", "llmgw-upgrade-soak"),
		UpstreamModel:      envString("LLMGATEWAY_SOAK_UPSTREAM_MODEL", "llmgw-k8s-chat"),
		UpstreamKey:        envString("LLMGATEWAY_SOAK_UPSTREAM_KEY", "sk-upgrade-soak"),
		BundleID:           envString("LLMGATEWAY_SOAK_BUNDLE_ID", "upgrade-soak-openai"),
		RunID:              envString("LLMGATEWAY_SOAK_RUN_ID", fmt.Sprintf("%d", time.Now().Unix())),
		Generations:        envInt("LLMGATEWAY_SOAK_GENERATIONS", 4),
		Users:              envInt("LLMGATEWAY_SOAK_USERS", 400),
		SSEUsers:           envInt("LLMGATEWAY_SOAK_SSE_USERS", 100),
		UserConcurrency:    envInt("LLMGATEWAY_SOAK_USER_CONCURRENCY", 20),
		NormalInterval:     envDuration("LLMGATEWAY_SOAK_NORMAL_INTERVAL", 10*time.Second),
		SSEDuration:        envDuration("LLMGATEWAY_SOAK_SSE_DURATION", 20*time.Second),
		MinimumSSEDuration: envDuration("LLMGATEWAY_SOAK_MIN_SSE_DURATION", 19*time.Second),
		NormalSuccessRate:  envFloat("LLMGATEWAY_SOAK_NORMAL_SUCCESS_RATE", 0.999),
		SSESuccessRate:     envFloat("LLMGATEWAY_SOAK_SSE_SUCCESS_RATE", 0.99),
		Warmup:             envDuration("LLMGATEWAY_SOAK_WARMUP", 30*time.Second),
		DrainTimeout:       envDuration("LLMGATEWAY_SOAK_DRAIN_TIMEOUT", 330*time.Second),
		RollbackWindow:     envDuration("LLMGATEWAY_SOAK_ROLLBACK_WINDOW", 300*time.Second),
		ManagerJobTimeout:  envDuration("LLMGATEWAY_SOAK_MANAGER_TIMEOUT", 15*time.Minute),
		ManagerCronJob:     envString("LLMGATEWAY_SOAK_MANAGER_CRONJOB", "llmgateway-set-manager"),
		ManagerProbeModel:  envString("LLMGATEWAY_SOAK_MANAGER_PROBE_MODEL", "llmgw-upgrade-soak"),
		MaxLoadSets:        envInt("LLMGATEWAY_SOAK_MAX_LOAD_SETS", 4),
		Quota:              int64(envInt("LLMGATEWAY_SOAK_QUOTA", 100000000)),
		ReportPath:         envString("LLMGATEWAY_SOAK_REPORT_PATH", "/dev/termination-log"),
	}
	if cfg.TargetSetID == "" {
		return cfg, fmt.Errorf("LLMGATEWAY_SOAK_TARGET_SET is required")
	}
	if cfg.TargetImage == "" || !strings.Contains(cfg.TargetImage, "@sha256:") {
		return cfg, fmt.Errorf("LLMGATEWAY_SOAK_TARGET_IMAGE must be an immutable digest")
	}
	if cfg.AdminToken == "" || cfg.InternalToken == "" {
		return cfg, fmt.Errorf("admin and internal tokens are required")
	}
	if cfg.Generations <= 0 || cfg.Users <= 0 || cfg.SSEUsers <= 0 || cfg.SSEUsers >= cfg.Users {
		return cfg, fmt.Errorf("generations and users must be positive, with 0 < SSE users < users")
	}
	if cfg.UserConcurrency <= 0 || cfg.UserConcurrency > cfg.Users {
		return cfg, fmt.Errorf("invalid user concurrency %d", cfg.UserConcurrency)
	}
	return cfg, nil
}

func envString(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		panic(fmt.Sprintf("invalid %s=%q", name, value))
	}
	return parsed
}

func envFloat(name string, fallback float64) float64 {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		panic(fmt.Sprintf("invalid %s=%q", name, value))
	}
	return parsed
}

func envDuration(name string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		panic(fmt.Sprintf("invalid %s=%q", name, value))
	}
	return parsed
}

func trimURL(value string) string { return strings.TrimRight(value, "/") }

func serviceAccountNamespace() string {
	raw, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace")
	if err != nil {
		return "llmgateway-kro-demo"
	}
	return strings.TrimSpace(string(raw))
}
