package instance

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	paigateway "ctl/pkg/adapter/aigateway"
	psandbox "ctl/pkg/adapter/sandbox"
	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	instancebirth "ctl/pkg/instancebirth"
	"ctl/pkg/metric"
	modelfactory "ctl/pkg/model/factory"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/model/operationhistory"
	taskmodel "ctl/pkg/model/task"
	"ctl/pkg/mq"
	mqfactory "ctl/pkg/mq/factory"
	"ctl/pkg/resource"
	"ctl/pkg/taskruntime/common"
	"ctl/pkg/tracing"

	"go.uber.org/zap"
)

const (
	defaultTaskExecuteIntervalSeconds = 30
	defaultTaskMaxExecuteCount        = 20
)

const (
	TaskNameCreateInstance            = common.TaskNameCreateInstance
	TaskNameDestroyInstance           = common.TaskNameDestroyInstance
	TaskNameBuildInstanceBirthProfile = common.TaskNameBuildInstanceBirthProfile
)

type CreateInstanceTaskPayload = common.CreateInstanceTaskPayload
type DestroyInstanceTaskPayload = common.DestroyInstanceTaskPayload
type BuildInstanceBirthProfileTaskPayload = common.BuildInstanceBirthProfileTaskPayload

type noopProducer struct{}

func (noopProducer) Send(_ *mq.Message) error { return nil }

func defaultProducer() mq.Producer {
	if resource.RedisMQClient == nil {
		return noopProducer{}
	}
	return mqfactory.DefaultMQFactory.Producer(pctx.NewContext(nil))
}

func truncateTaskMessage(err error) string {
	return taskmodel.TruncateMessage(err)
}

func ExecuteCreateInstanceTask(ctx pctx.Context, payload *CreateInstanceTaskPayload) error {
	return NewLogic().(*logic).RunCreateInstanceTask(ctx, payload)
}

func ExecuteDestroyInstanceTask(ctx pctx.Context, payload *DestroyInstanceTaskPayload) error {
	return NewLogic().(*logic).RunDestroyInstanceTask(ctx, payload)
}

func FinalizeCreateInstanceTaskFailure(ctx pctx.Context, payload *CreateInstanceTaskPayload, taskErr error) {
	NewLogic().(*logic).FinalizeCreateInstanceTaskFailure(ctx, payload, taskErr)
}

func FinalizeDestroyInstanceTaskFailure(ctx pctx.Context, payload *DestroyInstanceTaskPayload, taskErr error) {
	NewLogic().(*logic).FinalizeDestroyInstanceTaskFailure(ctx, payload, taskErr)
}

func CompleteAsyncOperation(ctx pctx.Context, operationID string, err error) {
	NewLogic().(*logic).completeOperation(ctx, operationID, err)
}

func IsPendingSandboxID(sandboxID string) bool {
	return strings.HasPrefix(sandboxID, "pending-")
}

func isPendingSandboxID(sandboxID string) bool {
	return IsPendingSandboxID(sandboxID)
}

func (l *logic) enqueueTask(ctx pctx.Context, taskName string, payload interface{}, parentTaskID string) (taskID string, err error) {
	ctx, span := tracing.StartTrace(ctx, "Instance.EnqueueTask")
	defer func() { span.EndWithError(err) }()

	if l.taskDao == nil {
		return "", errors.New("task dao is nil")
	}
	if l.producer == nil {
		return "", errors.New("mq producer is nil")
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal task payload: %w", err)
	}

	taskID = l.generateTaskID()
	taskEntity := &taskmodel.Entity{
		TaskId:          taskID,
		ParentTaskId:    parentTaskID,
		TaskName:        taskName,
		TaskParams:      string(body),
		TaskState:       taskmodel.StateCreated,
		TaskMessage:     "",
		TraceId:         ctx.GetRequestId(),
		ExecuteInterval: defaultTaskExecuteIntervalSeconds,
		ExecuteCount:    0,
		MaxExecuteCount: defaultTaskMaxExecuteCount,
		LastExecuteTime: time.Unix(0, 0),
	}
	taskEntity.UserID = ctx.GetUserID()

	if err := l.taskDao.Insert(taskEntity); err != nil {
		return "", fmt.Errorf("insert task: %w", err)
	}

	messageData, err := common.GenerateMessageData(ctx, taskName, taskID, payload)
	if err != nil {
		_ = l.taskDao.UpdateByKeyColumn(map[string]interface{}{
			taskmodel.ColumnTaskState:   taskmodel.StateFailed,
			taskmodel.ColumnTaskMessage: err.Error(),
		}, taskID)
		return taskID, fmt.Errorf("generate task message: %w", err)
	}
	if err := l.producer.Send(&mq.Message{Data: messageData}); err != nil {
		// MQ 发送失败时直接将 task 置为 FAILED，避免 bypass 再次补偿这条未真正入队的任务。
		_ = l.taskDao.UpdateByKeyColumn(map[string]interface{}{
			taskmodel.ColumnTaskState:   taskmodel.StateFailed,
			taskmodel.ColumnTaskMessage: err.Error(),
		}, taskID)
		return taskID, fmt.Errorf("send task message: %w", err)
	}

	return taskID, nil
}

