package instance

import (
	stdctx "context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	adapterfactory "ctl/pkg/adapter/factory"
	pllmgateway "ctl/pkg/adapter/llmgateway"
	popenclawgateway "ctl/pkg/adapter/openclawgateway"
	psandbox "ctl/pkg/adapter/sandbox"
	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	"ctl/pkg/logic/objectid"
	"ctl/pkg/metric"
	"ctl/pkg/model/channelloginsession"
	modelfactory "ctl/pkg/model/factory"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/model/operationhistory"
	modelpass "ctl/pkg/model/pass"
	taskmodel "ctl/pkg/model/task"
	quota "ctl/pkg/model/userresourcequota"
	"ctl/pkg/mq"
	"ctl/pkg/resource"
	"ctl/pkg/transport"

	"go.uber.org/zap"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const resourceNameOpenClawInstance = "OPENCLAW_INSTANCE"
const defaultOpenClawInstanceQuota = 5
const maxInstanceDisplayNameRunes = 64

var expectedPauseConflictMessages = []string{
	"already paused",
	"is paused",
	"paused",
}

var expectedResumeConflictMessages = []string{
	"already running",
	"is running",
	"running",
	"already resumed",
	"resumed",
}

type Logic interface {
	CreateInstance(ctx pctx.Context, req *transport.CreateInstanceRequest) (*transport.InstanceResponse, error)
	GetCreatePrerequisites(ctx pctx.Context) (*transport.CreatePrerequisitesResponse, error)
	UpdateInstance(ctx pctx.Context, instanceID string, req *transport.UpdateInstanceRequest) (*transport.InstanceResponse, error)
	ResetInstanceConfig(ctx pctx.Context, instanceID string) (*transport.InstanceConfigResetResponse, error)
	ListSoulTemplates(ctx pctx.Context) (*transport.ListSoulTemplatesResponse, error)
	GetUserUsage(ctx pctx.Context) (*transport.UserUsageResponse, error)
	GetInstance(ctx pctx.Context, instanceID string) (*transport.InstanceResponse, error)
	StartTerminalSession(ctx pctx.Context, instanceID string) (*transport.TerminalSessionResponse, error)
	ListInstances(ctx pctx.Context, page, pageSize int) (*transport.ListInstancesResponse, error)
	DestroyInstance(ctx pctx.Context, instanceID string) (*transport.InstanceResponse, error)
	PauseInstance(ctx pctx.Context, instanceID string) (*transport.InstanceResponse, error)
	ResumeInstance(ctx pctx.Context, instanceID string, req *transport.ResumeInstanceRequest) (*transport.InstanceResponse, error)
	SetInstanceTimeout(ctx pctx.Context, instanceID string, req *transport.SetTimeoutRequest) (*transport.InstanceResponse, error)
	ListOperations(ctx pctx.Context, instanceID string, page, pageSize int) (*transport.ListOperationsResponse, error)
	GetInstanceLogs(ctx pctx.Context, instanceID string, start *int64, limit *int32) (*psandbox.SandboxLogs, error)
	ExecDebugCommand(ctx pctx.Context, instanceID string, commandType string, runAsUser string) (*transport.ExecDebugCommandResponse, error)
	StreamDebugCommand(ctx pctx.Context, instanceID string, commandType string, runAsUser string, onEvent func(transport.ExecDebugCommandStreamEvent) error) error
	GetWorkspaceFiles(ctx pctx.Context, instanceID string, fileName string) (*transport.WorkspaceFilesResponse, error)
	UpdateWorkspaceFile(ctx pctx.Context, instanceID string, req *transport.UpdateWorkspaceFileRequest) (*transport.WorkspaceFileResponse, error)
	UploadWorkspaceAttachment(ctx pctx.Context, instanceID string, req *transport.UploadWorkspaceAttachmentRequest) (*transport.WorkspaceUploadResponse, error)
	ListWorkspaceUploads(ctx pctx.Context, instanceID string, req *transport.ListWorkspaceUploadsRequest) (*transport.WorkspaceUploadsResponse, error)
	GetWorkspaceUpload(ctx pctx.Context, instanceID, uploadID string) (*transport.WorkspaceUploadResponse, error)
	GetWorkspaceUploadContent(ctx pctx.Context, instanceID, uploadID string) (*transport.WorkspaceUploadResponse, []byte, error)
	ListAutomationSchedules(ctx pctx.Context, instanceID string, offset, limit int64) (*transport.AutomationSchedulesResponse, error)
	GetAutomationSchedule(ctx pctx.Context, instanceID, scheduleID string) (*transport.AutomationSchedule, error)
	CreateAutomationSchedule(ctx pctx.Context, instanceID string, req *transport.CreateAutomationScheduleRequest) (*transport.AutomationSchedule, error)
	UpdateAutomationSchedule(ctx pctx.Context, instanceID, scheduleID string, req *transport.UpdateAutomationScheduleRequest) (*transport.AutomationSchedule, error)
	DeleteAutomationSchedule(ctx pctx.Context, instanceID, scheduleID string) error
	RunAutomationSchedule(ctx pctx.Context, instanceID, scheduleID string) (*transport.AutomationRunResponse, error)
	GetChatClawState(ctx pctx.Context, instanceID string) (*transport.ChatClawStateResponse, error)
	SyncChatClawState(ctx pctx.Context, instanceID string) (*transport.ChatClawStateResponse, error)
	CreateChatClawAgent(ctx pctx.Context, instanceID string, req *transport.CreateChatClawAgentRequest) (*transport.ChatClawAgentResponse, error)
	UpdateChatClawAgent(ctx pctx.Context, instanceID, agentID string, req *transport.UpdateChatClawAgentRequest) (*transport.ChatClawAgentResponse, error)
	DeleteChatClawAgent(ctx pctx.Context, instanceID, agentID string) error
	CreateChatClawTeam(ctx pctx.Context, instanceID string, req *transport.CreateChatClawTeamRequest) (*transport.ChatClawTeamResponse, error)
	UpdateChatClawTeam(ctx pctx.Context, instanceID, teamID string, req *transport.UpdateChatClawTeamRequest) (*transport.ChatClawTeamResponse, error)
	DeleteChatClawTeam(ctx pctx.Context, instanceID, teamID string) error
	CreateChatClawConversation(ctx pctx.Context, instanceID string, req *transport.CreateChatClawConversationRequest) (*transport.ChatClawConversationResponse, error)
	UpdateChatClawConversation(ctx pctx.Context, instanceID, conversationID string, req *transport.UpdateChatClawConversationRequest) (*transport.ChatClawConversationResponse, error)
	DeleteChatClawConversation(ctx pctx.Context, instanceID, conversationID string) error
	GetChatClawRuntimeBootstrap(ctx pctx.Context, instanceID, conversationID string) (*transport.ChatClawRuntimeBootstrapResponse, error)
	CreateAgentChatLaunchToken(ctx pctx.Context, instanceID string) (*transport.AgentChatLaunchTokenResponse, error)
	IntrospectAgentChatLaunchToken(ctx pctx.Context, req *transport.AgentChatIntrospectRequest) (*transport.AgentChatIntrospectResponse, error)
	CreateWeixinLoginSession(ctx pctx.Context, instanceID string) (*transport.CreateWeixinLoginSessionResponse, error)
	GetWeixinLoginSession(ctx pctx.Context, instanceID, sessionID string) (*transport.WeixinLoginSessionResponse, error)
	CancelWeixinLoginSession(ctx pctx.Context, instanceID, sessionID string) (*transport.WeixinLoginSessionResponse, error)
	SubscribeWeixinLoginSession(ctx pctx.Context, instanceID, sessionID string) (*transport.WeixinLoginSessionResponse, <-chan transport.WeixinLoginSessionEvent, func(), error)
	ConfigureChannel(ctx pctx.Context, instanceID string, req *transport.ConfigureChannelRequest) (*transport.ConfigureChannelResponse, error)
}

type logic struct {
	instanceDao            modelinstance.Dao
	taskDao                taskmodel.Dao
	channelLoginSessionDao channelloginsession.Dao
	quotaDao               quota.Dao
	sandboxAdapter         psandbox.Adapter
	aiGatewayAdapter       pllmgateway.Adapter
	openclawGatewayAdapter popenclawgateway.Adapter
	producer               mq.Producer
	operationHistoryDao    operationhistory.Dao
	objectIdLogic          objectid.Logic
	logger                 *zap.Logger
	defaultTemplateClass   string
	defaultTemplate        string
	defaultSKUID           string
	candidateTemplates     []string
	executeTasksInline     bool
	weixinHub              *weixinLoginHub
	churnGuard             *createChurnGuard
}

func NewLogic() Logic {
	logger := resource.ZapLogger
	if logger == nil {
		logger = zap.NewNop()
	}
	instanceConf := currentInstanceAPIConfig()
	defaultTemplateClass := defaultTemplateClassIDFromConfig(instanceConf)
	defaultTemplate := defaultTemplateIDFromConfig(instanceConf)
	return &logic{
		instanceDao:            modelfactory.DefaultDaoFactory.InstanceDao(nil),
		channelLoginSessionDao: modelfactory.DefaultDaoFactory.ChannelLoginSessionDao(nil),
		taskDao:                modelfactory.DefaultDaoFactory.TaskDao(nil),
		quotaDao:               modelfactory.DefaultDaoFactory.UserResourceQuotaDao(nil),
		sandboxAdapter:         adapterfactory.DefaultAdapterFactory.SandboxAdapter(),
		aiGatewayAdapter:       adapterfactory.DefaultAdapterFactory.LLMGatewayAdapter(),
		openclawGatewayAdapter: adapterfactory.DefaultAdapterFactory.OpenClawGatewayAdapter(),
		producer:               defaultProducer(),
		operationHistoryDao:    modelfactory.DefaultDaoFactory.OperationHistoryDao(nil),
		objectIdLogic:          objectid.NewLogic(),
		logger:                 logger,
		defaultTemplateClass:   defaultTemplateClass,
		defaultTemplate:        defaultTemplate,
		defaultSKUID:           defaultSKUIDFromConfig(instanceConf),
		candidateTemplates:     candidateTemplateIDsFromConfig(instanceConf, defaultTemplateClass, defaultTemplate),
		executeTasksInline:     false,
		weixinHub:              newWeixinLoginHub(),
		churnGuard:             newCreateChurnGuard(instanceConf, logger),
	}
}

func NewLogicForTest(instanceDao modelinstance.Dao, quotaDao quota.Dao, sandboxAdapter psandbox.Adapter, aiGatewayAdapter pllmgateway.Adapter, opHistoryDao operationhistory.Dao, logger *zap.Logger, defaultTemplate string, candidateTemplates ...string) Logic {
	return newLogicForTest(instanceDao, quotaDao, sandboxAdapter, aiGatewayAdapter, opHistoryDao, logger, "", defaultTemplate, candidateTemplates...)
}

func NewLogicForTestWithTemplateClass(instanceDao modelinstance.Dao, quotaDao quota.Dao, sandboxAdapter psandbox.Adapter, aiGatewayAdapter pllmgateway.Adapter, opHistoryDao operationhistory.Dao, logger *zap.Logger, templateClassID string, defaultTemplate string, candidateTemplates ...string) Logic {
	return newLogicForTest(instanceDao, quotaDao, sandboxAdapter, aiGatewayAdapter, opHistoryDao, logger, templateClassID, defaultTemplate, candidateTemplates...)
}

func newLogicForTest(instanceDao modelinstance.Dao, quotaDao quota.Dao, sandboxAdapter psandbox.Adapter, aiGatewayAdapter pllmgateway.Adapter, opHistoryDao operationhistory.Dao, logger *zap.Logger, templateClassID string, defaultTemplate string, candidateTemplates ...string) Logic {
	if logger == nil {
		logger = zap.NewNop()
	}
	instanceConf := currentInstanceAPIConfig()
	return &logic{
		instanceDao:            instanceDao,
		channelLoginSessionDao: modelfactory.DefaultDaoFactory.ChannelLoginSessionDao(nil),
		taskDao:                modelfactory.DefaultDaoFactory.TaskDao(nil),
		quotaDao:               quotaDao,
		sandboxAdapter:         sandboxAdapter,
		aiGatewayAdapter:       aiGatewayAdapter,
		// Mia: test helper should not accidentally inherit a half-dead global Redis client.
		// Inline task execution already covers the business path we care about here.
		producer:             noopProducer{},
		operationHistoryDao:  opHistoryDao,
		objectIdLogic:        objectid.NewLogic(),
		logger:               logger,
		defaultTemplateClass: strings.TrimSpace(templateClassID),
		defaultTemplate:      defaultTemplate,
		defaultSKUID:         defaultSKUIDFromConfig(instanceConf),
		candidateTemplates: filterTemplateCandidatesForTemplateClass(
			uniqueNonEmptyStringsPreserveOrder(candidateTemplates),
			strings.TrimSpace(templateClassID),
			defaultTemplate,
		),
		executeTasksInline: true,
		weixinHub:          newWeixinLoginHub(),
		churnGuard:         newCreateChurnGuard(instanceConf, logger),
	}
}

func defaultTemplateClassIDFromConfig(conf *config.InstanceAPIConfig) string {
	if conf == nil {
		return ""
	}
	return strings.TrimSpace(conf.DefaultTemplateClassID)
}

func defaultTemplateIDFromConfig(conf *config.InstanceAPIConfig) string {
	if conf == nil {
		return ""
	}
	return conf.DefaultTemplateID
}

func defaultSKUIDFromConfig(conf *config.InstanceAPIConfig) string {
	if conf == nil {
		return ""
	}
	return strings.TrimSpace(conf.DefaultSKUID)
}

var legacyTemplateAliasPattern = regexp.MustCompile(`^pool-[a-z]?\d+$`)

func candidateTemplateIDsFromConfig(conf *config.InstanceAPIConfig, templateClassID, defaultTemplate string) []string {
	if conf == nil {
		return nil
	}
	candidates := uniqueNonEmptyStringsPreserveOrder(conf.CandidateTemplateIDs)
	return filterTemplateCandidatesForTemplateClass(candidates, strings.TrimSpace(templateClassID), strings.TrimSpace(defaultTemplate))
}

func filterTemplateCandidatesForTemplateClass(candidates []string, templateClassID, defaultTemplate string) []string {
	classID := strings.TrimSpace(templateClassID)
	if classID == "" {
		return candidates
	}

	filtered := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" || candidate == classID {
			continue
		}
		if candidate == defaultTemplate {
			filtered = append(filtered, candidate)
			continue
		}
		if legacyTemplateAliasPattern.MatchString(candidate) {
			continue
		}
		filtered = append(filtered, candidate)
	}
	return filtered
}

