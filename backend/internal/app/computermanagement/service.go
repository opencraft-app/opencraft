// Package computermanagement 实现 Computer 创建、查询和受限 TAT 操作。
package computermanagement

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/url"
	"strings"
	"time"

	"chatserver/internal/apperror"
	clockport "chatserver/internal/ports/clock"
	computerport "chatserver/internal/ports/computer"
	idport "chatserver/internal/ports/id"
	tencenttatport "chatserver/internal/ports/tencenttat"

	"github.com/google/uuid"
)

const (
	DefaultManagedTATRegion = "ap-beijing"
	DefaultHostLeaseTTL     = 90 * time.Second
)

// Config 定义由平台掌控、客户端不可覆盖的 Computer 策略。
type Config struct {
	ManagedTATRegion string
	HostLeaseTTL     time.Duration
}

// CreateCommand 是当前 Human 绑定 Computer 的输入。
type CreateCommand struct {
	AccountID       string
	ServerID        string
	IdempotencyKey  string
	Name            string
	TATRegion       string
	TATInstanceID   *string
	TATInstanceKind string
	OSType          string
}

// RefreshCommand 是当前 Human 发起的 Computer 状态刷新。
type RefreshCommand struct {
	AccountID      string
	ServerID       string
	ComputerID     string
	IdempotencyKey string
}

// ReleaseCommand 解除 Computer 的平台映射，不操作真实实例。
type ReleaseCommand struct {
	AccountID      string
	ServerID       string
	ComputerID     string
	IdempotencyKey string
}

// RegistrationMaterial 是只交给 Computer 进程的一次性 TAT 注册材料。
type RegistrationMaterial struct {
	ComputerID        string
	Protocol          string
	Region            string
	RegisterCodeID    string
	RegisterCodeValue string
	Tags              []RegistrationTag
	ExpiresAt         time.Time
}

type RegistrationTag struct {
	Key   string
	Value string
}

// Service 只编排平台映射和固定 TAT 能力，不接受任意远程命令。
type Service struct {
	repository computerport.Repository
	registrar  tencenttatport.Registrar
	terminals  tencenttatport.TerminalSessionIssuer
	ids        idport.Generator
	clock      clockport.Clock
	config     Config
}

// NewService 创建 Computer 应用服务。
func NewService(
	repository computerport.Repository,
	registrar tencenttatport.Registrar,
	terminals tencenttatport.TerminalSessionIssuer,
	ids idport.Generator,
	clock clockport.Clock,
	configs ...Config,
) (*Service, error) {
	if repository == nil || registrar == nil || terminals == nil ||
		ids == nil || clock == nil {
		return nil, errors.New("Computer 服务配置无效")
	}
	config := Config{
		ManagedTATRegion: DefaultManagedTATRegion,
		HostLeaseTTL:     DefaultHostLeaseTTL,
	}
	if len(configs) > 1 {
		return nil, errors.New("Computer 服务配置无效")
	}
	if len(configs) == 1 {
		config = configs[0]
	}
	config.ManagedTATRegion = strings.TrimSpace(config.ManagedTATRegion)
	if config.HostLeaseTTL == 0 {
		config.HostLeaseTTL = DefaultHostLeaseTTL
	}
	if !validTATRegion(config.ManagedTATRegion) ||
		config.HostLeaseTTL < 30*time.Second ||
		config.HostLeaseTTL > 10*time.Minute {
		return nil, errors.New("Computer 服务配置无效")
	}
	return &Service{
		repository: repository,
		registrar:  registrar,
		terminals:  terminals,
		ids:        ids,
		clock:      clock,
		config:     config,
	}, nil
}

