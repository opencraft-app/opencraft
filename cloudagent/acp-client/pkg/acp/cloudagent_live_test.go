package acp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCloudAgentLiveSessionLifecycle(t *testing.T) {
	client := newLiveCloudAgentClient(t)
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-e2e",
		ClientTitle:   "CloudAgent ACP Live E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{
		CWD:              liveCWD(),
		AgentVersion:     os.Getenv("CLOUDAGENT_ACP_E2E_AGENT_VERSION"),
		WorkspaceVersion: os.Getenv("CLOUDAGENT_ACP_E2E_WORKSPACE_VERSION"),
	})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	defer func() {
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	result, err := client.Prompt(ctx, session.SessionID, livePrompt(), CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("session/prompt: %v", err)
	}
	if !isNormalStopReason(result.StopReason) {
		t.Fatalf("unexpected stopReason %q raw=%s", result.StopReason, string(result.Raw))
	}

	status, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("_cloudagent.session.status: %v", err)
	}
	if status.Closed || status.ReadOnly {
		t.Fatalf("session should be writable after prompt: %+v raw=%s", status, string(status.Raw))
	}
	if status.RuntimeStatus == "" {
		t.Fatalf("status missing runtime_status: %s", string(status.Raw))
	}
	if status.RuntimeStatusSource == "" {
		t.Fatalf("status missing runtime_status_source: %s", string(status.Raw))
	}
	if status.RuntimeStoreLoad != "" && (status.RunCount == 0 || status.TranscriptCount == 0) {
		t.Fatalf("status returned runtime store load but missing transcript counters: %s", string(status.Raw))
	}
	if status.Sandbox.OuterSandboxID == "" {
		t.Fatalf("status missing outer sandbox id: %s", string(status.Raw))
	}

	followUp, err := client.Prompt(ctx, session.SessionID, "请只回答 FOLLOWUP_OK。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxFollowUp,
	})
	if err != nil {
		t.Fatalf("session/prompt follow_up: %v", err)
	}
	if !isNormalStopReason(followUp.StopReason) {
		t.Fatalf("unexpected follow_up stopReason %q raw=%s", followUp.StopReason, string(followUp.Raw))
	}
}

func TestCloudAgentLiveStatusDeleteAndVersionFields(t *testing.T) {
	client := newLiveCloudAgentClient(t)
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-status-e2e",
		ClientTitle:   "CloudAgent ACP Live Status E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{
		CWD:              liveCWD(),
		AgentVersion:     firstNonEmptyString(os.Getenv("CLOUDAGENT_ACP_E2E_AGENT_VERSION"), "builtin.v1"),
		WorkspaceVersion: firstNonEmptyString(os.Getenv("CLOUDAGENT_ACP_E2E_WORKSPACE_VERSION"), "builtin.v1"),
	})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}

	status, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after session/new: %v", err)
	}
	if status.SessionID != session.SessionID {
		t.Fatalf("status session mismatch: got=%s want=%s raw=%s", status.SessionID, session.SessionID, string(status.Raw))
	}
	if status.Sandbox.AgentVersion == "" || status.Sandbox.WorkspaceVersion == "" {
		t.Fatalf("status missing behavior versions: %s", string(status.Raw))
	}
	if status.Sandbox.OuterRuntime == "" || status.Sandbox.RuntimeRecovery == "" {
		t.Fatalf("status missing runtime recovery metadata: %s", string(status.Raw))
	}
	if status.Sandbox.OuterSandboxID == "" || status.Sandbox.WispSMHSpaceID == "" {
		t.Fatalf("status missing live runtime/workspace identity: %s", string(status.Raw))
	}
	if !status.RuntimeRestorable || !status.WorkspacePersistent {
		t.Fatalf("new live session should be restorable and workspace-persistent: %s", string(status.Raw))
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	if _, err := client.Status(ctx, session.SessionID); err == nil {
		t.Fatalf("status should fail after session/delete")
	}
}

func TestCloudAgentLiveSteerAndAbortPrimitives(t *testing.T) {
	client := newLiveCloudAgentClient(t)
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-steer-e2e",
		ClientTitle:   "CloudAgent ACP Live Steer E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	defer func() {
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	steer, err := client.Steer(ctx, session.SessionID, "这是一条 steer 输入。请只回答 STEER_OK。")
	if err != nil {
		t.Fatalf("steer prompt: %v", err)
	}
	if !isNormalStopReason(steer.StopReason) {
		t.Fatalf("unexpected steer stopReason %q raw=%s", steer.StopReason, string(steer.Raw))
	}
	if err := client.AbortSession(ctx, session.SessionID); err != nil {
		t.Fatalf("abort idle session should be accepted: %v", err)
	}
	afterAbort, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after abort: %v", err)
	}
	if afterAbort.Closed || afterAbort.ReadOnly {
		t.Fatalf("idle abort should not make session unusable: %s", string(afterAbort.Raw))
	}
	if afterAbort.RuntimeStatus == "prompting" {
		t.Fatalf("idle abort should not leave runtime prompting: %s", string(afterAbort.Raw))
	}
}

func TestCloudAgentLiveConversationHistory(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	var sessionID string
	defer func() {
		if sessionID != "" {
			deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer deleteCancel()
			_ = client.DeleteSession(deleteCtx, sessionID)
		}
		_ = client.Close()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-history-e2e",
		ClientTitle:   "CloudAgent ACP Live History E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	sessionID = session.SessionID

	needle := "cloudagent-history-" + strings.ReplaceAll(session.SessionID, "_", "-")
	firstPrompt := "这一轮只输出 HISTORY_READY。为了后续校验，这条用户消息包含唯一标记 " + needle + "。"
	first, err := client.Prompt(ctx, session.SessionID, firstPrompt, CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("first prompt: %v", err)
	}
	if !isNormalStopReason(first.StopReason) {
		t.Fatalf("unexpected first stopReason %q raw=%s", first.StopReason, string(first.Raw))
	}
	if err := client.Close(); err != nil {
		t.Fatalf("close first connection: %v", err)
	}

	output.Reset()

	client = newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-history-load-e2e",
		ClientTitle:   "CloudAgent ACP Live History Load E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize reconnected client: %v", err)
	}
	loaded, err := client.LoadSession(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/load: %v", err)
	}
	if loaded.ReadOnly {
		t.Fatalf("loaded session should remain writable: %+v", loaded)
	}
	afterLoadStatus, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after session/load: %v", err)
	}
	if !isCloudAgentWorkspaceWellDone(afterLoadStatus) {
		t.Fatalf("session/load status is not ACP workspace well-done: %s", string(afterLoadStatus.Raw))
	}

	second, err := client.Prompt(ctx, session.SessionID, "请查看本对话的上一条用户消息，复制其中以 cloudagent-history- 开头的唯一标记。不要解释，只输出标记本身。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("second prompt: %v", err)
	}
	outputText := output.String()
	if !strings.Contains(outputText, needle) {
		t.Fatalf("second prompt did not recover conversation history: want=%q got=%q raw=%s", needle, outputText, string(second.Raw))
	}
}

func TestCloudAgentLiveWorkspaceWellDoneAfterLoad(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	var sessionID string
	defer func() {
		if sessionID != "" {
			deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer deleteCancel()
			_ = client.DeleteSession(deleteCtx, sessionID)
		}
		_ = client.Close()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-well-done-e2e",
		ClientTitle:   "CloudAgent ACP Live Well-Done E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	sessionID = session.SessionID

	needle := "cloudagent-well-done-" + strings.ReplaceAll(session.SessionID, "_", "-")
	prepare, err := client.Prompt(ctx, session.SessionID, "请只回答 WELL_DONE_READY。为了 well-done 校验，这条用户消息包含唯一标记 "+needle+"。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("prepare prompt: %v", err)
	}
	if !isNormalStopReason(prepare.StopReason) {
		t.Fatalf("unexpected prepare stopReason %q raw=%s", prepare.StopReason, string(prepare.Raw))
	}

	beforeReconnect, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status before reconnect: %v", err)
	}
	if !isCloudAgentWorkspaceWellDone(beforeReconnect) {
		t.Fatalf("new session status is not ACP workspace well-done: %s", string(beforeReconnect.Raw))
	}

	if err := client.Close(); err != nil {
		t.Fatalf("close first connection: %v", err)
	}
	output.Reset()
	client = newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-well-done-load-e2e",
		ClientTitle:   "CloudAgent ACP Live Well-Done Load E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize reconnected client: %v", err)
	}

	loaded, err := client.LoadSession(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/load: %v", err)
	}
	if loaded.ReadOnly {
		t.Fatalf("session/load should not mark live workspace read-only: %+v", loaded)
	}
	afterLoad, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after session/load: %v", err)
	}
	if !isCloudAgentWorkspaceWellDone(afterLoad) {
		t.Fatalf("session status should be ACP workspace well-done after load: %s", string(afterLoad.Raw))
	}

	recovered, err := client.Prompt(ctx, session.SessionID, "请查看本对话历史，复制其中以 cloudagent-well-done- 开头的唯一标记。不要解释，只输出标记本身。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("prompt after well-done status: %v", err)
	}
	if !isNormalStopReason(recovered.StopReason) {
		t.Fatalf("unexpected recovered stopReason %q raw=%s", recovered.StopReason, string(recovered.Raw))
	}
	if outputText := output.String(); !strings.Contains(outputText, needle) {
		t.Fatalf("prompt after well-done status did not recover history: want=%q got=%q raw=%s", needle, outputText, string(recovered.Raw))
	}
}

func TestCloudAgentLiveUnknownVersionsRejected(t *testing.T) {
	client := newLiveCloudAgentClient(t)
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-version-reject-e2e",
		ClientTitle:   "CloudAgent ACP Live Version Reject E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	_, err := client.NewSession(ctx, CloudAgentSessionOptions{
		CWD:              liveCWD(),
		AgentVersion:     "missing.agent-version.e2e",
		WorkspaceVersion: "builtin.v1",
	})
	if err == nil {
		t.Fatal("unknown agent_version should be rejected")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "agent") {
		t.Fatalf("unknown agent_version error should mention agent version, got: %v", err)
	}

	_, err = client.NewSession(ctx, CloudAgentSessionOptions{
		CWD:              liveCWD(),
		AgentVersion:     "builtin.v1",
		WorkspaceVersion: "missing.workspace-version.e2e",
	})
	if err == nil {
		t.Fatal("unknown workspace_version should be rejected")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "workspace") {
		t.Fatalf("unknown workspace_version error should mention workspace version, got: %v", err)
	}
}

func TestCloudAgentLiveStatusExtensionUsesSnakeCaseFields(t *testing.T) {
	client := newLiveCloudAgentClient(t)
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-snake-case-e2e",
		ClientTitle:   "CloudAgent ACP Live Snake Case E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	defer func() {
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	status, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("_cloudagent.session.status: %v", err)
	}
	raw := string(status.Raw)
	for _, want := range []string{
		`"session_id"`,
		`"read_only"`,
		`"runtime_status"`,
		`"runtime_status_source"`,
		`"runtime_restorable"`,
		`"workspace_persistent"`,
		`"outer_sandbox_id"`,
		`"wisp_smh_space_id"`,
	} {
		if !strings.Contains(raw, want) {
			t.Fatalf("status extension missing snake_case field %s: %s", want, raw)
		}
	}
	for _, forbidden := range []string{
		`"sessionId"`,
		`"readOnly"`,
		`"runtimeStatus"`,
		`"runtimeStatusSource"`,
		`"runtimeRestorable"`,
		`"workspacePersistent"`,
		`"outerSandboxId"`,
		`"wispSmhSpaceId"`,
	} {
		if strings.Contains(raw, forbidden) {
			t.Fatalf("status extension leaked camelCase field %s: %s", forbidden, raw)
		}
	}
}

func TestCloudAgentLivePromptAfterDeleteReturnsProtocolError(t *testing.T) {
	client := newLiveCloudAgentClient(t)
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-delete-error-e2e",
		ClientTitle:   "CloudAgent ACP Live Delete Error E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	if _, err := client.Prompt(ctx, session.SessionID, "请只回答 SHOULD_NOT_RUN。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	}); err == nil {
		t.Fatalf("session/prompt should fail after session/delete")
	} else if !strings.Contains(strings.ToLower(err.Error()), "rpc error") {
		t.Fatalf("prompt after delete should return JSON-RPC error, got: %v", err)
	}
	if _, err := client.Status(ctx, session.SessionID); err == nil {
		t.Fatalf("status should fail after session/delete")
	}
}

func TestCloudAgentLiveInvalidInboxModeRejected(t *testing.T) {
	client := newLiveCloudAgentClient(t)
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-invalid-inbox-e2e",
		ClientTitle:   "CloudAgent ACP Live Invalid Inbox E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	defer func() {
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	_, err = client.conn.Call(ctx, "session/prompt", map[string]any{
		"sessionId": session.SessionID,
		"cwd":       liveCWD(),
		"prompt":    []map[string]any{{"type": "text", "text": "请只回答 SHOULD_NOT_RUN。"}},
		"_meta": map[string]any{
			"cloudagent": map[string]any{"inbox_mode": "invalid_mode"},
		},
	})
	if err == nil {
		t.Fatal("session/prompt should reject invalid _meta.cloudagent.inbox_mode")
	}
	lower := strings.ToLower(err.Error())
	if !strings.Contains(lower, "inbox") && !strings.Contains(lower, "invalid") {
		t.Fatalf("invalid inbox error should mention inbox/invalid mode, got: %v", err)
	}
	status, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after invalid inbox: %v", err)
	}
	if status.Closed || status.ReadOnly || status.RuntimeStatus == "prompting" {
		t.Fatalf("invalid inbox request should not leave session unusable: %s", string(status.Raw))
	}
}

func TestCloudAgentLiveLoadReplayDoesNotDuplicateFinalAssistantMessage(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: output.notification})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-replay-dedupe-e2e",
		ClientTitle:   "CloudAgent ACP Live Replay Dedupe E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	defer func() {
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	needle := "REPLAY_DEDUPE_" + strings.ReplaceAll(session.SessionID, "_", "-")
	result, err := client.Prompt(ctx, session.SessionID, "请只输出 "+needle+"，不要输出其它文字。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("seed prompt: %v", err)
	}
	if !isNormalStopReason(result.StopReason) {
		t.Fatalf("unexpected seed stopReason %q raw=%s", result.StopReason, string(result.Raw))
	}

	for i := 1; i <= 2; i++ {
		if err := client.Close(); err != nil {
			t.Fatalf("close connection before load round %d: %v", i, err)
		}
		output = &liveAgentOutput{}
		client = newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: output.notification})
		if _, err := client.Initialize(ctx, CloudAgentClientOptions{
			ClientName:    fmt.Sprintf("cloudagent-acp-live-replay-dedupe-load-%d", i),
			ClientTitle:   "CloudAgent ACP Live Replay Dedupe Load",
			ClientVersion: "0.1.0",
		}); err != nil {
			t.Fatalf("initialize load round %d: %v", i, err)
		}
		if _, err := client.LoadSession(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()}); err != nil {
			t.Fatalf("session/load round %d: %v", i, err)
		}
		got := output.String()
		if count := strings.Count(got, needle); count != 1 {
			t.Fatalf("session/load round %d should replay final assistant message once; count=%d want=1 got=%q", i, count, got)
		}
	}
}

func TestCloudAgentLiveCloseResumeFromWorkspace(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_RESTORE") {
		t.Skip("set CLOUDAGENT_ACP_E2E_RESTORE=1 to run close/resume restore e2e")
	}
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-restore-e2e",
		ClientTitle:   "CloudAgent ACP Live Restore E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if deleted {
			return
		}
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	needle := "cloudagent-resume-history-" + strings.ReplaceAll(session.SessionID, "_", "-")
	preparePrompt := "这是 close/resume 恢复前的准备消息。请只回答 READY。为了恢复校验，这条用户消息包含唯一标记 " + needle + "。"
	prepare, err := client.Prompt(ctx, session.SessionID, preparePrompt, CloudAgentPromptOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("prepare prompt: %v", err)
	}
	if !isNormalStopReason(prepare.StopReason) {
		t.Fatalf("unexpected prepare stopReason %q raw=%s", prepare.StopReason, string(prepare.Raw))
	}
	beforeClose, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status before close: %v", err)
	}
	oldOuter := beforeClose.Sandbox.OuterSandboxID
	oldSpace := beforeClose.Sandbox.WispSMHSpaceID
	if oldOuter == "" || oldSpace == "" {
		t.Fatalf("before close missing runtime identity: %s", string(beforeClose.Raw))
	}
	if !beforeClose.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("before close should have inner workspace runtime target: %s", string(beforeClose.Raw))
	}
	if !beforeClose.WorkspacePersistent || !beforeClose.RuntimeRestorable {
		t.Fatalf("before close should be workspace-persistent/restorable: %s", string(beforeClose.Raw))
	}

	if err := client.CloseSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/close: %v", err)
	}
	afterClose, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after close: %v", err)
	}
	if !afterClose.Closed || !afterClose.RuntimeRestorable || !afterClose.WorkspacePersistent {
		t.Fatalf("closed session should remain restorable: %s", string(afterClose.Raw))
	}
	if afterClose.Sandbox.OuterSandboxID != "" {
		t.Fatalf("closed session should not retain outer sandbox id: %s", string(afterClose.Raw))
	}
	if afterClose.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("closed session should not retain inner workspace runtime target: %s", string(afterClose.Raw))
	}
	if afterClose.Sandbox.WispSMHSpaceID != oldSpace {
		t.Fatalf("workspace changed after close: before=%s after=%s raw=%s", oldSpace, afterClose.Sandbox.WispSMHSpaceID, string(afterClose.Raw))
	}

	resumed, err := client.ResumeSession(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/resume: %v", err)
	}
	if resumed.ReadOnly {
		t.Fatalf("resumed session is read-only: %+v", resumed)
	}
	afterResume, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after resume: %v", err)
	}
	newOuter := afterResume.Sandbox.OuterSandboxID
	if afterResume.Closed || afterResume.ReadOnly {
		t.Fatalf("resumed session should be writable: %s", string(afterResume.Raw))
	}
	if newOuter == "" || newOuter == oldOuter {
		t.Fatalf("resume should create a different outer sandbox: old=%s new=%s raw=%s", oldOuter, newOuter, string(afterResume.Raw))
	}
	if !afterResume.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("resume should recreate inner workspace runtime target: %s", string(afterResume.Raw))
	}
	if afterResume.Sandbox.WispSMHSpaceID != oldSpace {
		t.Fatalf("resume should keep workspace space: before=%s after=%s raw=%s", oldSpace, afterResume.Sandbox.WispSMHSpaceID, string(afterResume.Raw))
	}

	output.Reset()
	recovered, err := client.Prompt(ctx, session.SessionID, "请查看本对话历史，复制其中以 cloudagent-resume-history- 开头的唯一标记。不要解释，只输出标记本身。", CloudAgentPromptOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("prompt after resume: %v", err)
	}
	outputText := output.String()
	if !strings.Contains(outputText, needle) {
		t.Fatalf("prompt after resume did not recover runtime transcript: want=%q got=%q raw=%s", needle, outputText, string(recovered.Raw))
	}
	deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer deleteCancel()
	if err := client.DeleteSession(deleteCtx, session.SessionID); err == nil {
		deleted = true
	} else {
		t.Logf("session/delete cleanup failed after behavior assertions passed: %v", err)
	}
}

