package codex

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"

	"velachat/agent/internal/common"
	"velachat/agent/internal/runtimeapi"
)

var configuredCodexModelPattern = regexp.MustCompile(
	`(?m)^\s*model\s*=\s*"([^"]+)"`,
)

func (d *Driver) DetectModels(ctx context.Context) (runtimeapi.ModelResult, error) {
	live, liveErr := d.detectModelsFromAppServer(ctx)
	if liveErr == nil && len(live.Models) > 0 {
		return live, nil
	}
	if ctx.Err() != nil {
		return runtimeapi.ModelResult{}, ctx.Err()
	}
	workingDirectory, err := os.Getwd()
	if err != nil {
		workingDirectory = "."
	}
	home, _ := resolveCodexHome(os.Environ(), workingDirectory)
	if cached, ok := detectCodexModelsFromCache(home); ok {
		if ctx.Err() != nil {
			return runtimeapi.ModelResult{}, ctx.Err()
		}
		return cached, nil
	}
	return runtimeapi.ModelResult{Unsupported: true}, nil
}

func detectCodexModelsFromCache(home string) (runtimeapi.ModelResult, bool) {
	cachePath := ""
	configPath := ""
	for _, root := range []string{home, filepath.Join(home, ".codex")} {
		candidate := filepath.Join(root, "models_cache.json")
		if _, err := os.Stat(candidate); err == nil {
			cachePath = candidate
			configPath = filepath.Join(root, "config.toml")
			break
		}
	}
	if cachePath == "" {
		return runtimeapi.ModelResult{}, false
	}
	raw, err := os.ReadFile(cachePath)
	if err != nil {
		return runtimeapi.ModelResult{}, false
	}
	var cache struct {
		Models []map[string]json.RawMessage `json:"models"`
	}
	if common.Unmarshal(raw, &cache) != nil {
		return runtimeapi.ModelResult{}, false
	}
	models := make([]runtimeapi.Model, 0, len(cache.Models))
	for _, entry := range cache.Models {
		var slug string
		if common.Unmarshal(entry["slug"], &slug) != nil || slug == "" {
			continue
		}
		if visibility, exists := entry["visibility"]; exists &&
			jsonValueIsTruthy(visibility) {
			var value string
			if common.Unmarshal(visibility, &value) != nil ||
				(value != "public" && value != "list") {
				continue
			}
		}
		if supported, exists := entry["supported_in_api"]; exists {
			var value bool
			if common.Unmarshal(supported, &value) == nil && !value {
				continue
			}
		}
		label := slug
		var displayName string
		if common.Unmarshal(entry["display_name"], &displayName) == nil &&
			len(displayName) > 0 {
			label = displayName
		}
		models = append(models, runtimeapi.Model{
			ID:       slug,
			Label:    label,
			Verified: "launchable",
		})
	}
	if len(models) == 0 {
		return runtimeapi.ModelResult{}, false
	}
	defaultModel := ""
	if config, err := os.ReadFile(configPath); err == nil {
		if match := configuredCodexModelPattern.FindSubmatch(config); len(match) == 2 {
			defaultModel = string(match[1])
		}
	}
	return runtimeapi.ModelResult{
		Models:  models,
		Default: defaultModel,
	}, true
}

func jsonValueIsTruthy(raw json.RawMessage) bool {
	var value any
	if common.Unmarshal(raw, &value) != nil {
		return false
	}
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0
	default:
		return true
	}
}