// Create 创建原生实例映射或 managed 占位。
func (service *Service) Create(
	ctx context.Context,
	command CreateCommand,
) (computerport.Computer, error) {
	if command.TATInstanceKind == "managed" {
		command.TATRegion = service.config.ManagedTATRegion
	}
	if err := validateCreate(command); err != nil {
		return computerport.Computer{}, err
	}
	computerID, err := service.ids.New()
	if err != nil {
		return computerport.Computer{},
			apperror.New("internal_error", "暂时无法创建 Computer", err)
	}
	lifecycle := "active"
	if command.TATInstanceKind == "managed" {
		lifecycle = "provisioning"
	}
	value, err := service.repository.Create(ctx, computerport.CreateCommand{
		AccountID:      command.AccountID,
		ServerID:       command.ServerID,
		IdempotencyKey: command.IdempotencyKey,
		RequestHash:    createHash(command),
		CreatedAt:      service.clock.Now().UTC(),
		Computer: computerport.Draft{
			ID:              computerID,
			Name:            strings.TrimSpace(command.Name),
			TATRegion:       strings.TrimSpace(command.TATRegion),
			TATInstanceID:   normalizedPointer(command.TATInstanceID),
			TATInstanceKind: command.TATInstanceKind,
			OSType:          command.OSType,
			LifecycleState:  lifecycle,
		},
	})
	if err != nil {
		return computerport.Computer{}, mapRepositoryError(err)
	}
	return value, nil
}

// List 列出当前 Human 可见的 Server Computer。
func (service *Service) List(
	ctx context.Context,
	accountID string,
	serverID string,
) ([]computerport.Computer, error) {
	if !validUUIDv7(accountID) || !validUUIDv7(serverID) {
		return nil, apperror.New("invalid_request", "Computer 列表参数无效", nil)
	}
	values, err := service.repository.List(ctx, accountID, serverID)
	if err != nil {
		return nil, mapRepositoryError(err)
	}
	for index := range values {
		values[index] = service.projectComputerConnection(values[index])
	}
	return values, nil
}

// Get 返回经过 membership 授权的单个 Computer。
func (service *Service) Get(
	ctx context.Context,
	accountID string,
	serverID string,
	computerID string,
) (computerport.Computer, error) {
	if !validUUIDv7(accountID) || !validUUIDv7(serverID) ||
		!validUUIDv7(computerID) {
		return computerport.Computer{},
			apperror.New("invalid_request", "Computer 查询参数无效", nil)
	}
	value, err := service.repository.Get(ctx, accountID, serverID, computerID)
	if err != nil {
		return computerport.Computer{}, mapRepositoryError(err)
	}
	return service.projectComputerConnection(value), nil
}

// Release 写入 removed 墓碑并使当前接入材料失效。
func (service *Service) Release(
	ctx context.Context,
	command ReleaseCommand,
) error {
	if !validUUIDv7(command.AccountID) ||
		!validUUIDv7(command.ServerID) ||
		!validUUIDv7(command.ComputerID) ||
		strings.TrimSpace(command.IdempotencyKey) == "" {
		return apperror.New("invalid_request", "Computer 解除参数无效", nil)
	}
	err := service.repository.Release(ctx, computerport.ReleaseCommand{
		AccountID:      command.AccountID,
		ServerID:       command.ServerID,
		ComputerID:     command.ComputerID,
		IdempotencyKey: strings.TrimSpace(command.IdempotencyKey),
		ReleasedAt:     service.clock.Now().UTC(),
	})
	if err != nil {
		return mapRepositoryError(err)
	}
	return nil
}

func (service *Service) projectComputerConnection(
	value computerport.Computer,
) computerport.Computer {
	value.LastObservedAt = value.HostLastSeenAt
	if value.HostLastSeenAt == nil {
		value.TATAgentState = "unknown"
		return value
	}
	age := service.clock.Now().UTC().Sub(value.HostLastSeenAt.UTC())
	if value.LifecycleState == "active" && age >= 0 &&
		age <= service.config.HostLeaseTTL {
		value.TATAgentState = "online"
	} else {
		value.TATAgentState = "offline"
	}
	return value
}