func TestCloudAgentLiveCloseResumePreservesWorkspaceFiles(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_RESTORE") {
		t.Skip("set CLOUDAGENT_ACP_E2E_RESTORE=1 to run workspace file close/resume e2e")
	}
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: output.notification})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-file-restore-e2e",
		ClientTitle:   "CloudAgent ACP Live File Restore E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if deleted {
			return
		}
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	needle := "cloudagent-file-restore-" + strings.ReplaceAll(session.SessionID, "_", "-")
	remotePath := "/workspace/e2e/persist-after-close.txt"
	create, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `mkdir -p /workspace/e2e && printf '"+needle+"\\n' > "+remotePath+" && cat "+remotePath+"`。命令结束后只输出终端里的 cloudagent-file-restore 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("create workspace file prompt: %v", err)
	}
	if !isNormalStopReason(create.StopReason) {
		t.Fatalf("unexpected create stopReason %q raw=%s", create.StopReason, string(create.Raw))
	}
	if !strings.Contains(output.CombinedString(), needle) {
		t.Fatalf("create output missing marker %q: got=%q raw=%s", needle, output.CombinedString(), string(create.Raw))
	}
	beforeClose, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status before close: %v", err)
	}
	oldOuter := beforeClose.Sandbox.OuterSandboxID
	oldSpace := beforeClose.Sandbox.WispSMHSpaceID
	if oldOuter == "" || oldSpace == "" || !beforeClose.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("before close missing runtime/workspace identity: %s", string(beforeClose.Raw))
	}

	if err := client.CloseSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/close: %v", err)
	}
	afterClose, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after close: %v", err)
	}
	if !afterClose.Closed || afterClose.Sandbox.OuterSandboxID != "" || afterClose.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("close should clear both live runtime targets: %s", string(afterClose.Raw))
	}
	if afterClose.Sandbox.WispSMHSpaceID != oldSpace {
		t.Fatalf("close should keep Wisp/SMH anchor: before=%s after=%s raw=%s", oldSpace, afterClose.Sandbox.WispSMHSpaceID, string(afterClose.Raw))
	}

	if _, err := client.ResumeSession(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()}); err != nil {
		t.Fatalf("session/resume: %v", err)
	}
	afterResume, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after resume: %v", err)
	}
	if afterResume.Sandbox.OuterSandboxID == "" || afterResume.Sandbox.OuterSandboxID == oldOuter || !afterResume.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("resume should recreate both runtime targets: old_outer=%s raw=%s", oldOuter, string(afterResume.Raw))
	}
	if afterResume.Sandbox.WispSMHSpaceID != oldSpace {
		t.Fatalf("resume should keep Wisp/SMH anchor: before=%s after=%s raw=%s", oldSpace, afterResume.Sandbox.WispSMHSpaceID, string(afterResume.Raw))
	}

	output.Reset()
	read, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `cat "+remotePath+"`。命令结束后只输出终端里的 cloudagent-file-restore 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("read restored workspace file prompt: %v", err)
	}
	if !isNormalStopReason(read.StopReason) {
		t.Fatalf("unexpected read stopReason %q raw=%s", read.StopReason, string(read.Raw))
	}
	if !strings.Contains(output.CombinedString(), needle) {
		t.Fatalf("restored prompt output missing marker %q: got=%q raw=%s", needle, output.CombinedString(), string(read.Raw))
	}
	if got := string(liveDownloadEnvdFile(t, ctx, session.SessionID, remotePath)); !strings.Contains(got, needle) {
		t.Fatalf("envd download after restore missing marker %q: got=%q", needle, got)
	}

	deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer deleteCancel()
	if err := client.DeleteSession(deleteCtx, session.SessionID); err == nil {
		deleted = true
	} else {
		t.Logf("session/delete cleanup failed after behavior assertions passed: %v", err)
	}
}