func (l *logic) markOperationRunning(ctx pctx.Context, operationID string) {
	if operationID == "" || l.operationHistoryDao == nil {
		return
	}
	if err := l.operationHistoryDao.UpdateStatus(ctx, operationID, operationhistory.StatusRunning, ""); err != nil {
		l.logger.Warn("update operation running failed",
			zap.Error(err),
			zap.String("operation_id", operationID),
		)
	}
}

func (l *logic) enqueueCreateInstanceTask(ctx pctx.Context, entity *modelinstance.Entity, skuID string, timeout int32, soulTemplateID string, operationID string) error {
	taskID, err := l.enqueueTask(ctx, TaskNameCreateInstance, &CreateInstanceTaskPayload{
		InstanceID:     entity.InstanceId,
		SKUID:          skuID,
		Timeout:        timeout,
		SoulTemplateID: soulTemplateID,
		OperationID:    operationID,
	}, operationID)
	if err != nil || !l.executeTasksInline {
		return err
	}
	return l.runCreateTaskInline(ctx, taskID, &CreateInstanceTaskPayload{
		InstanceID:     entity.InstanceId,
		SKUID:          skuID,
		Timeout:        timeout,
		SoulTemplateID: soulTemplateID,
		OperationID:    operationID,
	})
}

func (l *logic) enqueueDestroyInstanceTask(ctx pctx.Context, entity *modelinstance.Entity, releaseQuota bool, operationID string) error {
	taskID, err := l.enqueueTask(ctx, TaskNameDestroyInstance, &DestroyInstanceTaskPayload{
		InstanceID:   entity.InstanceId,
		ReleaseQuota: releaseQuota,
		OperationID:  operationID,
	}, operationID)
	if err != nil || !l.executeTasksInline {
		return err
	}
	return l.runDestroyTaskInline(ctx, taskID, &DestroyInstanceTaskPayload{
		InstanceID:   entity.InstanceId,
		ReleaseQuota: releaseQuota,
		OperationID:  operationID,
	})
}

func (l *logic) enqueueBirthProfileTask(ctx pctx.Context, instanceID, parentTaskID string) error {
	payload := &BuildInstanceBirthProfileTaskPayload{InstanceID: instanceID}
	taskID, err := l.enqueueCompensableTask(ctx, TaskNameBuildInstanceBirthProfile, payload, parentTaskID)
	if err != nil {
		return err
	}
	if !l.executeTasksInline {
		return nil
	}
	return l.runBuildBirthProfileTaskInline(ctx, taskID, payload)
}

func (l *logic) enqueueCompensableTask(ctx pctx.Context, taskName string, payload interface{}, parentTaskID string) (taskID string, err error) {
	ctx, span := tracing.StartTrace(ctx, "Instance.EnqueueCompensableTask")
	defer func() { span.EndWithError(err) }()

	if l.taskDao == nil {
		return "", errors.New("task dao is nil")
	}
	if l.producer == nil {
		return "", errors.New("mq producer is nil")
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal task payload: %w", err)
	}

	taskID = l.generateTaskID()
	taskEntity := &taskmodel.Entity{
		TaskId:          taskID,
		ParentTaskId:    parentTaskID,
		TaskName:        taskName,
		TaskParams:      string(body),
		TaskState:       taskmodel.StateCreated,
		TaskMessage:     "",
		TraceId:         ctx.GetRequestId(),
		ExecuteInterval: defaultTaskExecuteIntervalSeconds,
		ExecuteCount:    0,
		MaxExecuteCount: defaultTaskMaxExecuteCount,
		LastExecuteTime: time.Unix(0, 0),
	}
	taskEntity.UserID = ctx.GetUserID()

	if err := l.taskDao.Insert(taskEntity); err != nil {
		return "", fmt.Errorf("insert task: %w", err)
	}

	messageData, err := common.GenerateMessageData(ctx, taskName, taskID, payload)
	if err != nil {
		_ = l.taskDao.UpdateByKeyColumn(map[string]interface{}{
			taskmodel.ColumnTaskState:   taskmodel.StateFailed,
			taskmodel.ColumnTaskMessage: err.Error(),
		}, taskID)
		return taskID, fmt.Errorf("generate task message: %w", err)
	}
	if err := l.producer.Send(&mq.Message{Data: messageData}); err != nil {
		_ = l.taskDao.UpdateByKeyColumn(map[string]interface{}{
			taskmodel.ColumnTaskMessage: truncateTaskMessage(err),
		}, taskID)
		l.logger.Warn("send compensable task message failed, leave task in CREATED for bypass retry",
			zap.Error(err),
			zap.String("task_id", taskID),
			zap.String("task_name", taskName),
		)
	}
	return taskID, nil
}

