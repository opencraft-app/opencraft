package runtimeapi

import (
	"context"
	"encoding/json"
)

type ProbeResult struct {
	Available  bool
	Path       string
	Version    string
	Diagnostic string
}

type Model struct {
	ID                        string   `json:"id"`
	Label                     string   `json:"label,omitempty"`
	Verified                  string   `json:"verified,omitempty"`
	SupportedReasoningEfforts []string `json:"supportedReasoningEfforts,omitempty"`
	DefaultReasoningEffort    string   `json:"defaultReasoningEffort,omitempty"`
	ServiceTiers              []string `json:"serviceTiers,omitempty"`
	DefaultServiceTier        string   `json:"defaultServiceTier,omitempty"`
}

type ModelResult struct {
	Models      []Model `json:"models"`
	Default     string  `json:"default,omitempty"`
	Unsupported bool    `json:"-"`
}

type StartRequest struct {
	AgentID          string
	LaunchID         string
	WorkingDirectory string
	Prompt           string
	StandingPrompt   string
	SessionID        string
	Model            string
	ReasoningEffort  string
	ExecutionMode    string
	Environment      map[string]string
}

type Delivery struct {
	Text        string
	Attachments []AttachmentRef
	Mode        string
	Transient   bool
}

type AttachmentRef struct {
	ID        string `json:"id"`
	Filename  string `json:"filename"`
	MIMEType  string `json:"mimeType"`
	SizeBytes int64  `json:"sizeBytes"`
}

type MessageRegistration struct {
	Target      string
	Text        string
	Attachments []AttachmentRef
}

type EventKind string

const (
	EventActivity           EventKind = "activity"
	EventSession            EventKind = "session"
	EventThinking           EventKind = "thinking"
	EventAssistantText      EventKind = "assistant_message"
	EventToolCall           EventKind = "tool_call"
	EventToolOutput         EventKind = "tool_output"
	EventUsage              EventKind = "usage"
	EventCompactionStarted  EventKind = "compaction_started"
	EventCompactionFinished EventKind = "compaction_finished"
	EventReviewStarted      EventKind = "review_started"
	EventReviewFinished     EventKind = "review_finished"
	EventTurnCompletion     EventKind = "turn_completion"
	EventTerminalFailure    EventKind = "terminal_failure"
	EventRecovery           EventKind = "recovery"
	EventDiagnostic         EventKind = "runtime_diagnostic"
	EventError              EventKind = "error"
	EventStatus             EventKind = "status"
)

type Event struct {
	Kind                         EventKind       `json:"kind"`
	Text                         string          `json:"text,omitempty"`
	Name                         string          `json:"name,omitempty"`
	ActivityKind                 string          `json:"activityKind,omitempty"`
	Detail                       string          `json:"detail,omitempty"`
	DetailKind                   string          `json:"detailKind,omitempty"`
	SessionID                    string          `json:"sessionId,omitempty"`
	TurnID                       string          `json:"turnId,omitempty"`
	LaunchID                     string          `json:"launchId,omitempty"`
	Raw                          json.RawMessage `json:"raw,omitempty"`
	RuntimeErrorMessage          string          `json:"-"`
	RuntimeErrorReasonProvenance string          `json:"-"`
	RuntimeErrorNativeReason     *bool           `json:"-"`
	RecoverySource               string          `json:"-"`
	RecoveryClass                string          `json:"-"`
	RecoveryAction               string          `json:"-"`
	RequestedSessionID           string          `json:"-"`
}

type RuntimeDriver interface {
	Probe(context.Context) (ProbeResult, error)
	DetectModels(context.Context) (ModelResult, error)
	Start(context.Context, StartRequest) (RuntimeSession, error)
}

type DriverFactory func() (RuntimeDriver, error)

type BusyDeliveryMode string

const (
	BusyDeliveryNone   BusyDeliveryMode = "none"
	BusyDeliveryGated  BusyDeliveryMode = "gated"
	BusyDeliveryDirect BusyDeliveryMode = "direct"
)

type CompletionMode string

const (
	CompletionEvent CompletionMode = "event"
)

type RuntimePolicy struct {
	SupportsStdin bool
	BusyMode      BusyDeliveryMode
	Completion    CompletionMode
}

type BufferedLaunchMessage struct {
	Raw       json.RawMessage
	Transient bool
}

type LaunchInput struct {
	AgentID              string
	Runtime              string
	SessionID            string
	ResumePrompt         string
	WakeMessage          json.RawMessage
	WakeMessageTransient bool
	ResumeMessages       []json.RawMessage
	UnreadSummary        json.RawMessage
	BufferedMessages     []BufferedLaunchMessage
}

type LaunchPlan struct {
	Prompt                   string
	StandingPrompt           string
	RebindDelivery           *Delivery
	PostStartDelivery        *Delivery
	ConsumedBufferedMessages int
}

type LaunchPlanner interface {
	PlanLaunch(LaunchInput) (LaunchPlan, error)
}

type LaunchPlannerFunc func(LaunchInput) (LaunchPlan, error)

func (f LaunchPlannerFunc) PlanLaunch(input LaunchInput) (LaunchPlan, error) {
	return f(input)
}

type Registration struct {
	ID            string
	WireID        string
	DisplayName   string
	NewDriver     DriverFactory
	Policy        RuntimePolicy
	LaunchPlanner LaunchPlanner
}

type ResolvedRuntime struct {
	ID            string
	InternalID    string
	DisplayName   string
	NewDriver     DriverFactory
	Policy        RuntimePolicy
	LaunchPlanner LaunchPlanner
}

type RuntimeResolver interface {
	ResolveRuntime(string) (ResolvedRuntime, bool)
}

type InternalRuntimeResolver interface {
	ResolveInternalRuntime(string) (ResolvedRuntime, bool)
}

type RuntimeSession interface {
	Deliver(context.Context, Delivery) error
	Stop(context.Context) error
	Events() <-chan Event
	SessionID() string
}

// NativeSteerer is an optional RuntimeSession capability. Implementations send
// input to the currently active native turn without changing RuntimeSession's
// portable delivery contract.
type NativeSteerer interface {
	Steer(context.Context, Delivery) error
}

// NativeTurnInterrupter is an optional RuntimeSession capability. It interrupts
// only the active native turn; RuntimeSession.Stop continues to own whole
// process termination.
type NativeTurnInterrupter interface {
	InterruptTurn(context.Context) error
}

type RuntimeHomeInfo struct {
	ObservedDir   string
	ConfiguredDir string
	Explicit      bool
}

// RuntimeHomeProvider is an optional RuntimeSession capability. ObservedDir is
// authoritative for the live process; ConfiguredDir reconstructs idle/restart
// state when no live process is available.
type RuntimeHomeProvider interface {
	RuntimeHomeInfo() RuntimeHomeInfo
}

type Liveness string

const (
	LivenessUnknown Liveness = "unknown"
	LivenessAlive   Liveness = "alive"
	LivenessDead    Liveness = "dead"
)

// LivenessProber is an optional RuntimeSession capability. Unknown is a
// meaningful result: compatibility logic only suppresses a stall when the
// Runtime can positively establish that its native process is alive.
type LivenessProber interface {
	RuntimeLiveness() Liveness
}