func TestCloudAgentLiveStreamDisconnectCompletesAndReplays(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: output.notification})

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-stream-disconnect-e2e",
		ClientTitle:   "CloudAgent ACP Live Stream Disconnect E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	sessionID := session.SessionID
	deleted := false
	defer func() {
		if deleted {
			return
		}
		cleanupClient := newLiveCloudAgentClient(t)
		defer cleanupClient.Close()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cleanupCancel()
		_, _ = cleanupClient.Initialize(cleanupCtx, CloudAgentClientOptions{
			ClientName:    "cloudagent-acp-live-stream-disconnect-cleanup",
			ClientTitle:   "CloudAgent ACP Live Stream Disconnect Cleanup",
			ClientVersion: "0.1.0",
		})
		_ = cleanupClient.DeleteSession(cleanupCtx, sessionID)
	}()

	needle := "cloudagent-stream-disconnect-" + strings.ReplaceAll(sessionID, "_", "-")
	promptDone := make(chan error, 1)
	go func() {
		_, err := client.Prompt(ctx, sessionID, "请先输出 STREAM_DISCONNECT_BEGIN，然后必须调用 terminal 执行 `sleep 6 && echo "+needle+"`。命令结束后只追加终端输出的 cloudagent-stream-disconnect 标记。", CloudAgentPromptOptions{
			CWD:       liveCWD(),
			InboxMode: CloudAgentInboxPrompt,
		})
		promptDone <- err
	}()
	waitForLiveOutputContains(t, ctx, output, "STREAM_DISCONNECT_BEGIN")
	_ = client.Close()
	select {
	case err := <-promptDone:
		if err == nil {
			t.Fatalf("prompt call should end with connection close after client disconnect")
		}
	case <-time.After(15 * time.Second):
		t.Fatal("prompt call did not unblock after client disconnect")
	}

	reconnectedOutput := &liveAgentOutput{}
	reconnected := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: reconnectedOutput.notification})
	defer reconnected.Close()
	if _, err := reconnected.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-stream-disconnect-reconnect",
		ClientTitle:   "CloudAgent ACP Live Stream Disconnect Reconnect",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize reconnected client: %v", err)
	}
	waitForLiveSessionReady(t, ctx, reconnected, sessionID)
	if _, err := reconnected.LoadSession(ctx, sessionID, CloudAgentSessionOptions{CWD: liveCWD()}); err != nil {
		t.Fatalf("session/load after stream disconnect: %v", err)
	}
	if !strings.Contains(reconnectedOutput.CombinedString(), needle) {
		t.Fatalf("replayed transcript missing post-disconnect marker %q: got=%q", needle, reconnectedOutput.CombinedString())
	}
	if err := reconnected.DeleteSession(ctx, sessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveCloseThenPromptRestoresAndUsesWorkspaceTool(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_RESTORE") {
		t.Skip("set CLOUDAGENT_ACP_E2E_RESTORE=1 to run close then tool restore e2e")
	}
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: output.notification})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-close-tool-restore-e2e",
		ClientTitle:   "CloudAgent ACP Live Close Tool Restore E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if deleted {
			return
		}
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	needle := "cloudagent-close-tool-restore-" + strings.ReplaceAll(session.SessionID, "_", "-")
	remotePath := "/workspace/e2e/close-tool-restore.txt"
	liveUploadEnvdFile(t, ctx, session.SessionID, remotePath, "text/plain", []byte(needle+"\n"))
	waitForLiveEnvdFileContains(t, ctx, session.SessionID, remotePath, needle)
	beforeClose, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status before close: %v", err)
	}
	oldSpace := beforeClose.Sandbox.WispSMHSpaceID
	if oldSpace == "" || beforeClose.Sandbox.OuterSandboxID == "" || !beforeClose.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("before close missing runtime/workspace identity: %s", string(beforeClose.Raw))
	}
	if err := client.CloseSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/close: %v", err)
	}
	afterClose, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after close: %v", err)
	}
	if !afterClose.Closed || afterClose.Sandbox.OuterSandboxID != "" || afterClose.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("closed session should have no live runtime targets: %s", string(afterClose.Raw))
	}

	output.Reset()
	result, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `ls -la /workspace/e2e && cat "+remotePath+"`。命令结束后只输出终端里的文件名和 cloudagent-close-tool-restore 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("prompt should restore closed session and run workspace tool: %v", err)
	}
	if !isNormalStopReason(result.StopReason) {
		t.Fatalf("unexpected restore tool stopReason %q raw=%s", result.StopReason, string(result.Raw))
	}
	outputText := output.CombinedString()
	for _, want := range []string{"close-tool-restore.txt", needle} {
		if !strings.Contains(outputText, want) {
			t.Fatalf("restored tool output missing %q: got=%q raw=%s", want, outputText, string(result.Raw))
		}
	}
	for _, forbidden := range []string{"runtime_not_recovered", "HTTP 500", "openresty", "sandbox-host process.exec HTTP transport failed", "sandbox-host fs.list HTTP transport failed"} {
		if strings.Contains(outputText, forbidden) {
			t.Fatalf("restored tool prompt surfaced forbidden failure %q: got=%q raw=%s", forbidden, outputText, string(result.Raw))
		}
	}
	afterPrompt, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after restore prompt: %v", err)
	}
	if afterPrompt.Closed || afterPrompt.ReadOnly || afterPrompt.Sandbox.OuterSandboxID == "" || !afterPrompt.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("restore prompt should leave session writable with both runtime targets: %s", string(afterPrompt.Raw))
	}
	if afterPrompt.Sandbox.WispSMHSpaceID != oldSpace {
		t.Fatalf("restore prompt should keep workspace anchor: before=%s after=%s raw=%s", oldSpace, afterPrompt.Sandbox.WispSMHSpaceID, string(afterPrompt.Raw))
	}
	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveRepeatedCloseResumeKeepsWorkspaceAnchor(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_RESTORE") {
		t.Skip("set CLOUDAGENT_ACP_E2E_RESTORE=1 to run repeated close/resume e2e")
	}
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: output.notification})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-repeat-close-resume-e2e",
		ClientTitle:   "CloudAgent ACP Live Repeat Close Resume E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if deleted {
			return
		}
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	needle := "cloudagent-repeat-close-resume-" + strings.ReplaceAll(session.SessionID, "_", "-")
	remotePath := "/workspace/e2e/repeated-close-resume.txt"
	create, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `mkdir -p /workspace/e2e && printf '"+needle+"\\n' > "+remotePath+" && cat "+remotePath+"`。命令结束后只输出终端里的 cloudagent-repeat-close-resume 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("create repeated restore file: %v", err)
	}
	if !isNormalStopReason(create.StopReason) {
		t.Fatalf("unexpected create stopReason %q raw=%s", create.StopReason, string(create.Raw))
	}
	before, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status before repeated close/resume: %v", err)
	}
	workspaceAnchor := before.Sandbox.WispSMHSpaceID
	seenOuters := map[string]bool{before.Sandbox.OuterSandboxID: true}
	if workspaceAnchor == "" || before.Sandbox.OuterSandboxID == "" {
		t.Fatalf("initial session missing runtime/workspace identity: %s", string(before.Raw))
	}

	for i := 1; i <= 2; i++ {
		if err := client.CloseSession(ctx, session.SessionID); err != nil {
			t.Fatalf("session/close round %d: %v", i, err)
		}
		closed, err := client.Status(ctx, session.SessionID)
		if err != nil {
			t.Fatalf("status after close round %d: %v", i, err)
		}
		if !closed.Closed || closed.Sandbox.OuterSandboxID != "" || closed.Sandbox.HasInnerEnvdTarget || closed.Sandbox.WispSMHSpaceID != workspaceAnchor {
			t.Fatalf("close round %d should clear live targets and preserve anchor: %s", i, string(closed.Raw))
		}
		if _, err := client.ResumeSession(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()}); err != nil {
			t.Fatalf("session/resume round %d: %v", i, err)
		}
		resumed, err := client.Status(ctx, session.SessionID)
		if err != nil {
			t.Fatalf("status after resume round %d: %v", i, err)
		}
		if resumed.Closed || resumed.ReadOnly || resumed.Sandbox.OuterSandboxID == "" || !resumed.Sandbox.HasInnerEnvdTarget || resumed.Sandbox.WispSMHSpaceID != workspaceAnchor {
			t.Fatalf("resume round %d should restore writable runtime with same anchor: %s", i, string(resumed.Raw))
		}
		if seenOuters[resumed.Sandbox.OuterSandboxID] {
			t.Fatalf("resume round %d reused outer sandbox %s; seen=%#v raw=%s", i, resumed.Sandbox.OuterSandboxID, seenOuters, string(resumed.Raw))
		}
		seenOuters[resumed.Sandbox.OuterSandboxID] = true
		output.Reset()
		read, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `cat "+remotePath+"`。命令结束后只输出终端里的 cloudagent-repeat-close-resume 标记。", CloudAgentPromptOptions{
			CWD:       liveCWD(),
			InboxMode: CloudAgentInboxPrompt,
		})
		if err != nil {
			t.Fatalf("read after resume round %d: %v", i, err)
		}
		if !isNormalStopReason(read.StopReason) {
			t.Fatalf("unexpected read round %d stopReason %q raw=%s", i, read.StopReason, string(read.Raw))
		}
		if !strings.Contains(output.CombinedString(), needle) {
			t.Fatalf("read after resume round %d missing marker %q: got=%q raw=%s", i, needle, output.CombinedString(), string(read.Raw))
		}
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveMultiTurnRepeatedCloseResumeKeepsHistoryAndWorkspace(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_RESTORE") {
		t.Skip("set CLOUDAGENT_ACP_E2E_RESTORE=1 to run multi-turn repeated close/resume e2e")
	}
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: output.notification})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-multiturn-repeated-restore-e2e",
		ClientTitle:   "CloudAgent ACP Live MultiTurn Repeated Restore E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if deleted {
			return
		}
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	base := "cloudagent-multiturn-restore-" + strings.ReplaceAll(session.SessionID, "_", "-")
	firstMarker := base + "-turn1"
	secondMarker := base + "-turn2"
	filePath := "/workspace/e2e/multiturn-repeated-restore.txt"

	first, err := client.Prompt(ctx, session.SessionID, "第一轮：请只回答 MULTITURN_TURN1_READY。请记住唯一标记 "+firstMarker+"。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("turn1 prompt: %v", err)
	}
	if !isNormalStopReason(first.StopReason) {
		t.Fatalf("unexpected turn1 stopReason %q raw=%s", first.StopReason, string(first.Raw))
	}
	beforeClose, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status before first close: %v", err)
	}
	workspaceAnchor := beforeClose.Sandbox.WispSMHSpaceID
	if workspaceAnchor == "" || beforeClose.Sandbox.OuterSandboxID == "" || !beforeClose.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("before first close missing runtime/workspace identity: %s", string(beforeClose.Raw))
	}
	seenOuters := map[string]bool{beforeClose.Sandbox.OuterSandboxID: true}

	if err := client.CloseSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/close first round: %v", err)
	}
	closed1, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after first close: %v", err)
	}
	if !closed1.Closed || closed1.Sandbox.OuterSandboxID != "" || closed1.Sandbox.HasInnerEnvdTarget || closed1.Sandbox.WispSMHSpaceID != workspaceAnchor {
		t.Fatalf("first close should clear live targets and preserve anchor: %s", string(closed1.Raw))
	}
	if _, err := client.ResumeSession(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()}); err != nil {
		t.Fatalf("session/resume first round: %v", err)
	}
	resumed1, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after first resume: %v", err)
	}
	if resumed1.Closed || resumed1.ReadOnly || resumed1.Sandbox.OuterSandboxID == "" || !resumed1.Sandbox.HasInnerEnvdTarget || resumed1.Sandbox.WispSMHSpaceID != workspaceAnchor {
		t.Fatalf("first resume should restore writable runtime with same anchor: %s", string(resumed1.Raw))
	}
	if seenOuters[resumed1.Sandbox.OuterSandboxID] {
		t.Fatalf("first resume reused outer sandbox %s; seen=%#v raw=%s", resumed1.Sandbox.OuterSandboxID, seenOuters, string(resumed1.Raw))
	}
	seenOuters[resumed1.Sandbox.OuterSandboxID] = true

	output.Reset()
	second, err := client.Prompt(ctx, session.SessionID, "第二轮：请查看上一轮对话，必须输出 "+firstMarker+"。然后调用 terminal 执行 `mkdir -p /workspace/e2e && printf '"+firstMarker+"\\n"+secondMarker+"\\n' > "+filePath+" && cat "+filePath+"`。命令结束后只输出两个 cloudagent-multiturn-restore 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("turn2 prompt after first resume: %v", err)
	}
	if !isNormalStopReason(second.StopReason) {
		t.Fatalf("unexpected turn2 stopReason %q raw=%s", second.StopReason, string(second.Raw))
	}
	for _, want := range []string{firstMarker, secondMarker} {
		if !strings.Contains(output.CombinedString(), want) {
			t.Fatalf("turn2 output missing %q after first resume: got=%q raw=%s", want, output.CombinedString(), string(second.Raw))
		}
	}
	waitForLiveEnvdFileContains(t, ctx, session.SessionID, filePath, secondMarker)

	if err := client.CloseSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/close second round: %v", err)
	}
	closed2, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after second close: %v", err)
	}
	if !closed2.Closed || closed2.Sandbox.OuterSandboxID != "" || closed2.Sandbox.HasInnerEnvdTarget || closed2.Sandbox.WispSMHSpaceID != workspaceAnchor {
		t.Fatalf("second close should clear live targets and preserve anchor: %s", string(closed2.Raw))
	}
	if _, err := client.ResumeSession(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()}); err != nil {
		t.Fatalf("session/resume second round: %v", err)
	}
	resumed2, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after second resume: %v", err)
	}
	if resumed2.Closed || resumed2.ReadOnly || resumed2.Sandbox.OuterSandboxID == "" || !resumed2.Sandbox.HasInnerEnvdTarget || resumed2.Sandbox.WispSMHSpaceID != workspaceAnchor {
		t.Fatalf("second resume should restore writable runtime with same anchor: %s", string(resumed2.Raw))
	}
	if seenOuters[resumed2.Sandbox.OuterSandboxID] {
		t.Fatalf("second resume reused outer sandbox %s; seen=%#v raw=%s", resumed2.Sandbox.OuterSandboxID, seenOuters, string(resumed2.Raw))
	}

	output.Reset()
	third, err := client.Prompt(ctx, session.SessionID, "第三轮：请查看完整对话历史，并调用 terminal 执行 `cat "+filePath+"`。最终只输出 "+firstMarker+" 和 "+secondMarker+"，不要解释。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("turn3 prompt after second resume: %v", err)
	}
	if !isNormalStopReason(third.StopReason) {
		t.Fatalf("unexpected turn3 stopReason %q raw=%s", third.StopReason, string(third.Raw))
	}
	combined := output.CombinedString()
	for _, want := range []string{firstMarker, secondMarker} {
		if !strings.Contains(combined, want) {
			t.Fatalf("turn3 output missing %q after repeated restore: got=%q raw=%s", want, combined, string(third.Raw))
		}
	}
	for _, forbidden := range []string{"runtime_not_recovered", "session_read_only", "HTTP 500", "openresty", "No such file"} {
		if strings.Contains(combined, forbidden) {
			t.Fatalf("turn3 surfaced forbidden restore/workspace failure %q: got=%q raw=%s", forbidden, combined, string(third.Raw))
		}
	}
	if downloaded := string(liveDownloadEnvdFile(t, ctx, session.SessionID, filePath)); !strings.Contains(downloaded, firstMarker) || !strings.Contains(downloaded, secondMarker) {
		t.Fatalf("downloaded workspace file after repeated restore missing markers: %q", downloaded)
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveLoadClosedRestorableSessionRecoversOnPrompt(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_RESTORE") {
		t.Skip("set CLOUDAGENT_ACP_E2E_RESTORE=1 to run closed session/load restore e2e")
	}
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	var sessionID string
	deleted := false
	defer func() {
		if sessionID != "" && !deleted {
			deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer deleteCancel()
			_ = client.DeleteSession(deleteCtx, sessionID)
		}
		_ = client.Close()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-load-closed-e2e",
		ClientTitle:   "CloudAgent ACP Live Load Closed E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	sessionID = session.SessionID

	needle := "cloudagent-load-closed-" + strings.ReplaceAll(session.SessionID, "_", "-")
	prepare, err := client.Prompt(ctx, session.SessionID, "请只回答 LOAD_CLOSED_READY。为了 load closed 恢复校验，这条用户消息包含唯一标记 "+needle+"。", CloudAgentPromptOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("prepare prompt: %v", err)
	}
	if !isNormalStopReason(prepare.StopReason) {
		t.Fatalf("unexpected prepare stopReason %q raw=%s", prepare.StopReason, string(prepare.Raw))
	}
	beforeClose, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status before close: %v", err)
	}
	oldOuter := beforeClose.Sandbox.OuterSandboxID
	oldSpace := beforeClose.Sandbox.WispSMHSpaceID
	if oldOuter == "" || oldSpace == "" {
		t.Fatalf("before close missing runtime/workspace identity: %s", string(beforeClose.Raw))
	}
	if !beforeClose.WorkspacePersistent || !beforeClose.RuntimeRestorable {
		t.Fatalf("before close should be workspace-persistent/restorable: %s", string(beforeClose.Raw))
	}

	if err := client.CloseSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/close: %v", err)
	}
	afterClose, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after close: %v", err)
	}
	if !afterClose.Closed || !afterClose.RuntimeRestorable || !afterClose.WorkspacePersistent {
		t.Fatalf("closed session should remain restorable: %s", string(afterClose.Raw))
	}
	if afterClose.Sandbox.OuterSandboxID != "" {
		t.Fatalf("closed session should not retain outer sandbox id: %s", string(afterClose.Raw))
	}
	if afterClose.Sandbox.WispSMHSpaceID != oldSpace {
		t.Fatalf("workspace changed after close: before=%s after=%s raw=%s", oldSpace, afterClose.Sandbox.WispSMHSpaceID, string(afterClose.Raw))
	}

	if err := client.Close(); err != nil {
		t.Fatalf("close first connection: %v", err)
	}
	output.Reset()
	client = newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-load-closed-reconnect-e2e",
		ClientTitle:   "CloudAgent ACP Live Load Closed Reconnect E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize reconnected client: %v", err)
	}
	loaded, err := client.LoadSession(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/load closed restorable session: %v", err)
	}
	if loaded.ReadOnly {
		t.Fatalf("session/load should keep closed restorable session writable: %+v", loaded)
	}
	afterLoad, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after loading closed restorable session: %v", err)
	}
	if !afterLoad.Closed || afterLoad.Sandbox.OuterSandboxID != "" || afterLoad.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("session/load must not restore runtime targets: %s", string(afterLoad.Raw))
	}
	if afterLoad.Sandbox.WispSMHSpaceID != oldSpace {
		t.Fatalf("session/load should keep workspace anchor without restore: before=%s after=%s raw=%s", oldSpace, afterLoad.Sandbox.WispSMHSpaceID, string(afterLoad.Raw))
	}

	recovered, err := client.Prompt(ctx, session.SessionID, "请查看本对话历史，复制其中以 cloudagent-load-closed- 开头的唯一标记。不要解释，只输出标记本身。", CloudAgentPromptOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("prompt after session/load closed restorable session: %v", err)
	}
	if !isNormalStopReason(recovered.StopReason) {
		t.Fatalf("unexpected recovered stopReason %q raw=%s", recovered.StopReason, string(recovered.Raw))
	}
	if outputText := output.String(); !strings.Contains(outputText, needle) {
		t.Fatalf("prompt after session/load did not recover runtime transcript: want=%q got=%q raw=%s", needle, outputText, string(recovered.Raw))
	}
	afterPrompt, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after prompt restore: %v", err)
	}
	if afterPrompt.Closed || afterPrompt.ReadOnly {
		t.Fatalf("prompt restore should reopen writable session: %s", string(afterPrompt.Raw))
	}
	if afterPrompt.Sandbox.OuterSandboxID == "" || afterPrompt.Sandbox.OuterSandboxID == oldOuter {
		t.Fatalf("prompt restore should create a new outer sandbox: before=%s after=%s raw=%s", oldOuter, afterPrompt.Sandbox.OuterSandboxID, string(afterPrompt.Raw))
	}
	if afterPrompt.Sandbox.WispSMHSpaceID != oldSpace {
		t.Fatalf("prompt restore should keep workspace space: before=%s after=%s raw=%s", oldSpace, afterPrompt.Sandbox.WispSMHSpaceID, string(afterPrompt.Raw))
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveGatewayRestartLoadsClosedWorkspaceAndRestores(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_RESTORE") {
		t.Skip("set CLOUDAGENT_ACP_E2E_RESTORE=1 to run gateway restart restore e2e")
	}
	if strings.TrimSpace(os.Getenv("CLOUDAGENT_ACP_E2E_GATEWAY_RESTART_COMMAND")) == "" {
		t.Skip("set CLOUDAGENT_ACP_E2E_GATEWAY_RESTART_COMMAND to run gateway process restart e2e")
	}
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: output.notification})

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-gateway-restart-e2e",
		ClientTitle:   "CloudAgent ACP Live Gateway Restart E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	sessionID := session.SessionID
	deleted := false
	defer func() {
		if deleted {
			return
		}
		cleanupClient := newLiveCloudAgentClient(t)
		defer cleanupClient.Close()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cleanupCancel()
		_, _ = cleanupClient.Initialize(cleanupCtx, CloudAgentClientOptions{
			ClientName:    "cloudagent-acp-live-gateway-restart-cleanup",
			ClientTitle:   "CloudAgent ACP Live Gateway Restart Cleanup",
			ClientVersion: "0.1.0",
		})
		_ = cleanupClient.DeleteSession(cleanupCtx, sessionID)
	}()

	needle := "cloudagent-gateway-restart-" + strings.ReplaceAll(sessionID, "_", "-")
	remotePath := "/workspace/e2e/gateway-restart.txt"
	create, err := client.Prompt(ctx, sessionID, "必须调用 terminal 执行 `mkdir -p /workspace/e2e && printf '"+needle+"\\n' > "+remotePath+" && cat "+remotePath+"`。命令结束后只输出终端里的 cloudagent-gateway-restart 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("create file before gateway restart: %v", err)
	}
	if !isNormalStopReason(create.StopReason) {
		t.Fatalf("unexpected create stopReason %q raw=%s", create.StopReason, string(create.Raw))
	}
	beforeClose, err := client.Status(ctx, sessionID)
	if err != nil {
		t.Fatalf("status before close: %v", err)
	}
	oldSpace := beforeClose.Sandbox.WispSMHSpaceID
	if oldSpace == "" {
		t.Fatalf("missing Wisp/SMH anchor before gateway restart: %s", string(beforeClose.Raw))
	}
	if err := client.CloseSession(ctx, sessionID); err != nil {
		t.Fatalf("session/close: %v", err)
	}
	_ = client.Close()

	liveRestartGateway(t, ctx)

	output.Reset()
	client = newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: output.notification})
	defer client.Close()
	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-gateway-restart-reconnect",
		ClientTitle:   "CloudAgent ACP Live Gateway Restart Reconnect",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize after gateway restart: %v", err)
	}
	if _, err := client.LoadSession(ctx, sessionID, CloudAgentSessionOptions{CWD: liveCWD()}); err != nil {
		t.Fatalf("session/load after gateway restart: %v", err)
	}
	ready, err := client.EnsureRuntimeReady(ctx, sessionID, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("ensure_ready after gateway restart: %v", err)
	}
	if ready.Sandbox.OuterSandboxID == "" || ready.Sandbox.WispSMHSpaceID != oldSpace {
		t.Fatalf("ensure_ready after gateway restart should restore same workspace anchor: before=%s raw=%s", oldSpace, string(ready.Raw))
	}
	read, err := client.Prompt(ctx, sessionID, "必须调用 terminal 执行 `cat "+remotePath+"`。命令结束后只输出终端里的 cloudagent-gateway-restart 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("prompt after gateway restart restore: %v", err)
	}
	if !isNormalStopReason(read.StopReason) {
		t.Fatalf("unexpected read stopReason %q raw=%s", read.StopReason, string(read.Raw))
	}
	if !strings.Contains(output.CombinedString(), needle) {
		t.Fatalf("prompt after gateway restart missing marker %q: got=%q raw=%s", needle, output.CombinedString(), string(read.Raw))
	}
	if err := client.DeleteSession(ctx, sessionID); err != nil {
		t.Fatalf("session/delete after gateway restart: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveWorkspaceLifecycleNotificationsForCloseAndRestore(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_RESTORE") {
		t.Skip("set CLOUDAGENT_ACP_E2E_RESTORE=1 to run workspace lifecycle notification e2e")
	}
	events := &liveCloudAgentEvents{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: events.notification})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-lifecycle-e2e",
		ClientTitle:   "CloudAgent ACP Live Lifecycle E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if deleted {
			return
		}
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	if err := client.CloseSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/close: %v", err)
	}
	storageDone := events.waitLifecycle(t, ctx, session.SessionID, "storage", "cleanup", "done")
	if storageDone["lifecycle_id"] != "storage:"+session.SessionID+":cleanup" {
		t.Fatalf("unexpected storage lifecycle id: %#v", storageDone)
	}
	if storageDone["elapsed_ms"] == nil || storageDone["timestamp"] == "" {
		t.Fatalf("storage lifecycle should include timing fields: %#v", storageDone)
	}

	ready, err := client.EnsureRuntimeReady(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("ensure_ready after close: %v", err)
	}
	if !isCloudAgentWorkspaceWellDone(ready) {
		t.Fatalf("ensure_ready should return workspace well-done status: %s", string(ready.Raw))
	}
	events.assertLifecycleSeen(t, session.SessionID, "restore", "start", "running")
	events.assertLifecycleSeen(t, session.SessionID, "restore", "lease_wait", "running")
	events.assertLifecycleSeen(t, session.SessionID, "restore", "lease_wait", "done")
	events.assertLifecycleSeen(t, session.SessionID, "restore", "runtime", "running")
	events.assertLifecycleSeen(t, session.SessionID, "restore", "runtime", "done")
	restoreDone := events.waitLifecycle(t, ctx, session.SessionID, "restore", "ready", "done")
	if restoreDone["lifecycle_id"] != "restore:"+session.SessionID+":ready" {
		t.Fatalf("unexpected restore lifecycle id: %#v", restoreDone)
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveCloseAndDeleteHaveDifferentRecoverySemantics(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_RESTORE") {
		t.Skip("set CLOUDAGENT_ACP_E2E_RESTORE=1 to run close/delete semantic split e2e")
	}
	client := newLiveCloudAgentClient(t)
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-close-delete-e2e",
		ClientTitle:   "CloudAgent ACP Live Close Delete E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if deleted {
			return
		}
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	if err := client.CloseSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/close: %v", err)
	}
	closed, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after close: %v", err)
	}
	if !closed.Closed || !closed.RuntimeRestorable || !closed.WorkspacePersistent {
		t.Fatalf("session/close should leave a restorable workspace: %s", string(closed.Raw))
	}
	if _, err := client.ResumeSession(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()}); err != nil {
		t.Fatalf("session/resume after close: %v", err)
	}
	resumed, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after resume: %v", err)
	}
	if resumed.Closed || resumed.ReadOnly || resumed.Sandbox.OuterSandboxID == "" {
		t.Fatalf("resume should make closed session live again: %s", string(resumed.Raw))
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
	if _, err := client.Status(ctx, session.SessionID); err == nil {
		t.Fatalf("status should fail after session/delete")
	}
	if _, err := client.ResumeSession(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()}); err == nil {
		t.Fatalf("session/resume should fail after session/delete")
	}
}

