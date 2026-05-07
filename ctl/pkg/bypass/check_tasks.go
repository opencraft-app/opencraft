package bypass

import (
	"time"

	pctx "ctl/pkg/context"
	logfields "ctl/pkg/log"
	"ctl/pkg/logic/factory"
	"ctl/pkg/metric"
	daoFactory "ctl/pkg/model/factory"
	taskmodel "ctl/pkg/model/task"
	"ctl/pkg/mq"
	mqfactory "ctl/pkg/mq/factory"
	"ctl/pkg/taskruntime/common"

	"go.uber.org/zap"
)

const (
	bypassCheckTasks       = "checkTasks"
	checkTasksBatchSize    = 200
	checkTasksLockSeconds  = 600
	checkTasksLookbackDays = -90
)

func init() {
	registerBypass(bypassCheckTasks, newCheckTasks)
}

type checkTasks struct {
	*baseBypass
}

func newCheckTasks() Bypass {
	c := &checkTasks{
		baseBypass: newBaseBypass(bypassCheckTasks, checkTasksLockSeconds),
	}
	c.intervalFunc = c.interval
	c.runFunc = c.run
	return c
}

func (c *checkTasks) interval(_ pctx.Context) time.Duration {
	return time.Minute
}

func (c *checkTasks) run(ctx pctx.Context) {
	taskDao := daoFactory.DefaultDaoFactory.TaskDao(ctx)
	producer := mqfactory.DefaultMQFactory.Producer(ctx)
	lockLogic := factory.DefaultLogicFactory.LockLogic()
	now := time.Now()
	minCreatedTime := now.AddDate(0, 0, checkTasksLookbackDays)
	var lastID int64

	for {
		var tasks []*taskmodel.Entity
		err := taskDao.DB().
			Where(taskmodel.ColumnID+" > ?", lastID).
			Where(taskmodel.ColumnCreatedTime+" > ?", minCreatedTime).
			Where(taskmodel.ColumnTaskState+" IN ?", taskmodel.UnCompletedTaskStates()).
			Order(taskmodel.ColumnID + " ASC").
			Limit(checkTasksBatchSize).
			Find(&tasks).Error
		if err != nil {
			ctx.Logger().Error("query uncompleted tasks failed", zap.Error(err))
			return
		}
		if len(tasks) == 0 {
			return
		}

		for _, item := range tasks {
			if item == nil || item.Id == nil {
				continue
			}
			lastID = *item.Id
			taskCtx := ctx.WithContext(ctx)
			if item.TraceId != "" {
				taskCtx.SetRequestId(item.TraceId)
			}
			if item.UserID != "" {
				taskCtx = taskCtx.WithUserID(item.UserID)
			}
			taskCtx.SetAction(bypassCheckTasks)
			taskCtx.SetLogger(taskCtx.Logger().With(
				zap.String(logfields.FieldBypassName, bypassCheckTasks),
				zap.String(logfields.FieldTaskID, item.TaskId),
				zap.String(logfields.FieldTaskName, item.TaskName),
			))
			if now.Sub(item.LastExecuteTime) < time.Duration(item.ExecuteInterval)*time.Second {
				continue
			}
			// 达到最大执行次数时，检查锁是否还在；锁在说明有进程在跑，跳过不重投
			if item.ExecuteCount >= item.MaxExecuteCount {
				locked, lockErr := lockLogic.IsTaskLocked(taskCtx, item.TaskId)
				if lockErr != nil {
					taskCtx.Logger().Warn("check task lock failed, skip resend",
						zap.Error(lockErr),
						zap.String("task_id", item.TaskId),
					)
					continue
				}
				if locked {
					taskCtx.Logger().Info("task reached max_execute_count but lock still held, skip resend",
						zap.String("task_id", item.TaskId),
						zap.Int("execute_count", item.ExecuteCount),
						zap.Int("max_execute_count", item.MaxExecuteCount),
					)
					continue
				}
			}
			if err := producer.Send(&mq.Message{Data: common.GenerateMessageDataByTaskEntity(item)}); err != nil {
				taskCtx.Logger().Error("resend task to mq failed",
					zap.Error(err),
					zap.String("task_id", item.TaskId),
				)
			} else {
				metric.BypassCompensatedTasksTotalCounterVec.WithLabelValues(bypassCheckTasks).Inc()
			}
		}

		if len(tasks) < checkTasksBatchSize {
			return
		}
	}
}

// RunCheckTasksOnce 暴露给集成测试调用，执行一次 checkTasks 扫描逻辑。
// 不获取 bypass 分布式锁，直接调用 run 方法来测试纯扫描逻辑。
func RunCheckTasksOnce(ctx pctx.Context) {
	c := &checkTasks{baseBypass: newBaseBypass(bypassCheckTasks, checkTasksLockSeconds)}
	c.run(ctx)
}
