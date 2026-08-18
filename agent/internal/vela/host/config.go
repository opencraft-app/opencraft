// Package host maintains one Vela Agent's short-lived platform and IM
// sessions. Runtime lifetime is intentionally independent from IM renewal.
package host

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"velachat/agent/internal/vela/im"
	"velachat/agent/internal/vela/ingress"
	"velachat/agent/internal/vela/platform"
	velastate "velachat/agent/internal/vela/state"
)

var (
	ErrInvalidConfig              = errors.New("Vela Agent Host 配置无效")
	ErrFailureLimit               = errors.New("Vela Agent Host 连续失败次数已达上限")
	ErrShutdownTimeout            = errors.New("Vela Agent Host 停止超时")
	ErrTransportFailed            = errors.New("Vela IM Transport 已停止")
	ErrRecoveryStalled            = errors.New("Vela 历史消息恢复游标未前进")
	ErrRecoverySnapshotIncomplete = errors.New("Vela 历史消息尚未覆盖未读快照")
	ErrRecoveryInvalidPage        = errors.New(
		"Vela 历史消息恢复返回了错误会话",
	)
)

type SessionProvider interface {
	CreateRuntimeSession(
		context.Context,
	) (platform.RuntimeSession, error)
}

type TransportFactory interface {
	New() (im.Transport, error)
}

type RuntimeAdapter interface {
	UpdateSession(platform.RuntimeSession) error
	ingress.Handler
	Close(context.Context) error
}

type FailureStage string
type FailureCode string
type FailureScope string
type FailureDiagnosticCode string
type StartupStage string

const (
	StartupStageRuntimeSession  StartupStage = "runtime_session"
	StartupStageRuntimeBind     StartupStage = "runtime_bind"
	StartupStageTransportCreate StartupStage = "transport_create"
	StartupStageTransportStart  StartupStage = "transport_start"
	StartupStageHistoryRecovery StartupStage = "history_recovery"
	StartupStageServing         StartupStage = "serving"
)

const (
	FailureScopeIdentity FailureScope = "identity"
	FailureScopeSession  FailureScope = "session"
	FailureScopeMessage  FailureScope = "message"
)

const (
	FailureStageRuntimeSession  FailureStage = "runtime_session"
	FailureStageRuntimeBind     FailureStage = "runtime_bind"
	FailureStageLaunchID        FailureStage = "launch_id"
	FailureStageTransportCreate FailureStage = "transport_create"
	FailureStageTransportStart  FailureStage = "transport_start"
	FailureStageHistoryRecovery FailureStage = "history_recovery"
	FailureStageServing         FailureStage = "serving"
)