func (l *logic) RunCreateInstanceTask(ctx pctx.Context, payload *CreateInstanceTaskPayload) error {
	if payload == nil || strings.TrimSpace(payload.InstanceID) == "" {
		return errcode.ErrInstanceInvalidParam
	}
	l.markOperationRunning(ctx, payload.OperationID)

	entity, err := l.instanceDao.GetByInstanceID(ctx, payload.InstanceID)
	if err != nil {
		return err
	}
	if entity.Status == modelinstance.InstanceStatusRunning && !isPendingSandboxID(entity.SandboxId) {
		return nil
	}
	if entity.Status != modelinstance.InstanceStatusCreating {
		return errcode.ErrInstanceStatusInvalid
	}

	candidates := l.templateCandidates()
	selection := l.selectCreateCandidatePools(ctx, candidates)
	l.logger.Info("selected sandbox candidate pools for create",
		zap.String("instance_id", entity.InstanceId),
		zap.Strings("candidate_pools", selection.Pools),
		zap.Int("attempt_limit", selection.AttemptLimit),
		zap.Bool("used_pressure_snapshot", selection.UsedSnapshot),
		zap.Time("snapshot_refreshed_at", selection.SnapshotRefreshedAt),
	)

	sandboxResp, err := l.createSandboxWithFallback(ctx, entity.InstanceId, payload.SKUID, selection, payload.Timeout)
	if err != nil {
		return err
	}
	l.logger.Info("sandbox create returned",
		zap.String("instance_id", entity.InstanceId),
		zap.String("sandbox_id", sandboxResp.SandboxID),
		zap.String("template_id", sandboxResp.TemplateID),
		zap.String("pod_name", currentPodNameForDebug()),
	)

	if err := l.persistCreatedSandboxID(ctx, entity, sandboxResp.SandboxID); err != nil {
		_ = l.cleanupCreatedSandbox(ctx, entity.InstanceId, sandboxResp.SandboxID, "persist sandbox id failed")
		return err
	}

	if l.aiGatewayProvisioningEnabled() {
		if err := l.provisionAiGatewayOnCreate(ctx, entity, sandboxResp.SandboxID); err != nil {
			_ = l.cleanupCreatedSandbox(ctx, entity.InstanceId, sandboxResp.SandboxID, "ai-gateway onboarding failed")
			return errcode.Wrap(errcode.ErrInstanceCreationFailed, "provision ai-gateway on create for sandbox %s: %v", sandboxResp.SandboxID, err)
		}
	}

	if strings.TrimSpace(payload.SoulTemplateID) != "" {
		l.logger.Warn("skip soul template apply during create",
			zap.String("instance_id", entity.InstanceId),
			zap.String("sandbox_id", sandboxResp.SandboxID),
			zap.String("soul_template_id", payload.SoulTemplateID),
		)
	}

	if err := l.instanceDao.UpdateWithStatusPrecondition(ctx, entity.Id, []string{modelinstance.InstanceStatusCreating}, map[string]interface{}{
		modelinstance.ColumnStatus: modelinstance.InstanceStatusRunning,
	}); err != nil {
		_ = l.cleanupCreatedSandbox(ctx, entity.InstanceId, sandboxResp.SandboxID, "persist sandbox info failed")
		return errcode.Wrap(errcode.ErrInstanceCreationFailed, "persist sandbox status for sandbox %s: %v", sandboxResp.SandboxID, err)
	}
	metric.RecordInstanceCreate("success", sandboxResp.TemplateID, time.Since(entity.CreatedAt).Seconds())
	l.recordCreateSuccessEvent(ctx, entity.InstanceId)
	if err := l.enqueueBirthProfileTask(ctx, entity.InstanceId, payload.OperationID); err != nil {
		l.logger.Warn("enqueue birth profile task failed",
			zap.Error(err),
			zap.String("instance_id", entity.InstanceId),
		)
	}

	return nil
}

func (l *logic) selectCreateCandidatePools(ctx pctx.Context, candidates []string) orderedCandidatePools {
	conf := currentInstanceAPIConfig()
	now := time.Now().UTC()
	selection := orderCandidatePoolsForCreate(conf, now, candidates, nil)
	if l == nil || l.churnGuard == nil || l.churnGuard.snapshots == nil {
		return selection
	}
	snapshot, err := l.churnGuard.snapshots.Load(ctx)
	if err != nil {
		l.logger.Warn("load pool pressure snapshot for create ordering failed", zap.Error(err))
		return selection
	}
	return orderCandidatePoolsForCreate(conf, now, candidates, snapshot)
}

func (l *logic) cleanupCreatedSandbox(ctx pctx.Context, instanceID, sandboxID, reason string) error {
	if err := l.sandboxAdapter.DeleteSandbox(ctx, sandboxID); err != nil && !isSandboxNotFound(err) {
		l.logger.Error("cleanup sandbox after create task failure failed",
			zap.Error(err),
			zap.String("instance_id", instanceID),
			zap.String("sandbox_id", sandboxID),
			zap.String("reason", reason),
		)
		return err
	}
	return nil
}

func (l *logic) FinalizeCreateInstanceTaskFailure(ctx pctx.Context, payload *CreateInstanceTaskPayload, taskErr error) {
	if payload == nil {
		return
	}
	entity, err := l.instanceDao.GetByInstanceID(ctx, payload.InstanceID)
	if err == nil && entity.Status == modelinstance.InstanceStatusCreating {
		metric.RecordInstanceCreate("fail", firstTemplateOrUnknown(l.templateCandidates()), time.Since(entity.CreatedAt).Seconds())
		if updateErr := l.instanceDao.UpdateStatus(ctx, entity.Id, modelinstance.InstanceStatusFailed); updateErr != nil {
			l.logger.Warn("update create task instance failed state failed",
				zap.Error(updateErr),
				zap.String("instance_id", payload.InstanceID),
			)
		}
	}
	l.rollbackQuota(ctx)
	l.completeOperation(ctx, payload.OperationID, taskErr)
}

