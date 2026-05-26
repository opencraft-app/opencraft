package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

type CloudAgentClient struct {
	conn *Conn
}

type CloudAgentClientOptions struct {
	Headers            http.Header
	ProtocolVersion    int
	ClientName         string
	ClientTitle        string
	ClientVersion      string
	ClientCapabilities map[string]any
	OnNotification     func(raw json.RawMessage) error
	OnRequest          func(ctx context.Context, method string, id json.RawMessage, raw json.RawMessage) error
}

type CloudAgentInitializeResult struct {
	ProtocolVersion   int             `json:"protocolVersion"`
	AgentCapabilities json.RawMessage `json:"agentCapabilities"`
	AgentInfo         struct {
		Name    string `json:"name"`
		Title   string `json:"title"`
		Version string `json:"version"`
	} `json:"agentInfo"`
}

type CloudAgentSessionOptions struct {
	CWD              string
	AgentVersion     string
	WorkspaceVersion string
	SidecarURL       string
	SidecarSHA256    string
	SidecarSigURL    string
	SigningKeyID     string
	OuterRuntime     string
	RuntimeRecovery  string
	MCPServers       json.RawMessage
}

type CloudAgentSession struct {
	SessionID      string          `json:"sessionId"`
	ConfigOptions  json.RawMessage `json:"configOptions,omitempty"`
	ReadOnly       bool            `json:"-"`
	ReadOnlyReason string          `json:"-"`
	SessionProxyID string          `json:"-"`
}

type CloudAgentInboxMode string

const (
	CloudAgentInboxPrompt   CloudAgentInboxMode = "prompt"
	CloudAgentInboxSteer    CloudAgentInboxMode = "steer"
	CloudAgentInboxFollowUp CloudAgentInboxMode = "follow_up"
)

type CloudAgentPromptOptions struct {
	CWD       string
	InboxMode CloudAgentInboxMode
	Blocks    []map[string]any
}

type CloudAgentPromptResult struct {
	StopReason string          `json:"stopReason"`
	Raw        json.RawMessage `json:"-"`
}

type CloudAgentSessionStatus struct {
	SessionID           string `json:"session_id"`
	State               string `json:"state"`
	Closed              bool   `json:"closed"`
	ReadOnly            bool   `json:"read_only"`
	ReadOnlyReason      string `json:"read_only_reason"`
	RuntimeStatus       string `json:"runtime_status"`
	RuntimeStatusSource string `json:"runtime_status_source"`
	RuntimeStatusError  string `json:"runtime_status_error"`
	RuntimeStoreLoad    string `json:"runtime_store_load"`
	RunCount            int    `json:"run_count"`
	TranscriptCount     int    `json:"transcript_count"`
	LastUserHash        string `json:"last_user_hash"`
	LastAssistantHash   string `json:"last_assistant_hash"`
	RuntimeRestorable   bool   `json:"runtime_restorable"`
	WorkspacePersistent bool   `json:"workspace_persistent"`
	RuntimeGeneration   int64  `json:"runtime_generation"`
	LastRuntimeError    string `json:"last_runtime_error"`
	OK                  bool   `json:"ok,omitempty"`
	RestoreSource       string `json:"restore_source,omitempty"`
	Sandbox             struct {
		OuterRuntime        string `json:"outer_runtime"`
		RuntimeRecovery     string `json:"runtime_recovery"`
		AgentVersion        string `json:"agent_version"`
		WorkspaceVersion    string `json:"workspace_version"`
		RuntimeID           string `json:"runtime_id"`
		OuterSandboxID      string `json:"outer_sandbox_id"`
		HasInnerEnvdTarget  bool   `json:"has_inner_envd_target"`
		WispName            string `json:"wisp_name"`
		WispSMHSpaceID      string `json:"wisp_smh_space_id"`
		HasWorkspaceLease   bool   `json:"has_workspace_lease"`
		WorkspaceLeaseFence int64  `json:"workspace_lease_fence"`
	} `json:"sandbox"`
	RuntimeEnsureReady struct {
		Changed                bool   `json:"changed"`
		PreviousRuntimeID      string `json:"previous_runtime_id"`
		PreviousOuterSandboxID string `json:"previous_outer_sandbox_id"`
		RuntimeID              string `json:"runtime_id"`
		OuterSandboxID         string `json:"outer_sandbox_id"`
	} `json:"runtime_ensure_ready,omitempty"`
	Raw json.RawMessage `json:"-"`
}

func NormalizeACPWebSocketURL(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", fmt.Errorf("ACP URL is required")
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("unsupported ACP URL scheme %q", parsed.Scheme)
	}
	if parsed.Path == "" || parsed.Path == "/" {
		parsed.Path = "/acp"
	}
	return parsed.String(), nil
}

