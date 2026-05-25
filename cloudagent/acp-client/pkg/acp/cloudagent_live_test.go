package acp

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
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

type liveAgentOutput struct {
	mu     sync.Mutex
	output strings.Builder
}

func (c *liveAgentOutput) notification(raw json.RawMessage) error {
	var env struct {
		Method string `json:"method"`
		Params struct {
			Update struct {
				SessionUpdate string          `json:"sessionUpdate"`
				Content       json.RawMessage `json:"content"`
			} `json:"update"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return err
	}
	if env.Method != "session/update" || env.Params.Update.SessionUpdate != "agent_message_chunk" {
		return nil
	}
	var textContent struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(env.Params.Update.Content, &textContent); err != nil {
		return nil
	}
	c.mu.Lock()
	c.output.WriteString(textContent.Text)
	c.mu.Unlock()
	return nil
}

func (c *liveAgentOutput) Reset() {
	c.mu.Lock()
	c.output.Reset()
	c.mu.Unlock()
}

func (c *liveAgentOutput) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.output.String()
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