func currentInstanceAPIConfig() *config.InstanceAPIConfig {
	if config.ServerConf == nil || config.ServerConf.APIConfig == nil {
		return nil
	}
	return config.ServerConf.APIConfig.Instance
}

func (l *logic) ListSoulTemplates(_ pctx.Context) (*transport.ListSoulTemplatesResponse, error) {
	templates, err := listSoulTemplates()
	if err != nil {
		return nil, err
	}
	return &transport.ListSoulTemplatesResponse{Items: templates}, nil
}

func (l *logic) GetUserUsage(ctx pctx.Context) (*transport.UserUsageResponse, error) {
	userID := strings.TrimSpace(ctx.GetUserID())
	if userID == "" {
		return nil, errcode.ErrInstanceMissingUserID
	}

	if l.aiGatewayAdapter == nil {
		return &transport.UserUsageResponse{}, nil
	}

	usage, err := l.aiGatewayAdapter.GetUserUsage(ctx, userID)
	if err != nil {
		l.logger.Warn("fetch user usage from ai-gateway failed",
			zap.Error(err),
			zap.String("user_id", userID),
		)
		return &transport.UserUsageResponse{}, nil
	}

	return &transport.UserUsageResponse{
		UsedCredits:   usage.TotalTokens,
		TotalCredits:  0,
		TotalRequests: usage.TotalRequests,
	}, nil
}

func (l *logic) CreateInstance(ctx pctx.Context, req *transport.CreateInstanceRequest) (resp *transport.InstanceResponse, retErr error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, errcode.ErrInstanceMissingUserID
	}
	if req == nil {
		req = &transport.CreateInstanceRequest{}
	}

	timeout := transport.DefaultInstanceTimeoutSeconds
	if req.Timeout != nil {
		timeout = *req.Timeout
	}
	if !isValidInstanceTimeout(timeout) {
		return nil, errcode.ErrInstanceInvalidParam
	}
	displayName, err := validateOptionalInstanceDisplayName(req.Name)
	if err != nil {
		return nil, err
	}

	soulTemplateID, err := resolveRequestedSoulTemplateID(req.SoulTemplateID)
	if err != nil {
		return nil, err
	}

	if err := l.ensureShadowBindingIfRequired(ctx); err != nil {
		return nil, err
	}

	// trade-pass 拦截：检查用户 pass 状态
	// 设计稿：
	//   - .tmp/trade-pass-isolate-design.md §10 Q23 = C1 修订版（isolating / isolated）
	//   - .tmp/trade-pass-renew-design.md §3.1 / §3.4 v3.8（renewing 拦截）
	//   - bundle-instance-spec-design.md Q3=a / §4.3：顺手取出 active pass.bundle_id 反查
	//     instance_spec_id 选 per-spec 候选池
	//
	// 拦截策略：
	//   - 用户存在任何一个 pass.status='isolating' → 返回 PASS_ISOLATING（403）
	//   - 用户存在任何一个 pass.status='renewing' → 返回 PASS_RENEWING（403）
	//   - 用户存在任何一个 pass.status='isolated'  → 返回 PASS_ISOLATED（403）
	//   - 用户没有任何 active pass（无 pass / 全部 isolating-renewing-isolated 已被前面拦） →
	//     返回 ErrInstanceNoActivePass（403），强校验「必须先购买 bundle」
	//   - 用户至少有一个 active pass → 放行，由后续 AllocQuota / churn guard / 任务派发处理
	//
	// 顺序约束（必须在 ensureDefaultQuota / AllocQuota 之前）：
	//   - bundle 引入后 quota 行由 CreatePassWithQuota 按 bundle.agent_quota 同事务初始化；
	//     ensureDefaultQuota 仅作 last-resort 兜底（quota 行被外力删除时回写）
	//   - 把 active pass 强校验提前到这里，可彻底杜绝「无 pass 用户白嫖默认 5 配额」的旧路径
	//   - AllocQuota 会真的扣 available 配额，必须放在拦截之后避免误扣
	//
	// 实现注意：
	//   - 这里直接读 PassDao 不走 cache，因为 isolation 操作低频（管理员触发），
	//     CreateInstance 高频但 pass 数量可控（用户唯一 pass 强约束）
	//   - 用 modelpass 而不是 logic/pass，避免 instance ↔ pass 双向 logic 依赖循环
	activePassBundleID, err := l.checkPassNotIsolated(ctx)
	if err != nil {
		metric.RecordInstanceCreate("rejected_pass_isolated", "", "", 0)
		return nil, err
	}
	if activePassBundleID == "" {
		l.logger.Info("CreateInstance rejected: no active pass",
			zap.String("user_id", ctx.GetUserID()))
		metric.RecordInstanceCreate("rejected_no_active_pass", "", "", 0)
		return nil, errcode.ErrInstanceNoActivePass
	}

	// last-resort 防御性兜底：理论上 active pass 存在时 quota 行必然由 CreatePassWithQuota
	// 同事务初始化好；只有 quota 行被外力（运维 SQL / 数据迁移异常）删除时才会触发写入。
	// INSERT ON CONFLICT DO NOTHING 幂等，对正常路径无副作用。
	if err := l.ensureDefaultQuota(ctx, resourceNameOpenClawInstance, ""); err != nil {
		return nil, errcode.Wrap(errcode.ErrInstanceCreationFailed, "ensure quota: %v", err)
	}

	// 反查 bundle.instance_spec_id（设计稿 Q3=a）。
	// activePassBundleID 非空（已被强校验）；bundle 查询失败时 specID = "" 走兼容期 fallback。
	instanceSpecID := l.resolveInstanceSpecID(ctx, activePassBundleID)
	quotaAllocated, err := l.quotaDao.AllocQuota(ctx.GetUserID(), resourceNameOpenClawInstance, "", 1)
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrInstanceCreationFailed, "alloc quota: %v", err)
	}
	if !quotaAllocated {
		return nil, errcode.ErrInstanceQuotaExceeded
	}

	decision, err := l.evaluateCreateChurnGuard(ctx, instanceSpecID)
	if err != nil {
		l.rollbackQuota(ctx)
		return nil, err
	}
	if !decision.Allow {
		l.rollbackQuota(ctx)
		metric.RecordInstanceCreate("rejected", firstTemplateOrUnknown(decision.CandidatePools), instanceSpecID, 0)
		return nil, newInstanceChurnLimitedError(decision.RetryAfter)
	}

	entity := &modelinstance.Entity{
		InstanceId:  l.generateInstanceID(),
		DisplayName: displayName,
		Status:      modelinstance.InstanceStatusCreating,
		TimeoutAt:   time.Now().UTC().Add(time.Duration(timeout) * time.Second),
	}
	entity.SandboxId = pendingSandboxID(entity.InstanceId)

	operationID := l.recordOperation(ctx, entity.InstanceId, operationhistory.OperationTypeCreate)

	if err := l.instanceDao.Create(ctx, entity); err != nil {
		l.rollbackQuota(ctx)
		l.completeOperation(ctx, operationID, err)
		return nil, errcode.Wrap(errcode.ErrInstanceCreationFailed, "create instance record: %v", err)
	}

	if err := l.enqueueCreateInstanceTask(ctx, entity, instanceSpecID, timeout, soulTemplateID, operationID); err != nil {
		if l.executeTasksInline {
			return nil, err
		}
		if updateErr := l.instanceDao.UpdateStatus(ctx, entity.Id, modelinstance.InstanceStatusFailed); updateErr != nil {
			l.logger.Warn("update failed status", zap.Error(updateErr), zap.String("instance_id", entity.InstanceId))
		}
		l.rollbackQuota(ctx)
		l.completeOperation(ctx, operationID, err)
		return nil, errcode.Wrap(errcode.ErrSandboxServiceError, "enqueue create task: %v", err)
	}
	if l.executeTasksInline {
		latest, err := l.instanceDao.GetByInstanceID(ctx, entity.InstanceId)
		if err != nil {
			return nil, err
		}
		entity = latest
	}

	return toInstanceResponse(entity, true), nil
}

