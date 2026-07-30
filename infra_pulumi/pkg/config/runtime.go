package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	pconfig "github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

type RuntimeConfig struct {
	EnvironmentName           string
	InventoryPath             string
	EnableImport              bool
	ProjectRoot               string
	SecretID                  string
	SecretKey                 string
	NodePassword              pulumi.StringOutput
	DBPassword                pulumi.StringOutput
	RedisPassword             pulumi.StringOutput
	NotifyTestAllowlistSHA256 pulumi.StringOutput
	RegistryPullServer        string
	StorageAccessKeyImport    string
	Reconcile                 ReconcileConfig
}

type ReconcileConfig struct {
	SNATImports  map[string]string `json:"snatImports"`
	TKEClusterID string            `json:"tkeClusterId"`
}

func LoadRuntimeConfig(ctx *pulumi.Context) (*RuntimeConfig, error) {
	cfg := pconfig.New(ctx, "infra-pulumi")
	runtime := &RuntimeConfig{
		EnvironmentName:           cfg.Require("environmentName"),
		InventoryPath:             cfg.Require("inventoryPath"),
		EnableImport:              cfg.GetBool("enableImport"),
		SecretID:                  getenvOrEmpty("TENCENTCLOUD_SECRET_ID"),
		SecretKey:                 getenvOrEmpty("TENCENTCLOUD_SECRET_KEY"),
		NodePassword:              cfg.RequireSecret("nodePassword"),
		DBPassword:                cfg.RequireSecret("dbPassword"),
		RedisPassword:             cfg.RequireSecret("redisPassword"),
		NotifyTestAllowlistSHA256: cfg.GetSecret("notifyTestAllowlistSHA256"),
		RegistryPullServer:        cfg.Get("registryPullServer"),
	}
	if strings.TrimSpace(runtime.RegistryPullServer) == "" {
		runtime.RegistryPullServer = "ccr.ccs.tencentyun.com"
	}

	runtime.StorageAccessKeyImport = cfg.Get("storageAccessKeyImportId")
	runtime.ProjectRoot = resolveProjectRoot()

	if !filepath.IsAbs(runtime.InventoryPath) {
		runtime.InventoryPath = filepath.Clean(filepath.Join(runtime.ProjectRoot, runtime.InventoryPath))
	}
	if err := loadReconcileConfig(runtime); err != nil {
		return nil, err
	}
	return runtime, nil
}

func loadReconcileConfig(runtime *RuntimeConfig) error {
	reconcileFile, ok := lookupEnv("PULUMI_RECONCILE_FILE")
	if !ok || strings.TrimSpace(reconcileFile) == "" {
		return nil
	}

	data, err := os.ReadFile(reconcileFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, &runtime.Reconcile)
}

func getenvOrEmpty(key string) string {
	if v, ok := lookupEnv(key); ok {
		return v
	}
	return ""
}

var lookupEnv = func(key string) (string, bool) {
	return os.LookupEnv(key)
}

func resolveProjectRoot() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}

	root := wd
	for {
		if _, err := os.Stat(filepath.Join(root, "Pulumi.yaml")); err == nil {
			return root
		}
		parent := filepath.Dir(root)
		if parent == root || strings.TrimSpace(parent) == "" {
			return wd
		}
		root = parent
	}
}