func (l *logic) RunDestroyInstanceTask(ctx pctx.Context, payload *DestroyInstanceTaskPayload) error {
	if payload == nil || strings.TrimSpace(payload.InstanceID) == "" {
		return errcode.ErrInstanceInvalidParam
	}
	l.markOperationRunning(ctx, payload.OperationID)

	entity, err := l.instanceDao.GetByInstanceID(ctx, payload.InstanceID)
	if err != nil {
		if errors.Is(err, errcode.ErrInstanceNotFound) {
			return nil
		}
		return err
	}
	if entity.Status == modelinstance.InstanceStatusDeleted {
		return nil
	}
	if entity.Status != modelinstance.InstanceStatusDeleting {
		return errcode.ErrInstanceStatusInvalid
	}

	if strings.TrimSpace(entity.AiGatewayKeyID) != "" {
		if err := l.revokeAiGatewayApiKey(ctx, entity.AiGatewayKeyID); err != nil && !isAiGatewayKeyNotFound(err) {
			return fmt.Errorf("revoke ai-gateway api key: %w", err)
		}
	}

	if entity.SandboxId != "" && !isPendingSandboxID(entity.SandboxId) {
		err = l.sandboxAdapter.DeleteSandbox(ctx, entity.SandboxId)
		if err != nil && !isSandboxNotFound(err) {
			return err
		}
	}

	return l.finalizeInstanceDeletion(ctx, entity, payload.ReleaseQuota)
}

func (l *logic) FinalizeDestroyInstanceTaskFailure(ctx pctx.Context, payload *DestroyInstanceTaskPayload, taskErr error) {
	if payload == nil {
		return
	}
	l.completeOperation(ctx, payload.OperationID, taskErr)
}

func (l *logic) runCreateTaskInline(ctx pctx.Context, taskID string, payload *CreateInstanceTaskPayload) (err error) {
	ctx, span := tracing.StartTrace(ctx, "Instance.RunCreateTaskInline")
	defer func() { span.EndWithError(err) }()

	if err := l.taskDao.UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnExecuteCount:    1,
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
		taskmodel.ColumnTaskState:       taskmodel.StateRunning,
	}, taskID); err != nil {
		return err
	}
	if err := l.RunCreateInstanceTask(ctx, payload); err != nil {
		_ = l.taskDao.UpdateByKeyColumn(map[string]interface{}{
			taskmodel.ColumnTaskState:   taskmodel.StateFailed,
			taskmodel.ColumnTaskMessage: truncateTaskMessage(err),
		}, taskID)
		l.FinalizeCreateInstanceTaskFailure(ctx, payload, err)
		return err
	}
	if err := l.taskDao.UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, taskID); err != nil {
		return err
	}
	l.completeOperation(ctx, payload.OperationID, nil)
	return nil
}

func (l *logic) runDestroyTaskInline(ctx pctx.Context, taskID string, payload *DestroyInstanceTaskPayload) error {
	if err := l.taskDao.UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnExecuteCount:    1,
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
		taskmodel.ColumnTaskState:       taskmodel.StateRunning,
	}, taskID); err != nil {
		return err
	}
	if err := l.RunDestroyInstanceTask(ctx, payload); err != nil {
		if errors.Is(err, errcode.ErrSandboxServiceError) {
			if entity, getErr := l.instanceDao.GetByInstanceID(ctx, payload.InstanceID); getErr == nil && entity.Status == modelinstance.InstanceStatusDeleting {
				_ = l.instanceDao.UpdateStatus(ctx, entity.Id, modelinstance.InstanceStatusFailed)
			}
		}
		_ = l.taskDao.UpdateByKeyColumn(map[string]interface{}{
			taskmodel.ColumnTaskState:   taskmodel.StateFailed,
			taskmodel.ColumnTaskMessage: truncateTaskMessage(err),
		}, taskID)
		l.FinalizeDestroyInstanceTaskFailure(ctx, payload, err)
		return err
	}
	if err := l.taskDao.UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, taskID); err != nil {
		return err
	}
	l.completeOperation(ctx, payload.OperationID, nil)
	return nil
}

func (l *logic) runBuildBirthProfileTaskInline(ctx pctx.Context, taskID string, payload *BuildInstanceBirthProfileTaskPayload) error {
	if err := l.taskDao.UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnExecuteCount:    1,
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
		taskmodel.ColumnTaskState:       taskmodel.StateRunning,
	}, taskID); err != nil {
		return err
	}

	svc := instancebirth.NewService(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.InstanceBirthProfileDao(ctx),
	)
	if err := svc.RebuildForInstance(ctx, payload.InstanceID); err != nil {
		_ = l.taskDao.UpdateByKeyColumn(map[string]interface{}{
			taskmodel.ColumnTaskState:   taskmodel.StateFailed,
			taskmodel.ColumnTaskMessage: truncateTaskMessage(err),
		}, taskID)
		return err
	}

	return l.taskDao.UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, taskID)
}