// Refresh 提交固定的 TAT Agent 状态查询操作。
func (service *Service) Refresh(
	ctx context.Context,
	command RefreshCommand,
) (computerport.Operation, error) {
	if !validUUIDv7(command.AccountID) ||
		!validUUIDv7(command.ServerID) ||
		!validUUIDv7(command.ComputerID) ||
		strings.TrimSpace(command.IdempotencyKey) == "" {
		return computerport.Operation{},
			apperror.New("invalid_request", "Computer 刷新参数无效", nil)
	}
	value, err := service.repository.Get(
		ctx, command.AccountID, command.ServerID, command.ComputerID,
	)
	if err != nil {
		return computerport.Operation{}, mapRepositoryError(err)
	}
	if value.TATInstanceID == nil || value.LifecycleState != "active" {
		return computerport.Operation{},
			apperror.New("computer_not_ready", "Computer 尚未就绪", nil)
	}
	operationID, err := service.ids.New()
	if err != nil {
		return computerport.Operation{},
			apperror.New("internal_error", "暂时无法刷新 Computer", err)
	}
	operation, err := service.repository.EnqueueRefresh(
		ctx,
		computerport.RefreshCommand{
			AccountID:        command.AccountID,
			ServerID:         command.ServerID,
			ComputerID:       command.ComputerID,
			ComputerRevision: value.Revision,
			OperationID:      operationID,
			IdempotencyKey:   command.IdempotencyKey,
			CreatedAt:        service.clock.Now().UTC(),
		},
	)
	if err != nil {
		return computerport.Operation{}, mapRepositoryError(err)
	}
	return operation, nil
}

// CreateRegistration 创建限一台、限一小时的结构化 TAT 注册材料。
func (service *Service) CreateRegistration(
	ctx context.Context,
	accountID string,
	serverID string,
	computerID string,
) (RegistrationMaterial, error) {
	value, err := service.Get(ctx, accountID, serverID, computerID)
	if err != nil {
		return RegistrationMaterial{}, err
	}
	if value.TATInstanceKind != "managed" ||
		value.LifecycleState != "provisioning" ||
		value.TATInstanceID != nil {
		return RegistrationMaterial{},
			apperror.New(
				"computer_already_registered",
				"Computer 已注册或不是托管实例",
				nil,
			)
	}
	now := service.clock.Now().UTC()
	if value.RegistrationExpiresAt != nil &&
		value.RegistrationExpiresAt.After(now) {
		return RegistrationMaterial{},
			apperror.New(
				"computer_not_ready",
				"Computer 注册流程正在进行",
				nil,
			)
	}
	operationID, err := service.ids.New()
	if err != nil {
		return RegistrationMaterial{},
			apperror.New("internal_error", "暂时无法创建注册流程", err)
	}
	registration, err := service.registrar.CreateRegistration(
		ctx,
		tencenttatport.RegistrationRequest{
			Region:        value.TATRegion,
			Description:   "chatserver Computer " + value.ID,
			NamePrefix:    managedNamePrefix(value.ID),
			RegisterLimit: 1,
			EffectiveTime: time.Hour,
		},
	)
	if err != nil {
		return RegistrationMaterial{},
			apperror.New("tencent_unavailable", "暂时无法创建 TAT 注册码", err)
	}
	if !registration.ExpiresAt.After(now) ||
		registration.ExpiresAt.After(now.Add(2*time.Hour)) {
		return RegistrationMaterial{},
			apperror.New("internal_error", "TAT 注册码有效期无效", nil)
	}
	if _, err := service.repository.BeginRegistration(
		ctx,
		computerport.RegistrationCommand{
			AccountID:        accountID,
			ServerID:         serverID,
			ComputerID:       computerID,
			ComputerRevision: value.Revision,
			OperationID:      operationID,
			ExpiresAt:        registration.ExpiresAt.UTC(),
			CreatedAt:        now,
		},
	); err != nil {
		return RegistrationMaterial{}, mapRepositoryError(err)
	}
	if strings.TrimSpace(registration.CodeID) == "" ||
		strings.TrimSpace(registration.CodeValue) == "" {
		return RegistrationMaterial{},
			apperror.New("internal_error", "TAT 注册材料无效", nil)
	}
	return RegistrationMaterial{
		ComputerID:        value.ID,
		Protocol:          "tencent-tat-register-v1",
		Region:            value.TATRegion,
		RegisterCodeID:    registration.CodeID,
		RegisterCodeValue: registration.CodeValue,
		Tags: []RegistrationTag{{
			Key:   "agent-network-computer-id",
			Value: value.ID,
		}},
		ExpiresAt: registration.ExpiresAt.UTC(),
	}, nil
}