func TestCloudAgentLiveConcurrentEnsureReadyConvergesAfterClose(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_RESTORE") {
		t.Skip("set CLOUDAGENT_ACP_E2E_RESTORE=1 to run concurrent ensure_ready restore e2e")
	}
	client := newLiveCloudAgentClient(t)
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-concurrent-restore-e2e",
		ClientTitle:   "CloudAgent ACP Live Concurrent Restore E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if deleted {
			return
		}
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()
	if err := client.CloseSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/close: %v", err)
	}

	type ensureResult struct {
		status CloudAgentSessionStatus
		err    error
	}
	runEnsure := func(name string) ensureResult {
		c := newLiveCloudAgentClient(t)
		defer c.Close()
		if _, err := c.Initialize(ctx, CloudAgentClientOptions{
			ClientName:    name,
			ClientTitle:   name,
			ClientVersion: "0.1.0",
		}); err != nil {
			return ensureResult{err: err}
		}
		status, err := c.EnsureRuntimeReady(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()})
		return ensureResult{status: status, err: err}
	}
	results := make(chan ensureResult, 2)
	go func() { results <- runEnsure("cloudagent-acp-live-concurrent-restore-a") }()
	go func() { results <- runEnsure("cloudagent-acp-live-concurrent-restore-b") }()

	var successes []CloudAgentSessionStatus
	var retryableErrors []error
	for i := 0; i < 2; i++ {
		select {
		case result := <-results:
			if result.err != nil {
				if strings.Contains(strings.ToLower(result.err.Error()), "ownership") ||
					strings.Contains(strings.ToLower(result.err.Error()), "held") {
					retryableErrors = append(retryableErrors, result.err)
					continue
				}
				t.Fatalf("concurrent ensure_ready failed with non-retryable error: %v", result.err)
			}
			successes = append(successes, result.status)
		case <-ctx.Done():
			t.Fatalf("timed out waiting for concurrent ensure_ready: %v", ctx.Err())
		}
	}
	if len(successes) == 0 {
		status, err := client.EnsureRuntimeReady(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()})
		if err != nil {
			t.Fatalf("ensure_ready retry after ownership contention failed; prior=%v retry=%v", retryableErrors, err)
		}
		successes = append(successes, status)
	}
	finalStatus, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after concurrent ensure_ready: %v", err)
	}
	if finalStatus.Closed || finalStatus.ReadOnly || finalStatus.Sandbox.OuterSandboxID == "" {
		t.Fatalf("concurrent ensure_ready should converge to one live runtime: %s", string(finalStatus.Raw))
	}
	for _, status := range successes {
		if status.Sandbox.OuterSandboxID != "" && status.Sandbox.OuterSandboxID != finalStatus.Sandbox.OuterSandboxID {
			t.Fatalf("concurrent ensure_ready returned divergent outer runtime: success=%s final=%s", string(status.Raw), string(finalStatus.Raw))
		}
	}
	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveFollowUpQueuesBehindActivePrompt(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_INBOX") {
		t.Skip("set CLOUDAGENT_ACP_E2E_INBOX=1 to run live inbox queue e2e")
	}
	activeOutput := &liveAgentOutput{}
	activeClient := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: activeOutput.notification})
	defer activeClient.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := activeClient.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-followup-active-e2e",
		ClientTitle:   "CloudAgent ACP Live FollowUp Active E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize active client: %v", err)
	}
	session, err := activeClient.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if deleted {
			return
		}
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer deleteCancel()
		_ = activeClient.DeleteSession(deleteCtx, session.SessionID)
	}()

	activeMarker := "INBOX_ACTIVE_DONE_" + strings.ReplaceAll(session.SessionID, "_", "-")
	followMarker := "INBOX_FOLLOWUP_DONE_" + strings.ReplaceAll(session.SessionID, "_", "-")
	activeDone := make(chan error, 1)
	go func() {
		_, err := activeClient.Prompt(ctx, session.SessionID, "请先输出 INBOX_ACTIVE_BEGIN，然后必须调用 terminal 执行 `sleep 6 && echo "+activeMarker+"`。命令结束后只输出终端标记。", CloudAgentPromptOptions{
			CWD:       liveCWD(),
			InboxMode: CloudAgentInboxPrompt,
		})
		activeDone <- err
	}()
	waitForLiveOutputContains(t, ctx, activeOutput, "INBOX_ACTIVE_BEGIN")

	followOutput := &liveAgentOutput{}
	followClient := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: followOutput.notification})
	defer followClient.Close()
	if _, err := followClient.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-followup-queued-e2e",
		ClientTitle:   "CloudAgent ACP Live FollowUp Queued E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize followup client: %v", err)
	}
	followDone := make(chan error, 1)
	go func() {
		result, err := followClient.FollowUp(ctx, session.SessionID, "请只回答 "+followMarker+"。")
		if err == nil && !isNormalStopReason(result.StopReason) {
			err = fmt.Errorf("unexpected follow_up stopReason %q raw=%s", result.StopReason, string(result.Raw))
		}
		followDone <- err
	}()

	select {
	case err := <-activeDone:
		if err != nil {
			t.Fatalf("active prompt failed: %v", err)
		}
	case <-ctx.Done():
		t.Fatalf("active prompt did not finish: %v", ctx.Err())
	}
	if !strings.Contains(activeOutput.CombinedString(), activeMarker) {
		t.Fatalf("active prompt missing marker %q: got=%q", activeMarker, activeOutput.CombinedString())
	}
	select {
	case err := <-followDone:
		if err != nil {
			t.Fatalf("follow_up prompt failed: %v", err)
		}
	case <-ctx.Done():
		t.Fatalf("follow_up prompt did not finish after active prompt: %v", ctx.Err())
	}
	if !strings.Contains(followOutput.CombinedString(), followMarker) {
		t.Fatalf("follow_up output missing marker %q: got=%q", followMarker, followOutput.CombinedString())
	}
	status, err := activeClient.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after follow_up queue: %v", err)
	}
	if status.Closed || status.ReadOnly || status.RuntimeStatus == "prompting" {
		t.Fatalf("follow_up queue should leave session ready/writable: %s", string(status.Raw))
	}
	if err := activeClient.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveCancelActivePromptSettlesSession(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_INBOX") {
		t.Skip("set CLOUDAGENT_ACP_E2E_INBOX=1 to run live cancel inbox e2e")
	}
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: output.notification})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-cancel-active-e2e",
		ClientTitle:   "CloudAgent ACP Live Cancel Active E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if deleted {
			return
		}
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	promptDone := make(chan error, 1)
	go func() {
		_, err := client.Prompt(ctx, session.SessionID, "请先输出 INBOX_CANCEL_BEGIN，然后必须调用 terminal 执行 `sleep 30 && echo INBOX_CANCEL_SHOULD_NOT_FINISH`。命令结束后只输出终端标记。", CloudAgentPromptOptions{
			CWD:       liveCWD(),
			InboxMode: CloudAgentInboxPrompt,
		})
		promptDone <- err
	}()
	waitForLiveOutputContains(t, ctx, output, "INBOX_CANCEL_BEGIN")

	control := newLiveCloudAgentClient(t)
	defer control.Close()
	if _, err := control.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-cancel-control-e2e",
		ClientTitle:   "CloudAgent ACP Live Cancel Control E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize control client: %v", err)
	}
	if err := control.AbortSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/cancel active prompt: %v", err)
	}
	select {
	case err := <-promptDone:
		if err != nil {
			lower := strings.ToLower(err.Error())
			if !strings.Contains(lower, "cancel") && !strings.Contains(lower, "abort") && !strings.Contains(lower, "closed") {
				t.Fatalf("active prompt returned unexpected cancel error: %v", err)
			}
		}
	case <-time.After(90 * time.Second):
		t.Fatal("active prompt did not settle after session/cancel")
	}
	if strings.Contains(output.CombinedString(), "INBOX_CANCEL_SHOULD_NOT_FINISH") {
		t.Fatalf("cancelled prompt still completed long-running command: %q", output.CombinedString())
	}
	ready := waitForLiveSessionReady(t, ctx, control, session.SessionID)
	if ready.Closed || ready.ReadOnly || ready.RuntimeStatus == "prompting" {
		t.Fatalf("cancel should settle session back to writable ready state: %s", string(ready.Raw))
	}
	if err := control.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveCloseDuringActiveToolRunCanResume(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_RESTORE") {
		t.Skip("set CLOUDAGENT_ACP_E2E_RESTORE=1 to run active close/resume e2e")
	}
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: output.notification})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-active-close-e2e",
		ClientTitle:   "CloudAgent ACP Live Active Close E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if deleted {
			return
		}
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	promptDone := make(chan error, 1)
	go func() {
		_, err := client.Prompt(ctx, session.SessionID, "请先输出 ACTIVE_CLOSE_BEGIN，然后必须调用 terminal 执行 `sleep 20 && echo ACTIVE_CLOSE_TOOL_DONE`。命令结束后只输出终端标记。", CloudAgentPromptOptions{
			CWD:       liveCWD(),
			InboxMode: CloudAgentInboxPrompt,
		})
		promptDone <- err
	}()
	waitForLiveOutputContains(t, ctx, output, "ACTIVE_CLOSE_BEGIN")

	closeClient := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: output.notification})
	defer closeClient.Close()
	if _, err := closeClient.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-active-close-control",
		ClientTitle:   "CloudAgent ACP Live Active Close Control",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize close client: %v", err)
	}
	if err := closeClient.CloseSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/close during active prompt: %v", err)
	}
	select {
	case err := <-promptDone:
		if err != nil && !strings.Contains(strings.ToLower(err.Error()), "closed") && !strings.Contains(strings.ToLower(err.Error()), "cancel") {
			t.Fatalf("active prompt returned unexpected error after close: %v", err)
		}
	case <-time.After(90 * time.Second):
		t.Fatal("active prompt did not settle after session/close")
	}

	if _, err := closeClient.ResumeSession(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()}); err != nil {
		t.Fatalf("session/resume after active close: %v", err)
	}
	output.Reset()
	resumed, err := closeClient.Prompt(ctx, session.SessionID, "请只回答 ACTIVE_CLOSE_RESUMED。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("prompt after active close resume: %v", err)
	}
	if !isNormalStopReason(resumed.StopReason) {
		t.Fatalf("unexpected resumed stopReason %q raw=%s", resumed.StopReason, string(resumed.Raw))
	}
	if !strings.Contains(output.String(), "ACTIVE_CLOSE_RESUMED") {
		t.Fatalf("prompt after active close resume missing marker: got=%q raw=%s", output.String(), string(resumed.Raw))
	}
	if err := closeClient.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveDaemonKillRestartsInSameOuter(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_FAULT_INJECTION") {
		t.Skip("set CLOUDAGENT_ACP_E2E_FAULT_INJECTION=1 to run daemon fault-injection e2e")
	}
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-daemon-fault-e2e",
		ClientTitle:   "CloudAgent ACP Live Daemon Fault E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if deleted {
			return
		}
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	needle := "cloudagent-daemon-restart-" + strings.ReplaceAll(session.SessionID, "_", "-")
	prepare, err := client.Prompt(ctx, session.SessionID, "请只回答 DAEMON_READY。为了 daemon 重启恢复校验，这条用户消息包含唯一标记 "+needle+"。", CloudAgentPromptOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("prepare prompt: %v", err)
	}
	if !isNormalStopReason(prepare.StopReason) {
		t.Fatalf("unexpected prepare stopReason %q raw=%s", prepare.StopReason, string(prepare.Raw))
	}
	beforeKill, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status before daemon kill: %v", err)
	}
	oldOuter := beforeKill.Sandbox.OuterSandboxID
	if oldOuter == "" {
		t.Fatalf("status before daemon kill missing outer sandbox: %s", string(beforeKill.Raw))
	}

	if err := client.KillRuntimeDaemonForFaultInjection(ctx, session.SessionID); err != nil {
		t.Fatalf("kill daemon fault injection: %v", err)
	}

	output.Reset()
	recovered, err := client.Prompt(ctx, session.SessionID, "请查看本对话历史，复制其中以 cloudagent-daemon-restart- 开头的唯一标记。不要解释，只输出标记本身。", CloudAgentPromptOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("prompt after daemon kill: %v", err)
	}
	if !isNormalStopReason(recovered.StopReason) {
		t.Fatalf("unexpected recovered stopReason %q raw=%s", recovered.StopReason, string(recovered.Raw))
	}
	if outputText := output.String(); !strings.Contains(outputText, needle) {
		t.Fatalf("prompt after daemon restart did not recover runtime transcript: want=%q got=%q raw=%s", needle, outputText, string(recovered.Raw))
	}
	afterRecovery, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after daemon restart: %v", err)
	}
	if afterRecovery.Sandbox.OuterSandboxID != oldOuter {
		t.Fatalf("daemon restart should reuse same outer sandbox: before=%s after=%s raw=%s", oldOuter, afterRecovery.Sandbox.OuterSandboxID, string(afterRecovery.Raw))
	}
	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveOuterKillRecreatesRuntimeAndPreservesWorkspace(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_FAULT_INJECTION") {
		t.Skip("set CLOUDAGENT_ACP_E2E_FAULT_INJECTION=1 to run outer fault-injection e2e")
	}
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: output.notification})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-outer-fault-e2e",
		ClientTitle:   "CloudAgent ACP Live Outer Fault E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if deleted {
			return
		}
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	beforeKill, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status before outer kill: %v", err)
	}
	oldOuter := beforeKill.Sandbox.OuterSandboxID
	oldSpace := beforeKill.Sandbox.WispSMHSpaceID
	if oldOuter == "" || oldSpace == "" {
		t.Fatalf("status before outer kill missing runtime/workspace identity: %s", string(beforeKill.Raw))
	}
	if err := client.KillRuntimeOuterForFaultInjection(ctx, session.SessionID); err != nil {
		t.Fatalf("kill outer fault injection: %v", err)
	}

	output.Reset()
	readyMarker := "OUTER_RECREATE_READY_" + strings.ReplaceAll(session.SessionID, "_", "-")
	recovered, err := client.Prompt(ctx, session.SessionID, "请只回答 "+readyMarker+"。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("prompt after outer kill: %v", err)
	}
	if !isNormalStopReason(recovered.StopReason) {
		t.Fatalf("unexpected recovered stopReason %q raw=%s", recovered.StopReason, string(recovered.Raw))
	}
	if !strings.Contains(output.CombinedString(), readyMarker) {
		t.Fatalf("prompt after outer recreate missing marker %q: got=%q raw=%s", readyMarker, output.CombinedString(), string(recovered.Raw))
	}
	afterRecovery, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after outer recreate: %v", err)
	}
	if afterRecovery.Sandbox.OuterSandboxID == "" || afterRecovery.Sandbox.OuterSandboxID == oldOuter {
		t.Fatalf("outer fault should recreate a different outer sandbox: old=%s raw=%s", oldOuter, string(afterRecovery.Raw))
	}
	if afterRecovery.Sandbox.WispSMHSpaceID != oldSpace {
		t.Fatalf("outer fault recovery should keep Wisp/SMH anchor: before=%s after=%s raw=%s", oldSpace, afterRecovery.Sandbox.WispSMHSpaceID, string(afterRecovery.Raw))
	}
	needle := "cloudagent-outer-recreate-" + strings.ReplaceAll(session.SessionID, "_", "-")
	remotePath := "/workspace/e2e/outer-recreate.txt"
	liveUploadEnvdFile(t, ctx, session.SessionID, remotePath, "text/plain", []byte(needle+"\n"))
	waitForLiveEnvdFileContains(t, ctx, session.SessionID, remotePath, needle)
	output.Reset()
	readBack, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `cat "+remotePath+"`。命令结束后只输出终端里的 cloudagent-outer-recreate 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("prompt after outer recreate upload: %v", err)
	}
	if !isNormalStopReason(readBack.StopReason) {
		t.Fatalf("unexpected readBack stopReason %q raw=%s", readBack.StopReason, string(readBack.Raw))
	}
	if !strings.Contains(output.CombinedString(), needle) {
		t.Fatalf("prompt after outer recreate upload missing marker %q: got=%q raw=%s", needle, output.CombinedString(), string(readBack.Raw))
	}
	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveInnerKillRecreatesWorkspaceRuntime(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_FAULT_INJECTION") {
		t.Skip("set CLOUDAGENT_ACP_E2E_FAULT_INJECTION=1 to run inner fault-injection e2e")
	}
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{OnNotification: output.notification})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-inner-fault-e2e",
		ClientTitle:   "CloudAgent ACP Live Inner Fault E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if deleted {
			return
		}
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	needle := "cloudagent-inner-recreate-" + strings.ReplaceAll(session.SessionID, "_", "-")
	remotePath := "/workspace/e2e/inner-recreate.txt"
	create, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `mkdir -p /workspace/e2e && printf '"+needle+"\\n' > "+remotePath+" && sync && sleep 15 && cat "+remotePath+"`。命令结束后只输出终端里的 cloudagent-inner-recreate 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("create inner workspace file prompt: %v", err)
	}
	if !isNormalStopReason(create.StopReason) {
		t.Fatalf("unexpected create stopReason %q raw=%s", create.StopReason, string(create.Raw))
	}
	if !strings.Contains(output.CombinedString(), needle) {
		t.Fatalf("create inner workspace file missing marker %q: got=%q raw=%s", needle, output.CombinedString(), string(create.Raw))
	}
	waitForLiveEnvdFileContains(t, ctx, session.SessionID, remotePath, needle)
	beforeKill, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status before inner kill: %v", err)
	}
	if beforeKill.Sandbox.OuterSandboxID == "" || !beforeKill.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("status before inner kill missing runtime targets: %s", string(beforeKill.Raw))
	}
	if err := client.KillRuntimeInnerForFaultInjection(ctx, session.SessionID); err != nil {
		t.Fatalf("kill inner fault injection: %v", err)
	}

	output.Reset()
	read, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `cat "+remotePath+"`。命令结束后只输出终端里的 cloudagent-inner-recreate 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("prompt after inner kill: %v", err)
	}
	if !isNormalStopReason(read.StopReason) {
		t.Fatalf("unexpected read stopReason %q raw=%s", read.StopReason, string(read.Raw))
	}
	combined := output.CombinedString()
	if !strings.Contains(combined, needle) {
		t.Fatalf("prompt after inner recreate missing marker %q: got=%q raw=%s", needle, combined, string(read.Raw))
	}
	for _, forbidden := range []string{"HTTP 500", "openresty", "sandbox-host process.exec HTTP transport failed", "sandbox-host fs.list HTTP transport failed"} {
		if strings.Contains(combined, forbidden) {
			t.Fatalf("inner recreate surfaced transport failure %q: got=%q raw=%s", forbidden, combined, string(read.Raw))
		}
	}
	afterRecovery, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after inner recreate: %v", err)
	}
	if afterRecovery.Sandbox.OuterSandboxID != beforeKill.Sandbox.OuterSandboxID || !afterRecovery.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("inner fault should keep outer and recreate inner target: before=%s after=%s", string(beforeKill.Raw), string(afterRecovery.Raw))
	}
	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveWorkspaceToolsReachInnerSandbox(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-workspace-tools-e2e",
		ClientTitle:   "CloudAgent ACP Live Workspace Tools E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	defer func() {
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	result, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `pwd && echo CLOUDAGENT_WORKSPACE_TOOL_OK`。命令结束后只输出终端里的路径和标记，不要解释。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("workspace tool prompt: %v", err)
	}
	if !isNormalStopReason(result.StopReason) {
		t.Fatalf("unexpected workspace tool stopReason %q raw=%s", result.StopReason, string(result.Raw))
	}
	outputText := output.String()
	if strings.Contains(outputText, "sandbox-host") || strings.Contains(outputText, "HTTP 500") || strings.Contains(outputText, "openresty") {
		t.Fatalf("workspace tool surfaced sandbox-host transport failure: %q raw=%s", outputText, string(result.Raw))
	}
	if !strings.Contains(outputText, "CLOUDAGENT_WORKSPACE_TOOL_OK") {
		t.Fatalf("workspace tool output missing marker: got=%q raw=%s", outputText, string(result.Raw))
	}
	if !strings.Contains(outputText, liveCWD()) {
		t.Fatalf("workspace tool output missing cwd %q: got=%q raw=%s", liveCWD(), outputText, string(result.Raw))
	}
}