func (l *logic) persistCreatedSandboxID(ctx pctx.Context, entity *modelinstance.Entity, sandboxID string) error {
	previousSandboxID := ""
	instanceID := ""
	instanceDBID := int64(0)
	if entity != nil {
		previousSandboxID = entity.SandboxId
		instanceID = entity.InstanceId
		instanceDBID = entity.Id
	}
	if err := l.instanceDao.UpdateWithStatusPrecondition(ctx, entity.Id, []string{modelinstance.InstanceStatusCreating}, map[string]interface{}{
		modelinstance.ColumnSandboxID: sandboxID,
	}); err != nil {
		fields := []zap.Field{
			zap.String("instance_id", instanceID),
			zap.Int64("instance_db_id", instanceDBID),
			zap.String("previous_sandbox_id", previousSandboxID),
			zap.String("attempt_sandbox_id", sandboxID),
			zap.String("pod_name", currentPodNameForDebug()),
			zap.Error(err),
		}
		if latest, latestErr := l.instanceDao.GetByID(ctx, entity.Id); latestErr == nil && latest != nil {
			fields = append(fields,
				zap.String("current_sandbox_id", latest.SandboxId),
				zap.String("current_status", latest.Status),
				zap.Time("current_updated_at", latest.UpdatedAt),
			)
		}
		l.logger.Warn("sandbox assignment persist failed", fields...)
		if isDuplicateKeyError(err) {
			return errcode.Wrap(errcode.ErrInstanceCreationFailed, "duplicate sandbox id: %s", sandboxID)
		}
		return errcode.Wrap(errcode.ErrInstanceCreationFailed, "persist sandbox id %s: %v", sandboxID, err)
	}
	entity.SandboxId = sandboxID
	l.logger.Info("sandbox assignment persisted",
		zap.String("instance_id", instanceID),
		zap.Int64("instance_db_id", instanceDBID),
		zap.String("previous_sandbox_id", previousSandboxID),
		zap.String("current_sandbox_id", sandboxID),
		zap.String("pod_name", currentPodNameForDebug()),
	)
	return nil
}

func (l *logic) persistAiGatewayKeyID(ctx pctx.Context, entity *modelinstance.Entity, keyID string) error {
	return l.persistAiGatewayKeyIDWithStatuses(ctx, entity, keyID, []string{modelinstance.InstanceStatusCreating})
}

func (l *logic) persistAiGatewayKeyIDWithStatuses(ctx pctx.Context, entity *modelinstance.Entity, keyID string, statuses []string) error {
	keyID = strings.TrimSpace(keyID)
	if keyID == "" {
		return fmt.Errorf("ai-gateway key_id is empty")
	}
	if err := l.instanceDao.UpdateWithStatusPrecondition(ctx, entity.Id, statuses, map[string]interface{}{
		modelinstance.ColumnAiGatewayKeyID: keyID,
	}); err != nil {
		return fmt.Errorf("persist ai-gateway key id: %w", err)
	}
	entity.AiGatewayKeyID = keyID
	return nil
}

func generateGatewayAuthToken() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate gateway auth token: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

func (l *logic) persistGatewayAuthToken(ctx pctx.Context, entity *modelinstance.Entity, token string) error {
	return l.persistGatewayAuthTokenWithStatuses(ctx, entity, token, []string{modelinstance.InstanceStatusCreating})
}

func (l *logic) persistGatewayAuthTokenWithStatuses(ctx pctx.Context, entity *modelinstance.Entity, token string, statuses []string) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return fmt.Errorf("gateway auth token is empty")
	}
	if err := l.instanceDao.UpdateWithStatusPrecondition(ctx, entity.Id, statuses, map[string]interface{}{
		modelinstance.ColumnGatewayAuthToken: token,
	}); err != nil {
		return fmt.Errorf("persist gateway auth token: %w", err)
	}
	entity.GatewayAuthToken = token
	return nil
}

// createAiGatewayApiKey 调用 AI-Gateway 为用户创建 API Key
func (l *logic) createAiGatewayApiKey(ctx pctx.Context, userID, instanceID string) (*paigateway.CreateApiKeyResponse, error) {
	if l.aiGatewayAdapter == nil {
		return nil, fmt.Errorf("aiGatewayAdapter not configured")
	}
	l.logger.Info("ai-gateway create-api-key started",
		zap.String("instance_id", instanceID),
		zap.String("user_id", userID),
	)
	resp, err := l.aiGatewayAdapter.CreateApiKey(ctx, userID, "default")
	if err != nil {
		l.logger.Warn("ai-gateway create-api-key failed",
			zap.String("instance_id", instanceID),
			zap.String("user_id", userID),
			zap.Error(err),
		)
		return nil, fmt.Errorf("ai-gateway create-api-key: %w", err)
	}
	if strings.TrimSpace(resp.KeyID) == "" {
		return nil, fmt.Errorf("ai-gateway create-api-key: missing key_id")
	}
	if strings.TrimSpace(resp.APIKey) == "" {
		return nil, fmt.Errorf("ai-gateway create-api-key: missing api_key")
	}
	l.logger.Info("ai-gateway create-api-key succeeded",
		zap.String("instance_id", instanceID),
		zap.String("user_id", userID),
		zap.String("key_id", resp.KeyID),
	)
	return resp, nil
}

func (l *logic) revokeAiGatewayApiKey(ctx pctx.Context, keyID string) error {
	if strings.TrimSpace(keyID) == "" {
		return nil
	}
	if l.aiGatewayAdapter == nil {
		return fmt.Errorf("aiGatewayAdapter not configured")
	}
	return l.aiGatewayAdapter.RevokeApiKey(ctx, keyID)
}

func isDuplicateKeyError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "Duplicate entry") || strings.Contains(err.Error(), "1062")
}

func isAiGatewayKeyNotFound(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "status 404")
}

func currentPodNameForDebug() string {
	if name := os.Getenv("POD_NAME"); name != "" {
		return name
	}
	if name, err := os.Hostname(); err == nil && name != "" {
		return name
	}
	return "unknown"
}