// CreateTerminalSession 为 active 且在线的 Computer 签发一次性 PTY 引导信息。
func (service *Service) CreateTerminalSession(
	ctx context.Context,
	accountID string,
	serverID string,
	computerID string,
) (tencenttatport.TerminalSession, error) {
	if !validUUIDv7(accountID) || !validUUIDv7(serverID) ||
		!validUUIDv7(computerID) {
		return tencenttatport.TerminalSession{},
			apperror.New("invalid_request", "终端会话参数无效", nil)
	}
	value, err := service.repository.GetForAdmin(
		ctx, accountID, serverID, computerID,
	)
	if err != nil {
		return tencenttatport.TerminalSession{}, mapRepositoryError(err)
	}
	value = service.projectComputerConnection(value)
	if value.LifecycleState != "active" || value.TATInstanceID == nil {
		return tencenttatport.TerminalSession{},
			apperror.New("computer_not_ready", "Computer 尚未就绪", nil)
	}
	if value.TATAgentState != "online" {
		return tencenttatport.TerminalSession{},
			apperror.New("computer_offline", "Computer 当前离线", nil)
	}
	target := tencenttatport.TerminalTarget{
		ComputerID:   value.ID,
		Region:       value.TATRegion,
		InstanceKind: value.TATInstanceKind,
		InstanceID:   *value.TATInstanceID,
		OS:           tencenttatport.OS(value.OSType),
	}
	if err := target.Validate(); err != nil {
		return tencenttatport.TerminalSession{},
			apperror.New("internal_error", "Computer TAT 定位无效", err)
	}
	session, err := service.terminals.Issue(ctx, target)
	if err != nil {
		return tencenttatport.TerminalSession{}, mapTerminalSessionError(err)
	}
	if err := validateTerminalSession(
		session, target.InstanceID, service.clock.Now().UTC(),
	); err != nil {
		return tencenttatport.TerminalSession{},
			apperror.New("terminal_session_unavailable", "终端会话响应无效", err)
	}
	return session, nil
}

func mapTerminalSessionError(err error) error {
	if tencenttatport.CodeOf(err) == "terminal_target_offline" {
		return apperror.New("computer_offline", "Computer 当前离线", err)
	}
	return apperror.New(
		"terminal_session_unavailable",
		"暂时无法创建终端会话",
		err,
	)
}

func validateTerminalSession(
	session tencenttatport.TerminalSession,
	instanceID string,
	now time.Time,
) error {
	endpoint, err := url.Parse(strings.TrimSpace(session.WebSocketURL))
	if err != nil || endpoint.Scheme != "wss" || endpoint.Host == "" ||
		strings.TrimSpace(session.SessionID) == "" ||
		strings.TrimSpace(session.OwnerUIN) == "" ||
		session.AppID <= 0 ||
		strings.TrimSpace(session.InstanceID) != strings.TrimSpace(instanceID) ||
		!session.ExpiresAt.After(now) ||
		session.ExpiresAt.After(now.Add(15*time.Minute)) ||
		session.Cols < 1 || session.Cols > 1000 ||
		session.Rows < 1 || session.Rows > 1000 ||
		session.MaxIdleSeconds < 1 || session.MaxIdleSeconds > 86400 {
		return errors.New("TAT 终端会话字段无效")
	}
	return nil
}