func TestCloudAgentLiveConsecutiveWorkspaceToolPromptsStayWritable(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-consecutive-tool-e2e",
		ClientTitle:   "CloudAgent ACP Live Consecutive Tool E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	defer func() {
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	for i := 1; i <= 2; i++ {
		output.Reset()
		marker := fmt.Sprintf("CONSECUTIVE_WORKSPACE_TOOL_OK_%d", i)
		result, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `pwd && ls -la /workspace && df -h && echo "+marker+"`。命令结束后只输出终端里的 workspace、df 信息和 "+marker+"，不要解释。", CloudAgentPromptOptions{
			CWD:       liveCWD(),
			InboxMode: CloudAgentInboxPrompt,
		})
		if err != nil {
			t.Fatalf("workspace/df prompt round %d failed: %v", i, err)
		}
		if !isNormalStopReason(result.StopReason) {
			t.Fatalf("unexpected workspace/df round %d stopReason %q raw=%s", i, result.StopReason, string(result.Raw))
		}
		outputText := output.CombinedString()
		for _, want := range []string{liveCWD(), marker} {
			if !strings.Contains(outputText, want) {
				t.Fatalf("workspace/df round %d output missing %q: got=%q raw=%s", i, want, outputText, string(result.Raw))
			}
		}
		for _, forbidden := range []string{"restore_failed", "session_read_only", "runtime_not_recovered", "HTTP 500", "openresty", "sandbox-host process.exec HTTP transport failed", "sandbox-host fs.list HTTP transport failed"} {
			if strings.Contains(outputText, forbidden) {
				t.Fatalf("workspace/df round %d surfaced forbidden failure %q: got=%q raw=%s", i, forbidden, outputText, string(result.Raw))
			}
		}
		status, err := client.Status(ctx, session.SessionID)
		if err != nil {
			t.Fatalf("status after workspace/df round %d: %v", i, err)
		}
		if status.Closed || status.ReadOnly || status.ReadOnlyReason != "" || status.Sandbox.OuterSandboxID == "" || !status.Sandbox.HasInnerEnvdTarget {
			t.Fatalf("session should stay writable after workspace/df round %d: %s", i, string(status.Raw))
		}
	}
}