func (l *logic) aiGatewayProvisioningEnabled() bool {
	conf := config.ServerConf.AdapterConfig
	if conf == nil || conf.AiGateway == nil {
		return false
	}
	return strings.TrimSpace(conf.AiGateway.BaseURL) != ""
}

func (l *logic) ensureAiGatewayUser(ctx pctx.Context, userID, nickname, instanceID string) error {
	if l.aiGatewayAdapter == nil {
		return fmt.Errorf("aiGatewayAdapter not configured")
	}
	l.logger.Info("ai-gateway ensure-user started",
		zap.String("instance_id", instanceID),
		zap.String("user_id", userID),
	)
	resp, err := l.aiGatewayAdapter.EnsureUser(ctx, userID, nickname)
	if err != nil {
		l.logger.Warn("ai-gateway ensure-user failed",
			zap.String("instance_id", instanceID),
			zap.String("user_id", userID),
			zap.Error(err),
		)
		return fmt.Errorf("ai-gateway ensure-user: %w", err)
	}
	l.logger.Info("ai-gateway ensure-user succeeded",
		zap.String("instance_id", instanceID),
		zap.String("user_id", userID),
		zap.String("result", strings.TrimSpace(resp.Result)),
	)
	return nil
}

func (l *logic) provisionAiGatewayOnCreate(ctx pctx.Context, entity *modelinstance.Entity, sandboxID string) error {
	if err := l.ensureAiGatewayUser(ctx, ctx.GetUserID(), "", entity.InstanceId); err != nil {
		return err
	}
	apiKeyResp, err := l.createAiGatewayApiKey(ctx, ctx.GetUserID(), entity.InstanceId)
	if err != nil {
		return err
	}
	gatewayAuthToken, err := generateGatewayAuthToken()
	if err != nil {
		_ = l.revokeAiGatewayApiKey(ctx, apiKeyResp.KeyID)
		return err
	}

	revokeIfNeeded := func(stageErr error) error {
		revokeErr := l.revokeAiGatewayApiKey(ctx, apiKeyResp.KeyID)
		if revokeErr != nil {
			return fmt.Errorf("%w; revoke key %s: %v", stageErr, apiKeyResp.KeyID, revokeErr)
		}
		return stageErr
	}

	if err := l.configureOnboard(ctx, sandboxID, apiKeyResp.APIKey, gatewayAuthToken); err != nil {
		return revokeIfNeeded(fmt.Errorf("configure onboard: %w", err))
	}

	if err := l.persistAiGatewayKeyID(ctx, entity, apiKeyResp.KeyID); err != nil {
		l.logCreateOnboardPersistenceFailure(ctx, "persist_ai_gateway_key_id", entity, sandboxID, apiKeyResp.KeyID, err)
		return revokeIfNeeded(fmt.Errorf("persist ai-gateway key id: %w", err))
	}
	if err := l.persistGatewayAuthToken(ctx, entity, gatewayAuthToken); err != nil {
		l.logCreateOnboardPersistenceFailure(ctx, "persist_gateway_auth_token", entity, sandboxID, apiKeyResp.KeyID, err)
		return revokeIfNeeded(fmt.Errorf("persist gateway auth token: %w", err))
	}

	return nil
}

const hermesRuntimeUser = "agentuser"
const hermesDefaultProviderName = "custom"

// configureOnboard 通过 envd process 在沙箱中完成 Hermes 的默认模型初始化。
//
// 当前路径遵循 Hermes 镜像演进语义：
// 1. 镜像内置 acli 时优先使用 acli
// 2. 老镜像没有 acli 时，由 root 动态安装/更新 harness CLI 到 /usr/local/bin/harness
// 3. 再由 agentuser 执行模型配置命令
//
// 历史上这里走的是 `openclaw onboard` + gateway config patch；那套逻辑已保留在
// legacy helper 中，仅作回滚/排障参考，不再作为 Hermes create-time 初始化路径。
func (l *logic) configureOnboard(ctx pctx.Context, sandboxID string, apiKey string, gatewayAuthToken string) error {
	if strings.TrimSpace(apiKey) == "" {
		return fmt.Errorf("api_key is empty")
	}
	if strings.TrimSpace(gatewayAuthToken) == "" {
		return fmt.Errorf("gateway auth token is empty")
	}

	gwConf := config.ServerConf.AdapterConfig.AiGateway
	baseURL := gwConf.DefaultBaseURL      // 技术债：后续从 provisionResp 读取
	modelID := gwConf.DefaultModelID      // 技术债：后续从 provisionResp 读取
	compat := gwConf.DefaultCompatibility // 技术债：后续从 provisionResp 读取

	if baseURL == "" || modelID == "" {
		return fmt.Errorf("default_base_url or default_model_id not configured")
	}

	// Keep the provider identity stable with the legacy harness setup. The
	// environment config decides the endpoint/model; provider naming is not a
	// separate deploy-time default.
	providerID := hermesDefaultProviderName
	l.logHermesModelSetInput(sandboxID, providerID, modelID, baseURL, compat, apiKey)

	installResult, err := l.execSandboxProcessCommand(ctx, sandboxID, "hermes_ensure_model_cli", &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", renderHermesEnsureModelCLICommand()},
	}, 60)
	l.logHermesCommandResult("hermes_ensure_model_cli", sandboxID, installResult, err)
	if err != nil {
		return fmt.Errorf("exec ensure hermes model cli command: %w", err)
	}
	if !sandboxCommandSucceeded(installResult) {
		return fmt.Errorf("ensure hermes model cli command failed: %s", sandboxCommandFailureDetail(installResult))
	}

	modelSetCommand := shellUserCommand(hermesRuntimeUser, renderHermesModelSetCommand(
		modelID,
		providerID,
		baseURL,
		apiKey,
		compat,
	))
	modelSetResult, err := l.execSandboxProcessCommand(ctx, sandboxID, "hermes_model_set", &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", modelSetCommand},
		Env:  shellUserEnv(hermesRuntimeUser),
	}, 60)
	l.logHermesCommandResult("hermes_model_set", sandboxID, modelSetResult, err)
	if err != nil {
		return fmt.Errorf("exec hermes model set command: %w", err)
	}
	if !sandboxCommandSucceeded(modelSetResult) {
		return fmt.Errorf("hermes model set command failed: %s", sandboxCommandFailureDetail(modelSetResult))
	}

	l.logger.Info("hermes default model configured successfully",
		zap.String("sandbox_id", sandboxID),
		zap.String("provider_id", providerID),
		zap.String("model_id", modelID),
	)
	return nil
}