func DialCloudAgent(ctx context.Context, rawURL string, opts CloudAgentClientOptions) (*CloudAgentClient, error) {
	wsURL, err := NormalizeACPWebSocketURL(rawURL)
	if err != nil {
		return nil, err
	}
	conn, err := ConnectWSWithHeaders(ctx, wsURL, opts.Headers)
	if err != nil {
		return nil, err
	}
	if opts.OnNotification != nil {
		conn.SetNotificationHandler(opts.OnNotification)
	}
	if opts.OnRequest != nil {
		conn.SetRequestHandler(opts.OnRequest)
	}
	return &CloudAgentClient{conn: conn}, nil
}

func (c *CloudAgentClient) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

func (c *CloudAgentClient) Initialize(ctx context.Context, opts CloudAgentClientOptions) (CloudAgentInitializeResult, error) {
	protocol := opts.ProtocolVersion
	if protocol == 0 {
		protocol = 1
	}
	caps := opts.ClientCapabilities
	if caps == nil {
		caps = map[string]any{}
	}
	clientName := firstNonEmptyString(opts.ClientName, "cloudagent-acp-sdk")
	clientTitle := firstNonEmptyString(opts.ClientTitle, "CloudAgent ACP SDK")
	clientVersion := firstNonEmptyString(opts.ClientVersion, "0.1.0")
	result, err := c.conn.Call(ctx, "initialize", map[string]any{
		"protocolVersion":    protocol,
		"clientCapabilities": caps,
		"clientInfo": map[string]any{
			"name":    clientName,
			"title":   clientTitle,
			"version": clientVersion,
		},
	})
	if err != nil {
		return CloudAgentInitializeResult{}, err
	}
	var out CloudAgentInitializeResult
	if err := json.Unmarshal(result, &out); err != nil {
		return CloudAgentInitializeResult{}, err
	}
	return out, nil
}

func (c *CloudAgentClient) NewSession(ctx context.Context, opts CloudAgentSessionOptions) (CloudAgentSession, error) {
	params := sessionParams(opts)
	raw, err := c.conn.Call(ctx, "session/new", params)
	if err != nil {
		return CloudAgentSession{}, err
	}
	return decodeCloudAgentSession(raw, "")
}

func (c *CloudAgentClient) LoadSession(ctx context.Context, sessionID string, opts CloudAgentSessionOptions) (CloudAgentSession, error) {
	params := sessionParams(opts)
	params["sessionId"] = sessionID
	raw, err := c.conn.Call(ctx, "session/load", params)
	if err != nil {
		return CloudAgentSession{}, err
	}
	return decodeCloudAgentSession(raw, sessionID)
}

func (c *CloudAgentClient) ResumeSession(ctx context.Context, sessionID string, opts CloudAgentSessionOptions) (CloudAgentSession, error) {
	params := sessionParams(opts)
	params["sessionId"] = sessionID
	raw, err := c.conn.Call(ctx, "session/resume", params)
	if err != nil {
		return CloudAgentSession{}, err
	}
	return decodeCloudAgentSession(raw, sessionID)
}

func (c *CloudAgentClient) EnsureRuntimeReady(ctx context.Context, sessionID string, opts CloudAgentSessionOptions) (CloudAgentSessionStatus, error) {
	params := map[string]any{"session_id": sessionID}
	if strings.TrimSpace(opts.CWD) != "" {
		params["cwd"] = opts.CWD
	}
	raw, err := c.conn.Call(ctx, "_cloudagent.runtime.ensure_ready", params)
	if err != nil {
		return CloudAgentSessionStatus{}, err
	}
	var out CloudAgentSessionStatus
	out.Raw = append(json.RawMessage(nil), raw...)
	if err := json.Unmarshal(raw, &out); err != nil {
		return CloudAgentSessionStatus{}, err
	}
	return out, nil
}

func (c *CloudAgentClient) Prompt(ctx context.Context, sessionID, text string, opts CloudAgentPromptOptions) (CloudAgentPromptResult, error) {
	blocks := opts.Blocks
	if len(blocks) == 0 {
		blocks = []map[string]any{{"type": "text", "text": text}}
	}
	params := map[string]any{
		"sessionId": sessionID,
		"prompt":    blocks,
	}
	if strings.TrimSpace(opts.CWD) != "" {
		params["cwd"] = opts.CWD
	}
	if opts.InboxMode != "" {
		params["_meta"] = map[string]any{
			"cloudagent": map[string]any{"inbox_mode": string(opts.InboxMode)},
		}
	}
	raw, err := c.conn.Call(ctx, "session/prompt", params)
	if err != nil {
		return CloudAgentPromptResult{}, err
	}
	var out CloudAgentPromptResult
	out.Raw = append(json.RawMessage(nil), raw...)
	if err := json.Unmarshal(raw, &out); err != nil {
		return CloudAgentPromptResult{}, err
	}
	return out, nil
}

func (c *CloudAgentClient) PromptText(ctx context.Context, sessionID, text string) (CloudAgentPromptResult, error) {
	return c.Prompt(ctx, sessionID, text, CloudAgentPromptOptions{InboxMode: CloudAgentInboxPrompt})
}