func TestCloudAgentLiveUploadDownloadAndWorkspaceListBehavior(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-upload-list-e2e",
		ClientTitle:   "CloudAgent ACP Live Upload List E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	defer func() {
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	needle := "cloudagent-upload-list-" + strings.ReplaceAll(session.SessionID, "_", "-")
	uploadedBody := []byte("CLOUDAGENT_UPLOAD_FILE_PRESENT\n" + needle + "\n")
	fileID := liveUploadFile(t, ctx, "upload-check.txt", "text/plain", uploadedBody)
	if got := liveDownloadFile(t, ctx, fileID); string(got) != string(uploadedBody) {
		t.Fatalf("downloaded wrapper file mismatch: want=%q got=%q", string(uploadedBody), string(got))
	}

	result, err := client.Prompt(ctx, session.SessionID, "", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
		Blocks: []map[string]any{
			{
				"type": "text",
				"text": "必须调用 terminal 执行 `ls -la /workspace/inputs/docs && cat /workspace/inputs/docs/upload-check.txt`。命令结束后只输出终端里看到的文件名和 cloudagent-upload-list- 开头的唯一标记。",
			},
			{
				"type": "resource",
				"resource": map[string]any{
					"uri":          "wrapper-file://" + fileID,
					"mimeType":     "text/plain",
					"name":         "upload-check.txt",
					"size":         len(uploadedBody),
					"relativePath": "docs/upload-check.txt",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("upload/list prompt: %v", err)
	}
	if !isNormalStopReason(result.StopReason) {
		t.Fatalf("unexpected upload/list stopReason %q raw=%s", result.StopReason, string(result.Raw))
	}
	outputText := output.CombinedString()
	for _, want := range []string{"upload-check.txt", "CLOUDAGENT_UPLOAD_FILE_PRESENT", needle} {
		if !strings.Contains(outputText, want) {
			t.Fatalf("agent output missing %q: got=%q raw=%s", want, outputText, string(result.Raw))
		}
	}
	for _, forbidden := range []string{"HTTP 500", "openresty"} {
		if strings.Contains(outputText, forbidden) {
			t.Fatalf("upload/list surfaced transport failure %q: got=%q raw=%s", forbidden, outputText, string(result.Raw))
		}
	}
}

func TestCloudAgentLiveMultipleResourceFilesNestedWorkspaceListBehavior(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-multi-resource-e2e",
		ClientTitle:   "CloudAgent ACP Live Multi Resource E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	defer func() {
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	needle := "cloudagent-multi-resource-" + strings.ReplaceAll(session.SessionID, "_", "-")
	alphaBody := []byte("CLOUDAGENT_MULTI_RESOURCE_ALPHA\n" + needle + "-alpha\n")
	betaBody := []byte("CLOUDAGENT_MULTI_RESOURCE_BETA\n" + needle + "-beta\n")
	alphaID := liveUploadFile(t, ctx, "alpha.txt", "text/plain", alphaBody)
	betaID := liveUploadFile(t, ctx, "beta.txt", "text/plain", betaBody)

	result, err := client.Prompt(ctx, session.SessionID, "", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
		Blocks: []map[string]any{
			{
				"type": "text",
				"text": "必须调用 terminal 执行 `find /workspace/inputs/multi -maxdepth 3 -type f -print | sort && cat /workspace/inputs/multi/alpha.txt && cat /workspace/inputs/multi/nested/beta.txt`。命令结束后只输出终端里的文件路径和两个 cloudagent-multi-resource 标记。",
			},
			{
				"type": "resource",
				"resource": map[string]any{
					"uri":          "wrapper-file://" + alphaID,
					"mimeType":     "text/plain",
					"name":         "alpha.txt",
					"size":         len(alphaBody),
					"relativePath": "multi/alpha.txt",
				},
			},
			{
				"type": "resource",
				"resource": map[string]any{
					"uri":          "wrapper-file://" + betaID,
					"mimeType":     "text/plain",
					"name":         "beta.txt",
					"size":         len(betaBody),
					"relativePath": "multi/nested/beta.txt",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("multi-resource prompt: %v", err)
	}
	if !isNormalStopReason(result.StopReason) {
		t.Fatalf("unexpected multi-resource stopReason %q raw=%s", result.StopReason, string(result.Raw))
	}
	outputText := output.CombinedString()
	for _, want := range []string{"multi/alpha.txt", "multi/nested/beta.txt", needle + "-alpha", needle + "-beta"} {
		if !strings.Contains(outputText, want) {
			t.Fatalf("agent output missing %q: got=%q raw=%s", want, outputText, string(result.Raw))
		}
	}
}

func TestCloudAgentLiveEnvdUploadDownloadBehavior(t *testing.T) {
	client := newLiveCloudAgentClient(t)
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-envd-upload-list-e2e",
		ClientTitle:   "CloudAgent ACP Live Envd Upload List E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	defer func() {
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	if _, err := client.EnsureRuntimeReady(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()}); err != nil {
		t.Fatalf("ensure runtime ready: %v", err)
	}

	remotePath := "/workspace/e2e/envd-upload-check.txt"
	needle := "cloudagent-envd-upload-" + strings.ReplaceAll(session.SessionID, "_", "-")
	uploadedBody := []byte("CLOUDAGENT_ENVD_UPLOAD_FILE_PRESENT\n" + needle + "\n")
	liveUploadEnvdFile(t, ctx, session.SessionID, remotePath, "text/plain", uploadedBody)
	if got := liveDownloadEnvdFile(t, ctx, session.SessionID, remotePath); string(got) != string(uploadedBody) {
		t.Fatalf("downloaded envd file mismatch: want=%q got=%q", string(uploadedBody), string(got))
	}
}

func TestCloudAgentLiveEnvdUploadDownloadThenAgentListBehavior(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-envd-agent-list-e2e",
		ClientTitle:   "CloudAgent ACP Live Envd Agent List E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	defer func() {
		deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer deleteCancel()
		_ = client.DeleteSession(deleteCtx, session.SessionID)
	}()

	if _, err := client.EnsureRuntimeReady(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()}); err != nil {
		t.Fatalf("ensure runtime ready: %v", err)
	}

	remotePath := "/workspace/e2e/transfer-visible.txt"
	needle := "cloudagent-envd-agent-visible-" + strings.ReplaceAll(session.SessionID, "_", "-")
	uploadedBody := []byte("CLOUDAGENT_ENVD_AGENT_VISIBLE\n" + needle + "\n")
	liveUploadEnvdFile(t, ctx, session.SessionID, remotePath, "text/plain", uploadedBody)
	if got := liveDownloadEnvdFile(t, ctx, session.SessionID, remotePath); string(got) != string(uploadedBody) {
		t.Fatalf("downloaded envd file mismatch: want=%q got=%q", string(uploadedBody), string(got))
	}

	result, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `ls -la /workspace/e2e && cat /workspace/e2e/transfer-visible.txt`。命令结束后只输出终端里的文件名和 cloudagent-envd-agent-visible 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("envd agent list prompt: %v", err)
	}
	if !isNormalStopReason(result.StopReason) {
		t.Fatalf("unexpected envd agent list stopReason %q raw=%s", result.StopReason, string(result.Raw))
	}
	outputText := output.CombinedString()
	for _, want := range []string{"transfer-visible.txt", "CLOUDAGENT_ENVD_AGENT_VISIBLE", needle} {
		if !strings.Contains(outputText, want) {
			t.Fatalf("agent output missing %q: got=%q raw=%s", want, outputText, string(result.Raw))
		}
	}
	for _, forbidden := range []string{"No such file", "HTTP 500", "openresty"} {
		if strings.Contains(outputText, forbidden) {
			t.Fatalf("envd agent list surfaced failure %q: got=%q raw=%s", forbidden, outputText, string(result.Raw))
		}
	}
}

func TestCloudAgentLiveWorkspaceHTTPTransferRoundTripWithAgentInnerSandbox(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-workspace-http-transfer-e2e",
		ClientTitle:   "CloudAgent ACP Live Workspace HTTP Transfer E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if !deleted {
			deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer deleteCancel()
			_ = client.DeleteSession(deleteCtx, session.SessionID)
		}
	}()

	uploadPath := "/workspace/e2e/http-upload-visible.txt"
	uploadMarker := "cloudagent-http-upload-visible-" + strings.ReplaceAll(session.SessionID, "_", "-")
	uploadBody := []byte("CLOUDAGENT_HTTP_UPLOAD_VISIBLE\n" + uploadMarker + "\n")
	liveUploadEnvdFile(t, ctx, session.SessionID, uploadPath, "text/plain", uploadBody)
	if got := string(liveDownloadEnvdFile(t, ctx, session.SessionID, uploadPath)); got != string(uploadBody) {
		t.Fatalf("HTTP download of HTTP-uploaded file mismatch: want=%q got=%q", string(uploadBody), got)
	}
	afterUpload, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after HTTP upload/download: %v", err)
	}
	assertLiveWispWorkspaceStatus(t, afterUpload, "after HTTP upload/download")
	if !afterUpload.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("HTTP workspace upload should ensure an inner workspace runtime target: %s", string(afterUpload.Raw))
	}

	result, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `ls -la /workspace/e2e && cat "+uploadPath+"`。命令结束后只输出终端里的文件名和 cloudagent-http-upload-visible 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("agent list/cat HTTP-uploaded workspace file: %v", err)
	}
	if !isNormalStopReason(result.StopReason) {
		t.Fatalf("unexpected upload-visible stopReason %q raw=%s", result.StopReason, string(result.Raw))
	}
	outputText := output.CombinedString()
	for _, want := range []string{"http-upload-visible.txt", "CLOUDAGENT_HTTP_UPLOAD_VISIBLE", uploadMarker} {
		if !strings.Contains(outputText, want) {
			t.Fatalf("agent could not see HTTP-uploaded workspace file %q: got=%q raw=%s", want, outputText, string(result.Raw))
		}
	}
	for _, forbidden := range []string{"No such file", "HTTP 500", "openresty", "sandbox-host process.exec HTTP transport failed", "sandbox-host fs.list HTTP transport failed"} {
		if strings.Contains(outputText, forbidden) {
			t.Fatalf("HTTP upload visibility surfaced failure %q: got=%q raw=%s", forbidden, outputText, string(result.Raw))
		}
	}
	afterAgentRead, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after agent reads HTTP-uploaded file: %v", err)
	}
	assertLiveWispWorkspaceStatus(t, afterAgentRead, "after agent reads HTTP-uploaded file")
	if !afterAgentRead.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("agent file read should bind an inner workspace runtime: %s", string(afterAgentRead.Raw))
	}

	output.Reset()
	downloadPath := "/workspace/e2e/http-download-from-agent.txt"
	downloadMarker := "cloudagent-http-download-visible-" + strings.ReplaceAll(session.SessionID, "_", "-")
	write, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `printf 'CLOUDAGENT_HTTP_DOWNLOAD_VISIBLE\\n"+downloadMarker+"\\n' > "+downloadPath+" && sync && ls -la /workspace/e2e && cat "+downloadPath+"`。命令结束后只输出终端里的文件名和 cloudagent-http-download-visible 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("agent write workspace file for HTTP download: %v", err)
	}
	if !isNormalStopReason(write.StopReason) {
		t.Fatalf("unexpected download-visible stopReason %q raw=%s", write.StopReason, string(write.Raw))
	}
	if !strings.Contains(output.CombinedString(), downloadMarker) {
		t.Fatalf("agent write output missing marker %q: got=%q raw=%s", downloadMarker, output.CombinedString(), string(write.Raw))
	}
	downloaded := string(liveDownloadEnvdFile(t, ctx, session.SessionID, downloadPath))
	for _, want := range []string{"CLOUDAGENT_HTTP_DOWNLOAD_VISIBLE", downloadMarker} {
		if !strings.Contains(downloaded, want) {
			t.Fatalf("HTTP download could not read agent-written workspace file %q: got=%q", want, downloaded)
		}
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveWorkspaceHTTPTransferPersistsAcrossWispRestore(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_RESTORE") {
		t.Skip("set CLOUDAGENT_ACP_E2E_RESTORE=1 to run Wisp-backed workspace transfer restore e2e")
	}
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-workspace-http-transfer-restore-e2e",
		ClientTitle:   "CloudAgent ACP Live Workspace HTTP Transfer Restore E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if !deleted {
			deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer deleteCancel()
			_ = client.DeleteSession(deleteCtx, session.SessionID)
		}
	}()

	uploadPath := "/workspace/e2e/wisp-restore-http-upload.txt"
	uploadMarker := "cloudagent-wisp-restore-http-upload-" + strings.ReplaceAll(session.SessionID, "_", "-")
	liveUploadEnvdFile(t, ctx, session.SessionID, uploadPath, "text/plain", []byte("CLOUDAGENT_WISP_RESTORE_HTTP_UPLOAD\n"+uploadMarker+"\n"))
	waitForLiveEnvdFileContains(t, ctx, session.SessionID, uploadPath, uploadMarker)

	agentPath := "/workspace/e2e/wisp-restore-agent-write.txt"
	agentMarker := "cloudagent-wisp-restore-agent-write-" + strings.ReplaceAll(session.SessionID, "_", "-")
	write, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `printf 'CLOUDAGENT_WISP_RESTORE_AGENT_WRITE\\n"+agentMarker+"\\n' > "+agentPath+" && sync && cat "+uploadPath+" && cat "+agentPath+"`。命令结束后只输出终端里的两个 cloudagent-wisp-restore 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("agent write before Wisp restore: %v", err)
	}
	if !isNormalStopReason(write.StopReason) {
		t.Fatalf("unexpected pre-restore write stopReason %q raw=%s", write.StopReason, string(write.Raw))
	}
	outputText := output.CombinedString()
	for _, want := range []string{uploadMarker, agentMarker} {
		if !strings.Contains(outputText, want) {
			t.Fatalf("pre-restore agent output missing %q: got=%q raw=%s", want, outputText, string(write.Raw))
		}
	}

	beforeClose, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status before Wisp restore close: %v", err)
	}
	assertLiveWispWorkspaceStatus(t, beforeClose, "before Wisp restore close")
	oldOuter := beforeClose.Sandbox.OuterSandboxID
	oldSpace := beforeClose.Sandbox.WispSMHSpaceID
	if oldOuter == "" || oldSpace == "" || !beforeClose.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("before close missing live Wisp/inner identity: %s", string(beforeClose.Raw))
	}

	if err := client.CloseSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/close before Wisp restore: %v", err)
	}
	afterClose, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after Wisp restore close: %v", err)
	}
	if !afterClose.Closed || afterClose.Sandbox.OuterSandboxID != "" || afterClose.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("close should clear live sandbox targets: %s", string(afterClose.Raw))
	}
	if afterClose.Sandbox.WispSMHSpaceID != oldSpace || !afterClose.WorkspacePersistent {
		t.Fatalf("close should keep Wisp workspace anchor: before_space=%s raw=%s", oldSpace, string(afterClose.Raw))
	}

	if _, err := client.ResumeSession(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()}); err != nil {
		t.Fatalf("session/resume after Wisp restore close: %v", err)
	}
	afterResume := waitForLiveEnsureRuntimeReady(t, ctx, client, session.SessionID)
	assertLiveWispWorkspaceStatus(t, afterResume, "after Wisp restore resume")
	if afterResume.Sandbox.OuterSandboxID == "" || afterResume.Sandbox.OuterSandboxID == oldOuter || !afterResume.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("resume should recreate outer and inner runtime targets: old_outer=%s raw=%s", oldOuter, string(afterResume.Raw))
	}
	if afterResume.Sandbox.WispSMHSpaceID != oldSpace {
		t.Fatalf("resume should keep Wisp workspace anchor: before_space=%s raw=%s", oldSpace, string(afterResume.Raw))
	}

	for _, check := range []struct {
		path   string
		marker string
	}{
		{path: uploadPath, marker: uploadMarker},
		{path: agentPath, marker: agentMarker},
	} {
		if got := string(liveDownloadEnvdFile(t, ctx, session.SessionID, check.path)); !strings.Contains(got, check.marker) {
			t.Fatalf("HTTP download after Wisp restore missing marker %q from %s: got=%q", check.marker, check.path, got)
		}
	}

	output.Reset()
	read, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `cat "+uploadPath+" && cat "+agentPath+"`。命令结束后只输出终端里的两个 cloudagent-wisp-restore 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("agent read after Wisp restore: %v", err)
	}
	if !isNormalStopReason(read.StopReason) {
		t.Fatalf("unexpected post-restore read stopReason %q raw=%s", read.StopReason, string(read.Raw))
	}
	outputText = output.CombinedString()
	for _, want := range []string{uploadMarker, agentMarker} {
		if !strings.Contains(outputText, want) {
			t.Fatalf("post-restore agent output missing %q: got=%q raw=%s", want, outputText, string(read.Raw))
		}
	}
	for _, forbidden := range []string{"No such file", "runtime_not_recovered", "HTTP 500", "openresty", "sandbox-host process.exec HTTP transport failed", "sandbox-host fs.list HTTP transport failed"} {
		if strings.Contains(outputText, forbidden) {
			t.Fatalf("post-restore transfer surfaced forbidden failure %q: got=%q raw=%s", forbidden, outputText, string(read.Raw))
		}
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveWorkspaceHTTPUploadVisibleToFileTools(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-workspace-http-file-tools-e2e",
		ClientTitle:   "CloudAgent ACP Live Workspace HTTP File Tools E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if !deleted {
			deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer deleteCancel()
			_ = client.DeleteSession(deleteCtx, session.SessionID)
		}
	}()

	remotePath := "/workspace/e2e/list-tool-visible/nested/file-list-visible.txt"
	marker := "cloudagent-file-list-visible-" + strings.ReplaceAll(session.SessionID, "_", "-")
	body := []byte("CLOUDAGENT_FILE_LIST_VISIBLE\n" + marker + "\n")
	liveUploadEnvdFile(t, ctx, session.SessionID, remotePath, "text/plain", body)
	if got := string(liveDownloadEnvdFile(t, ctx, session.SessionID, remotePath)); got != string(body) {
		t.Fatalf("HTTP download of file-tools upload mismatch: want=%q got=%q", string(body), got)
	}
	afterUpload, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after file-tools upload: %v", err)
	}
	assertLiveWispWorkspaceStatus(t, afterUpload, "after file-tools upload")
	if !afterUpload.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("HTTP upload should ensure inner runtime before file tools read it: %s", string(afterUpload.Raw))
	}

	result, err := client.Prompt(ctx, session.SessionID, "必须先调用 file_list 工具，参数 path=/workspace/e2e/list-tool-visible、recursive=true、includeHidden=true；然后调用 file_read 工具读取 /workspace/e2e/list-tool-visible/nested/file-list-visible.txt。最后只输出工具看到的文件名和 cloudagent-file-list-visible 标记，不要用 terminal。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("file tools prompt for HTTP-uploaded workspace file: %v", err)
	}
	if !isNormalStopReason(result.StopReason) {
		t.Fatalf("unexpected file-tools stopReason %q raw=%s", result.StopReason, string(result.Raw))
	}
	outputText := output.CombinedString()
	for _, want := range []string{"file_list", "file-list-visible.txt", "CLOUDAGENT_FILE_LIST_VISIBLE", marker} {
		if !strings.Contains(outputText, want) {
			t.Fatalf("file tools output missing %q: got=%q raw=%s", want, outputText, string(result.Raw))
		}
	}
	if !strings.Contains(outputText, "file_read") && !strings.Contains(outputText, "read_file") {
		t.Fatalf("file tools output missing file_read/read_file tool call: got=%q raw=%s", outputText, string(result.Raw))
	}
	for _, forbidden := range []string{"No such file", "Path does not exist", "Session sandbox is not available", "HTTP 500", "openresty", "sandbox-host fs.list HTTP transport failed"} {
		if strings.Contains(outputText, forbidden) {
			t.Fatalf("file tools surfaced forbidden failure %q: got=%q raw=%s", forbidden, outputText, string(result.Raw))
		}
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveWorkspaceHTTPTransferPreservesEscapedPathTextContent(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-workspace-http-escaped-path-e2e",
		ClientTitle:   "CloudAgent ACP Live Workspace HTTP Escaped Path E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if !deleted {
			deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer deleteCancel()
			_ = client.DeleteSession(deleteCtx, session.SessionID)
		}
	}()

	remotePath := "/workspace/e2e/path with spaces/text-data.txt"
	marker := "cloudagent-escaped-path-" + strings.ReplaceAll(session.SessionID, "_", "-")
	body := []byte("CLOUDAGENT_ESCAPED_PATH\n" + marker + "\n")
	liveUploadEnvdFile(t, ctx, session.SessionID, remotePath, "text/plain", body)
	if got := liveDownloadEnvdFile(t, ctx, session.SessionID, remotePath); !bytes.Equal(got, body) {
		t.Fatalf("escaped path HTTP round trip mismatch: want=%q got=%q", string(body), string(got))
	}
	afterUpload, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after escaped path upload: %v", err)
	}
	assertLiveWispWorkspaceStatus(t, afterUpload, "after escaped path upload")
	if !afterUpload.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("escaped path HTTP upload should ensure an inner workspace runtime target: %s", string(afterUpload.Raw))
	}

	result, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `ls -la '/workspace/e2e/path with spaces' && cat '/workspace/e2e/path with spaces/text-data.txt'`。命令结束后只输出终端里的 text-data.txt 文件名和 cloudagent-escaped-path 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("agent read escaped path HTTP-uploaded workspace file: %v", err)
	}
	if !isNormalStopReason(result.StopReason) {
		t.Fatalf("unexpected escaped path stopReason %q raw=%s", result.StopReason, string(result.Raw))
	}
	outputText := output.CombinedString()
	for _, want := range []string{"text-data.txt", "CLOUDAGENT_ESCAPED_PATH", marker} {
		if !strings.Contains(outputText, want) {
			t.Fatalf("escaped path agent output missing %q: got=%q raw=%s", want, outputText, string(result.Raw))
		}
	}
	for _, forbidden := range []string{"No such file", "HTTP 500", "openresty", "sandbox-host process.exec HTTP transport failed"} {
		if strings.Contains(outputText, forbidden) {
			t.Fatalf("escaped path transfer surfaced forbidden failure %q: got=%q raw=%s", forbidden, outputText, string(result.Raw))
		}
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveWorkspaceHTTPUploadOverwritesActiveInnerFile(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-workspace-http-overwrite-e2e",
		ClientTitle:   "CloudAgent ACP Live Workspace HTTP Overwrite E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if !deleted {
			deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer deleteCancel()
			_ = client.DeleteSession(deleteCtx, session.SessionID)
		}
	}()

	remotePath := "/workspace/e2e/overwrite-active-inner.txt"
	oldMarker := "cloudagent-overwrite-old-" + strings.ReplaceAll(session.SessionID, "_", "-")
	newMarker := "cloudagent-overwrite-new-" + strings.ReplaceAll(session.SessionID, "_", "-")
	create, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `mkdir -p /workspace/e2e && printf 'CLOUDAGENT_OVERWRITE_OLD\\n"+oldMarker+"\\n' > "+remotePath+" && cat "+remotePath+"`。命令结束后只输出终端里的 cloudagent-overwrite-old 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("agent create file before HTTP overwrite: %v", err)
	}
	if !isNormalStopReason(create.StopReason) {
		t.Fatalf("unexpected overwrite-create stopReason %q raw=%s", create.StopReason, string(create.Raw))
	}
	if !strings.Contains(output.CombinedString(), oldMarker) {
		t.Fatalf("pre-overwrite agent output missing old marker %q: got=%q raw=%s", oldMarker, output.CombinedString(), string(create.Raw))
	}
	beforeUpload, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status before HTTP overwrite: %v", err)
	}
	assertLiveWispWorkspaceStatus(t, beforeUpload, "before HTTP overwrite")
	if !beforeUpload.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("pre-overwrite prompt should have active inner runtime: %s", string(beforeUpload.Raw))
	}

	newBody := []byte("CLOUDAGENT_OVERWRITE_NEW\n" + newMarker + "\n")
	liveUploadEnvdFile(t, ctx, session.SessionID, remotePath, "text/plain", newBody)
	if got := string(liveDownloadEnvdFile(t, ctx, session.SessionID, remotePath)); got != string(newBody) {
		t.Fatalf("HTTP download after overwrite mismatch: want=%q got=%q", string(newBody), got)
	}

	output.Reset()
	read, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `cat "+remotePath+"`。命令结束后只输出终端里的 cloudagent-overwrite-new 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("agent read after HTTP overwrite: %v", err)
	}
	if !isNormalStopReason(read.StopReason) {
		t.Fatalf("unexpected overwrite-read stopReason %q raw=%s", read.StopReason, string(read.Raw))
	}
	outputText := output.CombinedString()
	if !strings.Contains(outputText, newMarker) {
		t.Fatalf("post-overwrite agent output missing new marker %q: got=%q raw=%s", newMarker, outputText, string(read.Raw))
	}
	if strings.Contains(outputText, oldMarker) {
		t.Fatalf("post-overwrite agent output still contains old marker %q: got=%q raw=%s", oldMarker, outputText, string(read.Raw))
	}
	for _, forbidden := range []string{"No such file", "HTTP 500", "openresty", "sandbox-host process.exec HTTP transport failed"} {
		if strings.Contains(outputText, forbidden) {
			t.Fatalf("overwrite surfaced forbidden failure %q: got=%q raw=%s", forbidden, outputText, string(read.Raw))
		}
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveWorkspaceHTTPTransferSurvivesSessionLoadReconnect(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-workspace-http-load-reconnect-e2e",
		ClientTitle:   "CloudAgent ACP Live Workspace HTTP Load Reconnect E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if !deleted {
			deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer deleteCancel()
			_ = client.DeleteSession(deleteCtx, session.SessionID)
		}
	}()

	uploadPath := "/workspace/e2e/load-reconnect-http-upload.txt"
	uploadMarker := "cloudagent-load-reconnect-upload-" + strings.ReplaceAll(session.SessionID, "_", "-")
	liveUploadEnvdFile(t, ctx, session.SessionID, uploadPath, "text/plain", []byte("CLOUDAGENT_LOAD_RECONNECT_UPLOAD\n"+uploadMarker+"\n"))

	agentPath := "/workspace/e2e/load-reconnect-agent-write.txt"
	agentMarker := "cloudagent-load-reconnect-agent-" + strings.ReplaceAll(session.SessionID, "_", "-")
	write, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `printf 'CLOUDAGENT_LOAD_RECONNECT_AGENT\\n"+agentMarker+"\\n' > "+agentPath+" && sync && cat "+uploadPath+" && cat "+agentPath+"`。命令结束后只输出终端里的两个 cloudagent-load-reconnect 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("agent write before session/load reconnect: %v", err)
	}
	if !isNormalStopReason(write.StopReason) {
		t.Fatalf("unexpected load-reconnect write stopReason %q raw=%s", write.StopReason, string(write.Raw))
	}
	outputText := output.CombinedString()
	for _, want := range []string{uploadMarker, agentMarker} {
		if !strings.Contains(outputText, want) {
			t.Fatalf("pre-load reconnect output missing %q: got=%q raw=%s", want, outputText, string(write.Raw))
		}
	}
	beforeLoad, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status before load reconnect: %v", err)
	}
	assertLiveWispWorkspaceStatus(t, beforeLoad, "before load reconnect")
	if !beforeLoad.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("pre-load reconnect should have active inner runtime: %s", string(beforeLoad.Raw))
	}

	reconnectedOutput := &liveAgentOutput{}
	reconnected := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: reconnectedOutput.notification,
	})
	defer reconnected.Close()
	if _, err := reconnected.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-workspace-http-load-reconnect-client",
		ClientTitle:   "CloudAgent ACP Live Workspace HTTP Load Reconnect Client",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize reconnect client: %v", err)
	}
	if _, err := reconnected.LoadSession(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()}); err != nil {
		t.Fatalf("session/load reconnect: %v", err)
	}
	afterLoad, err := reconnected.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after load reconnect: %v", err)
	}
	assertLiveWispWorkspaceStatus(t, afterLoad, "after load reconnect")
	if afterLoad.Closed || afterLoad.ReadOnly || !afterLoad.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("session/load reconnect should keep live workspace writable: %s", string(afterLoad.Raw))
	}
	if afterLoad.Sandbox.WispSMHSpaceID != beforeLoad.Sandbox.WispSMHSpaceID {
		t.Fatalf("session/load reconnect should keep Wisp anchor: before=%s raw=%s", beforeLoad.Sandbox.WispSMHSpaceID, string(afterLoad.Raw))
	}

	for _, check := range []struct {
		path   string
		marker string
	}{
		{path: uploadPath, marker: uploadMarker},
		{path: agentPath, marker: agentMarker},
	} {
		if got := string(liveDownloadEnvdFile(t, ctx, session.SessionID, check.path)); !strings.Contains(got, check.marker) {
			t.Fatalf("HTTP download after session/load reconnect missing marker %q from %s: got=%q", check.marker, check.path, got)
		}
	}

	read, err := reconnected.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `cat "+uploadPath+" && cat "+agentPath+"`。命令结束后只输出终端里的两个 cloudagent-load-reconnect 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("agent read after session/load reconnect: %v", err)
	}
	if !isNormalStopReason(read.StopReason) {
		t.Fatalf("unexpected load-reconnect read stopReason %q raw=%s", read.StopReason, string(read.Raw))
	}
	outputText = reconnectedOutput.CombinedString()
	for _, want := range []string{uploadMarker, agentMarker} {
		if !strings.Contains(outputText, want) {
			t.Fatalf("post-load reconnect output missing %q: got=%q raw=%s", want, outputText, string(read.Raw))
		}
	}
	for _, forbidden := range []string{"No such file", "runtime_not_recovered", "HTTP 500", "openresty", "sandbox-host process.exec HTTP transport failed"} {
		if strings.Contains(outputText, forbidden) {
			t.Fatalf("load reconnect surfaced forbidden failure %q: got=%q raw=%s", forbidden, outputText, string(read.Raw))
		}
	}

	if err := reconnected.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveWorkspaceHTTPTransferPreservesBinaryContent(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-workspace-http-binary-e2e",
		ClientTitle:   "CloudAgent ACP Live Workspace HTTP Binary E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if !deleted {
			deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer deleteCancel()
			_ = client.DeleteSession(deleteCtx, session.SessionID)
		}
	}()

	remotePath := "/workspace/e2e/binary-data.bin"
	body := append([]byte{0x00, 0x01, 0x02, 0x7f, 0x80, 0xff}, []byte("CLOUDAGENT_BINARY_TRANSFER_"+session.SessionID)...)
	expectedHash := fmt.Sprintf("%x", sha256.Sum256(body))
	liveUploadEnvdFile(t, ctx, session.SessionID, remotePath, "application/octet-stream", body)
	if got := liveDownloadEnvdFile(t, ctx, session.SessionID, remotePath); !bytes.Equal(got, body) {
		t.Fatalf("binary HTTP round trip mismatch: want=%x got=%x", body, got)
	}
	afterUpload, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after binary upload: %v", err)
	}
	assertLiveWispWorkspaceStatus(t, afterUpload, "after binary upload")
	if !afterUpload.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("binary HTTP upload should ensure an inner workspace runtime target: %s", string(afterUpload.Raw))
	}

	result, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `sha256sum /workspace/e2e/binary-data.bin && ls -la /workspace/e2e/binary-data.bin`。命令结束后只输出终端里的 sha256 和 binary-data.bin 文件名。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("agent hash binary HTTP-uploaded workspace file: %v", err)
	}
	if !isNormalStopReason(result.StopReason) {
		t.Fatalf("unexpected binary hash stopReason %q raw=%s", result.StopReason, string(result.Raw))
	}
	outputText := output.CombinedString()
	for _, want := range []string{expectedHash, "binary-data.bin"} {
		if !strings.Contains(outputText, want) {
			t.Fatalf("binary agent output missing %q: got=%q raw=%s", want, outputText, string(result.Raw))
		}
	}
	for _, forbidden := range []string{"No such file", "HTTP 500", "openresty", "sandbox-host process.exec HTTP transport failed"} {
		if strings.Contains(outputText, forbidden) {
			t.Fatalf("binary transfer surfaced forbidden failure %q: got=%q raw=%s", forbidden, outputText, string(result.Raw))
		}
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveWorkspaceHTTPDownloadMissingFileReturnsNotFound(t *testing.T) {
	client := newLiveCloudAgentClient(t)
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-workspace-http-missing-download-e2e",
		ClientTitle:   "CloudAgent ACP Live Workspace HTTP Missing Download E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if !deleted {
			deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer deleteCancel()
			_ = client.DeleteSession(deleteCtx, session.SessionID)
		}
	}()
	waitForLiveEnsureRuntimeReady(t, ctx, client, session.SessionID)

	missingPath := "/workspace/e2e/missing-download/" + strings.ReplaceAll(session.SessionID, "_", "-") + "-does-not-exist.txt"
	body, err := liveTryDownloadEnvdFile(t, ctx, session.SessionID, missingPath)
	if err == nil {
		t.Fatalf("missing workspace file download unexpectedly succeeded with %d bytes", len(body))
	}
	errText := err.Error()
	if !strings.Contains(errText, "status=404") || !strings.Contains(string(body), "workspace_file_not_found") {
		t.Fatalf("missing workspace file download should return 404 workspace_file_not_found: err=%v body=%s", err, string(body))
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveWorkspaceHTTPTransferLargeFiles(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-workspace-http-large-file-e2e",
		ClientTitle:   "CloudAgent ACP Live Workspace HTTP Large File E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if !deleted {
			deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer deleteCancel()
			_ = client.DeleteSession(deleteCtx, session.SessionID)
		}
	}()

	sizes := []int{5 * 1024 * 1024}
	expected := make([]string, 0, len(sizes)*2)
	for _, size := range sizes {
		name := fmt.Sprintf("large-%dmb.bin", size/(1024*1024))
		remotePath := "/workspace/e2e/large-transfer/" + name
		body := liveDeterministicBytes(size, "cloudagent-large-transfer-"+session.SessionID+"-"+name)
		sum := fmt.Sprintf("%x", sha256.Sum256(body))
		liveUploadEnvdFile(t, ctx, session.SessionID, remotePath, "application/octet-stream", body)
		if got := liveDownloadEnvdFile(t, ctx, session.SessionID, remotePath); !bytes.Equal(got, body) {
			t.Fatalf("large file HTTP round trip mismatch for %s: want_len=%d got_len=%d", name, len(body), len(got))
		}
		expected = append(expected, name, sum)
	}
	afterUpload, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status after large uploads: %v", err)
	}
	assertLiveWispWorkspaceStatus(t, afterUpload, "after large uploads")
	if !afterUpload.Sandbox.HasInnerEnvdTarget {
		t.Fatalf("large HTTP upload should ensure an inner workspace runtime target: %s", string(afterUpload.Raw))
	}

	result, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `sha256sum /workspace/e2e/large-transfer/large-5mb.bin && ls -lh /workspace/e2e/large-transfer`。命令结束后只输出终端里的 sha256 和文件名。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("agent hash large HTTP-uploaded workspace files: %v", err)
	}
	if !isNormalStopReason(result.StopReason) {
		t.Fatalf("unexpected large-file stopReason %q raw=%s", result.StopReason, string(result.Raw))
	}
	outputText := output.CombinedString()
	for _, want := range expected {
		if !strings.Contains(outputText, want) {
			t.Fatalf("large-file agent output missing %q: got=%q raw=%s", want, outputText, string(result.Raw))
		}
	}
	for _, forbidden := range []string{"No such file", "HTTP 500", "openresty", "sandbox-host process.exec HTTP transport failed"} {
		if strings.Contains(outputText, forbidden) {
			t.Fatalf("large-file transfer surfaced forbidden failure %q: got=%q raw=%s", forbidden, outputText, string(result.Raw))
		}
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveWorkspaceHTTPTransferBatchUploadListRead(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-workspace-http-batch-upload-e2e",
		ClientTitle:   "CloudAgent ACP Live Workspace HTTP Batch Upload E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if !deleted {
			deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer deleteCancel()
			_ = client.DeleteSession(deleteCtx, session.SessionID)
		}
	}()

	type uploadCase struct {
		path   string
		name   string
		marker string
	}
	cases := []uploadCase{
		{path: "/workspace/e2e/batch-upload/a/one.txt", name: "one.txt", marker: "cloudagent-batch-one-" + strings.ReplaceAll(session.SessionID, "_", "-")},
		{path: "/workspace/e2e/batch-upload/b/two.txt", name: "two.txt", marker: "cloudagent-batch-two-" + strings.ReplaceAll(session.SessionID, "_", "-")},
		{path: "/workspace/e2e/batch-upload/c/nested/three.txt", name: "three.txt", marker: "cloudagent-batch-three-" + strings.ReplaceAll(session.SessionID, "_", "-")},
	}
	for _, item := range cases {
		body := []byte("CLOUDAGENT_BATCH_UPLOAD\n" + item.marker + "\n")
		liveUploadEnvdFile(t, ctx, session.SessionID, item.path, "text/plain", body)
		if got := string(liveDownloadEnvdFile(t, ctx, session.SessionID, item.path)); got != string(body) {
			t.Fatalf("batch HTTP round trip mismatch for %s: want=%q got=%q", item.path, string(body), got)
		}
	}

	result, err := client.Prompt(ctx, session.SessionID, "必须先调用 file_list 工具，参数 path=/workspace/e2e/batch-upload、recursive=true、includeHidden=true；然后分别调用 file_read 工具读取 one.txt、two.txt、three.txt。最后只输出工具看到的三个文件名和三个 cloudagent-batch 标记，不要用 terminal。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("file tools batch upload prompt: %v", err)
	}
	if !isNormalStopReason(result.StopReason) {
		t.Fatalf("unexpected batch upload stopReason %q raw=%s", result.StopReason, string(result.Raw))
	}
	outputText := output.CombinedString()
	for _, want := range []string{"file_list", "one.txt", "two.txt", "three.txt"} {
		if !strings.Contains(outputText, want) {
			t.Fatalf("batch upload output missing %q: got=%q raw=%s", want, outputText, string(result.Raw))
		}
	}
	for _, item := range cases {
		if !strings.Contains(outputText, item.marker) {
			t.Fatalf("batch upload output missing marker %q: got=%q raw=%s", item.marker, outputText, string(result.Raw))
		}
	}
	if !strings.Contains(outputText, "file_read") && !strings.Contains(outputText, "read_file") {
		t.Fatalf("batch upload output missing file_read/read_file tool call: got=%q raw=%s", outputText, string(result.Raw))
	}
	for _, forbidden := range []string{"Session sandbox is not available", "HTTP 500", "openresty", "sandbox-host fs.list HTTP transport failed", "sandbox-host fs.read HTTP transport failed"} {
		if strings.Contains(outputText, forbidden) {
			t.Fatalf("batch upload surfaced forbidden failure %q: got=%q raw=%s", forbidden, outputText, string(result.Raw))
		}
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveWorkspaceHTTPUploadDuringActivePromptVisibleNextTurn(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-workspace-http-active-upload-e2e",
		ClientTitle:   "CloudAgent ACP Live Workspace HTTP Active Upload E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if !deleted {
			deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer deleteCancel()
			_ = client.DeleteSession(deleteCtx, session.SessionID)
		}
	}()

	activeDone := make(chan struct{})
	var activeResult CloudAgentPromptResult
	var activeErr error
	go func() {
		defer close(activeDone)
		activeResult, activeErr = client.Prompt(ctx, session.SessionID, "请先输出 ACTIVE_UPLOAD_BEGIN，然后必须调用 terminal 执行 `sleep 8 && echo ACTIVE_UPLOAD_DONE`。命令结束后只输出 ACTIVE_UPLOAD_DONE。", CloudAgentPromptOptions{
			CWD:       liveCWD(),
			InboxMode: CloudAgentInboxPrompt,
		})
	}()
	waitForLiveOutputContains(t, ctx, output, "ACTIVE_UPLOAD_BEGIN")

	remotePath := "/workspace/e2e/active-upload/created-during-active.txt"
	marker := "cloudagent-active-upload-" + strings.ReplaceAll(session.SessionID, "_", "-")
	liveUploadEnvdFile(t, ctx, session.SessionID, remotePath, "text/plain", []byte("CLOUDAGENT_ACTIVE_UPLOAD\n"+marker+"\n"))
	if got := string(liveDownloadEnvdFile(t, ctx, session.SessionID, remotePath)); !strings.Contains(got, marker) {
		t.Fatalf("HTTP download during active prompt missing marker %q: got=%q", marker, got)
	}

	select {
	case <-activeDone:
	case <-ctx.Done():
		t.Fatalf("active prompt did not finish before context done: %v", ctx.Err())
	}
	if activeErr != nil {
		t.Fatalf("active prompt failed: %v", activeErr)
	}
	if !isNormalStopReason(activeResult.StopReason) {
		t.Fatalf("unexpected active prompt stopReason %q raw=%s", activeResult.StopReason, string(activeResult.Raw))
	}

	output.Reset()
	read, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `ls -la /workspace/e2e/active-upload && cat /workspace/e2e/active-upload/created-during-active.txt`。命令结束后只输出终端里的 created-during-active.txt 文件名和 cloudagent-active-upload 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("agent read file uploaded during active prompt: %v", err)
	}
	if !isNormalStopReason(read.StopReason) {
		t.Fatalf("unexpected active-upload read stopReason %q raw=%s", read.StopReason, string(read.Raw))
	}
	outputText := output.CombinedString()
	for _, want := range []string{"created-during-active.txt", marker} {
		if !strings.Contains(outputText, want) {
			t.Fatalf("active-upload next turn output missing %q: got=%q raw=%s", want, outputText, string(read.Raw))
		}
	}
	for _, forbidden := range []string{"No such file", "runtime_not_recovered", "HTTP 500", "openresty", "sandbox-host process.exec HTTP transport failed"} {
		if strings.Contains(outputText, forbidden) {
			t.Fatalf("active-upload surfaced forbidden failure %q: got=%q raw=%s", forbidden, outputText, string(read.Raw))
		}
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveWorkspaceHTTPTransferRepeatedCloseResumeUploadDownload(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_RESTORE") {
		t.Skip("set CLOUDAGENT_ACP_E2E_RESTORE=1 to run repeated Wisp close/resume workspace transfer e2e")
	}
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-workspace-http-repeated-restore-e2e",
		ClientTitle:   "CloudAgent ACP Live Workspace HTTP Repeated Restore E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if !deleted {
			deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer deleteCancel()
			_ = client.DeleteSession(deleteCtx, session.SessionID)
		}
	}()

	baseMarker := "cloudagent-repeated-transfer-base-" + strings.ReplaceAll(session.SessionID, "_", "-")
	basePath := "/workspace/e2e/repeated-transfer/base.txt"
	liveUploadEnvdFile(t, ctx, session.SessionID, basePath, "text/plain", []byte("CLOUDAGENT_REPEATED_TRANSFER_BASE\n"+baseMarker+"\n"))
	initialStatus, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status before repeated transfer close: %v", err)
	}
	assertLiveWispWorkspaceStatus(t, initialStatus, "before repeated transfer close")
	spaceID := initialStatus.Sandbox.WispSMHSpaceID

	for round := 1; round <= 2; round++ {
		if err := client.CloseSession(ctx, session.SessionID); err != nil {
			t.Fatalf("session/close round %d: %v", round, err)
		}
		if _, err := client.ResumeSession(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()}); err != nil {
			t.Fatalf("session/resume round %d: %v", round, err)
		}
		ready := waitForLiveEnsureRuntimeReady(t, ctx, client, session.SessionID)
		assertLiveWispWorkspaceStatus(t, ready, fmt.Sprintf("after repeated transfer resume round %d", round))
		if ready.Sandbox.WispSMHSpaceID != spaceID {
			t.Fatalf("resume round %d changed Wisp anchor: before=%s raw=%s", round, spaceID, string(ready.Raw))
		}
		if got := string(liveDownloadEnvdFile(t, ctx, session.SessionID, basePath)); !strings.Contains(got, baseMarker) {
			t.Fatalf("round %d base file missing after resume: got=%q", round, got)
		}

		roundPath := fmt.Sprintf("/workspace/e2e/repeated-transfer/round-%d.txt", round)
		roundMarker := fmt.Sprintf("cloudagent-repeated-transfer-round-%d-%s", round, strings.ReplaceAll(session.SessionID, "_", "-"))
		liveUploadEnvdFile(t, ctx, session.SessionID, roundPath, "text/plain", []byte("CLOUDAGENT_REPEATED_TRANSFER_ROUND\n"+roundMarker+"\n"))
		if got := string(liveDownloadEnvdFile(t, ctx, session.SessionID, roundPath)); !strings.Contains(got, roundMarker) {
			t.Fatalf("round %d upload/download missing marker %q: got=%q", round, roundMarker, got)
		}
		output.Reset()
		read, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `cat "+basePath+" && cat "+roundPath+"`。命令结束后只输出终端里的 cloudagent-repeated-transfer 标记。", CloudAgentPromptOptions{
			CWD:       liveCWD(),
			InboxMode: CloudAgentInboxPrompt,
		})
		if err != nil {
			t.Fatalf("round %d agent read repeated transfer files: %v", round, err)
		}
		if !isNormalStopReason(read.StopReason) {
			t.Fatalf("unexpected repeated transfer round %d stopReason %q raw=%s", round, read.StopReason, string(read.Raw))
		}
		outputText := output.CombinedString()
		for _, want := range []string{baseMarker, roundMarker} {
			if !strings.Contains(outputText, want) {
				t.Fatalf("round %d agent output missing %q: got=%q raw=%s", round, want, outputText, string(read.Raw))
			}
		}
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveWorkspaceHTTPOverwritePersistsAcrossCloseResume(t *testing.T) {
	if !liveBool("CLOUDAGENT_ACP_E2E_RESTORE") {
		t.Skip("set CLOUDAGENT_ACP_E2E_RESTORE=1 to run overwrite restore workspace transfer e2e")
	}
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-workspace-http-overwrite-restore-e2e",
		ClientTitle:   "CloudAgent ACP Live Workspace HTTP Overwrite Restore E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if !deleted {
			deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer deleteCancel()
			_ = client.DeleteSession(deleteCtx, session.SessionID)
		}
	}()

	remotePath := "/workspace/e2e/overwrite-restore/same-path.txt"
	oldMarker := "cloudagent-overwrite-restore-old-" + strings.ReplaceAll(session.SessionID, "_", "-")
	newMarker := "cloudagent-overwrite-restore-new-" + strings.ReplaceAll(session.SessionID, "_", "-")
	liveUploadEnvdFile(t, ctx, session.SessionID, remotePath, "text/plain", []byte("CLOUDAGENT_OVERWRITE_RESTORE_OLD\n"+oldMarker+"\n"))
	liveUploadEnvdFile(t, ctx, session.SessionID, remotePath, "text/plain", []byte("CLOUDAGENT_OVERWRITE_RESTORE_NEW\n"+newMarker+"\n"))
	if got := string(liveDownloadEnvdFile(t, ctx, session.SessionID, remotePath)); !strings.Contains(got, newMarker) || strings.Contains(got, oldMarker) {
		t.Fatalf("HTTP download before close should contain only new marker: old=%q new=%q got=%q", oldMarker, newMarker, got)
	}
	beforeClose, err := client.Status(ctx, session.SessionID)
	if err != nil {
		t.Fatalf("status before overwrite restore close: %v", err)
	}
	assertLiveWispWorkspaceStatus(t, beforeClose, "before overwrite restore close")
	spaceID := beforeClose.Sandbox.WispSMHSpaceID

	if err := client.CloseSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/close after overwrite: %v", err)
	}
	if _, err := client.ResumeSession(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()}); err != nil {
		t.Fatalf("session/resume after overwrite: %v", err)
	}
	ready := waitForLiveEnsureRuntimeReady(t, ctx, client, session.SessionID)
	assertLiveWispWorkspaceStatus(t, ready, "after overwrite restore resume")
	if ready.Sandbox.WispSMHSpaceID != spaceID {
		t.Fatalf("overwrite restore changed Wisp anchor: before=%s raw=%s", spaceID, string(ready.Raw))
	}
	if got := string(liveDownloadEnvdFile(t, ctx, session.SessionID, remotePath)); !strings.Contains(got, newMarker) || strings.Contains(got, oldMarker) {
		t.Fatalf("HTTP download after close/resume should contain only new marker: old=%q new=%q got=%q", oldMarker, newMarker, got)
	}

	result, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `cat /workspace/e2e/overwrite-restore/same-path.txt`。命令结束后只输出终端里的 cloudagent-overwrite-restore-new 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("agent read overwrite after close/resume: %v", err)
	}
	if !isNormalStopReason(result.StopReason) {
		t.Fatalf("unexpected overwrite restore read stopReason %q raw=%s", result.StopReason, string(result.Raw))
	}
	outputText := output.CombinedString()
	if !strings.Contains(outputText, newMarker) {
		t.Fatalf("agent output after close/resume missing new marker %q: got=%q raw=%s", newMarker, outputText, string(result.Raw))
	}
	if strings.Contains(outputText, oldMarker) {
		t.Fatalf("agent output after close/resume still contains old marker %q: got=%q raw=%s", oldMarker, outputText, string(result.Raw))
	}

	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