func (l *logic) GetCreatePrerequisites(ctx pctx.Context) (*transport.CreatePrerequisitesResponse, error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, errcode.ErrInstanceMissingUserID
	}
	resp := &transport.CreatePrerequisitesResponse{
		SiteKind:             config.SiteKind(),
		ShadowAccountEnabled: config.ShadowBindingRequired(),
		ShadowBound:          false,
	}
	if !resp.ShadowAccountEnabled {
		return resp, nil
	}
	binding, err := adapterfactory.DefaultAdapterFactory.ShadowAdapter().GetBindingByUserID(ctx.GetUserID())
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrInstanceCreationFailed, "check shadow binding: %v", err)
	}
	resp.ShadowBound = binding != nil
	return resp, nil
}

func (l *logic) UpdateInstance(ctx pctx.Context, instanceID string, req *transport.UpdateInstanceRequest) (*transport.InstanceResponse, error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, errcode.ErrInstanceMissingUserID
	}
	instanceID = strings.TrimSpace(instanceID)
	if instanceID == "" || req == nil || req.Name == nil {
		return nil, errcode.ErrInstanceInvalidParam
	}

	displayName, err := validateInstanceDisplayName(*req.Name)
	if err != nil {
		return nil, err
	}

	entity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	if entity.DisplayName == displayName {
		return toInstanceResponse(entity, true), nil
	}
	if err := l.instanceDao.UpdateDisplayName(ctx, entity.Id, displayName); err != nil {
		return nil, err
	}
	entity.DisplayName = displayName
	return toInstanceResponse(entity, true), nil
}

// ensureDefaultQuota 是 OPENCLAW_INSTANCE 配额的 last-resort 防御性兜底。
//
// 历史背景（v1，bundle 未引入前）：作为「用户首次 createInstance 自动分配 5 个配额」的入口。
//
// 当前语义（v2，bundle/pass 引入后，2026-06-08 调整）：
//   - 正常付费用户的 quota 行由 modelpass.CreatePassWithQuota 按 bundle.agent_quota 同事务初始化
//   - CreateInstance 已强校验 active pass 存在（见 ErrInstanceNoActivePass）；
//     因此进入 ensureDefaultQuota 时 quota 行**必然**已存在，INSERT ON CONFLICT DO NOTHING 直接跳过
//   - 仅当 quota 行被外力删除（运维 SQL / 数据迁移异常）时，本兜底才会真正写入一行
//     total=available=defaultQuotaTotal(=5)，避免 AllocQuota 直接 NPE
//   - 即便兜底命中，bundle.agent_quota 后续也会通过 CreatePassWithQuota 的 UPDATE 同步覆盖回正确值
//
// 不再用于「无 active pass 用户白嫖默认 5 配额」的旧路径。
func (l *logic) ensureDefaultQuota(ctx pctx.Context, resourceName, resourceKey string) error {
	quotaTotal := defaultQuotaTotal(resourceName)
	if quotaTotal <= 0 {
		return nil
	}

	return l.quotaDao.DB().
		Clauses(clause.OnConflict{
			Columns: []clause.Column{
				{Name: quota.ColumnUserID},
				{Name: quota.ColumnResourceName},
				{Name: quota.ColumnResourceKey},
			},
			DoNothing: true,
		}).
		Create(&quota.Entity{
			UserID:                 ctx.GetUserID(),
			ResourceName:           resourceName,
			ResourceKey:            resourceKey,
			ResourceQuotaAvailable: quotaTotal,
			ResourceQuotaTotal:     quotaTotal,
		}).Error
}

func (l *logic) ensureShadowBindingIfRequired(ctx pctx.Context) error {
	if !config.ShadowBindingRequired() {
		return nil
	}
	binding, err := adapterfactory.DefaultAdapterFactory.ShadowAdapter().GetBindingByUserID(ctx.GetUserID())
	if err != nil {
		return errcode.Wrap(errcode.ErrInstanceCreationFailed, "check shadow binding: %v", err)
	}
	if binding == nil {
		return errcode.ErrInstanceShadowBindingRequired
	}
	return nil
}

// checkPassNotIsolated 拦截 pass 处于 isolating / isolated / renewing 状态的 CreateInstance 调用
// 设计稿：
//   - .tmp/trade-pass-isolate-design.md §10 Q23 = C1 修订版（isolating / isolated）
//   - .tmp/trade-pass-renew-design.md §3.1 / §3.4 v3.8（renewing 拦截：续费 task 进行中不允许创建实例）
//   - bundle-instance-spec-design.md v9 / Q3=a：顺手返回 active pass.bundle_id 供调用方反查 instance_spec_id
//
// 返回值：
//   - activePassBundleID：用户当前 active pass.bundle_id。无 pass / 无 active pass 时返回空字符串；
//     用户同时有多个 active pass 是异常状况（业务上唯一 pass 强约束），返回第一个。
//   - error：
//   - errcode.ErrPassIsolating：发现至少一个 isolating 状态的 pass
//   - errcode.ErrPassRenewing：发现至少一个 renewing 状态的 pass（且无 isolating）
//   - errcode.ErrPassIsolated：发现至少一个 isolated 状态的 pass（且无 isolating/renewing）
//   - 其他 error：DB 异常，应让 caller 把请求快速失败
//
// 多个 pass 同时存在多种状态时的优先级：isolating > renewing > isolated
//   - 用更"短暂"的状态覆盖，引导 caller 先重试再判断永久拦截
//   - 本期用户唯一 pass 约束下不会同时出现
func (l *logic) checkPassNotIsolated(ctx pctx.Context) (string, error) {
	userID := ctx.GetUserID()
	if userID == "" {
		return "", nil
	}
	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)
	passes, err := passDao.ListByUserID(userID)
	if err != nil {
		return "", errcode.Wrap(errcode.ErrInstanceCreationFailed, "check pass status: %v", err)
	}
	if len(passes) == 0 {
		return "", nil
	}
	hasIsolated := false
	hasRenewing := false
	activePassBundleID := ""
	for _, p := range passes {
		switch p.Status {
		case modelpass.StatusIsolating:
			l.logger.Info("CreateInstance blocked by pass isolating",
				zap.String("user_id", userID), zap.String("pass_id", p.PassID))
			return "", errcode.ErrPassIsolating
		case modelpass.StatusRenewing:
			hasRenewing = true
		case modelpass.StatusIsolated:
			hasIsolated = true
		case modelpass.StatusActive:
			if activePassBundleID == "" {
				activePassBundleID = p.BundleID
			}
		}
	}
	if hasRenewing {
		l.logger.Info("CreateInstance blocked by pass renewing",
			zap.String("user_id", userID))
		return "", errcode.ErrPassRenewing
	}
	if hasIsolated {
		l.logger.Info("CreateInstance blocked by pass isolated",
			zap.String("user_id", userID))
		return "", errcode.ErrPassIsolated
	}
	return activePassBundleID, nil
}

// resolveInstanceSpecID 反查 bundle.instance_spec_id。
// activePassBundleID 为空或 bundle 查询失败时返回空字符串，调用方走兼容期全局候选池。
func (l *logic) resolveInstanceSpecID(ctx pctx.Context, activePassBundleID string) string {
	activePassBundleID = strings.TrimSpace(activePassBundleID)
	if activePassBundleID == "" {
		return ""
	}
	bundleDao := modelfactory.DefaultDaoFactory.BundleDao(nil)
	bundle, err := bundleDao.GetByBundleID(activePassBundleID)
	if err != nil {
		l.logger.Warn("resolve instance spec id: bundle not found, fallback to default",
			zap.String("bundle_id", activePassBundleID),
			zap.Error(err),
		)
		return ""
	}
	return strings.TrimSpace(bundle.InstanceSpecID)
}

func defaultQuotaTotal(resourceName string) int64 {
	if config.ServerConf.GlobalQuotaConfig != nil && config.ServerConf.GlobalQuotaConfig.ResourceDefaultQuotas != nil {
		if quotaTotal, ok := config.ServerConf.GlobalQuotaConfig.ResourceDefaultQuotas[resourceName]; ok && quotaTotal > 0 {
			return quotaTotal
		}
	}

	if resourceName == resourceNameOpenClawInstance {
		return defaultOpenClawInstanceQuota
	}

	return 0
}

func (l *logic) templateCandidates() []string {
	return uniqueNonEmptyStringsPreserveOrder(append([]string{l.defaultTemplate}, l.candidateTemplates...))
}

// templateCandidatesForSpec 返回指定实例规格的候选池列表。
func (l *logic) templateCandidatesForSpec(specID string) ([]string, error) {
	specID = strings.TrimSpace(specID)
	if specID == "" {
		return l.templateCandidates(), nil
	}
	conf := currentInstanceAPIConfig()
	if sp, ok := conf.SpecPoolFor(specID); ok {
		return uniqueNonEmptyStringsPreserveOrder(
			append([]string{sp.DefaultTemplateID}, sp.CandidateTemplateIDs...),
		), nil
	}
	return nil, errcode.Wrap(errcode.ErrBundleInstanceSpecNoPool,
		"no candidate pools configured for instance_spec_id %q", specID)
}

