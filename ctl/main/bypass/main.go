// Package main ...
package main

import (
	"errors"
	"flag"
	"fmt"

	"go.uber.org/zap"

	"ctl/pkg/tracing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"

	"ctl/main/common"
	"ctl/pkg/bypass"
	"ctl/pkg/config"
	"ctl/pkg/metric"
	"ctl/pkg/resource"
)

var args struct {
	confDir string
}

func main() {
	err := parseArgs()
	if err != nil {
		fmt.Println("parseArgs error:", err)
		flag.PrintDefaults()
		return
	}

	err = config.Init(args.confDir)
	if err != nil {
		fmt.Println("conf.Init error:", err)
		return
	}

	err = resource.InitLog(config.ServerConf.LogConfig.Bypass)
	if err != nil {
		fmt.Println("resource.InitLog error:", err)
		return
	}
	defer func() {
		resource.FreeLog()
	}()

	err = common.InitCommon()
	if err != nil {
		fmt.Println("common.InitCommon error:", err)
		return
	}

	err = tracing.Init(config.ServerConf.TracingConfig, "lightglobal-bypass")
	if err != nil {
		resource.ZapLogger.Error("tracing.Init error", zap.Error(err))
	} else {
		defer func() {
			err = tracing.Shutdown()
			if err != nil {
				resource.ZapLogger.Error("tracing.Shutdown error", zap.Error(err))
			}
		}()
	}

	if config.ServerConf.MiscConfig.BlockBypassAndService {
		resource.ZapLogger.Info("bypass is blocked by config")
		select {}
	}

	// 注册 Bypass 服务的监控指标
	if config.ServerConf.MonitorConfig.Bypass != nil {
		common.InitMonitor(config.ServerConf.MonitorConfig.Bypass, []prometheus.Collector{
			// Task 表维度指标（TaskGaugeCollector 只注册在 Bypass，避免三服务重复查同一张表）
			metric.NewTaskGaugeCollector(resource.GormDB),
			// Bypass 指标
			metric.BypassExecutionTotalCounterVec,
			metric.BypassCompensatedTasksTotalCounterVec,
			metric.BypassExecutionDurationHistogramVec,
			metric.OpenClawInstanceUserAbuseActiveCooldowns,
			metric.OpenClawInstancePoolPressureState,
			metric.OpenClawInstancePoolPressureClean,
			metric.OpenClawInstancePoolPressureAllocated,
			metric.OpenClawInstancePoolPressureCreating,
			metric.OpenClawInstancePoolPressureDry,
			metric.OpenClawInstancePoolPressureResetting,
			metric.OpenClawInstancePoolPressureDesired,
			metric.OpenClawInstancePoolPressureHotTransitionsTotal,
			// 基础设施指标（DB/Redis 连接池）
			metric.NewDBPoolCollector(resource.GormDB),
			metric.NewRedisPoolCollector(map[string]*redis.Client{
				"main": resource.RedisMainClient,
				"mq":   resource.RedisMQClient,
			}),
		})
	}

	bypass.RunBypasses(config.ServerConf.BypassConfig.SpecifyNames...)
}

func parseArgs() error {
	flag.StringVar(&args.confDir, "conf-dir", "", "conf-dir absolute path")
	flag.Parse()

	if args.confDir == "" {
		return errors.New("missing flag conf-dir")
	}

	return nil
}