func TestCloudAgentLiveAgentWritesWorkspaceFileThenEnvdDownloadBehavior(t *testing.T) {
	output := &liveAgentOutput{}
	client := newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), liveTimeout())
	defer cancel()

	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-agent-write-download-e2e",
		ClientTitle:   "CloudAgent ACP Live Agent Write Download E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	session, err := client.NewSession(ctx, CloudAgentSessionOptions{CWD: liveCWD()})
	if err != nil {
		t.Fatalf("session/new: %v", err)
	}
	deleted := false
	defer func() {
		if !deleted {
			deleteCtx, deleteCancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer deleteCancel()
			_ = client.DeleteSession(deleteCtx, session.SessionID)
		}
	}()

	remotePath := "/workspace/generated/agent-output.txt"
	needle := "cloudagent-agent-write-" + strings.ReplaceAll(session.SessionID, "_", "-")
	result, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `mkdir -p /workspace/generated && printf 'CLOUDAGENT_AGENT_WRITE_FILE_PRESENT\\n"+needle+"\\n' > /workspace/generated/agent-output.txt && ls -la /workspace/generated && cat /workspace/generated/agent-output.txt`。命令结束后只输出终端里的文件名和 cloudagent-agent-write 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("agent write prompt: %v", err)
	}
	if !isNormalStopReason(result.StopReason) {
		t.Fatalf("unexpected agent write stopReason %q raw=%s", result.StopReason, string(result.Raw))
	}
	outputText := output.CombinedString()
	for _, want := range []string{"agent-output.txt", "CLOUDAGENT_AGENT_WRITE_FILE_PRESENT", needle} {
		if !strings.Contains(outputText, want) {
			t.Fatalf("agent output missing %q: got=%q raw=%s", want, outputText, string(result.Raw))
		}
	}
	downloaded := string(liveDownloadEnvdFile(t, ctx, session.SessionID, remotePath))
	if !strings.Contains(downloaded, needle) || !strings.Contains(downloaded, "CLOUDAGENT_AGENT_WRITE_FILE_PRESENT") {
		t.Fatalf("downloaded agent file missing marker: %q", downloaded)
	}

	if err := client.Close(); err != nil {
		t.Fatalf("close first connection: %v", err)
	}
	output.Reset()
	client = newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{
		OnNotification: output.notification,
	})
	if _, err := client.Initialize(ctx, CloudAgentClientOptions{
		ClientName:    "cloudagent-acp-live-agent-write-download-e2e",
		ClientTitle:   "CloudAgent ACP Live Agent Write Download E2E",
		ClientVersion: "0.1.0",
	}); err != nil {
		t.Fatalf("initialize reconnected client: %v", err)
	}
	if _, err := client.LoadSession(ctx, session.SessionID, CloudAgentSessionOptions{CWD: liveCWD()}); err != nil {
		t.Fatalf("session/load: %v", err)
	}
	second, err := client.Prompt(ctx, session.SessionID, "必须调用 terminal 执行 `cat /workspace/generated/agent-output.txt`。只输出终端里的 cloudagent-agent-write 标记。", CloudAgentPromptOptions{
		CWD:       liveCWD(),
		InboxMode: CloudAgentInboxPrompt,
	})
	if err != nil {
		t.Fatalf("post-load cat prompt: %v", err)
	}
	if !isNormalStopReason(second.StopReason) {
		t.Fatalf("unexpected post-load stopReason %q raw=%s", second.StopReason, string(second.Raw))
	}
	if !strings.Contains(output.CombinedString(), needle) {
		t.Fatalf("post-load agent output missing marker %q: got=%q raw=%s", needle, output.CombinedString(), string(second.Raw))
	}
	if err := client.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatalf("session/delete: %v", err)
	}
	deleted = true
}