const (
	FailureCodeRuntimeSessionUnavailable FailureCode = "runtime_session_unavailable"
	FailureCodeRuntimeBindFailed         FailureCode = "runtime_bind_failed"
	FailureCodeLaunchIDFailed            FailureCode = "launch_id_failed"
	FailureCodeTransportCreateFailed     FailureCode = "transport_create_failed"
	FailureCodeTransportStartFailed      FailureCode = "transport_start_failed"
	FailureCodeRecoveryStalled           FailureCode = "recovery_stalled"
	FailureCodeRecoveryHistoryExpired    FailureCode = "recovery_history_expired"
	FailureCodeRecoveryInvalidPage       FailureCode = "recovery_invalid_page"
	FailureCodeRecoveryTransport         FailureCode = "recovery_transport"
	FailureCodeTransportEventsClosed     FailureCode = "transport_events_closed"
	FailureCodeTransportLoginFailed      FailureCode = "transport_login_failed"
	FailureCodeTransportStopped          FailureCode = "transport_stopped"
	FailureCodeKickedOutMultAccount      FailureCode = "kicked_out_mult_account"
	FailureCodeKickedOutMultDevice       FailureCode = "kicked_out_mult_device"
	FailureCodeKickedOutUserSigExpired   FailureCode = "kicked_out_usersig_expired"
	FailureCodeKickedOutRESTAPI          FailureCode = "kicked_out_rest_api"
	FailureCodeKickedOutUnknown          FailureCode = "kicked_out_unknown"
	FailureCodeMessageEventInvalid       FailureCode = "message_event_invalid"
	FailureCodeMessageHandlerFailed      FailureCode = "message_handler_failed"
	FailureCodeMessageHandlerTimeout     FailureCode = "message_handler_timeout"
	FailureCodeMessageQueueOverflow      FailureCode = "message_queue_overflow"
	FailureCodeMessageCursorWriteFailed  FailureCode = "message_cursor_write_failed"
	FailureCodeMessageSessionMissing     FailureCode = "message_session_missing"
	FailureCodeMessageEnvelopeInvalid    FailureCode = "message_envelope_invalid"
	FailureCodeGatewayRegisterFailed     FailureCode = "gateway_register_failed"
	FailureCodeRuntimeUnavailable        FailureCode = "runtime_unavailable"
	FailureCodeRuntimePlanFailed         FailureCode = "runtime_plan_failed"
	FailureCodeRuntimeStartFailed        FailureCode = "runtime_start_failed"
	FailureCodeRuntimeDeliverFailed      FailureCode = "runtime_deliver_failed"
	FailureCodeSDKErrorNonRetryable      FailureCode = "sdk_error_non_retryable"
	FailureCodeServingUnknown            FailureCode = "serving_unknown"
)

const (
	FailureDiagnosticRuntimeDirectUnavailable FailureDiagnosticCode = "runtime_direct_unavailable"
	FailureDiagnosticRuntimeStaleLaunch       FailureDiagnosticCode = "runtime_stale_launch"
	FailureDiagnosticRuntimeAgentIdle         FailureDiagnosticCode = "runtime_agent_idle"
	FailureDiagnosticRuntimeDelayedIdle       FailureDiagnosticCode = "runtime_delayed_idle"
	FailureDiagnosticRuntimeTurnBoundary      FailureDiagnosticCode = "runtime_turn_boundary"
	FailureDiagnosticRuntimeTimeout           FailureDiagnosticCode = "runtime_timeout"
	FailureDiagnosticRuntimeRejected          FailureDiagnosticCode = "runtime_rejected"
)

type FailureDiagnostic struct {
	AgentID     string
	RuntimeKind string
	Code        FailureDiagnosticCode
}

type Failure struct {
	Scope      FailureScope
	Code       FailureCode
	Retryable  bool
	Diagnostic FailureDiagnostic
}

type failureError struct {
	failure Failure
	cause   error
}

func (e *failureError) Error() string {
	return string(e.failure.Code)
}

func (e *failureError) Unwrap() error {
	return e.cause
}

func NewFailureError(
	scope FailureScope,
	code FailureCode,
	retryable bool,
	cause error,
) error {
	if !knownFailureScope(scope) || !knownFailureCode(code) {
		scope = FailureScopeMessage
		code = FailureCodeMessageHandlerFailed
		retryable = true
	}
	return &failureError{
		failure: Failure{
			Scope:     scope,
			Code:      code,
			Retryable: retryable,
		},
		cause: cause,
	}
}

func NewFailureErrorWithDiagnostic(
	scope FailureScope,
	code FailureCode,
	retryable bool,
	diagnostic FailureDiagnostic,
	cause error,
) error {
	if !knownFailureScope(scope) || !knownFailureCode(code) {
		scope = FailureScopeMessage
		code = FailureCodeMessageHandlerFailed
		retryable = true
	}
	return &failureError{
		failure: Failure{
			Scope: scope, Code: code, Retryable: retryable,
			Diagnostic: safeFailureDiagnostic(diagnostic),
		},
		cause: cause,
	}
}

func DescribeFailure(err error) (Failure, bool) {
	var value *failureError
	if !errors.As(err, &value) || value == nil {
		return Failure{}, false
	}
	return value.failure, true
}