// templateClassForSpec 返回指定实例规格对应的 sandbox template_class_id。
func (l *logic) templateClassForSpec(specID string) string {
	specID = strings.TrimSpace(specID)
	if specID == "" {
		return l.defaultTemplateClass
	}
	conf := currentInstanceAPIConfig()
	if sp, ok := conf.SpecPoolFor(specID); ok {
		if classID := strings.TrimSpace(sp.TemplateClassID); classID != "" {
			return classID
		}
	}
	return l.defaultTemplateClass
}

// skuIDForSpec 返回指定实例规格对应的 sandbox sku_id。
func (l *logic) skuIDForSpec(specID string) string {
	specID = strings.TrimSpace(specID)
	if specID == "" {
		return l.defaultSKUID
	}
	conf := currentInstanceAPIConfig()
	if sp, ok := conf.SpecPoolFor(specID); ok {
		if skuID := strings.TrimSpace(sp.SKUID); skuID != "" {
			return skuID
		}
	}
	return l.defaultSKUID
}

func (l *logic) resolveCreateCandidatePools(ctx pctx.Context, instanceSpecID string) ([]string, error) {
	if _, err := l.templateCandidatesForSpec(instanceSpecID); err != nil {
		return nil, err
	}
	if l.sandboxAdapter == nil {
		return nil, errcode.Wrap(errcode.ErrSandboxServiceError, "sandbox adapter is unavailable")
	}

	livePoolEntities, err := l.sandboxAdapter.ListPools(ctx)
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrSandboxServiceError, "list pools: %v", err)
	}

	livePools := uniqueNonEmptyStringsPreserveOrder(listPoolIDs(
		livePoolEntities,
		l.templateClassForSpec(instanceSpecID),
		l.skuIDForSpec(instanceSpecID),
	))
	if len(livePools) == 0 {
		return nil, errcode.Wrap(errcode.ErrSandboxServiceError, "no active sandbox pools available")
	}
	return livePools, nil
}

func listPoolIDs(pools []psandbox.Pool, templateClassID, skuID string) []string {
	seen := make(map[string]struct{}, len(pools))
	ids := make([]string, 0, len(pools))
	templateClassID = strings.TrimSpace(templateClassID)
	skuID = strings.TrimSpace(skuID)
	for _, pool := range pools {
		if !poolEligibleForCreate(pool, templateClassID, skuID) {
			continue
		}
		poolID := strings.TrimSpace(pool.ID)
		if poolID == "" {
			continue
		}
		if _, ok := seen[poolID]; ok {
			continue
		}
		seen[poolID] = struct{}{}
		ids = append(ids, poolID)
	}
	return ids
}

func poolEligibleForCreate(pool psandbox.Pool, templateClassID, skuID string) bool {
	if status := strings.TrimSpace(pool.Status); status != "" && status != "active" {
		return false
	}
	switch strings.TrimSpace(pool.CapacityState) {
	case "", "active":
	default:
		return false
	}
	if templateClassID != "" {
		poolTemplateClassID := strings.TrimSpace(pool.TemplateClassID)
		if poolTemplateClassID != "" && poolTemplateClassID != templateClassID {
			return false
		}
	}
	if skuID != "" {
		poolSKUID := strings.TrimSpace(pool.SKUID)
		if poolSKUID != "" && poolSKUID != skuID {
			return false
		}
	}
	return true
}

func (l *logic) createSandboxWithFallback(ctx pctx.Context, instanceID string, instanceSpecID string, ordered orderedCandidatePools, timeout int32) (*psandbox.Sandbox, error) {
	candidateTemplates := ordered.Pools
	if ordered.AttemptLimit > 0 && ordered.AttemptLimit < len(candidateTemplates) {
		candidateTemplates = candidateTemplates[:ordered.AttemptLimit]
	}
	if len(candidateTemplates) == 0 {
		return nil, errcode.Wrap(errcode.ErrSandboxServiceError, "no candidate templates configured")
	}

	templateClassID := l.templateClassForSpec(instanceSpecID)
	// 设计稿 §13.2 R1f 对偶项：sku 解析全权由 skuIDForSpec 处理 — spec 命中显式 sku_id
	// 时返 spec 级值（多规格隔离），未命中或为空时 fallback 到全局 defaultSKUID（兼容
	// 期 / 单 sku 部署）。函数返回值已是最终生效 sku，无需额外兜底。
	effectiveSKUID := l.skuIDForSpec(instanceSpecID)

	var failures []string
	for _, templateID := range candidateTemplates {
		resp, err := l.sandboxAdapter.CreateSandbox(ctx, &psandbox.CreateSandboxRequest{
			TemplateClassID: templateClassID,
			TemplateID:      templateID,
			SKUID:           effectiveSKUID,
			Timeout:         &timeout,
			Metadata: map[string]string{
				"user_id":     ctx.GetUserID(),
				"instance_id": instanceID,
			},
		})
		if err == nil {
			return resp, nil
		}

		failures = append(failures, fmt.Sprintf("%s: %v", templateID, err))
		if !shouldFallbackToNextTemplate(ctx, err) {
			return nil, errcode.Wrap(errcode.ErrSandboxServiceError, "create sandbox with template %s: %v (attempts: %s)", templateID, err, strings.Join(failures, "; "))
		}
		l.logger.Warn("create sandbox failed, trying next template",
			zap.String("instance_id", instanceID),
			zap.String("template_id", templateID),
			zap.Error(err),
		)
	}

	return nil, errcode.Wrap(errcode.ErrSandboxServiceError, "all candidate templates failed: %s", strings.Join(failures, "; "))
}

func shouldFallbackToNextTemplate(ctx pctx.Context, err error) bool {
	if err == nil {
		return false
	}
	if ctx != nil && ctx.Err() != nil {
		return false
	}
	if errors.Is(err, stdctx.Canceled) || errors.Is(err, stdctx.DeadlineExceeded) {
		return false
	}

	var bizErr *errcode.Error
	if errors.As(err, &bizErr) {
		switch bizErr.HTTPStatus {
		case 401, 403, 408, 429:
			return false
		}
	}
	return true
}

func (l *logic) GetInstance(ctx pctx.Context, instanceID string) (*transport.InstanceResponse, error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, errcode.ErrInstanceMissingUserID
	}
	if strings.TrimSpace(instanceID) == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}

	entity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	return toInstanceResponse(entity, true), nil
}

func (l *logic) StartTerminalSession(ctx pctx.Context, instanceID string) (*transport.TerminalSessionResponse, error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, errcode.ErrInstanceMissingUserID
	}
	if strings.TrimSpace(instanceID) == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}

	entity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(entity.SandboxId) == "" {
		return nil, errcode.ErrSandboxNotFound
	}

	session, err := l.sandboxAdapter.StartTerminalSession(ctx, entity.SandboxId)
	if err != nil {
		return nil, err
	}
	return &transport.TerminalSessionResponse{
		PoolID:         session.PoolID,
		SessionID:      session.SessionID,
		Region:         session.Region,
		InstanceID:     session.InstanceID,
		OwnerUin:       session.OwnerUin,
		LoginUin:       session.LoginUin,
		AppID:          session.AppID,
		WsURL:          session.WsURL,
		Cols:           session.Cols,
		Rows:           session.Rows,
		TimeoutSeconds: session.TimeoutSeconds,
		Username:       session.Username,
		WorkingDir:     session.WorkingDir,
	}, nil
}

func (l *logic) ListInstances(ctx pctx.Context, page, pageSize int) (*transport.ListInstancesResponse, error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, errcode.ErrInstanceMissingUserID
	}
	if page < 1 {
		page = 1
	}
	if pageSize == 0 {
		pageSize = 20
	}
	if pageSize < 1 || pageSize > 100 {
		return nil, errcode.ErrInstanceInvalidParam
	}

	entities, total, err := l.instanceDao.ListByUserID(ctx, ctx.GetUserID(), page, pageSize)
	if err != nil {
		return nil, fmt.Errorf("list instances: %w", err)
	}

	items := make([]*transport.InstanceResponse, 0, len(entities))
	for i := range entities {
		items = append(items, toInstanceResponse(&entities[i], false))
	}

	return &transport.ListInstancesResponse{
		Total:    total,
		Page:     page,
		PageSize: pageSize,
		Items:    items,
	}, nil
}

func (l *logic) DestroyInstance(ctx pctx.Context, instanceID string) (resp *transport.InstanceResponse, retErr error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, errcode.ErrInstanceMissingUserID
	}
	instanceID = strings.TrimSpace(instanceID)
	if instanceID == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}

	entity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	previousStatus := entity.Status
	releaseQuota := entity.Status != modelinstance.InstanceStatusFailed
	operationID := l.recordOperation(ctx, instanceID, operationhistory.OperationTypeDestroy)
	// 异步成功路径下 operation 维持 CREATED，最终由 worker 在成功/失败时回写终态。

	switch entity.Status {
	case modelinstance.InstanceStatusRunning, modelinstance.InstanceStatusPaused, modelinstance.InstanceStatusFailed:
		if err := l.instanceDao.TransitionStatus(
			ctx,
			entity.Id,
			[]string{modelinstance.InstanceStatusRunning, modelinstance.InstanceStatusPaused, modelinstance.InstanceStatusFailed},
			modelinstance.InstanceStatusDeleting,
		); err != nil {
			return nil, err
		}
	case modelinstance.InstanceStatusDeleting:
		l.logger.Warn("resuming instance deletion from deleting state",
			zap.String("instance_id", entity.InstanceId),
			zap.String("sandbox_id", entity.SandboxId),
		)
	default:
		l.completeOperation(ctx, operationID, errcode.ErrInstanceStatusInvalid)
		return nil, errcode.ErrInstanceStatusInvalid
	}

	if err := l.enqueueDestroyInstanceTask(ctx, entity, releaseQuota, operationID); err != nil {
		if previousStatus != modelinstance.InstanceStatusDeleting && !l.executeTasksInline {
			if revertErr := l.instanceDao.UpdateStatus(ctx, entity.Id, previousStatus); revertErr != nil {
				l.logger.Warn("revert deleting status failed",
					zap.Error(revertErr),
					zap.String("instance_id", entity.InstanceId),
				)
			} else {
				entity.Status = previousStatus
			}
		}
		l.completeOperation(ctx, operationID, err)
		if l.executeTasksInline {
			return nil, err
		}
		return nil, errcode.Wrap(errcode.ErrSandboxServiceError, "enqueue destroy task: %v", err)
	}
	destroyAccepted := previousStatus != modelinstance.InstanceStatusDeleting
	if l.executeTasksInline {
		entity.Status = modelinstance.InstanceStatusDeleted
	} else {
		entity.Status = modelinstance.InstanceStatusDeleting
	}
	if destroyAccepted {
		l.recordDestroyAcceptedEvent(ctx, entity.InstanceId)
	}

	return toInstanceResponse(entity, false), nil
}

