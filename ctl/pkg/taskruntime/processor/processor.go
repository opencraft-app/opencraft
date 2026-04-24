// Package processor ...
package processor

import (
	"encoding/json"
	"fmt"
	"sync"

	"ctl/pkg/log"
	"ctl/pkg/taskruntime"
	"ctl/pkg/tracing"
	"go.opentelemetry.io/otel/attribute"
	"go.uber.org/zap"

	"ctl/pkg/taskflow"

	"ctl/pkg/context"
	"ctl/pkg/metric"
	"ctl/pkg/mq"
	"ctl/pkg/taskruntime/common"
)

type processor struct {
	wg     sync.WaitGroup
	logger *zap.Logger
}

// NewProcessor ...
func NewProcessor(logger *zap.Logger) *processor {
	return &processor{
		wg:     sync.WaitGroup{},
		logger: logger,
	}
}

// Process ...
func (p *processor) Process(message *mq.Message) error {
	msg := new(common.TaskMessage)
	err := json.Unmarshal(message.Data, msg)
	if err != nil {
		err = fmt.Errorf("json.Unmarshal error: %w", err)
		p.logger.Error("process message error", zap.Error(err))
		return err
	}

	pf, ok := pfMap[msg.TaskName]
	if !ok {
		err = fmt.Errorf("processFunc not exist, messageData %s", string(message.Data))
		p.logger.Error("process message error", zap.Error(err))
		return err
	}

	ctx := p.newContext(msg)

	task, in, out, err := pf(ctx, msg.Data)
	if err != nil {
		err = fmt.Errorf("processFunc run error: %w", err)
		p.logger.Error("process message error", zap.Error(err))
		return err
	}

	task.SetTaskId(msg.TaskId)
	p.runTask(ctx, task, in, out)

	return nil
}

// Wait ...
func (p *processor) Wait() error {
	p.logger.Info("processor wait")
	p.wg.Wait()

	return nil
}

func (p *processor) runTask(ctx context.Context, task taskruntime.ServiceTask, in, out interface{}) {
	p.wg.Add(1)

	go func() {
		defer func() {
			p.wg.Done()
		}()

		var err error
		taskName := task.Name()
		ctx, span := tracing.StartTrace(ctx, fmt.Sprintf("RunTask %s", taskName))
		span.SetAttributes(attribute.String(tracing.SpanAttributeKeyTaskName, taskName))
		defer func() { span.EndWithError(err) }()

		gauge := metric.TaskRunningCountGaugeVec.WithLabelValues(task.Name())
		gauge.Inc()
		err = taskflow.NewRunner[context.Context]().
			SetStartTraceFunc(tracing.StartTraceForFramework).
			RunTask(ctx, task, in, out)
		gauge.Dec()

		if err != nil {
			err = fmt.Errorf("TaskRunner.RunTask error: %w", err)
			p.logger.Error("runTask error", zap.Error(err))
		}
	}()
}

func (p *processor) newContext(msg *common.TaskMessage) context.Context {
	ctx := context.NewContext(nil).WithUserID(msg.Account.UserID)
	ctx.SetRequestId(msg.TraceId)
	ctx.SetLogger(ctx.Logger().With(
		zap.String(log.FieldTraceID, msg.TraceId),
		zap.String(log.FieldTaskName, msg.TaskName),
		zap.String(log.FieldTaskID, msg.TaskId),
	))
	ctx.SetAction(msg.TaskName)
	ctx.SetSqlCommentUserID(msg.Account.UserID)

	return ctx
}