func renderHermesEnsureModelCLICommand() string {
	return strings.Join([]string{
		`if command -v acli >/dev/null 2>&1; then`,
		`  exit 0`,
		`fi`,
		`sudo curl -fsSL -z /usr/local/bin/harness -o /tmp/harness "https://agentone-1388575217.cos.ap-guangzhou.myqcloud.com/harness-linux-amd64"`,
		`if [ -s /tmp/harness ]; then`,
		`  sudo mv /tmp/harness /usr/local/bin/harness`,
		`  sudo chmod +x /usr/local/bin/harness`,
		`else`,
		`  rm -f /tmp/harness`,
		`fi`,
		`command -v harness >/dev/null 2>&1`,
	}, "\n")
}

func (l *logic) logHermesCommandResult(commandKind string, sandboxID string, result *psandbox.ExecCommandResult, err error) {
	if l.logger == nil {
		return
	}
	fields := []zap.Field{
		zap.String("sandbox_id", sandboxID),
		zap.String("command_kind", commandKind),
	}
	if result != nil {
		fields = append(fields,
			zap.String("status", strings.TrimSpace(result.Status)),
			zap.Int64("exit_code", result.ExitCode),
			zap.String("invocation_id", strings.TrimSpace(result.InvocationID)),
			zap.String("command_id", strings.TrimSpace(result.CommandID)),
			zap.String("stdout_tail", truncateForLog(result.Stdout, 256)),
			zap.String("stderr_tail", truncateForLog(result.Stderr, 256)),
			zap.String("error_info", strings.TrimSpace(result.ErrorInfo)),
		)
	}
	if err != nil {
		l.logger.Warn("hermes command finished with error", append(fields, zap.Error(err))...)
		return
	}
	l.logger.Info("hermes command finished", fields...)
}

func (l *logic) logHermesModelSetInput(sandboxID, providerID, modelID, baseURL, compat, apiKey string) {
	if l.logger == nil {
		return
	}
	l.logger.Info("hermes model set input",
		zap.String("sandbox_id", sandboxID),
		zap.String("provider_id", providerID),
		zap.String("model_id", modelID),
		zap.String("base_url", baseURL),
		zap.String("compatibility", compat),
		zap.String("api_mode", mapHermesAPIMode(compat)),
		zap.Bool("api_key_present", strings.TrimSpace(apiKey) != ""),
		zap.Int("api_key_length", len(strings.TrimSpace(apiKey))),
	)
}

func (l *logic) logCreateOnboardPersistenceFailure(ctx pctx.Context, stage string, entity *modelinstance.Entity, sandboxID, keyID string, err error) {
	if l.logger == nil || entity == nil {
		return
	}
	fields := []zap.Field{
		zap.String("stage", stage),
		zap.String("instance_id", entity.InstanceId),
		zap.Int64("instance_db_id", entity.Id),
		zap.String("sandbox_id", sandboxID),
		zap.String("new_key_id", keyID),
		zap.String("expected_status", modelinstance.InstanceStatusCreating),
		zap.String("entity_status_in_memory", entity.Status),
		zap.Error(err),
	}
	if latest, latestErr := l.instanceDao.GetByID(ctx, entity.Id); latestErr != nil {
		fields = append(fields, zap.Error(latestErr))
		l.logger.Warn("create-time onboarding persistence failed and current instance reload failed", fields...)
		return
	} else if latest != nil {
		fields = append(fields,
			zap.String("current_status", latest.Status),
			zap.String("current_sandbox_id", latest.SandboxId),
			zap.String("current_ai_gateway_key_id", latest.AiGatewayKeyID),
			zap.String("current_gateway_auth_token_prefix", truncateForLog(latest.GatewayAuthToken, 8)),
			zap.Time("current_updated_at", latest.UpdatedAt),
		)
	}
	l.logger.Warn("create-time onboarding persistence failed", fields...)
}

func truncateForLog(value string, max int) string {
	value = strings.TrimSpace(value)
	if max <= 0 || len(value) <= max {
		return value
	}
	return value[len(value)-max:]
}