func (l *logic) PauseInstance(ctx pctx.Context, instanceID string) (resp *transport.InstanceResponse, retErr error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, errcode.ErrInstanceMissingUserID
	}
	instanceID = strings.TrimSpace(instanceID)
	if instanceID == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}

	operationID := l.recordOperation(ctx, instanceID, operationhistory.OperationTypePause)
	defer func() { l.completeOperation(ctx, operationID, retErr) }()

	entity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	if entity.Status != modelinstance.InstanceStatusRunning {
		return nil, errcode.ErrInstanceStatusInvalid
	}

	if err := l.sandboxAdapter.PauseSandbox(ctx, entity.SandboxId); err != nil {
		if !isExpectedSandboxConflict(err, expectedPauseConflictMessages) {
			return nil, err
		}
		l.logger.Warn("sandbox already paused, treating as success",
			zap.String("instance_id", entity.InstanceId),
			zap.String("sandbox_id", entity.SandboxId),
			zap.Error(err),
		)
	}

	if err := l.instanceDao.TransitionStatus(
		ctx,
		entity.Id,
		[]string{modelinstance.InstanceStatusRunning},
		modelinstance.InstanceStatusPaused,
	); err != nil {
		l.logger.Error("persist paused state failed after sandbox pause",
			zap.Error(err),
			zap.String("instance_id", entity.InstanceId),
			zap.String("sandbox_id", entity.SandboxId),
		)
		return nil, err
	}
	entity.Status = modelinstance.InstanceStatusPaused
	return toInstanceResponse(entity, false), nil
}

func (l *logic) ResumeInstance(ctx pctx.Context, instanceID string, req *transport.ResumeInstanceRequest) (resp *transport.InstanceResponse, retErr error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, errcode.ErrInstanceMissingUserID
	}
	instanceID = strings.TrimSpace(instanceID)
	if instanceID == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}

	operationID := l.recordOperation(ctx, instanceID, operationhistory.OperationTypeResume)
	defer func() { l.completeOperation(ctx, operationID, retErr) }()
	if req == nil {
		req = &transport.ResumeInstanceRequest{}
	}
	timeout := transport.DefaultInstanceTimeoutSeconds
	if req.Timeout != nil {
		timeout = *req.Timeout
	}
	if !isValidInstanceTimeout(timeout) {
		return nil, errcode.ErrInstanceInvalidParam
	}

	entity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	if entity.Status != modelinstance.InstanceStatusPaused {
		return nil, errcode.ErrInstanceStatusInvalid
	}

	timeoutAt := time.Now().UTC().Add(time.Duration(timeout) * time.Second)
	sandboxReq := &psandbox.ResumeSandboxRequest{Timeout: &timeout}
	if err := l.resumeSandbox(ctx, entity, sandboxReq); err != nil {
		return nil, err
	}

	updates := map[string]interface{}{
		modelinstance.ColumnStatus:    modelinstance.InstanceStatusRunning,
		modelinstance.ColumnTimeoutAt: timeoutAt,
	}
	if err := l.instanceDao.UpdateWithStatusPrecondition(
		ctx,
		entity.Id,
		[]string{modelinstance.InstanceStatusPaused},
		updates,
	); err != nil {
		l.logger.Error("persist running state failed after sandbox resume",
			zap.Error(err),
			zap.String("instance_id", entity.InstanceId),
			zap.String("sandbox_id", entity.SandboxId),
		)
		return nil, err
	}
	entity.Status = modelinstance.InstanceStatusRunning
	entity.TimeoutAt = timeoutAt

	return toInstanceResponse(entity, true), nil
}

func (l *logic) SetInstanceTimeout(ctx pctx.Context, instanceID string, req *transport.SetTimeoutRequest) (resp *transport.InstanceResponse, retErr error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, errcode.ErrInstanceMissingUserID
	}
	instanceID = strings.TrimSpace(instanceID)
	if instanceID == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}

	operationID := l.recordOperation(ctx, instanceID, operationhistory.OperationTypeSetTimeout)
	defer func() { l.completeOperation(ctx, operationID, retErr) }()
	if req == nil || req.Timeout == nil || !isValidInstanceTimeout(*req.Timeout) {
		return nil, errcode.ErrInstanceInvalidParam
	}

	entity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	switch entity.Status {
	case modelinstance.InstanceStatusRunning, modelinstance.InstanceStatusPaused:
	default:
		return nil, errcode.ErrInstanceStatusInvalid
	}

	timeoutAt := time.Now().UTC().Add(time.Duration(*req.Timeout) * time.Second)
	if err := l.sandboxAdapter.SetTimeout(ctx, entity.SandboxId, *req.Timeout); err != nil {
		return nil, err
	}

	if err := l.instanceDao.UpdateWithStatusPrecondition(
		ctx,
		entity.Id,
		[]string{modelinstance.InstanceStatusRunning, modelinstance.InstanceStatusPaused},
		map[string]interface{}{modelinstance.ColumnTimeoutAt: timeoutAt},
	); err != nil {
		l.logger.Error("persist timeout failed after sandbox timeout update",
			zap.Error(err),
			zap.String("instance_id", entity.InstanceId),
			zap.String("sandbox_id", entity.SandboxId),
		)
		return nil, err
	}
	entity.TimeoutAt = timeoutAt

	return toInstanceResponse(entity, true), nil
}

func isSandboxNotFound(err error) bool {
	return errors.Is(err, errcode.ErrSandboxNotFound)
}

func isExpectedSandboxConflict(err error, expectedMessages []string) bool {
	if !errors.Is(err, errcode.ErrSandboxStatusConflict) {
		return false
	}
	if len(expectedMessages) == 0 {
		return true
	}
	message := strings.ToLower(err.Error())
	for _, expected := range expectedMessages {
		if strings.Contains(message, expected) {
			return true
		}
	}
	return false
}

func (l *logic) resumeSandbox(ctx pctx.Context, entity *modelinstance.Entity, req *psandbox.ResumeSandboxRequest) error {
	if _, err := l.sandboxAdapter.ResumeSandbox(ctx, entity.SandboxId, req); err != nil {
		if !isExpectedSandboxConflict(err, expectedResumeConflictMessages) {
			return err
		}
		l.logger.Warn("sandbox already running, treating as success",
			zap.String("instance_id", entity.InstanceId),
			zap.String("sandbox_id", entity.SandboxId),
			zap.Error(err),
		)
	}
	return nil
}

func isValidInstanceTimeout(timeout int32) bool {
	return timeout > 0 && timeout <= transport.MaxInstanceTimeoutSeconds
}

func (l *logic) finalizeInstanceDeletion(ctx pctx.Context, entity *modelinstance.Entity, releaseQuota bool) error {
	err := resource.GormDB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		updateResult := tx.Table(modelinstance.TableName).
			Where(modelinstance.ColumnID+" = ? AND "+modelinstance.ColumnUserID+" = ? AND "+modelinstance.ColumnStatus+" = ?",
				entity.Id, ctx.GetUserID(), modelinstance.InstanceStatusDeleting).
			Update(modelinstance.ColumnStatus, modelinstance.InstanceStatusDeleted)
		if updateResult.Error != nil {
			return fmt.Errorf("mark instance deleted: %w", updateResult.Error)
		}
		if updateResult.RowsAffected == 0 {
			return l.mapFinalizeDeleteConflict(tx, ctx, entity.Id)
		}

		if releaseQuota {
			freedResult := tx.Table(quota.TableName).
				Where(quota.ColumnUserID+" = ? AND "+quota.ColumnResourceName+" = ? AND "+quota.ColumnResourceKey+" = ? AND ("+
					quota.ColumnResourceQuotaAvailable+" + ?) <= "+quota.ColumnResourceQuotaTotal,
					ctx.GetUserID(), resourceNameOpenClawInstance, "", 1).
				Updates(map[string]interface{}{
					quota.ColumnResourceQuotaAvailable: gorm.Expr(quota.ColumnResourceQuotaAvailable+" + ?", 1),
				})
			if freedResult.Error != nil {
				return errcode.Wrap(errcode.ErrQuotaReleaseFailed, "free quota: %v", freedResult.Error)
			}
			if freedResult.RowsAffected == 0 {
				alreadyReleased, missingRow, quotaErr := l.isQuotaAlreadyReleased(tx, ctx.GetUserID(), resourceNameOpenClawInstance, "")
				if quotaErr != nil {
					return errcode.Wrap(errcode.ErrQuotaReleaseFailed, "inspect quota release conflict: %v", quotaErr)
				}
				switch {
				case alreadyReleased:
					l.logger.Warn("quota already released during instance deletion, treating as success",
						zap.String("instance_id", entity.InstanceId),
						zap.String("user_id", ctx.GetUserID()),
					)
				case missingRow:
					l.logger.Warn("quota row missing during instance deletion, treating as success",
						zap.String("instance_id", entity.InstanceId),
						zap.String("user_id", ctx.GetUserID()),
					)
				default:
					return errcode.Wrap(errcode.ErrQuotaReleaseFailed, "free quota affected no rows")
				}
			}
		}

		deleteResult := tx.Table(modelinstance.TableName).
			Where(modelinstance.ColumnID+" = ? AND "+modelinstance.ColumnUserID+" = ?", entity.Id, ctx.GetUserID()).
			Delete(&modelinstance.Entity{})
		if deleteResult.Error != nil {
			return fmt.Errorf("soft delete instance: %w", deleteResult.Error)
		}
		if deleteResult.RowsAffected == 0 {
			return errcode.ErrInstanceNotFound
		}

		return nil
	})
	if err != nil {
		l.logger.Error("finalize instance deletion failed",
			zap.Error(err),
			zap.String("instance_id", entity.InstanceId),
			zap.String("sandbox_id", entity.SandboxId),
			zap.Bool("sandbox_deleted_needs_retry", true),
		)
	}
	return err
}

func (l *logic) mapFinalizeDeleteConflict(tx *gorm.DB, ctx pctx.Context, instanceDBID int64) error {
	var record modelinstance.Entity
	err := tx.Unscoped().
		Table(modelinstance.TableName).
		Where(modelinstance.ColumnID+" = ? AND "+modelinstance.ColumnUserID+" = ?", instanceDBID, ctx.GetUserID()).
		First(&record).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return fmt.Errorf("query instance during delete finalization: %w", err)
	}
	if record.Status == modelinstance.InstanceStatusDeleted || record.DeletedAt.Valid {
		return nil
	}
	return errcode.ErrInstanceStatusInvalid
}

