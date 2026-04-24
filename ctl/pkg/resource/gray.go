// Package resource ...
package resource

import (
	"fmt"
	"os"
	"strconv"
	"time"

	"go.uber.org/zap"
	"ctl/pkg/config"
)

// GrayRoutine ...
func GrayRoutine(config *config.GrayConfig) {
	ZapLogger.Info("run gray routine")
	for {
		curHour := time.Now().Hour()
		ZapLogger.Info(fmt.Sprintf("cur hour is %d", curHour))
		if curHour == config.StartHour {
			cnt, err := grayRoutineCount(config)
			if err != nil {
				ZapLogger.Error("grayRoutineCount error", zap.Error(err))
			} else {
				ZapLogger.Info(fmt.Sprintf("grayRoutineCount is %d", cnt))
				for i := 0; i < cnt; i++ {
					ZapLogger.Info(fmt.Sprintf("run gray routine %d", i))
					go func() {
						ticker := time.NewTicker(time.Second * time.Duration(config.RunSeconds))
						defer ticker.Stop()
						for {
							select {
							case <-ticker.C:
								return
							default:
							}
						}
					}()
				}
			}
		}

		// 下次任务触发在整点的第10分钟
		now := time.Now()
		interval := 3600 - now.Second() - now.Minute()*60 + 10*60
		ZapLogger.Info("GrayRoutine.SleepInterval", zap.Int("seconds", interval))
		time.Sleep(time.Second * time.Duration(interval))
	}
}

func grayRoutineCount(config *config.GrayConfig) (int, error) {
	ncpu, err := cpuCount()
	if err != nil {
		return 0, fmt.Errorf("cpuCount error: %w", err)
	}

	v := config.CpuPercent
	if v <= 0 || v > 100 {
		return 0, fmt.Errorf("cpu_percent config error, must between 0,100, config is %d", v)
	}

	return ncpu / (100 / v), nil
}

func cpuCount() (int, error) {
	cntStr := os.Getenv("POD_CPU_COUNT")
	if cntStr == "" {
		content, err := os.ReadFile("/etc/podinfo/cpu")
		if err != nil {
			return 0, fmt.Errorf("os.ReadFile /etc/podinfo/cpu error: %w", err)
		}
		cntStr = string(content)
	}

	cnt, err := strconv.Atoi(cntStr)
	if err != nil {
		return 0, fmt.Errorf("strconv.Atoi parse cpu cnt from podinfo error: %w", err)
	}

	return cnt, nil
}
