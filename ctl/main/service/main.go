// Package main ...
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"ctl/pkg/tracing"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"ctl/main/common"
	"ctl/pkg/config"
	pcontext "ctl/pkg/context"
	"ctl/pkg/metric"
	"ctl/pkg/mq"
	"ctl/pkg/mq/factory"
	"ctl/pkg/resource"
	"ctl/pkg/taskruntime/processor"
)

var (
	args struct {
		confDir string
	}

	consumer mq.Consumer
)

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

	err = resource.InitLog(config.ServerConf.LogConfig.Service)
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

	common.InitMonitor(config.ServerConf.MonitorConfig.Service, []prometheus.Collector{
		metric.TaskDurationHistogramVec,
		metric.TaskFailedTotalCounterVec,
		metric.TaskSuccessTotalCounterVec,
		metric.TaskRunningCountGaugeVec,
		metric.AdapterRequestTotalCounterVec,
		metric.AdapterRequestErrorTotalCounterVec,
		metric.AdapterLatencyHistogramVec,
		metric.OpenClawInstanceCreateTotal,
		metric.OpenClawInstanceCreateDuration,
		metric.OpenClawInstanceUserChurnEventsTotal,
		metric.RemoteCommandTotalCounterVec,
		metric.RemoteCommandDurationHistogramVec,
		metric.RemoteCommandInflightGaugeVec,
		// 基础设施指标（DB/Redis 连接池）
		metric.NewDBPoolCollector(resource.GormDB),
		metric.NewRedisPoolCollector(map[string]*redis.Client{
			"main": resource.RedisMainClient,
			"mq":   resource.RedisMQClient,
		}),
	})

	err = tracing.Init(config.ServerConf.TracingConfig, "lightglobal-service")
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
		resource.ZapLogger.Info("service is blocked by config")
		select {}
	}

	err = runService()
	if err != nil {
		fmt.Println("runService error:", err)
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

func runService() error {
	ctx := pcontext.NewContext(nil)
	consumer = factory.DefaultMQFactory.Consumer(ctx)
	consumer.SetMessageProcessor(processor.NewProcessor(ctx.Logger()))

	go signalHandler()

	fmt.Println("consumer start")
	err := consumer.Start()
	if err != nil {
		return fmt.Errorf("consumer.Start error: %w", err)
	}

	return nil
}

func signalHandler() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGUSR2)

	for {
		sig := <-ch
		fmt.Println("receive signal", sig)

		switch sig {
		case syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGUSR2:
			// stop
			fmt.Println("receive stop signal, will stop service")
			signal.Stop(ch)
			err := consumer.Stop()
			fmt.Println("graceful stop complete", err)
			return
		default:
			continue
		}
	}
}