func (l *logic) isQuotaAlreadyReleased(tx *gorm.DB, userID, resourceName, resourceKey string) (alreadyReleased bool, missingRow bool, err error) {
	var quotaRecord quota.Entity
	err = tx.Table(quota.TableName).
		Where(quota.ColumnUserID+" = ? AND "+quota.ColumnResourceName+" = ? AND "+quota.ColumnResourceKey+" = ?",
			userID, resourceName, resourceKey).
		Clauses(clause.Locking{Strength: "UPDATE"}).
		First(&quotaRecord).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, true, nil
		}
		return false, false, err
	}
	return quotaRecord.ResourceQuotaAvailable >= quotaRecord.ResourceQuotaTotal, false, nil
}

func (l *logic) rollbackQuota(ctx pctx.Context) {
	freed, err := l.quotaDao.FreeQuota(ctx.GetUserID(), resourceNameOpenClawInstance, "", 1)
	if err != nil {
		l.logger.Error("rollback quota failed",
			zap.Error(err),
			zap.String("user_id", ctx.GetUserID()),
		)
		return
	}
	if !freed {
		l.logger.Warn("rollback quota affected no rows",
			zap.String("user_id", ctx.GetUserID()),
		)
	}
}

func (l *logic) generateInstanceID() string {
	return l.objectIdLogic.GenerateInstanceId()
}

func (l *logic) generateTaskID() string {
	return l.objectIdLogic.GenerateTaskId()
}

func pendingSandboxID(instanceID string) string {
	return "pending-" + instanceID
}

func normalizeInstanceDisplayName(value string) string {
	return strings.TrimSpace(value)
}

func validateInstanceDisplayName(value string) (string, error) {
	displayName := normalizeInstanceDisplayName(value)
	if displayName == "" {
		return "", errcode.ErrInstanceInvalidParam
	}
	if utf8.RuneCountInString(displayName) > maxInstanceDisplayNameRunes {
		return "", errcode.ErrInstanceInvalidParam
	}
	return displayName, nil
}

func validateOptionalInstanceDisplayName(value string) (string, error) {
	displayName := normalizeInstanceDisplayName(value)
	if displayName == "" {
		return "", nil
	}
	if utf8.RuneCountInString(displayName) > maxInstanceDisplayNameRunes {
		return "", errcode.ErrInstanceInvalidParam
	}
	return displayName, nil
}

func firstTemplateOrUnknown(templateIDs []string) string {
	for _, templateID := range templateIDs {
		templateID = strings.TrimSpace(templateID)
		if templateID != "" {
			return templateID
		}
	}
	return "unknown"
}

func toInstanceResponse(entity *modelinstance.Entity, includeTimeout bool) *transport.InstanceResponse {
	sandboxID := entity.SandboxId
	if isPendingSandboxID(sandboxID) {
		sandboxID = ""
	}
	resp := &transport.InstanceResponse{
		InstanceID: entity.InstanceId,
		Name:       entity.DisplayName,
		SandboxID:  sandboxID,
		Status:     entity.Status,
		CreatedAt:  entity.CreatedAt,
	}
	if includeTimeout {
		timeoutAt := entity.TimeoutAt
		resp.TimeoutAt = &timeoutAt
	}
	return resp
}

// ListOperations 查询实例的操作历史记录
func (l *logic) ListOperations(ctx pctx.Context, instanceID string, page, pageSize int) (*transport.ListOperationsResponse, error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, errcode.ErrInstanceMissingUserID
	}
	instanceID = strings.TrimSpace(instanceID)
	if instanceID == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}

	// 验证实例存在且属于当前用户
	if _, err := l.instanceDao.GetByInstanceID(ctx, instanceID); err != nil {
		return nil, err
	}

	if page < 1 {
		page = 1
	}
	if pageSize == 0 {
		pageSize = 20
	}
	if pageSize < 1 || pageSize > 100 {
		return nil, errcode.ErrInstanceInvalidParam
	}

	entities, total, err := l.operationHistoryDao.ListByInstanceID(ctx, instanceID, ctx.GetUserID(), page, pageSize)
	if err != nil {
		return nil, fmt.Errorf("list operations: %w", err)
	}

	items := make([]*transport.OperationResponse, 0, len(entities))
	for i := range entities {
		items = append(items, &transport.OperationResponse{
			OperationID:   entities[i].OperationId,
			OperationType: entities[i].OperationType,
			InstanceID:    entities[i].InstanceId,
			Status:        entities[i].Status,
			ErrorMessage:  entities[i].ErrorMessage,
			CreatedAt:     entities[i].CreatedAt,
			UpdatedAt:     entities[i].UpdatedAt,
		})
	}

	return &transport.ListOperationsResponse{
		Total:    total,
		Page:     page,
		PageSize: pageSize,
		Items:    items,
	}, nil
}

// GetInstanceLogs 查询实例的沙箱日志
func (l *logic) GetInstanceLogs(ctx pctx.Context, instanceID string, start *int64, limit *int32) (*psandbox.SandboxLogs, error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, errcode.ErrInstanceMissingUserID
	}
	instanceID = strings.TrimSpace(instanceID)
	if instanceID == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}

	entity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}

	// 只有 Running 和 Paused 状态的实例才有可用的沙箱日志
	switch entity.Status {
	case modelinstance.InstanceStatusRunning, modelinstance.InstanceStatusPaused:
		// ok
	default:
		return nil, errcode.ErrInstanceStatusInvalid
	}

	return l.sandboxAdapter.GetLogs(ctx, entity.SandboxId, &psandbox.GetLogsRequest{
		Start: start,
		Limit: limit,
	})
}

// recordOperation 记录操作开始，返回 operationID（辅助功能，失败仅 warn 日志）
func (l *logic) recordOperation(ctx pctx.Context, instanceID, operationType string) string {
	if l.operationHistoryDao == nil {
		return ""
	}
	operationID := l.objectIdLogic.GenerateOperationId()
	entity := &operationhistory.Entity{
		OperationId:   operationID,
		OperationType: operationType,
		InstanceId:    instanceID,
		UserId:        ctx.GetUserID(),
		Status:        operationhistory.StatusCreated,
	}
	if err := l.operationHistoryDao.Create(ctx, entity); err != nil {
		l.logger.Warn("record operation start failed",
			zap.Error(err),
			zap.String("operation_id", operationID),
			zap.String("instance_id", instanceID),
		)
	}
	return operationID
}

// completeOperation 更新操作结果（辅助功能，失败仅 warn 日志）
func (l *logic) completeOperation(ctx pctx.Context, operationID string, err error) {
	if operationID == "" || l.operationHistoryDao == nil {
		return
	}
	status := operationhistory.StatusSuccess
	var errMsg string
	if err != nil {
		status = operationhistory.StatusFailed
		// 只记录业务错误码和简要描述，避免泄露内部细节
		var bizErr *errcode.Error
		if errors.As(err, &bizErr) {
			errMsg = bizErr.Code + ": " + bizErr.Message
		} else {
			errMsg = "internal error"
		}
		// 截断到合理长度
		if len(errMsg) > 2048 {
			errMsg = errMsg[:2048]
		}
	}
	if updateErr := l.operationHistoryDao.UpdateStatus(ctx, operationID, status, errMsg); updateErr != nil {
		l.logger.Warn("record operation result failed",
			zap.Error(updateErr),
			zap.String("operation_id", operationID),
		)
	}
}

type debugCommandSpec struct {
	bash       string
	timeoutSec int
}

