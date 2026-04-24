// Package app ...
package app

import (
	"fmt"
	"time"

	"github.com/BurntSushi/toml"
	"go.uber.org/zap"

	"ctl/pkg/util"
)

const (
	updateAppsCacheInterval = time.Second * 60
)

// App ...
type App struct {
	Name      string
	SecretId  string `toml:"secret_id"`
	SecretKey string `toml:"secret_key"`

	CheckAction bool     `toml:"check_action"`
	ActionList  []string `toml:"action_list"`
	ActionMap   map[string]bool
}

type appsCache struct {
	cacheTime        time.Time
	appMapByName     map[string]*App
	appMapBySecretId map[string]*App
}

var appsCacheData *appsCache

// InitAppsCacheData ...
func InitAppsCacheData(dir string, logger *zap.Logger) error {
	cache, err := loadAppsCache(dir)
	if err != nil {
		return fmt.Errorf("loadAppsCache error: %w", err)
	}
	appsCacheData = cache

	go func() {
		for {
			time.Sleep(updateAppsCacheInterval)

			cache, err = loadAppsCache(dir)
			if err != nil {
				logger.Error("loadAppsCache error", zap.Error(err))
			} else {
				logger.Info("update appsCacheData")
				appsCacheData = cache
			}
		}
	}()

	return nil
}

func loadAppsCache(dir string) (*appsCache, error) {
	files, err := util.ListFilesInDir(dir, "*.toml")
	if err != nil {
		return nil, fmt.Errorf("ListFilesInDir error: %w", err)
	}

	cache := &appsCache{
		cacheTime:        time.Now(),
		appMapByName:     make(map[string]*App),
		appMapBySecretId: make(map[string]*App),
	}
	for _, path := range files {
		app, err := parseAppFile(path)
		if err != nil {
			return nil, fmt.Errorf("parseAppFile error: %w", err)
		}

		cache.appMapByName[app.Name] = app
		cache.appMapBySecretId[app.SecretId] = app
	}

	return cache, nil
}

func parseAppFile(path string) (*App, error) {
	app := &App{
		ActionMap: make(map[string]bool),
	}
	_, err := toml.DecodeFile(path, app)
	if err != nil {
		return nil, fmt.Errorf("toml.DecodeFile error: %w", err)
	}

	app.SecretId = util.DecryptString(app.SecretId)
	app.SecretKey = util.DecryptString(app.SecretKey)

	for _, action := range app.ActionList {
		app.ActionMap[action] = true
	}

	return app, nil
}

// LatestCacheTime ...
func LatestCacheTime() time.Time {
	return appsCacheData.cacheTime
}
