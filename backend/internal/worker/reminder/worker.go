// Package reminder 提供 Reminder 调度的轮询执行器。
package reminder

import (
	"context"
	"errors"
	"time"
)

type processor interface {
	ProcessOne(context.Context) (bool, error)
}

type Config struct {
	PollInterval time.Duration
}

type Worker struct {
	processor processor
	config    Config
}

func New(processor processor, config Config) (*Worker, error) {
	if processor == nil || config.PollInterval <= 0 {
		return nil, errors.New("Reminder Worker 运行配置无效")
	}
	return &Worker{processor: processor, config: config}, nil
}

func (worker *Worker) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("Reminder Worker 上下文无效")
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