func debugCommandSpecFor(commandType string) (debugCommandSpec, bool) {
	switch strings.TrimSpace(commandType) {
	case "openclaw_version":
		return debugCommandSpec{
			bash:       `openclaw --version`,
			timeoutSec: debugExecTimeoutSec,
		}, true
	case "openclaw_config":
		return debugCommandSpec{
			bash: strings.Join([]string{
				`OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"`,
				`if [ ! -s "$OPENCLAW_CONFIG_PATH" ]; then echo "openclaw config not found: $OPENCLAW_CONFIG_PATH" >&2; exit 1; fi`,
				`sed -n '1,240p' "$OPENCLAW_CONFIG_PATH"`,
			}, "\n"),
			timeoutSec: debugExecTimeoutSec,
		}, true
	case "openclaw_soul":
		return debugCommandSpec{
			bash: strings.Join([]string{
				`OPENCLAW_SOUL_PATH="${OPENCLAW_SOUL_PATH:-$HOME/.openclaw/workspace/SOUL.md}"`,
				`if [ ! -s "$OPENCLAW_SOUL_PATH" ]; then echo "openclaw soul not found: $OPENCLAW_SOUL_PATH" >&2; exit 1; fi`,
				`sed -n '1,240p' "$OPENCLAW_SOUL_PATH"`,
			}, "\n"),
			timeoutSec: debugExecTimeoutSec,
		}, true
	case "openclaw_channels_status":
		return debugCommandSpec{
			bash: strings.Join([]string{
				`openclaw channels list || true`,
				`echo ---`,
				`openclaw channels status --probe`,
			}, "\n"),
			timeoutSec: 60,
		}, true
	case "openclaw_logs_recent":
		return debugCommandSpec{
			bash: strings.Join([]string{
				`openclaw logs --limit 200 --local-time`,
			}, "\n"),
			timeoutSec: 60,
		}, true
	case "openclaw_sessions_recent":
		return debugCommandSpec{
			bash: strings.Join([]string{
				`SESS_DIR="${HOME}/.openclaw/agents/main/sessions"`,
				`if [ ! -d "$SESS_DIR" ]; then echo "openclaw sessions dir not found: $SESS_DIR" >&2; exit 1; fi`,
				`echo "sessions_dir=$SESS_DIR"`,
				`echo "===files==="`,
				`ls -lt "$SESS_DIR" || true`,
				`echo "===sessions.json==="`,
				`if [ -f "$SESS_DIR/sessions.json" ]; then sed -n '1,240p' "$SESS_DIR/sessions.json"; else echo "sessions.json missing"; fi`,
				`echo "===latest_transcripts==="`,
				`find "$SESS_DIR" -maxdepth 1 -type f -name '*.jsonl' -printf '%T@ %p\n' | sort -nr | head -2 | cut -d' ' -f2- | while IFS= read -r transcript; do`,
				`  [ -n "$transcript" ] || continue`,
				`  echo "--- $transcript ---"`,
				`  tail -n 120 "$transcript" || true`,
				`done`,
			}, "\n"),
			timeoutSec: 60,
		}, true
	case "openclaw_qqbot_logs":
		return debugCommandSpec{
			bash: strings.Join([]string{
				`openclaw channels logs --channel qqbot || true`,
				`echo ---`,
				`openclaw logs --limit 120 --local-time || true`,
			}, "\n"),
			timeoutSec: 60,
		}, true
	case "openclaw_doctor":
		return debugCommandSpec{
			bash:       `openclaw doctor`,
			timeoutSec: 90,
		}, true
	case "openclaw_gateway_status":
		port := 18789
		if cfg := config.ServerConf.AdapterConfig; cfg != nil && cfg.AiGateway != nil && cfg.AiGateway.DefaultGatewayPort > 0 {
			port = cfg.AiGateway.DefaultGatewayPort
		}
		return debugCommandSpec{
			bash: strings.Join([]string{
				fmt.Sprintf(`echo "gateway_port=%d"`, port),
				`echo "===ps==="`,
				`ps -ef | grep -E 'openclaw-gateway|openclaw gateway' | grep -v grep || true`,
				`echo "===listen==="`,
				fmt.Sprintf(`ss -tlnp 2>/dev/null | grep ':%d ' || true`, port),
				`echo "===systemd==="`,
				`systemctl is-active openclaw-gateway 2>/dev/null || true`,
				`systemctl is-enabled openclaw-gateway 2>/dev/null || true`,
			}, "\n"),
			timeoutSec: debugExecTimeoutSec,
		}, true
	case "openclaw_agent_smoke":
		port := 18789
		if cfg := config.ServerConf.AdapterConfig; cfg != nil && cfg.AiGateway != nil && cfg.AiGateway.DefaultGatewayPort > 0 {
			port = cfg.AiGateway.DefaultGatewayPort
		}
		startGateway := openclawShellCommand(fmt.Sprintf("gateway run --bind loopback --port %d --force", port))
		runAgent := openclawShellCommand(fmt.Sprintf(
			"agent --local --agent main --message %s --thinking low",
			shellQuoteArg("Reply with only the word OK"),
		))
		return debugCommandSpec{
			bash: strings.Join([]string{
				fmt.Sprintf(`ss -tlnp 2>/dev/null | grep ':%d ' | grep -oP 'pid=\K[0-9]+' | head -1 | xargs -r kill -9 2>/dev/null || true`, port),
				`rm -f /tmp/openclaw-debug-gateway.log`,
				`nohup /bin/bash -lc ` + shellQuoteArg(startGateway) + ` >/tmp/openclaw-debug-gateway.log 2>&1 </dev/null &`,
				fmt.Sprintf(`for i in $(seq 1 20); do sleep 1; if ss -tln 2>/dev/null | grep -q ':%d '; then break; fi; done`, port),
				fmt.Sprintf(`if ! ss -tln 2>/dev/null | grep -q ':%d '; then echo "openclaw gateway did not start" >&2; tail -n 80 /tmp/openclaw-debug-gateway.log 2>/dev/null || true; exit 1; fi`, port),
				`timeout 45 /bin/bash -lc ` + shellQuoteArg(runAgent),
			}, "\n"),
			timeoutSec: 90,
		}, true
	case "openclaw_agent_ip_smoke":
		port := 18789
		if cfg := config.ServerConf.AdapterConfig; cfg != nil && cfg.AiGateway != nil && cfg.AiGateway.DefaultGatewayPort > 0 {
			port = cfg.AiGateway.DefaultGatewayPort
		}
		startGateway := openclawShellCommand(fmt.Sprintf("gateway run --bind loopback --port %d --force", port))
		runAgent := openclawShellCommand(fmt.Sprintf(
			"agent --local --agent main --message %s --thinking low",
			shellQuoteArg("Use tools if needed, then reply with only the server IP address."),
		))
		return debugCommandSpec{
			bash: strings.Join([]string{
				fmt.Sprintf(`ss -tlnp 2>/dev/null | grep ':%d ' | grep -oP 'pid=\K[0-9]+' | head -1 | xargs -r kill -9 2>/dev/null || true`, port),
				`rm -f /tmp/openclaw-debug-gateway.log`,
				`nohup /bin/bash -lc ` + shellQuoteArg(startGateway) + ` >/tmp/openclaw-debug-gateway.log 2>&1 </dev/null &`,
				fmt.Sprintf(`for i in $(seq 1 20); do sleep 1; if ss -tln 2>/dev/null | grep -q ':%d '; then break; fi; done`, port),
				fmt.Sprintf(`if ! ss -tln 2>/dev/null | grep -q ':%d '; then echo "openclaw gateway did not start" >&2; tail -n 80 /tmp/openclaw-debug-gateway.log 2>/dev/null || true; exit 1; fi`, port),
				`timeout 60 /bin/bash -lc ` + shellQuoteArg(runAgent),
			}, "\n"),
			timeoutSec: 120,
		}, true
	case "openclaw_agent_file_smoke":
		port := 18789
		if cfg := config.ServerConf.AdapterConfig; cfg != nil && cfg.AiGateway != nil && cfg.AiGateway.DefaultGatewayPort > 0 {
			port = cfg.AiGateway.DefaultGatewayPort
		}
		startGateway := openclawShellCommand(fmt.Sprintf("gateway run --bind loopback --port %d --force", port))
		runAgent := openclawShellCommand(fmt.Sprintf(
			"agent --local --agent main --message %s --thinking low",
			shellQuoteArg("Use tools if needed, read /etc/lightclaw/image-version, then reply with only that file content."),
		))
		return debugCommandSpec{
			bash: strings.Join([]string{
				fmt.Sprintf(`ss -tlnp 2>/dev/null | grep ':%d ' | grep -oP 'pid=\K[0-9]+' | head -1 | xargs -r kill -9 2>/dev/null || true`, port),
				`rm -f /tmp/openclaw-debug-gateway.log`,
				`nohup /bin/bash -lc ` + shellQuoteArg(startGateway) + ` >/tmp/openclaw-debug-gateway.log 2>&1 </dev/null &`,
				fmt.Sprintf(`for i in $(seq 1 20); do sleep 1; if ss -tln 2>/dev/null | grep -q ':%d '; then break; fi; done`, port),
				fmt.Sprintf(`if ! ss -tln 2>/dev/null | grep -q ':%d '; then echo "openclaw gateway did not start" >&2; tail -n 80 /tmp/openclaw-debug-gateway.log 2>/dev/null || true; exit 1; fi`, port),
				`timeout 60 /bin/bash -lc ` + shellQuoteArg(runAgent),
			}, "\n"),
			timeoutSec: 120,
		}, true
	default:
		return debugCommandSpec{}, false
	}
}

func resolveDebugCommandSpec(command string) (debugCommandSpec, string, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return debugCommandSpec{}, "", errcode.ErrDebugInvalidCommand
	}
	if spec, ok := debugCommandSpecFor(command); ok {
		return spec, "debug_" + command, nil
	}
	return debugCommandSpec{
		bash:       command,
		timeoutSec: 120,
	}, "debug_raw", nil
}

const debugExecTimeoutSec = 30

type debugExecError struct {
	cause  error
	detail *transport.ExecDebugCommandResponse
}

var allowedDebugRunAsUsers = map[string]struct{}{
	"agentuser": {},
}

func normalizeDebugRunAsUser(raw string) (string, error) {
	user := strings.TrimSpace(raw)
	if user == "" {
		return "", nil
	}
	if _, ok := allowedDebugRunAsUsers[user]; !ok {
		return "", errcode.Wrap(errcode.ErrDebugInvalidRunAs, "run_as_user %q is not allowed", user)
	}
	return user, nil
}

func (l *logic) prepareDebugCommand(ctx pctx.Context, instanceID string, commandType string, runAsUser string) (*modelinstance.Entity, string, string, string, map[string]string, int, error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, "", "", "", nil, 0, errcode.ErrInstanceMissingUserID
	}
	instanceID = strings.TrimSpace(instanceID)
	commandType = strings.TrimSpace(commandType)
	if instanceID == "" || commandType == "" {
		return nil, "", "", "", nil, 0, errcode.ErrInstanceInvalidParam
	}
	normalizedRunAsUser, err := normalizeDebugRunAsUser(runAsUser)
	if err != nil {
		return nil, "", "", "", nil, 0, err
	}

	spec, commandKind, err := resolveDebugCommandSpec(commandType)
	if err != nil {
		return nil, "", "", "", nil, 0, err
	}
	command := spec.bash
	var processEnv map[string]string
	if normalizedRunAsUser != "" {
		command = shellUserCommand(normalizedRunAsUser, command)
		processEnv = shellUserEnv(normalizedRunAsUser)
	}

	entity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, "", "", "", nil, 0, err
	}
	if entity.Status != modelinstance.InstanceStatusRunning {
		return nil, "", "", "", nil, 0, errcode.Wrap(errcode.ErrDebugNotSupported, "instance status is %s, expected running", entity.Status)
	}
	return entity, commandKind, command, normalizedRunAsUser, processEnv, spec.timeoutSec, nil
}

func (e *debugExecError) Error() string {
	return e.cause.Error()
}

func (e *debugExecError) Unwrap() error {
	return e.cause
}

func (e *debugExecError) ErrorDetail() any {
	return e.detail
}

func buildExecDebugCommandResponse(result *psandbox.ExecCommandResult, runAsUser string) *transport.ExecDebugCommandResponse {
	if result == nil {
		return &transport.ExecDebugCommandResponse{
			Status:    "FAILED",
			RunAsUser: runAsUser,
			Detail:    "empty command result",
		}
	}

	resp := &transport.ExecDebugCommandResponse{
		RunAsUser:    runAsUser,
		Status:       result.Status,
		ExitCode:     result.ExitCode,
		Output:       result.Output,
		Stdout:       result.Stdout,
		Stderr:       result.Stderr,
		CommandID:    result.CommandID,
		InvocationID: result.InvocationID,
		StartTime:    result.StartTime,
		EndTime:      result.EndTime,
	}
	if !sandboxCommandSucceeded(result) {
		resp.Detail = sandboxCommandFailureDetail(result)
	}
	return resp
}

func newDebugExecError(cause error, result *psandbox.ExecCommandResult, runAsUser string) error {
	if cause == nil {
		return nil
	}
	return &debugExecError{
		cause:  cause,
		detail: buildExecDebugCommandResponse(result, runAsUser),
	}
}