func (c *CloudAgentClient) Steer(ctx context.Context, sessionID, text string) (CloudAgentPromptResult, error) {
	return c.Prompt(ctx, sessionID, text, CloudAgentPromptOptions{InboxMode: CloudAgentInboxSteer})
}

func (c *CloudAgentClient) FollowUp(ctx context.Context, sessionID, text string) (CloudAgentPromptResult, error) {
	return c.Prompt(ctx, sessionID, text, CloudAgentPromptOptions{InboxMode: CloudAgentInboxFollowUp})
}

func (c *CloudAgentClient) CancelSession(ctx context.Context, sessionID string) error {
	_ = ctx
	return c.conn.Notify("session/cancel", map[string]any{"sessionId": sessionID})
}

func (c *CloudAgentClient) AbortSession(ctx context.Context, sessionID string) error {
	return c.CancelSession(ctx, sessionID)
}

func (c *CloudAgentClient) CloseSession(ctx context.Context, sessionID string) error {
	_, err := c.conn.Call(ctx, "session/close", map[string]any{"sessionId": sessionID})
	return err
}

func (c *CloudAgentClient) DeleteSession(ctx context.Context, sessionID string) error {
	_, err := c.conn.Call(ctx, "session/delete", map[string]any{"sessionId": sessionID})
	return err
}

func (c *CloudAgentClient) Status(ctx context.Context, sessionID string) (CloudAgentSessionStatus, error) {
	raw, err := c.conn.Call(ctx, "_cloudagent.session.status", map[string]any{"session_id": sessionID})
	if err != nil {
		return CloudAgentSessionStatus{}, err
	}
	var out CloudAgentSessionStatus
	out.Raw = append(json.RawMessage(nil), raw...)
	if err := json.Unmarshal(raw, &out); err != nil {
		return CloudAgentSessionStatus{}, err
	}
	return out, nil
}

func (c *CloudAgentClient) KillRuntimeDaemonForFaultInjection(ctx context.Context, sessionID string) error {
	_, err := c.conn.Call(ctx, "_cloudagent.runtime.kill_daemon", map[string]any{"session_id": sessionID})
	return err
}

func (c *CloudAgentClient) KillRuntimeOuterForFaultInjection(ctx context.Context, sessionID string) error {
	_, err := c.conn.Call(ctx, "_cloudagent.runtime.kill_outer", map[string]any{"session_id": sessionID})
	return err
}

func (c *CloudAgentClient) KillRuntimeInnerForFaultInjection(ctx context.Context, sessionID string) error {
	_, err := c.conn.Call(ctx, "_cloudagent.runtime.kill_inner", map[string]any{"session_id": sessionID})
	return err
}

func sessionParams(opts CloudAgentSessionOptions) map[string]any {
	params := map[string]any{}
	if strings.TrimSpace(opts.CWD) != "" {
		params["cwd"] = opts.CWD
	}
	if len(opts.MCPServers) > 0 && string(opts.MCPServers) != "null" {
		params["mcpServers"] = opts.MCPServers
	}
	cloud := map[string]any{}
	addString := func(key, value string) {
		if strings.TrimSpace(value) != "" {
			cloud[key] = strings.TrimSpace(value)
		}
	}
	addString("agent_version", opts.AgentVersion)
	addString("workspace_version", opts.WorkspaceVersion)
	addString("sidecar_url", opts.SidecarURL)
	addString("sidecar_sha256", opts.SidecarSHA256)
	addString("sidecar_sig_url", opts.SidecarSigURL)
	addString("signing_key_id", opts.SigningKeyID)
	addString("outer_runtime", opts.OuterRuntime)
	addString("runtime_recovery", opts.RuntimeRecovery)
	if len(cloud) > 0 {
		params["_meta"] = map[string]any{"cloudagent": cloud}
	}
	return params
}

func decodeCloudAgentSession(raw json.RawMessage, fallbackSessionID string) (CloudAgentSession, error) {
	var out CloudAgentSession
	if err := json.Unmarshal(raw, &out); err != nil {
		return CloudAgentSession{}, err
	}
	if out.SessionID == "" {
		out.SessionID = strings.TrimSpace(fallbackSessionID)
	}
	if out.SessionID == "" {
		return CloudAgentSession{}, fmt.Errorf("ACP session response missing sessionId")
	}
	var envelope struct {
		Meta struct {
			CloudAgent struct {
				ReadOnly       bool   `json:"read_only"`
				ReadOnlyReason string `json:"read_only_reason"`
				SessionProxyID string `json:"session_proxy_id"`
			} `json:"cloudagent"`
		} `json:"_meta"`
	}
	if err := json.Unmarshal(raw, &envelope); err == nil {
		out.ReadOnly = envelope.Meta.CloudAgent.ReadOnly
		out.ReadOnlyReason = envelope.Meta.CloudAgent.ReadOnlyReason
		out.SessionProxyID = envelope.Meta.CloudAgent.SessionProxyID
	}
	return out, nil
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
