// Package common ...
package common

import (
	"fmt"
	"net/http"
	"net/http/pprof"

	"go.uber.org/zap"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	adapterFactory "ctl/pkg/adapter/factory"
	"ctl/pkg/config"
	"ctl/pkg/logic/app"
	"ctl/pkg/resource"
)

func initBackendRoutines() error {
	err := app.InitAppsCacheData(config.ServerConf.MiscConfig.AppsDataDir, resource.ZapLogger)
	if err != nil {
		return fmt.Errorf("app.InitAppsCacheData error: %w", err)
	}

	if config.ServerConf.GrayConfig.Enable {
		go resource.GrayRoutine(config.ServerConf.GrayConfig)
	}

	return nil
}

// InitCommon ...
func InitCommon() error {
	err := resource.InitMySQL(config.ServerConf.DBConfig)
	if err != nil {
		return fmt.Errorf("resource.InitMySQL error: %w", err)
	}

	err = verifySchemaVersion(resource.GormDB, config.LoadedConfDir)
	if err != nil {
		return fmt.Errorf("verifySchemaVersion error: %w", err)
	}

	err = initBackendRoutines()
	if err != nil {
		return fmt.Errorf("initBackendRoutines error: %w", err)
	}

	resource.InitRedis(config.ServerConf.RedisConfig)

	resource.SandboxAdapter = adapterFactory.DefaultAdapterFactory.SandboxAdapter()

	return nil
}

// InitMonitor ...
func InitMonitor(config *config.MonitorConfig, collectors []prometheus.Collector) {
	registry := prometheus.NewRegistry()
	for _, collector := range collectors {
		if collector != nil {
			if err := registry.Register(collector); err != nil {
				resource.ZapLogger.Error("register monitor collector failed", zap.Error(err))
			}
		}
	}
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))
	if config.EnablePprof {
		mux.HandleFunc("/debug/pprof/", pprof.Index)
		mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
		mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
		mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
		mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	}
	addr := fmt.Sprintf(":%d", config.Port)
	go func() {
		resource.ZapLogger.Info("run monitor", zap.Int("port", config.Port), zap.String("addr", addr))
		err := http.ListenAndServe(addr, mux)
		if err != nil {
			resource.ZapLogger.Fatal("monitor.ListenAndServe error", zap.Error(err))
		}
	}()
}