// ExecDebugCommand executes either a built-in debug alias or a raw bash command on the instance's sandbox via envd process stream.
func (l *logic) ExecDebugCommand(ctx pctx.Context, instanceID string, commandType string, runAsUser string) (*transport.ExecDebugCommandResponse, error) {
	entity, commandKind, command, normalizedRunAsUser, processEnv, timeoutSec, err := l.prepareDebugCommand(ctx, instanceID, commandType, runAsUser)
	if err != nil {
		return nil, err
	}

	result, err := l.execSandboxProcessCommand(ctx, entity.SandboxId, commandKind, &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", command},
		Env:  processEnv,
		Pty:  false,
	}, timeoutSec)
	if err != nil {
		if errors.Is(err, errcode.ErrSandboxTimeout) {
			return nil, newDebugExecError(errcode.ErrDebugExecTimeout, result, normalizedRunAsUser)
		}
		return nil, newDebugExecError(errcode.Wrap(errcode.ErrDebugExecFailed, "%v", err), result, normalizedRunAsUser)
	}
	if !sandboxCommandSucceeded(result) {
		return nil, newDebugExecError(errcode.Wrap(errcode.ErrDebugExecFailed, "%s", sandboxCommandFailureDetail(result)), result, normalizedRunAsUser)
	}

	return buildExecDebugCommandResponse(result, normalizedRunAsUser), nil
}

// StreamDebugCommand executes a debug command via envd process stream and relays
// stdout/stderr chunks through the provided callback. It keeps synchronous JSON
// semantics unchanged by existing ExecDebugCommand while enabling SSE clients.
func (l *logic) StreamDebugCommand(ctx pctx.Context, instanceID string, commandType string, runAsUser string, onEvent func(transport.ExecDebugCommandStreamEvent) error) error {
	entity, _, command, normalizedRunAsUser, processEnv, timeoutSec, err := l.prepareDebugCommand(ctx, instanceID, commandType, runAsUser)
	if err != nil {
		return err
	}

	runCtx, cancel := stdctx.WithTimeout(ctx, time.Duration(timeoutSec)*time.Second)
	defer cancel()

	startedAt := time.Now().UTC()
	result := &psandbox.ExecCommandResult{
		Status:    "RUNNING",
		StartTime: startedAt.Format(time.RFC3339),
	}
	var stdoutBuf strings.Builder
	var stderrBuf strings.Builder
	started := false
	ended := false

	err = l.sandboxAdapter.StartProcessStream(runCtx, entity.SandboxId, &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", command},
		Env:  processEnv,
		Pty:  false,
	}, func(ev psandbox.ProcessStreamEvent) error {
		if ev.PID != 0 && !started {
			started = true
			pidRef := fmt.Sprintf("pid:%d", ev.PID)
			result.InvocationID = pidRef
			result.CommandID = pidRef
			if onEvent != nil {
				if err := onEvent(transport.ExecDebugCommandStreamEvent{
					Type:         "started",
					InvocationID: pidRef,
					CommandID:    pidRef,
					RunAsUser:    normalizedRunAsUser,
				}); err != nil {
					return err
				}
			}
		}
		if ev.Stdout != "" {
			appendBounded(&stdoutBuf, ev.Stdout, debugProcessOutputMaxBytes)
			if onEvent != nil {
				if err := onEvent(transport.ExecDebugCommandStreamEvent{
					Type:         "stdout",
					Stream:       "stdout",
					Chunk:        ev.Stdout,
					InvocationID: result.InvocationID,
					CommandID:    result.CommandID,
					RunAsUser:    normalizedRunAsUser,
				}); err != nil {
					return err
				}
			}
		}
		if ev.Stderr != "" {
			appendBounded(&stderrBuf, ev.Stderr, debugProcessOutputMaxBytes)
			if onEvent != nil {
				if err := onEvent(transport.ExecDebugCommandStreamEvent{
					Type:         "stderr",
					Stream:       "stderr",
					Chunk:        ev.Stderr,
					InvocationID: result.InvocationID,
					CommandID:    result.CommandID,
					RunAsUser:    normalizedRunAsUser,
				}); err != nil {
					return err
				}
			}
		}
		if !ev.Ended {
			return nil
		}

		ended = true
		result.ExitCode = int64(ev.ExitCode)
		result.EndTime = time.Now().UTC().Format(time.RFC3339)
		result.Stdout = stdoutBuf.String()
		result.Stderr = stderrBuf.String()
		result.Output = result.Stdout + result.Stderr
		result.ErrorInfo = strings.TrimSpace(ev.Error)
		result.Status = normalizeProcessExitStatus(ev.Status, ev.ExitCode)
		if onEvent != nil {
			return onEvent(transport.ExecDebugCommandStreamEvent{
				Type:         "finished",
				InvocationID: result.InvocationID,
				CommandID:    result.CommandID,
				RunAsUser:    normalizedRunAsUser,
				Response:     buildExecDebugCommandResponse(result, normalizedRunAsUser),
			})
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, stdctx.DeadlineExceeded) || errors.Is(runCtx.Err(), stdctx.DeadlineExceeded) {
			result.Status = "TIMEOUT"
		} else {
			result.Status = "FAILED"
			result.ErrorInfo = err.Error()
		}
		result.EndTime = time.Now().UTC().Format(time.RFC3339)
		result.Stdout = stdoutBuf.String()
		result.Stderr = stderrBuf.String()
		result.Output = result.Stdout + result.Stderr
		if onEvent != nil {
			_ = onEvent(transport.ExecDebugCommandStreamEvent{
				Type:         "finished",
				InvocationID: result.InvocationID,
				CommandID:    result.CommandID,
				RunAsUser:    normalizedRunAsUser,
				Response:     buildExecDebugCommandResponse(result, normalizedRunAsUser),
			})
			return nil
		}
		return err
	}
	if !ended && onEvent != nil {
		result.Status = "FAILED"
		result.EndTime = time.Now().UTC().Format(time.RFC3339)
		result.Stdout = stdoutBuf.String()
		result.Stderr = stderrBuf.String()
		result.Output = result.Stdout + result.Stderr
		result.ErrorInfo = "process stream ended without exit event"
		return onEvent(transport.ExecDebugCommandStreamEvent{
			Type:         "finished",
			InvocationID: result.InvocationID,
			CommandID:    result.CommandID,
			RunAsUser:    normalizedRunAsUser,
			Response:     buildExecDebugCommandResponse(result, normalizedRunAsUser),
		})
	}
	return nil
}

const channelConfigExecTimeoutSec = 60

// ConfigureChannel 在实例的 sandbox 中配置指定通道（添加通道 + 重启 gateway）
func (l *logic) ConfigureChannel(ctx pctx.Context, instanceID string, req *transport.ConfigureChannelRequest) (*transport.ConfigureChannelResponse, error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, errcode.ErrInstanceMissingUserID
	}
	instanceID = strings.TrimSpace(instanceID)
	if instanceID == "" {
		return nil, errcode.ErrChannelInvalidParam
	}
	if req == nil || strings.TrimSpace(req.Channel) == "" || strings.TrimSpace(req.Token) == "" {
		return nil, errcode.ErrChannelInvalidParam
	}

	entity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	if entity.Status != modelinstance.InstanceStatusRunning {
		return nil, errcode.ErrInstanceStatusInvalid
	}

	if strings.EqualFold(strings.TrimSpace(req.Channel), "qqbot") {
		pluginResult, pluginErr := l.execSandboxProcessCommand(ctx, entity.SandboxId, "configure_channel_plugin_qqbot", &psandbox.ProcessStartRequest{
			Cmd:  "/bin/bash",
			Args: []string{"-l", "-c", openclawEnsureQQBotPluginCommand()},
			Pty:  false,
		}, channelConfigExecTimeoutSec)
		if pluginErr != nil {
			return nil, errcode.Wrap(errcode.ErrChannelConfigFailed, "ensure qqbot plugin: %v", pluginErr)
		}
		if !sandboxCommandSucceeded(pluginResult) {
			return &transport.ConfigureChannelResponse{
				Status:           "Failed",
				Channel:          req.Channel,
				GatewayRestarted: false,
				Output:           pluginResult.Output,
			}, errcode.Wrap(errcode.ErrChannelConfigFailed, "ensure qqbot plugin %s", sandboxCommandFailureDetail(pluginResult))
		}
	}

	// 构造 openclaw channels add 命令
	addArgs := fmt.Sprintf("channels add --channel %s --token %s", shellQuoteArg(req.Channel), shellQuoteArg(req.Token))
	if account := strings.TrimSpace(req.Account); account != "" {
		addArgs = fmt.Sprintf(
			"channels add --channel %s --account %s --token %s",
			shellQuoteArg(req.Channel),
			shellQuoteArg(account),
			shellQuoteArg(req.Token),
		)
	}
	addCmd := openclawShellCommand(addArgs)

	addResult, err := l.execSandboxProcessCommand(ctx, entity.SandboxId, "configure_channel_add", &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", addCmd},
		Pty:  false,
	}, channelConfigExecTimeoutSec)
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrChannelConfigFailed, "channels add: %v", err)
	}
	if !sandboxCommandSucceeded(addResult) {
		return &transport.ConfigureChannelResponse{
			Status:           "Failed",
			Channel:          req.Channel,
			GatewayRestarted: false,
			Output:           addResult.Output,
		}, errcode.Wrap(errcode.ErrChannelConfigFailed, "channels add %s", sandboxCommandFailureDetail(addResult))
	}

	// 重启 gateway
	restartCmd := openclawGatewayRestartCommand()
	restartResult, err := l.execSandboxProcessCommand(ctx, entity.SandboxId, "configure_channel_restart", &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", restartCmd},
		Pty:  false,
	}, channelConfigExecTimeoutSec)
	gatewayRestarted := err == nil && sandboxCommandSucceeded(restartResult)

	output := addResult.Output
	if restartResult != nil && restartResult.Output != "" {
		output = output + "\n" + restartResult.Output
	}

	if !gatewayRestarted {
		l.logger.Warn("gateway restart failed after channel config",
			zap.String("instance_id", entity.InstanceId),
			zap.String("channel", req.Channel),
			zap.Error(err),
		)
		if err == nil {
			err = errcode.Wrap(errcode.ErrChannelConfigFailed, "gateway restart %s", sandboxCommandFailureDetail(restartResult))
		} else {
			err = errcode.Wrap(errcode.ErrChannelConfigFailed, "gateway restart: %v", err)
		}
		return &transport.ConfigureChannelResponse{
			Status:           "Failed",
			Channel:          req.Channel,
			GatewayRestarted: false,
			Output:           strings.TrimSpace(output),
		}, err
	}

	return &transport.ConfigureChannelResponse{
		Status:           "Succeeded",
		Channel:          req.Channel,
		GatewayRestarted: gatewayRestarted,
		Output:           strings.TrimSpace(output),
	}, nil
}
