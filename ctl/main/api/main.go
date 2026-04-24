// Package main ...
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"

	"ctl/pkg/tracing"
	"go.uber.org/zap"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/redis/go-redis/v9"

	"ctl/main/common"
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

	err = resource.InitLog(config.ServerConf.LogConfig.API)
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

	common.InitMonitor(config.ServerConf.MonitorConfig.API, []prometheus.Collector{
		// 现有 CGW/API/Adapter 通用指标（向后兼容）
		metric.CgwAPIPanicCounter,
		metric.CgwAPIErrorCounterVec,
		metric.CgwAPILatencyHistogramVec,
		metric.APIRequestTotalCounterVec,
		metric.APIRequestErrorTotalCounterVec,
		metric.APILatencyHistogramVec,
		metric.AdapterRequestTotalCounterVec,
		metric.AdapterRequestErrorTotalCounterVec,
		metric.AdapterLatencyHistogramVec,
		// OpenClaw 业务指标
		metric.OpenClawAPIRequestTotal,
		metric.OpenClawAPIRequestDuration,
		metric.OpenClawInstanceCreateTotal,
		metric.OpenClawInstanceCreateDuration,
		metric.OpenClawInstanceCreateRejectionsTotal,
		metric.OpenClawInstanceChurnGuardEvalTotal,
		metric.OpenClawInstanceChurnGuardRetryAfter,
		metric.OpenClawInstanceUserChurnEventsTotal,
		metric.OpenClawInstanceUserAbuseGuardEvalTotal,
		metric.OpenClawInstanceUserAbuseCooldownsTotal,
		metric.OpenClawSandboxAPITotal,
		metric.OpenClawSandboxAPIDuration,
		metric.RemoteCommandTotalCounterVec,
		metric.RemoteCommandDurationHistogramVec,
		metric.RemoteCommandInflightGaugeVec,
		// 实例状态 Gauge（实时查询 DB）
		metric.NewInstanceGaugeCollector(resource.GormDB),
		// 基础设施指标（DB/Redis 连接池）
		metric.NewDBPoolCollector(resource.GormDB),
		metric.NewRedisPoolCollector(map[string]*redis.Client{
			"main": resource.RedisMainClient,
			"mq":   resource.RedisMQClient,
		}),
		// Go runtime + process collectors（内存、GC、goroutine、fd 等）
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	})

	err = tracing.Init(config.ServerConf.TracingConfig, "lightglobal-api")
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

	as, err := newAPIServer()
	if err != nil {
		fmt.Println("newAPIServer error:", err)
		return
	}

	if err = as.run(); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Println("APIServer run error:", err)
		return
	}
}

func parseArgs() error {
	flag.StringVar(&args.confDir, "conf-dir", "", "conf-dir absolute path")
	flag.Parse()

	if args.confDir == "" {
		return errors.New("missing flag conf-dir")
	}

	return nil
}