func renderHermesModelSetCommand(modelID, providerName, baseURL, apiKey, compat string) string {
	modelName := providerName
	acliParts := []string{
		fmt.Sprintf(`--name %s`, shellQuoteArg(providerName)),
	}
	harnessParts := []string{
		fmt.Sprintf(`--model %s`, shellQuoteArg(modelID)),
		fmt.Sprintf(`--name %s`, shellQuoteArg(providerName)),
	}
	if strings.TrimSpace(baseURL) != "" {
		acliParts = append(acliParts, fmt.Sprintf(`--base-url %s`, shellQuoteArg(baseURL)))
		harnessParts = append(harnessParts, fmt.Sprintf(`--base-url %s`, shellQuoteArg(baseURL)))
	}
	if strings.TrimSpace(apiKey) != "" {
		harnessParts = append(harnessParts, fmt.Sprintf(`--api-key %s`, shellQuoteArg(apiKey)))
	}
	if api := mapHermesProviderAPI(compat); strings.TrimSpace(api) != "" {
		acliParts = append(acliParts, fmt.Sprintf(`--api %s`, shellQuoteArg(api)))
	}
	if strings.TrimSpace(apiKey) != "" {
		acliParts = append(acliParts, `--api-key "$ACLI_SECRET_API_KEY"`)
	}
	if strings.TrimSpace(modelID) != "" {
		acliParts = append(acliParts, fmt.Sprintf(`--model-id %s`, shellQuoteArg(modelID)))
	}
	if strings.TrimSpace(modelName) != "" {
		acliParts = append(acliParts, fmt.Sprintf(`--model-name %s`, shellQuoteArg(modelName)))
	}
	if harnessAPIMode := mapHermesAPIMode(compat); strings.TrimSpace(harnessAPIMode) != "" {
		harnessParts = append(harnessParts, fmt.Sprintf(`--api-mode %s`, shellQuoteArg(harnessAPIMode)))
	}
	acliArgs := strings.Join(acliParts, " ")
	harnessArgs := strings.Join(harnessParts, " ")
	secretExport := `ACLI_SECRET_API_KEY=` + shellQuoteArg(apiKey)
	lines := []string{
		`if command -v acli >/dev/null 2>&1; then`,
		`  ` + secretExport,
		fmt.Sprintf(`  save_output="$(acli provider save %s)"`, acliArgs),
		`  printf '%s\n' "$save_output"`,
		`  switch_model="$(printf '%s\n' "$save_output" | python3 -c 'import json,re,sys`,
		`raw=sys.stdin.read()`,
		`match=re.search(r"\{.*\}", raw, re.S)`,
		`if not match:`,
		`    raise SystemExit("provider save did not return JSON")`,
		`payload=json.loads(match.group(0))`,
		`data=payload.get("data", payload) if isinstance(payload, dict) else {}`,
		`def pick(*keys):`,
		`    for key in keys:`,
		`        value=data.get(key) if isinstance(data, dict) else None`,
		`        if isinstance(value, str) and value.strip():`,
		`            return value.strip()`,
		`    return ""`,
		`model=pick("model", "model_name", "modelName", "default_model", "defaultModel")`,
		`provider=pick("provider", "provider_name", "providerName", "name")`,
		`if "/" in model:`,
		`    print(model)`,
		`elif provider and model:`,
		`    print(provider + "/" + model)`,
		`else:`,
		`    raise SystemExit("provider save output missing switch model")`,
		`')"`,
		`  acli model switch --model "$switch_model"`,
	}
	lines = append(lines,
		`elif command -v harness >/dev/null 2>&1; then`,
		fmt.Sprintf(`  harness model set %s`, harnessArgs),
		`else`,
		`  echo "neither acli nor harness found" >&2`,
		`  exit 127`,
		`fi`,
	)
	return strings.Join(lines, "\n")
}

func mapHermesProviderAPI(compat string) string {
	switch strings.TrimSpace(strings.ToLower(compat)) {
	case "", "openai", "openai-completions", "openai-compatible", "chat_completions", "chat-completions":
		return "chat_completions"
	case "anthropic", "anthropic-messages":
		return "anthropic_messages"
	default:
		return compat
	}
}

func mapHermesAPIMode(compat string) string {
	switch strings.TrimSpace(strings.ToLower(compat)) {
	case "", "openai", "openai-completions":
		return "openai-completions"
	case "anthropic", "anthropic-messages":
		return "anthropic-messages"
	default:
		return compat
	}
}

func (l *logic) applySoulTemplateOnCreate(ctx pctx.Context, sandboxID, templateID string) error {
	content, err := loadSoulTemplateContent(templateID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(content) == "" {
		return nil
	}

	result, err := l.execSandboxProcessCommand(ctx, sandboxID, "openclaw_write_soul", &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", openclawRuntimeUserCommand(renderSandboxSoulWriteCommand(content))},
	}, 60)
	if err != nil {
		return fmt.Errorf("exec soul write command: %w", err)
	}
	if !sandboxCommandSucceeded(result) {
		return fmt.Errorf("soul write command failed: %s", sandboxCommandFailureDetail(result))
	}

	l.logger.Info("openclaw soul configured successfully",
		zap.String("sandbox_id", sandboxID),
		zap.String("soul_template_id", templateID),
	)
	return nil
}

func shellSingleQuote(value string) string {
	return strings.ReplaceAll(value, `'`, `'\''`)
}
