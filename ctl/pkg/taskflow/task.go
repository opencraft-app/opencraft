package taskflow

import (
	"context"
	"time"

	"go.uber.org/zap"
)

const (
	StepCodeFailure = "FAILURE"

	StepCodeSuccess = "SUCCESS"

	StepCodeJump1 = "JUMP1"
	StepCodeJump2 = "JUMP2"
	StepCodeJump3 = "JUMP3"
)

// TaskContext 是 taskflow 的 Context 约束接口
// 要求实现 context.Context 和 Logger() *zap.Logger
type TaskContext interface {
	context.Context

	Logger() *zap.Logger
}

// StepFunc 步骤执行函数
type StepFunc[T TaskContext] func(ctx T) (code string, err error)

// StepFailedFunc 步骤失败回调
type StepFailedFunc func(stepKey string, err error)

// StepConfig 步骤配置
type StepConfig[T TaskContext] struct {
	RetryCnt   int
	RetryDelay time.Duration

	StepFunc       StepFunc[T]
	StepFailedFunc StepFailedFunc
	RouteMap       map[string]string
}

// Task 任务接口
type Task[T TaskContext] interface {
	Name() string

	Init(in, out interface{}) error

	StepConfigMap() map[string]*StepConfig[T]
	FirstStepKey() string

	BeforeStep(stepKey string)
	AfterStep(stepKey string)

	Error() error
}