func validateCreate(command CreateCommand) error {
	if !validUUIDv7(command.AccountID) || !validUUIDv7(command.ServerID) ||
		strings.TrimSpace(command.IdempotencyKey) == "" ||
		len(strings.TrimSpace(command.Name)) == 0 ||
		len(strings.TrimSpace(command.Name)) > 100 ||
		strings.TrimSpace(command.TATRegion) == "" {
		return apperror.New("invalid_request", "Computer 创建参数无效", nil)
	}
	if command.OSType != "linux" &&
		command.OSType != "windows" &&
		command.OSType != "macos" {
		return apperror.New("computer_os_unsupported", "不支持该操作系统", nil)
	}
	instanceID := normalizedPointer(command.TATInstanceID)
	switch command.TATInstanceKind {
	case "cvm", "lighthouse":
		if instanceID == nil || command.OSType == "macos" {
			if command.OSType == "macos" {
				return apperror.New(
					"computer_os_unsupported",
					"macOS 仅支持托管 Computer",
					nil,
				)
			}
			return apperror.New("invalid_request", "原生实例必须提供实例 ID", nil)
		}
	case "managed":
		if instanceID != nil {
			return apperror.New("invalid_request", "托管实例创建时不能提供实例 ID", nil)
		}
	default:
		return apperror.New("invalid_request", "TAT 实例类型无效", nil)
	}
	return nil
}

func createHash(command CreateCommand) [32]byte {
	instanceID := ""
	if command.TATInstanceID != nil {
		instanceID = strings.TrimSpace(*command.TATInstanceID)
	}
	return sha256.Sum256([]byte(strings.Join([]string{
		strings.TrimSpace(command.Name),
		strings.TrimSpace(command.TATRegion),
		command.TATInstanceKind,
		instanceID,
		command.OSType,
	}, "\x00")))
}

func normalizedPointer(value *string) *string {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	normalized := strings.TrimSpace(*value)
	return &normalized
}

func validUUIDv7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.Version() == 7
}

func validTATRegion(value string) bool {
	value = strings.TrimSpace(value)
	if len(value) < 3 || len(value) > 64 ||
		value[0] == '-' || value[len(value)-1] == '-' {
		return false
	}
	for _, character := range value {
		if character != '-' &&
			(character < 'a' || character > 'z') &&
			(character < '0' || character > '9') {
			return false
		}
	}
	return true
}

func mapRepositoryError(err error) error {
	switch {
	case errors.Is(err, computerport.ErrServerNotFound):
		return apperror.New("server_not_found", "Server 不存在", err)
	case errors.Is(err, computerport.ErrComputerNotFound):
		return apperror.New("computer_not_found", "Computer 不存在", err)
	case errors.Is(err, computerport.ErrComputerNameConflict),
		errors.Is(err, computerport.ErrInstanceConflict):
		return apperror.New("revision_conflict", "Computer 已存在", err)
	case errors.Is(err, computerport.ErrIdempotencyConflict):
		return apperror.New(
			"idempotency_conflict",
			"幂等键与原请求不一致",
			err,
		)
	case errors.Is(err, computerport.ErrRegistrationActive):
		return apperror.New(
			"computer_not_ready",
			"Computer 注册流程正在进行",
			err,
		)
	case errors.Is(err, computerport.ErrAdminRequired):
		return apperror.New("permission_denied", "没有创建终端会话的权限", err)
	case errors.Is(err, computerport.ErrComputerHasBoundAgents):
		return apperror.New(
			"computer_has_bound_agents",
			"请先迁移或解绑 Computer 上的 Agent",
			err,
		)
	default:
		return apperror.New("internal_error", "暂时无法处理 Computer", err)
	}
}

func managedNamePrefix(computerID string) string {
	compact := strings.ReplaceAll(computerID, "-", "")
	if len(compact) > 12 {
		compact = compact[len(compact)-12:]
	}
	return "chatserver-" + compact
}