func knownFailureScope(scope FailureScope) bool {
	switch scope {
	case FailureScopeIdentity, FailureScopeSession, FailureScopeMessage:
		return true
	default:
		return false
	}
}

func knownFailureCode(code FailureCode) bool {
	switch code {
	case FailureCodeRuntimeSessionUnavailable,
		FailureCodeRuntimeBindFailed,
		FailureCodeLaunchIDFailed,
		FailureCodeTransportCreateFailed,
		FailureCodeTransportStartFailed,
		FailureCodeRecoveryStalled,
		FailureCodeRecoveryHistoryExpired,
		FailureCodeRecoveryInvalidPage,
		FailureCodeRecoveryTransport,
		FailureCodeTransportEventsClosed,
		FailureCodeTransportLoginFailed,
		FailureCodeTransportStopped,
		FailureCodeKickedOutMultAccount,
		FailureCodeKickedOutMultDevice,
		FailureCodeKickedOutUserSigExpired,
		FailureCodeKickedOutRESTAPI,
		FailureCodeKickedOutUnknown,
		FailureCodeMessageEventInvalid,
		FailureCodeMessageHandlerFailed,
		FailureCodeMessageHandlerTimeout,
		FailureCodeMessageQueueOverflow,
		FailureCodeMessageCursorWriteFailed,
		FailureCodeMessageSessionMissing,
		FailureCodeMessageEnvelopeInvalid,
		FailureCodeGatewayRegisterFailed,
		FailureCodeRuntimeUnavailable,
		FailureCodeRuntimePlanFailed,
		FailureCodeRuntimeStartFailed,
		FailureCodeRuntimeDeliverFailed,
		FailureCodeSDKErrorNonRetryable,
		FailureCodeServingUnknown:
		return true
	default:
		return false
	}
}

type FailureReport struct {
	Scope            FailureScope
	Stage            FailureStage
	Code             FailureCode
	Retryable        bool
	Attempt          int
	MessageID        string
	ConversationKind im.ConversationType
	Diagnostic       FailureDiagnostic
}

func (f FailureReport) String() string {
	f = safeFailureReport(f)
	var result strings.Builder
	fmt.Fprintf(
		&result,
		"scope=%s stage=%s code=%s retryable=%t attempt=%d",
		f.Scope,
		f.Stage,
		f.Code,
		f.Retryable,
		f.Attempt,
	)
	if f.MessageID != "" {
		fmt.Fprintf(&result, " message_id=%s", f.MessageID)
	}
	if f.ConversationKind != "" {
		fmt.Fprintf(
			&result,
			" conversation_kind=%s",
			f.ConversationKind,
		)
	}
	if f.Diagnostic.Code != "" {
		fmt.Fprintf(
			&result,
			" agent_id=%s runtime_kind=%s diagnostic=%s",
			f.Diagnostic.AgentID,
			f.Diagnostic.RuntimeKind,
			f.Diagnostic.Code,
		)
	}
	return result.String()
}

func safeFailureReport(report FailureReport) FailureReport {
	if !knownFailureScope(report.Scope) {
		report.Scope = FailureScopeSession
	}
	if !knownFailureStage(report.Stage) {
		report.Stage = FailureStageServing
	}
	if !knownFailureCode(report.Code) {
		report.Code = FailureCodeServingUnknown
	}
	if report.Attempt <= 0 {
		report.Attempt = 1
	}
	report.MessageID = safeMessageID(report.MessageID)
	switch report.ConversationKind {
	case im.ConversationC2C, im.ConversationGroup, im.ConversationTopic:
	default:
		report.ConversationKind = ""
	}
	report.Diagnostic = safeFailureDiagnostic(report.Diagnostic)
	return report
}

func safeFailureDiagnostic(value FailureDiagnostic) FailureDiagnostic {
	if !knownFailureDiagnosticCode(value.Code) {
		return FailureDiagnostic{}
	}
	value.AgentID = safeMessageID(value.AgentID)
	switch value.RuntimeKind {
	case "codex", "hermes-acp", "hermes-gateway":
	default:
		return FailureDiagnostic{}
	}
	if value.AgentID == "" {
		return FailureDiagnostic{}
	}
	return value
}

