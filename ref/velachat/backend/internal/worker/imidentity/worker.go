// Package imidentity 提供 Human IM 身份操作的轮询执行器。
package imidentity

import (
	"context"
	"errors"
	"time"
)

type processor interface {
	ProcessOne(context.Context) (bool, error)
}

// Config 配置无任务时的恢复扫描间隔。
type Config struct {
	PollInterval time.Duration
}

// Worker 连续处理当前 SQLite 中到期的 IM 身份操作。
type Worker struct {
	processor processor
	config    Config
}

// New 创建 IM 身份 Worker。
func New(processor processor, config Config) (*Worker, error) {
	if processor == nil || config.PollInterval <= 0 {
		return nil, errors.New("IM 身份 Worker 运行配置无效")
	}
	return &Worker{processor: processor, config: config}, nil
}

// Run 在有工作时立即排空；无工作时等待下一次恢复扫描。
func (worker *Worker) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("IM 身份 Worker 上下文无效")
	}
	timer := time.NewTimer(time.Hour)
	if !timer.Stop() {
		<-timer.C
	}
	defer timer.Stop()
	for {
		processed, err := worker.processor.ProcessOne(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if processed {
			continue
		}
		timer.Reset(worker.config.PollInterval)
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
		}
	}
}
