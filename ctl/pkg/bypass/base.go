// Package bypass ...
package bypass

import (
	"fmt"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.uber.org/zap"

	"ctl/pkg/log"
	"ctl/pkg/metric"
	"ctl/pkg/tracing"

	"ctl/pkg/context"
	"ctl/pkg/logic/factory"
	"ctl/pkg/resource"
)

// Bypass ...
type Bypass interface {
	Run()
}

type newBypassFunc func() Bypass

var bypassTable = make(map[string]newBypassFunc)

func registerBypass(name string, f newBypassFunc) {
	bypassTable[name] = f
}

// RunBypasses ...
func RunBypasses(names ...string) {
	wg := new(sync.WaitGroup)

	if len(names) == 0 {
		for name := range bypassTable {
			runBypass(name, wg)
		}
	} else {
		for _, name := range names {
			runBypass(name, wg)
		}
	}

	wg.Wait()
}

func runBypass(name string, wg *sync.WaitGroup) {
	resource.ZapLogger.Info("Run bypass " + name)

	f := bypassTable[name]
	wg.Add(1)
	go func() {
		f().Run()
		wg.Done()
	}()
}

type baseBypass struct {
	name string

	lockSeconds int64

	intervalFunc func(ctx context.Context) time.Duration
	runFunc      func(ctx context.Context)

	preRunFunc  func(ctx context.Context)
	postRunFunc func(ctx context.Context)
}

func newBaseBypass(name string, lockSeconds int64) *baseBypass {
	return &baseBypass{
		name:        name,
		lockSeconds: lockSeconds,
	}
}

// Run ...
func (b *baseBypass) Run() {
	for {
		ctx := context.NewContext(nil)
		ctx.SetAction(b.name)
		ctx.SetSqlCommentUserID(b.name)

		b.runPeriod(ctx)

		time.Sleep(b.intervalFunc(ctx))
	}
}

func (b *baseBypass) runPeriod(ctx context.Context) {
	var err error

	ctx, span := tracing.StartTrace(ctx, fmt.Sprintf("runPeriod bypass %s", b.name))
	span.SetAttributes(attribute.String(tracing.SpanAttributeKeyBypassName, b.name))
	defer func() { span.EndWithError(err) }()

	lockLogic := factory.DefaultLogicFactory.LockLogic()
	logger := ctx.Logger()

	success, err := lockLogic.LockBypass(ctx, b.name, b.lockSeconds)
	if err != nil {
		logger.Error("lockLogic.LockBypass error", zap.Error(err))
		metric.BypassExecutionTotalCounterVec.WithLabelValues(b.name, "error").Inc()
		return
	}
	if !success {
		logger.Warn("lock bypass failed", zap.String(log.FieldBypassName, b.name))
		metric.BypassExecutionTotalCounterVec.WithLabelValues(b.name, "lock_failed").Inc()
		return
	}

	// lock 成功后开始计时，避免 duration 包含等待锁时间
	execStart := time.Now()

	logger.Info("bypass run started", zap.String(log.FieldBypassName, b.name))

	// 捕获 runFunc 中的 panic，防止 bypass goroutine 静默死亡
	func() {
		defer func() {
			if r := recover(); r != nil {
				logger.Error("bypass runFunc panic recovered",
					zap.String(log.FieldBypassName, b.name),
					zap.Any("panic", r),
				)
				metric.BypassExecutionTotalCounterVec.WithLabelValues(b.name, "error").Inc()
				err = fmt.Errorf("bypass %s panic: %v", b.name, r)
			}
		}()
		if b.preRunFunc != nil {
			b.preRunFunc(ctx)
		}
		b.runFunc(ctx)
		if b.postRunFunc != nil {
			b.postRunFunc(ctx)
		}
	}()

	if err != nil {
		// panic 已被记录为 error，直接返回
		return
	}

	metric.BypassExecutionTotalCounterVec.WithLabelValues(b.name, "executed").Inc()
	metric.BypassExecutionDurationHistogramVec.WithLabelValues(b.name).Observe(time.Since(execStart).Seconds())

	// unlock 错误不应污染 Span 状态（业务逻辑已成功执行）
	deled, unlockErr := lockLogic.UnlockBypass(ctx, b.name)
	if unlockErr != nil {
		logger.Error("lockLogic.UnlockTask error", zap.Error(unlockErr))
	}
	if !deled {
		logger.Warn("lockLogic.UnlockBypass not deled")
	}
}