func knownFailureDiagnosticCode(code FailureDiagnosticCode) bool {
	switch code {
	case FailureDiagnosticRuntimeDirectUnavailable,
		FailureDiagnosticRuntimeStaleLaunch,
		FailureDiagnosticRuntimeAgentIdle,
		FailureDiagnosticRuntimeDelayedIdle,
		FailureDiagnosticRuntimeTurnBoundary,
		FailureDiagnosticRuntimeTimeout,
		FailureDiagnosticRuntimeRejected:
		return true
	default:
		return false
	}
}

func knownFailureStage(stage FailureStage) bool {
	switch stage {
	case FailureStageRuntimeSession,
		FailureStageRuntimeBind,
		FailureStageLaunchID,
		FailureStageTransportCreate,
		FailureStageTransportStart,
		FailureStageHistoryRecovery,
		FailureStageServing:
		return true
	default:
		return false
	}
}

func safeMessageID(value string) string {
	if value == "" {
		return ""
	}
	if len(value) <= 256 {
		safe := true
		for index := 0; index < len(value); index++ {
			character := value[index]
			if (character >= 'a' && character <= 'z') ||
				(character >= 'A' && character <= 'Z') ||
				(character >= '0' && character <= '9') ||
				strings.ContainsRune("._:@#-", rune(character)) {
				continue
			}
			safe = false
			break
		}
		if safe {
			return value
		}
	}
	digest := sha256.Sum256([]byte(value))
	return fmt.Sprintf("sha256:%x", digest[:8])
}

type Config struct {
	// Sessions is authorized by the daemon's Computer Session and is always
	// bound to the current server-allocated Launch fence.
	Sessions   SessionProvider
	Transports TransportFactory
	Runtime    RuntimeAdapter
	Cursors    velastate.CursorStore

	NewLaunchID func() (string, error)

	RefreshBefore     time.Duration
	BackoffBase       time.Duration
	BackoffMax        time.Duration
	MaxFailures       int
	ShutdownTimeout   time.Duration
	MaxInFlightEvents int
	IngressQueueSize  int

	RecoveryMessageTimeout time.Duration

	ReportFailure func(FailureReport)
	// ReportStartup exposes only a fixed startup-stage enum. It must return
	// quickly and must not call back into Host.
	ReportStartup func(StartupStage)
	// ReportReady is called once after IM login and unread recovery have both
	// completed. It may be called again after a reconnect. It must return
	// quickly and must not call back into Host.
	ReportReady func()
	// ReportUnready is called after a previously ready IM data plane leaves its
	// serving loop for refresh or recovery. Normal Host shutdown is excluded.
	ReportUnready func()
}

func normalizeConfig(config Config) (Config, error) {
	if config.NewLaunchID == nil {
		config.NewLaunchID = func() (string, error) {
			value, err := uuid.NewV7()
			if err != nil {
				return "", err
			}
			return value.String(), nil
		}
	}
	if config.RecoveryMessageTimeout == 0 {
		config.RecoveryMessageTimeout = 30 * time.Second
	}
	if config.IngressQueueSize == 0 {
		config.IngressQueueSize = 128
	}
	if config.Sessions == nil ||
		config.Transports == nil ||
		config.Runtime == nil ||
		config.Cursors == nil ||
		config.RefreshBefore <= 0 ||
		config.BackoffBase <= 0 ||
		config.BackoffMax < config.BackoffBase ||
		config.MaxFailures <= 0 ||
		config.ShutdownTimeout <= 0 ||
		config.MaxInFlightEvents <= 0 ||
		config.IngressQueueSize <= 0 ||
		config.RecoveryMessageTimeout <= 0 {
		return Config{}, ErrInvalidConfig
	}
	return config, nil
}