type liveAgentOutput struct {
	mu     sync.Mutex
	output strings.Builder
	tools  strings.Builder
}

type liveCloudAgentEvents struct {
	mu        sync.Mutex
	lifecycle []map[string]any
}

func (e *liveCloudAgentEvents) notification(raw json.RawMessage) error {
	var env struct {
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return err
	}
	if env.Method != "_cloudagent.workspace.lifecycle" {
		return nil
	}
	e.mu.Lock()
	e.lifecycle = append(e.lifecycle, cloneStringAnyMap(env.Params))
	e.mu.Unlock()
	return nil
}

func (e *liveCloudAgentEvents) waitLifecycle(t *testing.T, ctx context.Context, sessionID, operation, phase, status string) map[string]any {
	t.Helper()
	deadline := time.NewTimer(90 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if event, ok := e.findLifecycle(sessionID, operation, phase, status); ok {
			return event
		}
		select {
		case <-ctx.Done():
			t.Fatalf("timed out waiting for lifecycle %s/%s/%s: %v seen=%#v", operation, phase, status, ctx.Err(), e.snapshot())
		case <-deadline.C:
			t.Fatalf("timed out waiting for lifecycle %s/%s/%s seen=%#v", operation, phase, status, e.snapshot())
		case <-ticker.C:
		}
	}
}

func (e *liveCloudAgentEvents) assertLifecycleSeen(t *testing.T, sessionID, operation, phase, status string) {
	t.Helper()
	if _, ok := e.findLifecycle(sessionID, operation, phase, status); !ok {
		t.Fatalf("missing lifecycle %s/%s/%s seen=%#v", operation, phase, status, e.snapshot())
	}
}

func (e *liveCloudAgentEvents) findLifecycle(sessionID, operation, phase, status string) (map[string]any, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, event := range e.lifecycle {
		if event["session_id"] == sessionID && event["operation"] == operation && event["phase"] == phase && event["status"] == status {
			return cloneStringAnyMap(event), true
		}
	}
	return nil, false
}

func (e *liveCloudAgentEvents) snapshot() []map[string]any {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]map[string]any, 0, len(e.lifecycle))
	for _, event := range e.lifecycle {
		out = append(out, cloneStringAnyMap(event))
	}
	return out
}

func cloneStringAnyMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func (c *liveAgentOutput) notification(raw json.RawMessage) error {
	var env struct {
		Method string `json:"method"`
		Params struct {
			Update struct {
				SessionUpdate string          `json:"sessionUpdate"`
				Name          string          `json:"name"`
				Content       json.RawMessage `json:"content"`
				RawOutput     json.RawMessage `json:"rawOutput"`
			} `json:"update"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return err
	}
	if env.Method != "session/update" {
		return nil
	}
	switch env.Params.Update.SessionUpdate {
	case "agent_message_chunk":
		var textContent struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal(env.Params.Update.Content, &textContent); err != nil {
			return nil
		}
		c.mu.Lock()
		c.output.WriteString(textContent.Text)
		c.mu.Unlock()
	case "tool_call_update":
		c.mu.Lock()
		if env.Params.Update.Name != "" {
			c.tools.WriteString(env.Params.Update.Name)
			c.tools.WriteByte('\n')
		}
		if len(env.Params.Update.RawOutput) > 0 && string(env.Params.Update.RawOutput) != "null" {
			c.tools.Write(env.Params.Update.RawOutput)
			c.tools.WriteByte('\n')
		}
		if len(env.Params.Update.Content) > 0 && string(env.Params.Update.Content) != "null" {
			c.tools.Write(env.Params.Update.Content)
			c.tools.WriteByte('\n')
		}
		c.mu.Unlock()
	}
	return nil
}

func (c *liveAgentOutput) Reset() {
	c.mu.Lock()
	c.output.Reset()
	c.tools.Reset()
	c.mu.Unlock()
}

func (c *liveAgentOutput) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.output.String()
}

func (c *liveAgentOutput) CombinedString() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.output.String() + c.tools.String()
}

func waitForLiveOutputContains(t *testing.T, ctx context.Context, output *liveAgentOutput, marker string) {
	t.Helper()
	deadline := time.NewTimer(75 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		if strings.Contains(output.CombinedString(), marker) {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("timed out waiting for output marker %q: %v got=%q", marker, ctx.Err(), output.CombinedString())
		case <-deadline.C:
			t.Fatalf("timed out waiting for output marker %q got=%q", marker, output.CombinedString())
		case <-ticker.C:
		}
	}
}

func waitForLiveSessionReady(t *testing.T, ctx context.Context, client *CloudAgentClient, sessionID string) CloudAgentSessionStatus {
	t.Helper()
	deadline := time.Now().Add(90 * time.Second)
	var lastStatus CloudAgentSessionStatus
	var lastErr error
	for {
		status, err := client.Status(ctx, sessionID)
		if err == nil {
			lastStatus = status
			if isCloudAgentWorkspaceWellDone(status) {
				return status
			}
		} else {
			lastErr = err
		}
		if time.Now().After(deadline) {
			if lastErr != nil {
				t.Fatalf("session %s did not become ready: last_status=%s last_err=%v", sessionID, string(lastStatus.Raw), lastErr)
			}
			t.Fatalf("session %s did not become ready: last_status=%s", sessionID, string(lastStatus.Raw))
		}
		select {
		case <-ctx.Done():
			t.Fatalf("session %s did not become ready before context done: last_status=%s last_err=%v err=%v", sessionID, string(lastStatus.Raw), lastErr, ctx.Err())
		case <-time.After(1 * time.Second):
		}
	}
}

func waitForLiveEnsureRuntimeReady(t *testing.T, ctx context.Context, client *CloudAgentClient, sessionID string) CloudAgentSessionStatus {
	t.Helper()
	deadline := time.Now().Add(3 * time.Minute)
	var lastStatus CloudAgentSessionStatus
	var lastErr error
	for {
		status, err := client.EnsureRuntimeReady(ctx, sessionID, CloudAgentSessionOptions{CWD: liveCWD()})
		if err == nil {
			lastStatus = status
			if isCloudAgentWorkspaceWellDone(status) {
				return status
			}
		} else {
			lastErr = err
		}
		if time.Now().After(deadline) {
			if lastErr != nil {
				t.Fatalf("session %s did not ensure ready: last_status=%s last_err=%v", sessionID, string(lastStatus.Raw), lastErr)
			}
			t.Fatalf("session %s did not ensure ready: last_status=%s", sessionID, string(lastStatus.Raw))
		}
		select {
		case <-ctx.Done():
			t.Fatalf("session %s did not ensure ready before context done: last_status=%s last_err=%v err=%v", sessionID, string(lastStatus.Raw), lastErr, ctx.Err())
		case <-time.After(3 * time.Second):
		}
	}
}

func newLiveCloudAgentClient(t *testing.T) *CloudAgentClient {
	t.Helper()
	return newLiveCloudAgentClientWithOptions(t, CloudAgentClientOptions{})
}

func newLiveCloudAgentClientWithOptions(t *testing.T, opts CloudAgentClientOptions) *CloudAgentClient {
	t.Helper()
	rawURL := strings.TrimSpace(firstNonEmptyString(
		os.Getenv("CLOUDAGENT_ACP_E2E_URL"),
		os.Getenv("ACP_CLIENT_URL"),
	))
	if rawURL == "" {
		t.Skip("set CLOUDAGENT_ACP_E2E_URL to run live CloudAgent ACP e2e")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	opts.Headers = liveHeaders()
	client, err := DialCloudAgent(ctx, rawURL, opts)
	if err != nil {
		t.Fatalf("dial live CloudAgent ACP %s: %v", rawURL, err)
	}
	return client
}

func liveHeaders() http.Header {
	headers := http.Header{}
	if authorization := strings.TrimSpace(os.Getenv("CLOUDAGENT_ACP_E2E_AUTHORIZATION")); authorization != "" {
		headers.Set("Authorization", authorization)
	} else if bearer := strings.TrimSpace(firstNonEmptyString(os.Getenv("CLOUDAGENT_ACP_E2E_BEARER"), os.Getenv("GATEWAY_API_KEY"))); bearer != "" {
		headers.Set("Authorization", "Bearer "+bearer)
	}
	if tenant := strings.TrimSpace(firstNonEmptyString(os.Getenv("CLOUDAGENT_ACP_E2E_TENANT_ID"), os.Getenv("GATEWAY_DEFAULT_TENANT_ID"))); tenant != "" {
		headers.Set("X-Tenant-ID", tenant)
	}
	if project := strings.TrimSpace(firstNonEmptyString(os.Getenv("CLOUDAGENT_ACP_E2E_PROJECT_ID"), os.Getenv("GATEWAY_DEFAULT_PROJECT_ID"))); project != "" {
		headers.Set("X-Project-ID", project)
	}
	if sandboxScope := strings.TrimSpace(firstNonEmptyString(os.Getenv("CLOUDAGENT_ACP_E2E_SANDBOX_SCOPE"), os.Getenv("GATEWAY_DEFAULT_SANDBOX_SCOPE"))); sandboxScope != "" {
		headers.Set("X-Sandbox-Scope", sandboxScope)
	}
	return headers
}

func liveHTTPBaseURL(t *testing.T) string {
	t.Helper()
	rawURL := strings.TrimSpace(firstNonEmptyString(
		os.Getenv("CLOUDAGENT_ACP_E2E_HTTP_URL"),
		os.Getenv("CLOUDAGENT_ACP_E2E_URL"),
		os.Getenv("ACP_CLIENT_URL"),
	))
	if rawURL == "" {
		t.Skip("set CLOUDAGENT_ACP_E2E_URL to run live CloudAgent ACP e2e")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse live ACP URL: %v", err)
	}
	switch parsed.Scheme {
	case "ws":
		parsed.Scheme = "http"
	case "wss":
		parsed.Scheme = "https"
	case "http", "https":
	default:
		t.Fatalf("unsupported live ACP URL scheme %q", parsed.Scheme)
	}
	parsed.Path = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return strings.TrimRight(parsed.String(), "/")
}

func liveRestartGateway(t *testing.T, ctx context.Context) {
	t.Helper()
	command := strings.TrimSpace(os.Getenv("CLOUDAGENT_ACP_E2E_GATEWAY_RESTART_COMMAND"))
	if command == "" {
		t.Skip("set CLOUDAGENT_ACP_E2E_GATEWAY_RESTART_COMMAND to restart the local gateway")
	}
	restartCtx, cancel := context.WithTimeout(ctx, envDuration("CLOUDAGENT_ACP_E2E_GATEWAY_RESTART_TIMEOUT", 90*time.Second))
	defer cancel()
	cmd := exec.CommandContext(restartCtx, "/bin/sh", "-lc", command)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("gateway restart command failed: %v output=%s", err, string(output))
	}
	baseURL := liveHTTPBaseURL(t)
	deadline := time.Now().Add(envDuration("CLOUDAGENT_ACP_E2E_GATEWAY_HEALTH_TIMEOUT", 90*time.Second))
	var lastErr error
	for time.Now().Before(deadline) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/selfcheck", nil)
		if err != nil {
			t.Fatal(err)
		}
		for key, values := range liveHeaders() {
			for _, value := range values {
				req.Header.Add(key, value)
			}
		}
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			raw, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK && bytes.Contains(raw, []byte(`"ok":true`)) {
				return
			}
			lastErr = fmt.Errorf("selfcheck status=%d body=%s", resp.StatusCode, string(raw))
		} else {
			lastErr = err
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("gateway did not become healthy after restart: %v", lastErr)
}

func liveUploadFile(t *testing.T, ctx context.Context, filename, contentType string, content []byte) string {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("purpose", "assistants"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, liveHTTPBaseURL(t)+"/v1/files", &body)
	if err != nil {
		t.Fatal(err)
	}
	for key, values := range liveHeaders() {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	if strings.TrimSpace(contentType) != "" {
		req.Header.Set("X-CloudAgent-Test-Content-Type", contentType)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("upload file status=%d body=%s", resp.StatusCode, string(raw))
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode upload response: %v body=%s", err, string(raw))
	}
	if out.ID == "" {
		t.Fatalf("upload response missing id: %s", string(raw))
	}
	return out.ID
}

func liveDownloadFile(t *testing.T, ctx context.Context, fileID string) []byte {
	t.Helper()
	return liveHTTPGetBytes(t, ctx, fmt.Sprintf("%s/v1/files/%s/content", liveHTTPBaseURL(t), url.PathEscape(fileID)))
}

func liveDeterministicBytes(size int, seed string) []byte {
	if size <= 0 {
		return nil
	}
	out := make([]byte, size)
	blockSeed := []byte(seed)
	offset := 0
	for counter := 0; offset < len(out); counter++ {
		blockInput := append(append([]byte{}, blockSeed...), byte(counter), byte(counter>>8), byte(counter>>16), byte(counter>>24))
		block := sha256.Sum256(blockInput)
		offset += copy(out[offset:], block[:])
	}
	return out
}

func liveDownloadEnvdFile(t *testing.T, ctx context.Context, sessionID, remotePath string) []byte {
	t.Helper()
	endpoint := fmt.Sprintf("%s/v1/acp/sessions/%s/envd/files?path=%s", liveHTTPBaseURL(t), url.PathEscape(sessionID), url.QueryEscape(remotePath))
	return liveHTTPGetBytes(t, ctx, endpoint)
}

func waitForLiveEnvdFileContains(t *testing.T, ctx context.Context, sessionID, remotePath, marker string) {
	t.Helper()
	deadline := time.Now().Add(45 * time.Second)
	var last string
	var lastErr error
	var attempts int
	for {
		attempts++
		content, err := liveTryDownloadEnvdFile(t, ctx, sessionID, remotePath)
		if err != nil {
			lastErr = err
			last = ""
		} else {
			lastErr = nil
			last = string(content)
		}
		if err == nil && strings.Contains(last, marker) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("envd download missing marker %q after %d attempt(s): got=%q last_err=%v", marker, attempts, last, lastErr)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("envd download missing marker %q before context done after %d attempt(s): last=%q last_err=%v err=%v", marker, attempts, last, lastErr, ctx.Err())
		case <-time.After(3 * time.Second):
		}
	}
}

func liveTryDownloadEnvdFile(t *testing.T, ctx context.Context, sessionID, remotePath string) ([]byte, error) {
	t.Helper()
	endpoint := fmt.Sprintf("%s/v1/acp/sessions/%s/envd/files?path=%s", liveHTTPBaseURL(t), url.PathEscape(sessionID), url.QueryEscape(remotePath))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	for key, values := range liveHeaders() {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return raw, fmt.Errorf("GET %s status=%d body=%s", endpoint, resp.StatusCode, string(raw))
	}
	return raw, nil
}

func liveUploadEnvdFile(t *testing.T, ctx context.Context, sessionID, remotePath, contentType string, content []byte) {
	t.Helper()
	endpoint := fmt.Sprintf("%s/v1/acp/sessions/%s/envd/files?path=%s", liveHTTPBaseURL(t), url.PathEscape(sessionID), url.QueryEscape(remotePath))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	for key, values := range liveHeaders() {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	req.Header.Set("Content-Type", firstNonEmptyString(contentType, "application/octet-stream"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST %s status=%d body=%s", endpoint, resp.StatusCode, string(raw))
	}
}

func liveHTTPGetBytes(t *testing.T, ctx context.Context, endpoint string) []byte {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	for key, values := range liveHeaders() {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s status=%d body=%s", endpoint, resp.StatusCode, string(raw))
	}
	return raw
}

func liveCWD() string {
	return firstNonEmptyString(os.Getenv("CLOUDAGENT_ACP_E2E_CWD"), "/workspace")
}

func livePrompt() string {
	return firstNonEmptyString(os.Getenv("CLOUDAGENT_ACP_E2E_PROMPT"), "请只回答 OK。")
}

func liveTimeout() time.Duration {
	if raw := strings.TrimSpace(os.Getenv("CLOUDAGENT_ACP_E2E_TIMEOUT")); raw != "" {
		if value, err := time.ParseDuration(raw); err == nil {
			return value
		}
	}
	return 8 * time.Minute
}

func envDuration(key string, fallback time.Duration) time.Duration {
	if raw := strings.TrimSpace(os.Getenv(key)); raw != "" {
		if value, err := time.ParseDuration(raw); err == nil {
			return value
		}
	}
	return fallback
}

func liveBool(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func isNormalStopReason(value string) bool {
	switch value {
	case "", "end_turn", "stop":
		return true
	default:
		return false
	}
}

func isCloudAgentWorkspaceWellDone(status CloudAgentSessionStatus) bool {
	if status.SessionID == "" || status.Closed || status.ReadOnly {
		return false
	}
	switch strings.ToLower(status.RuntimeStatus) {
	case "attached", "ready", "idle", "running", "recovered", "restored":
		return true
	default:
		return false
	}
}

func assertLiveWispWorkspaceStatus(t *testing.T, status CloudAgentSessionStatus, where string) {
	t.Helper()
	if status.Sandbox.OuterRuntime != "wisp" {
		t.Fatalf("%s: expected Wisp outer runtime: %s", where, string(status.Raw))
	}
	if !status.WorkspacePersistent || !status.RuntimeRestorable {
		t.Fatalf("%s: expected persistent/restorable Wisp workspace: %s", where, string(status.Raw))
	}
	if status.Sandbox.WispSMHSpaceID == "" {
		t.Fatalf("%s: expected Wisp/SMH workspace anchor: %s", where, string(status.Raw))
	}
}
