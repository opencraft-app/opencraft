package instance

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"testing"

	psandbox "ctl/pkg/adapter/sandbox"
	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	"ctl/pkg/metric"
	channelloginsession "ctl/pkg/model/channelloginsession"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/transport"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"go.uber.org/zap"
)

type commandSandboxAdapterStub struct {
	psandbox.Adapter
	results         []*psandbox.ExecCommandResult
	errs            []error
	terminalSession *psandbox.TerminalSession
	terminalErr     error
	terminalCalls   []string
	calls           []commandSandboxCall
	processErr      error
	processEvents   []psandbox.ProcessStreamEvent
	processErrs     []error
	processBatches  [][]psandbox.ProcessStreamEvent
	processCalls    []psandbox.ProcessStartRequest
	processFunc     func(req *psandbox.ProcessStartRequest) []psandbox.ProcessStreamEvent
	stdinCalls      []commandSandboxStdinCall
	stdinResult     *psandbox.ExecCommandResult
	stdinErr        error
}

type commandSandboxStdinCall struct {
	sandboxID string
	req       psandbox.ProcessStartRequest
	stdin     []byte
}

type commandSandboxCall struct {
	sandboxID string
	bash      string
	timeout   int
}

func (s *commandSandboxAdapterStub) ExecCommand(_ context.Context, sandboxID, bash string, timeoutSec int) (*psandbox.ExecCommandResult, error) {
	s.calls = append(s.calls, commandSandboxCall{
		sandboxID: sandboxID,
		bash:      bash,
		timeout:   timeoutSec,
	})
	if len(s.errs) > 0 {
		err := s.errs[0]
		s.errs = s.errs[1:]
		if err != nil {
			return nil, err
		}
	}
	if len(s.results) > 0 {
		result := s.results[0]
		s.results = s.results[1:]
		return result, nil
	}
	return nil, nil
}

func (s *commandSandboxAdapterStub) StartTerminalSession(_ context.Context, sandboxID string) (*psandbox.TerminalSession, error) {
	s.terminalCalls = append(s.terminalCalls, sandboxID)
	if s.terminalErr != nil {
		return nil, s.terminalErr
	}
	if s.terminalSession != nil {
		return s.terminalSession, nil
	}
	return &psandbox.TerminalSession{}, nil
}

func (s *commandSandboxAdapterStub) StartProcessStream(_ context.Context, _ string, req *psandbox.ProcessStartRequest, onEvent func(psandbox.ProcessStreamEvent) error) error {
	if req != nil {
		s.processCalls = append(s.processCalls, *req)
	}
	events := s.processEvents
	if s.processFunc != nil && req != nil {
		events = s.processFunc(req)
	}
	if len(s.processBatches) > 0 {
		events = s.processBatches[0]
		s.processBatches = s.processBatches[1:]
	}
	for _, ev := range events {
		if err := onEvent(ev); err != nil {
			return err
		}
	}
	if len(s.processErrs) > 0 {
		err := s.processErrs[0]
		s.processErrs = s.processErrs[1:]
		return err
	}
	return s.processErr
}

func (s *commandSandboxAdapterStub) RunProcessWithStdin(_ context.Context, sandboxID string, req *psandbox.ProcessStartRequest, stdin []byte) (*psandbox.ExecCommandResult, error) {
	if req != nil {
		cloned := *req
		s.stdinCalls = append(s.stdinCalls, commandSandboxStdinCall{
			sandboxID: sandboxID,
			req:       cloned,
			stdin:     append([]byte(nil), stdin...),
		})
	}
	if s.stdinErr != nil {
		return s.stdinResult, s.stdinErr
	}
	if s.stdinResult != nil {
		return s.stdinResult, nil
	}
	return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0}, nil
}

type commandInstanceDaoStub struct {
	modelinstance.Dao
	entity       *modelinstance.Entity
	err          error
	updated      map[string]interface{}
	updateID     int64
	updateStates []string
}

func (s *commandInstanceDaoStub) GetByInstanceID(_ pctx.Context, _ string) (*modelinstance.Entity, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.entity, nil
}

func (s *commandInstanceDaoStub) UpdateWithStatusPrecondition(_ pctx.Context, id int64, fromStatuses []string, updates map[string]interface{}) error {
	s.updateID = id
	s.updateStates = append([]string(nil), fromStatuses...)
	s.updated = updates
	if s.entity != nil {
		if keyID, ok := updates[modelinstance.ColumnAiGatewayKeyID].(string); ok {
			s.entity.AiGatewayKeyID = keyID
		}
		if token, ok := updates[modelinstance.ColumnGatewayAuthToken].(string); ok {
			s.entity.GatewayAuthToken = token
		}
	}
	return nil
}

func TestExecSandboxCommandRecordsSuccessMetrics(t *testing.T) {
	logic := &logic{
		sandboxAdapter: &commandSandboxAdapterStub{
			results: []*psandbox.ExecCommandResult{{
				Status:   "SUCCESS",
				ExitCode: 0,
			}},
		},
		logger: zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	beforeTotal := testutil.ToFloat64(metric.RemoteCommandTotalCounterVec.WithLabelValues("test_command_metrics", "success"))
	beforeInflight := testutil.ToFloat64(metric.RemoteCommandInflightGaugeVec.WithLabelValues("test_command_metrics"))

	result, err := logic.execSandboxCommand(ctx, "sbx-1", "test_command_metrics", "hostname", 30)
	if err != nil {
		t.Fatalf("exec sandbox command: %v", err)
	}
	if !sandboxCommandSucceeded(result) {
		t.Fatalf("expected sandbox command success, got %#v", result)
	}

	afterTotal := testutil.ToFloat64(metric.RemoteCommandTotalCounterVec.WithLabelValues("test_command_metrics", "success"))
	afterInflight := testutil.ToFloat64(metric.RemoteCommandInflightGaugeVec.WithLabelValues("test_command_metrics"))
	if afterTotal-beforeTotal != 1 {
		t.Fatalf("expected success counter to increase by 1, got before=%v after=%v", beforeTotal, afterTotal)
	}
	if afterInflight != beforeInflight {
		t.Fatalf("expected inflight gauge to return to baseline, got before=%v after=%v", beforeInflight, afterInflight)
	}
}

func TestExecDebugCommandRejectsNonZeroExit(t *testing.T) {
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: &commandSandboxAdapterStub{
			processEvents: []psandbox.ProcessStreamEvent{{
				Ended:    true,
				ExitCode: 17,
				Stderr:   "boom",
			}},
		},
		logger: zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	_, err := logic.ExecDebugCommand(ctx, "ins-1", "openclaw_version", "")
	if !errors.Is(err, errcode.ErrDebugExecFailed) {
		t.Fatalf("expected debug exec failed, got %v", err)
	}
	var detailProvider interface{ ErrorDetail() any }
	if !errors.As(err, &detailProvider) {
		t.Fatalf("expected detailed debug exec error, got %T", err)
	}
	detail, ok := detailProvider.ErrorDetail().(*transport.ExecDebugCommandResponse)
	if !ok {
		t.Fatalf("expected debug response detail, got %T", detailProvider.ErrorDetail())
	}
	if detail.ExitCode != 17 || detail.Stderr != "boom" {
		t.Fatalf("unexpected debug detail: %+v", detail)
	}
	if detail.Detail != "status=FAILED exit_code=17 stderr=boom" {
		t.Fatalf("expected failure detail, got %+v", detail)
	}
}

func TestStartTerminalSessionUsesOwnedInstanceSandbox(t *testing.T) {
	adapter := &commandSandboxAdapterStub{
		terminalSession: &psandbox.TerminalSession{
			SandboxID:      "sbx-1",
			PoolID:         "pool-1",
			SessionID:      "sess-1",
			Region:         "ap-beijing",
			InstanceID:     "i-123",
			OwnerUin:       "10001",
			LoginUin:       "10002",
			AppID:          123,
			WsURL:          "wss://tat.example.test/ws",
			Cols:           120,
			Rows:           30,
			TimeoutSeconds: 3600,
			Username:       "agentuser",
			WorkingDir:     "/home/agentuser",
		},
	}
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: adapter,
		logger:         zap.NewNop(),
	}

	resp, err := logic.StartTerminalSession(pctx.NewContext(nil).WithUserID("user-1"), "ins-1")
	if err != nil {
		t.Fatalf("start terminal session: %v", err)
	}
	if len(adapter.terminalCalls) != 1 || adapter.terminalCalls[0] != "sbx-1" {
		t.Fatalf("expected sandbox session call for sbx-1, got %+v", adapter.terminalCalls)
	}
	if resp.SessionID != "sess-1" || resp.WsURL != "wss://tat.example.test/ws" {
		t.Fatalf("unexpected response: %+v", resp)
	}
	if resp.Username != "agentuser" || resp.WorkingDir != "/home/agentuser" {
		t.Fatalf("unexpected terminal identity: %+v", resp)
	}
}

func TestStartTerminalSessionDoesNotCallSandboxWhenInstanceLookupFails(t *testing.T) {
	adapter := &commandSandboxAdapterStub{}
	logic := &logic{
		instanceDao:    &commandInstanceDaoStub{err: errcode.ErrInstanceNotFound},
		sandboxAdapter: adapter,
		logger:         zap.NewNop(),
	}

	_, err := logic.StartTerminalSession(pctx.NewContext(nil).WithUserID("other-user"), "ins-1")
	if !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("expected instance not found, got %v", err)
	}
	if len(adapter.terminalCalls) != 0 {
		t.Fatalf("sandbox must not be called for inaccessible instance, got %+v", adapter.terminalCalls)
	}
}

func TestExecDebugCommandUsesProcessStream(t *testing.T) {
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: &commandSandboxAdapterStub{
			processEvents: []psandbox.ProcessStreamEvent{
				{PID: 4321},
				{Stdout: "OpenClaw 2026.3.11\n"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
			},
		},
		logger: zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	resp, err := logic.ExecDebugCommand(ctx, "ins-1", "openclaw_version", "")
	if err != nil {
		t.Fatalf("exec debug command: %v", err)
	}
	if resp.Status != "SUCCESS" {
		t.Fatalf("expected success status, got %s", resp.Status)
	}
	if !strings.Contains(resp.Output, "OpenClaw") {
		t.Fatalf("expected version output, got %q", resp.Output)
	}
	if resp.Stdout != "OpenClaw 2026.3.11\n" {
		t.Fatalf("expected stdout, got %q", resp.Stdout)
	}
	if resp.Stderr != "" {
		t.Fatalf("expected empty stderr, got %q", resp.Stderr)
	}
	if resp.InvocationID != "pid:4321" {
		t.Fatalf("expected pid-based invocation id, got %q", resp.InvocationID)
	}

	adapter := logic.sandboxAdapter.(*commandSandboxAdapterStub)
	if len(adapter.calls) != 0 {
		t.Fatalf("expected debug exec to avoid TAT ExecCommand, got %d calls", len(adapter.calls))
	}
	if len(adapter.processCalls) != 1 {
		t.Fatalf("expected one process call, got %d", len(adapter.processCalls))
	}
	if adapter.processCalls[0].Cmd != "/bin/bash" {
		t.Fatalf("expected bash process, got %q", adapter.processCalls[0].Cmd)
	}
}

func TestExecDebugCommandNormalizesExitStatusZero(t *testing.T) {
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: &commandSandboxAdapterStub{
			processEvents: []psandbox.ProcessStreamEvent{
				{PID: 5678},
				{Stdout: "OpenClaw 2026.3.11\n"},
				{Ended: true, ExitCode: 0, Status: "exit status 0"},
			},
		},
		logger: zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	resp, err := logic.ExecDebugCommand(ctx, "ins-1", "openclaw_version", "")
	if err != nil {
		t.Fatalf("exec debug command: %v", err)
	}
	if resp.Status != "SUCCESS" {
		t.Fatalf("expected normalized success status, got %s", resp.Status)
	}
	if resp.InvocationID != "pid:5678" {
		t.Fatalf("expected pid-based invocation id, got %q", resp.InvocationID)
	}
}

func TestGetWorkspaceFilesReadsSingleFile(t *testing.T) {
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: &commandSandboxAdapterStub{
			processEvents: []psandbox.ProcessStreamEvent{
				{Stdout: "__CTL_WS_FILE__SOUL.md\taGVsbG8=\n"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
			},
		},
		logger: zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	resp, err := logic.GetWorkspaceFiles(ctx, "ins-1", "SOUL.md")
	if err != nil {
		t.Fatalf("get workspace files: %v", err)
	}
	if len(resp.Items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(resp.Items))
	}
	if resp.Items[0].Name != "SOUL.md" || resp.Items[0].Content != "hello" || !resp.Items[0].Exists {
		t.Fatalf("unexpected item: %+v", resp.Items[0])
	}
}

func TestUpdateWorkspaceFileWritesAllowedFile(t *testing.T) {
	adapter := &commandSandboxAdapterStub{
		processEvents: []psandbox.ProcessStreamEvent{
			{Ended: true, ExitCode: 0, Status: "SUCCESS"},
		},
	}
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: adapter,
		logger:         zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	resp, err := logic.UpdateWorkspaceFile(ctx, "ins-1", &transport.UpdateWorkspaceFileRequest{
		Name:    "SOUL.md",
		Content: "hello soul",
	})
	if err != nil {
		t.Fatalf("update workspace file: %v", err)
	}
	if resp.Name != "SOUL.md" || resp.Content != "hello soul" || !resp.Exists {
		t.Fatalf("unexpected response: %+v", resp)
	}
	if len(adapter.processCalls) != 1 {
		t.Fatalf("expected one process call, got %d", len(adapter.processCalls))
	}
	if !strings.Contains(strings.Join(adapter.processCalls[0].Args, " "), "SOUL.md") {
		t.Fatalf("expected SOUL.md in command args, got %+v", adapter.processCalls[0].Args)
	}
}

func TestUpdateWorkspaceFileRejectsUnknownFile(t *testing.T) {
	logic := &logic{logger: zap.NewNop()}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	_, err := logic.UpdateWorkspaceFile(ctx, "ins-1", &transport.UpdateWorkspaceFileRequest{
		Name:    "secrets.txt",
		Content: "nope",
	})
	if !errors.Is(err, errcode.ErrInstanceInvalidParam) {
		t.Fatalf("expected invalid param, got %v", err)
	}
}

func TestUploadWorkspaceAttachmentStreamsFileViaProcessStdin(t *testing.T) {
	prevUUIDFn := chatClawUUIDFn
	chatClawUUIDFn = func() string { return "1" }
	defer func() { chatClawUUIDFn = prevUUIDFn }()

	adapter := &commandSandboxAdapterStub{
		stdinResult: &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0},
		processBatches: [][]psandbox.ProcessStreamEvent{
			{
				{Stdout: "__CTL_CC_AGENT__main\t4D61696E\t5072696D617279\tgeneral\t2F686F6D652F6C69676874636C61772F2E6F70656E636C61772F776F726B7370616365\t1712817000\t1712817000\n"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
			},
			{
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
			},
			{
				{Stdout: "__CTL_CC_UPLOAD__upload_1\tworkspace-upload\tupload_1\tagent\tmain\tmain\t\t746573742E6D64\t746578742F6D61726B646F776E\t8\t2F686F6D652F6C69676874636C61772F2E6F70656E636C61772F776F726B7370616365\t75706C6F6164732F75706C6F61645F312D746573742E6D64\t1712817000\t1712817000\n"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
			},
		},
	}
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: adapter,
		logger:         zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	resp, err := logic.UploadWorkspaceAttachment(ctx, "ins-1", &transport.UploadWorkspaceAttachmentRequest{
		OwnerType: "agent",
		OwnerID:   "main",
		FileName:  "test.md",
		MediaType: "text/markdown",
		SizeBytes: 8,
		Content:   []byte("# hello\n"),
	})
	if err != nil {
		t.Fatalf("upload workspace attachment: %v", err)
	}
	if resp.ID != "upload_1" {
		t.Fatalf("unexpected upload response: %+v", resp)
	}
	if len(adapter.stdinCalls) != 1 {
		t.Fatalf("expected one stdin process call, got %d", len(adapter.stdinCalls))
	}
	if string(adapter.stdinCalls[0].stdin) != "# hello\n" {
		t.Fatalf("unexpected stdin payload: %q", string(adapter.stdinCalls[0].stdin))
	}
	if !strings.Contains(strings.Join(adapter.stdinCalls[0].req.Args, " "), `head -c 8 >`) {
		t.Fatalf("expected fixed-length stdin write command, got %+v", adapter.stdinCalls[0].req.Args)
	}
	if len(adapter.processCalls) != 3 {
		t.Fatalf("expected three sqlite process calls, got %d", len(adapter.processCalls))
	}
}

func TestUploadWorkspaceAttachmentSkipsMetadataInsertWhenFileWriteFails(t *testing.T) {
	prevUUIDFn := chatClawUUIDFn
	chatClawUUIDFn = func() string { return "1" }
	defer func() { chatClawUUIDFn = prevUUIDFn }()

	adapter := &commandSandboxAdapterStub{
		stdinResult: &psandbox.ExecCommandResult{Status: "FAILED", ExitCode: 1, ErrorInfo: "write failed"},
		stdinErr:    errors.New("write failed"),
		processBatches: [][]psandbox.ProcessStreamEvent{
			{
				{Stdout: "__CTL_CC_AGENT__main\t4D61696E\t5072696D617279\tgeneral\t2F686F6D652F6C69676874636C61772F2E6F70656E636C61772F776F726B7370616365\t1712817000\t1712817000\n"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
			},
		},
	}
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: adapter,
		logger:         zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	_, err := logic.UploadWorkspaceAttachment(ctx, "ins-1", &transport.UploadWorkspaceAttachmentRequest{
		OwnerType: "agent",
		OwnerID:   "main",
		FileName:  "test.md",
		MediaType: "text/markdown",
		SizeBytes: 8,
		Content:   []byte("# hello\n"),
	})
	if !errors.Is(err, errcode.ErrDebugExecFailed) {
		t.Fatalf("expected debug exec failed, got %v", err)
	}
	if len(adapter.processCalls) != 1 {
		t.Fatalf("expected only the initial snapshot read, got %d process calls", len(adapter.processCalls))
	}
}

func TestGetWorkspaceUploadContentExpandsOutputLimitForLargeFiles(t *testing.T) {
	largeContent := strings.Repeat("B", 120000)
	encoded := base64.StdEncoding.EncodeToString([]byte(largeContent))
	adapter := &commandSandboxAdapterStub{
		processBatches: [][]psandbox.ProcessStreamEvent{
			{
				{Stdout: "__CTL_CC_UPLOAD__upload_1\tworkspace-upload\tupload_1\tagent\tmain\tmain\t\t746573742E6D64\t746578742F6D61726B646F776E\t120000\t2F686F6D652F6C69676874636C61772F2E6F70656E636C61772F776F726B7370616365\t75706C6F6164732F75706C6F61645F312D746573742E6D64\t1712817000\t1712817000\n"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
			},
			{
				{Stdout: encoded},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
			},
		},
	}
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: adapter,
		logger:         zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	upload, content, err := logic.GetWorkspaceUploadContent(ctx, "ins-1", "upload_1")
	if err != nil {
		t.Fatalf("get workspace upload content: %v", err)
	}
	if upload.ID != "upload_1" {
		t.Fatalf("unexpected upload: %+v", upload)
	}
	if len(content) != len(largeContent) {
		t.Fatalf("unexpected content length: got=%d want=%d", len(content), len(largeContent))
	}
	if string(content[:8]) != largeContent[:8] {
		t.Fatalf("unexpected content prefix")
	}
}

func TestGetChatClawStateReadsSnapshot(t *testing.T) {
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: &commandSandboxAdapterStub{
			processEvents: []psandbox.ProcessStreamEvent{
				{Stdout: "__CTL_CC_AGENT__main\t4D61696E\t5072696D617279\tgeneral\t2F686F6D652F6C69676874636C61772F2E6F70656E636C61772F776F726B7370616365\t1712817000\t1712817000\n"},
				{Stdout: "__CTL_CC_TEAM__solo-team\t536F6C6F205465616D\t5368656C6C\t5B226D61696E225D\t1712817000\t1712817000\n"},
				{Stdout: "__CTL_CC_CONVERSATION__conv_1\tagent\tmain\tmain\t4E657720636F6E766572736174696F6E\t\t1712817000\t1712817000\n"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
			},
		},
		logger: zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	resp, err := logic.GetChatClawState(ctx, "ins-1")
	if err != nil {
		t.Fatalf("get chatclaw state: %v", err)
	}
	if len(resp.Agents) != 1 || resp.Agents[0].ID != "main" {
		t.Fatalf("unexpected agents: %+v", resp.Agents)
	}
	if len(resp.Teams) != 1 || resp.Teams[0].ID != "solo-team" {
		t.Fatalf("unexpected teams: %+v", resp.Teams)
	}
	if len(resp.Conversations) != 1 || resp.Conversations[0].ID != "conv_1" {
		t.Fatalf("unexpected conversations: %+v", resp.Conversations)
	}
	if resp.Conversations[0].AgentID != "main" {
		t.Fatalf("unexpected conversation agent id: %+v", resp.Conversations[0])
	}
}

func TestCreateChatClawAgentRunsProjectionAndReturnsSnapshotRow(t *testing.T) {
	prevUUIDFn := chatClawUUIDFn
	chatClawUUIDFn = func() string { return "agent-one" }
	defer func() { chatClawUUIDFn = prevUUIDFn }()

	createdAgentID := "agent_agentone"
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: &commandSandboxAdapterStub{
			processFunc: func(req *psandbox.ProcessStartRequest) []psandbox.ProcessStreamEvent {
				if req == nil || len(req.Args) == 0 {
					return []psandbox.ProcessStreamEvent{{Ended: true, ExitCode: 0, Status: "SUCCESS"}}
				}
				bash := req.Args[len(req.Args)-1]
				switch {
				case strings.Contains(bash, "INSERT INTO chatclaw_agents"):
					return []psandbox.ProcessStreamEvent{{Ended: true, ExitCode: 0, Status: "SUCCESS"}}
				case strings.Contains(bash, chatClawProjectionOKPrefix):
					return []psandbox.ProcessStreamEvent{{Stdout: "__CTL_CC_PROJECTION__CHANGED\n__CTL_CC_PROJECTION__OK\n"}, {Ended: true, ExitCode: 0, Status: "SUCCESS"}}
				case strings.Contains(bash, "openclaw-gateway.service"):
					return []psandbox.ProcessStreamEvent{{Ended: true, ExitCode: 0, Status: "SUCCESS"}}
				case strings.Contains(bash, chatClawSnapshotAgentPrefix):
					return []psandbox.ProcessStreamEvent{{
						Stdout: fmt.Sprintf("__CTL_CC_AGENT__%s\t5265736561726368\t64657363\tresearch\t2F686F6D652F6C69676874636C61772F2E6F70656E636C61772F776F726B73706163652D%s\t1712817000\t1712817001\n", createdAgentID, hex.EncodeToString([]byte(createdAgentID))),
					}, {Ended: true, ExitCode: 0, Status: "SUCCESS"}}
				default:
					return []psandbox.ProcessStreamEvent{{Ended: true, ExitCode: 0, Status: "SUCCESS"}}
				}
			},
		},
		logger: zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	resp, err := logic.CreateChatClawAgent(ctx, "ins-1", &transport.CreateChatClawAgentRequest{
		Name:        "Research",
		Description: "desc",
		Specialty:   "research",
	})
	if err != nil {
		t.Fatalf("create chatclaw agent: %v", err)
	}
	if resp.Name != "Research" || resp.Specialty != "research" {
		t.Fatalf("unexpected response: %+v", resp)
	}

	adapter := logic.sandboxAdapter.(*commandSandboxAdapterStub)
	if len(adapter.processCalls) != 4 {
		t.Fatalf("expected 4 process calls, got %d", len(adapter.processCalls))
	}
	if !strings.Contains(adapter.processCalls[0].Args[len(adapter.processCalls[0].Args)-1], "ensure_sqlite3") {
		t.Fatalf("expected sqlite3 bootstrap in create command, got %+v", adapter.processCalls[0])
	}
	if !strings.Contains(adapter.processCalls[1].Args[len(adapter.processCalls[1].Args)-1], chatClawProjectionOKPrefix) {
		t.Fatalf("expected projection command in second call, got %+v", adapter.processCalls[1])
	}
	if !strings.Contains(adapter.processCalls[1].Args[len(adapter.processCalls[1].Args)-1], `config.gateway.controlUi.allowedOrigins = ["*"];`) {
		t.Fatalf("expected control ui allowed origins in projection command, got %+v", adapter.processCalls[1])
	}
	if !strings.Contains(adapter.processCalls[1].Args[len(adapter.processCalls[1].Args)-1], `config.gateway.bind = "lan";`) {
		t.Fatalf("expected gateway bind lan in projection command, got %+v", adapter.processCalls[1])
	}
	if !strings.Contains(adapter.processCalls[1].Args[len(adapter.processCalls[1].Args)-1], `config.gateway.auth.mode = "trusted-proxy";`) {
		t.Fatalf("expected trusted-proxy auth in projection command, got %+v", adapter.processCalls[1])
	}
	if !strings.Contains(adapter.processCalls[1].Args[len(adapter.processCalls[1].Args)-1], `config.gateway.auth.trustedProxy.userHeader = "Host";`) {
		t.Fatalf("expected trusted proxy user header in projection command, got %+v", adapter.processCalls[1])
	}
	if !strings.Contains(adapter.processCalls[1].Args[len(adapter.processCalls[1].Args)-1], `config.gateway.trustedProxies = ["0.0.0.0/0"];`) {
		t.Fatalf("expected trusted proxies wildcard in projection command, got %+v", adapter.processCalls[1])
	}
	if !strings.Contains(adapter.processCalls[1].Args[len(adapter.processCalls[1].Args)-1], `OPENCLAW_RUNTIME_HOME`) ||
		!strings.Contains(adapter.processCalls[1].Args[len(adapter.processCalls[1].Args)-1], `sudo -u "$OPENCLAW_RUNTIME_USER"`) {
		t.Fatalf("expected projection to target runtime user home, got %+v", adapter.processCalls[1])
	}
	if !strings.Contains(adapter.processCalls[2].Args[len(adapter.processCalls[2].Args)-1], "openclaw-gateway.service") {
		t.Fatalf("expected gateway restart after changed projection, got %+v", adapter.processCalls[2])
	}
}

func TestExecDebugCommandSupportsRawBash(t *testing.T) {
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: &commandSandboxAdapterStub{
			processEvents: []psandbox.ProcessStreamEvent{
				{PID: 6789},
				{Stdout: "raw-debug\n"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
			},
		},
		logger: zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	resp, err := logic.ExecDebugCommand(ctx, "ins-1", "echo raw-debug", "")
	if err != nil {
		t.Fatalf("exec raw debug command: %v", err)
	}
	if resp.Status != "SUCCESS" {
		t.Fatalf("expected success status, got %s", resp.Status)
	}

	adapter := logic.sandboxAdapter.(*commandSandboxAdapterStub)
	if len(adapter.processCalls) != 1 {
		t.Fatalf("expected one process call, got %d", len(adapter.processCalls))
	}
	if got := adapter.processCalls[0].Args[2]; got != "echo raw-debug" {
		t.Fatalf("expected raw bash command, got %q", got)
	}
}

func TestExecDebugCommandSupportsRunAsAgentUser(t *testing.T) {
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: &commandSandboxAdapterStub{
			processEvents: []psandbox.ProcessStreamEvent{
				{PID: 6790},
				{Stdout: "raw-debug\n"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
			},
		},
		logger: zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	resp, err := logic.ExecDebugCommand(ctx, "ins-1", "echo raw-debug", "agentuser")
	if err != nil {
		t.Fatalf("exec raw debug command as agentuser: %v", err)
	}
	if resp.RunAsUser != "agentuser" {
		t.Fatalf("expected run_as_user to round-trip, got %+v", resp)
	}

	adapter := logic.sandboxAdapter.(*commandSandboxAdapterStub)
	if len(adapter.processCalls) != 1 {
		t.Fatalf("expected one process call, got %d", len(adapter.processCalls))
	}
	cmd := adapter.processCalls[0].Args[2]
	if !strings.Contains(cmd, `target_user='agentuser'`) {
		t.Fatalf("expected wrapped target user, got %q", cmd)
	}
	if !strings.Contains(cmd, `sudo -u "$target_user"`) {
		t.Fatalf("expected sudo wrapper, got %q", cmd)
	}
	if !strings.Contains(cmd, `bash -c 'echo raw-debug'`) {
		t.Fatalf("expected raw command inside wrapped shell, got %q", cmd)
	}
	if adapter.processCalls[0].Env["HOME"] != "/home/agentuser" {
		t.Fatalf("expected HOME env for agentuser, got %+v", adapter.processCalls[0].Env)
	}
	if !strings.Contains(adapter.processCalls[0].Env["PATH"], "/home/agentuser/.local/bin") {
		t.Fatalf("expected PATH env to include agentuser local bin, got %+v", adapter.processCalls[0].Env)
	}
}

func TestExecDebugCommandRejectsUnsupportedRunAsUser(t *testing.T) {
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: &commandSandboxAdapterStub{},
		logger:         zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	_, err := logic.ExecDebugCommand(ctx, "ins-1", "echo raw-debug", "root")
	if !errors.Is(err, errcode.ErrDebugInvalidRunAs) {
		t.Fatalf("expected invalid run_as_user error, got %v", err)
	}
}

func TestConfigureOnboardUsesProcessStream(t *testing.T) {
	origAdapterConf := config.ServerConf.AdapterConfig
	t.Cleanup(func() {
		config.ServerConf.AdapterConfig = origAdapterConf
	})
	config.ServerConf.AdapterConfig = &config.AdapterConfig{
		LLMGateway: &config.LLMGatewayConfig{
			Enabled:              true,
			DefaultBaseURL:       "http://gateway.example.com",
			DefaultModelID:       "kimi-k2.5",
			DefaultCompatibility: "openai",
			DefaultGatewayPort:   18789,
			DefaultProviderID:    "custom-test",
		},
	}

	adapter := &commandSandboxAdapterStub{
		processEvents: []psandbox.ProcessStreamEvent{
			{PID: 9001},
			{Stdout: "ok\n"},
			{Ended: true, ExitCode: 0, Status: "SUCCESS"},
		},
	}
	logic := &logic{
		sandboxAdapter: adapter,
		logger:         zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	if err := logic.configureOnboard(ctx, "sbx-1", "sk-test", "gw-token-test", &gatewayRuntimeConfig{
		DefaultBaseURL:       "https://llmgw-inner.example.com/v1",
		DefaultModelID:       "auto",
		DefaultCompatibility: "openai",
	}); err != nil {
		t.Fatalf("configure onboard: %v", err)
	}
	if len(adapter.calls) != 0 {
		t.Fatalf("expected onboard to avoid TAT ExecCommand, got %d calls", len(adapter.calls))
	}
	if len(adapter.processCalls) != 2 {
		t.Fatalf("expected two process calls, got %d", len(adapter.processCalls))
	}
	ensureReq := adapter.processCalls[0]
	if ensureReq.Cmd != "/bin/bash" {
		t.Fatalf("expected bash process, got %q", ensureReq.Cmd)
	}
	if len(ensureReq.Args) != 3 || ensureReq.Args[0] != "-l" || ensureReq.Args[1] != "-c" {
		t.Fatalf("expected bash -l -c args, got %#v", ensureReq.Args)
	}
	if !strings.Contains(ensureReq.Args[2], "command -v acli") || !strings.Contains(ensureReq.Args[2], "curl -fsSL -z /usr/local/bin/harness") {
		t.Fatalf("expected model cli ensure command, got %q", ensureReq.Args[2])
	}
	modelReq := adapter.processCalls[1]
	if modelReq.Cmd != "/bin/bash" {
		t.Fatalf("expected bash process for model set, got %q", modelReq.Cmd)
	}
	if !strings.Contains(modelReq.Args[2], "acli provider save") || !strings.Contains(modelReq.Args[2], "harness model set") {
		t.Fatalf("expected acli-first provider save command, got %q", modelReq.Args[2])
	}
	if !strings.Contains(modelReq.Args[2], "ACLI_SECRET_API_KEY=") ||
		!strings.Contains(modelReq.Args[2], "sk-test") ||
		!strings.Contains(modelReq.Args[2], "--api-key \"$ACLI_SECRET_API_KEY\"") {
		t.Fatalf("expected api key flag in command, got %q", modelReq.Args[2])
	}
	if !strings.Contains(modelReq.Args[2], "--name") ||
		!strings.Contains(modelReq.Args[2], "acli model switch --model") ||
		!strings.Contains(modelReq.Args[2], "--model-name") ||
		!strings.Contains(modelReq.Args[2], "auto") ||
		!strings.Contains(modelReq.Args[2], "switch_model=") ||
		!strings.Contains(modelReq.Args[2], "model_name") ||
		!strings.Contains(modelReq.Args[2], "--model \"$switch_model\"") ||
		strings.Contains(modelReq.Args[2], "--agent") ||
		!strings.Contains(modelReq.Args[2], "--api") ||
		!strings.Contains(modelReq.Args[2], "--model-id") ||
		!strings.Contains(modelReq.Args[2], "--model-name") ||
		!strings.Contains(modelReq.Args[2], "custom") {
		t.Fatalf("expected fixed custom provider in command, got %q", modelReq.Args[2])
	}
	if modelReq.Env["HOME"] != "/home/agentuser" {
		t.Fatalf("expected HOME env for agentuser, got %+v", modelReq.Env)
	}
}

func TestDebugCommandSpecForOpenclawAgentSmoke(t *testing.T) {
	spec, ok := debugCommandSpecFor("openclaw_agent_smoke")
	if !ok {
		t.Fatalf("expected smoke command to be registered")
	}
	if spec.timeoutSec != 90 {
		t.Fatalf("expected 90s timeout, got %d", spec.timeoutSec)
	}
	if !strings.Contains(spec.bash, "openclaw-debug-gateway.log") {
		t.Fatalf("expected gateway log path in smoke script")
	}
	if !strings.Contains(spec.bash, "agent --local --agent main --message") || !strings.Contains(spec.bash, "Reply with only the word OK") {
		t.Fatalf("expected agent smoke command, got %s", spec.bash)
	}
}

func TestDebugCommandSpecForOpenclawSoul(t *testing.T) {
	spec, ok := debugCommandSpecFor("openclaw_soul")
	if !ok {
		t.Fatalf("expected soul command to be registered")
	}
	if spec.timeoutSec != debugExecTimeoutSec {
		t.Fatalf("expected %d timeout, got %d", debugExecTimeoutSec, spec.timeoutSec)
	}
	if !strings.Contains(spec.bash, ".openclaw/workspace/SOUL.md") {
		t.Fatalf("expected SOUL.md path, got %s", spec.bash)
	}
}

func TestDebugCommandSpecForOpenclawAgentIPSmoke(t *testing.T) {
	spec, ok := debugCommandSpecFor("openclaw_agent_ip_smoke")
	if !ok {
		t.Fatalf("expected ip smoke command to be registered")
	}
	if spec.timeoutSec != 120 {
		t.Fatalf("expected 120s timeout, got %d", spec.timeoutSec)
	}
	if !strings.Contains(spec.bash, "Use tools if needed, then reply with only the server IP address.") {
		t.Fatalf("expected IP smoke prompt, got %s", spec.bash)
	}
}

func TestDebugCommandSpecForOpenclawAgentFileSmoke(t *testing.T) {
	spec, ok := debugCommandSpecFor("openclaw_agent_file_smoke")
	if !ok {
		t.Fatalf("expected file smoke command to be registered")
	}
	if spec.timeoutSec != 120 {
		t.Fatalf("expected 120s timeout, got %d", spec.timeoutSec)
	}
	if !strings.Contains(spec.bash, "read /etc/lightclaw/image-version") {
		t.Fatalf("expected file smoke prompt, got %s", spec.bash)
	}
}

func TestDebugCommandSpecForOpenclawChannelsStatus(t *testing.T) {
	spec, ok := debugCommandSpecFor("openclaw_channels_status")
	if !ok {
		t.Fatalf("expected channels status command to be registered")
	}
	if spec.timeoutSec != 60 {
		t.Fatalf("expected 60s timeout, got %d", spec.timeoutSec)
	}
	if !strings.Contains(spec.bash, "openclaw channels list") {
		t.Fatalf("expected channels list command, got %s", spec.bash)
	}
	if !strings.Contains(spec.bash, "openclaw channels status --probe") {
		t.Fatalf("expected channels status command, got %s", spec.bash)
	}
}

func TestDebugCommandSpecForOpenclawLogsRecent(t *testing.T) {
	spec, ok := debugCommandSpecFor("openclaw_logs_recent")
	if !ok {
		t.Fatalf("expected logs command to be registered")
	}
	if spec.timeoutSec != 60 {
		t.Fatalf("expected 60s timeout, got %d", spec.timeoutSec)
	}
	if !strings.Contains(spec.bash, "openclaw logs --limit 200 --local-time") {
		t.Fatalf("expected recent logs command, got %s", spec.bash)
	}
}

func TestDebugCommandSpecForOpenclawSessionsRecent(t *testing.T) {
	spec, ok := debugCommandSpecFor("openclaw_sessions_recent")
	if !ok {
		t.Fatalf("expected sessions command to be registered")
	}
	if spec.timeoutSec != 60 {
		t.Fatalf("expected 60s timeout, got %d", spec.timeoutSec)
	}
	if !strings.Contains(spec.bash, `SESS_DIR="${HOME}/.openclaw/agents/main/sessions"`) {
		t.Fatalf("expected sessions dir bootstrap, got %s", spec.bash)
	}
	if !strings.Contains(spec.bash, `find "$SESS_DIR" -maxdepth 1 -type f -name '*.jsonl'`) {
		t.Fatalf("expected transcript scan command, got %s", spec.bash)
	}
}

func TestResolveDebugCommandSpecFallsBackToRawBash(t *testing.T) {
	spec, kind, err := resolveDebugCommandSpec("echo hi")
	if err != nil {
		t.Fatalf("resolve raw debug command: %v", err)
	}
	if kind != "debug_raw" {
		t.Fatalf("expected debug_raw kind, got %s", kind)
	}
	if spec.bash != "echo hi" {
		t.Fatalf("expected raw bash passthrough, got %q", spec.bash)
	}
	if spec.timeoutSec != 120 {
		t.Fatalf("expected raw command timeout 120s, got %d", spec.timeoutSec)
	}
}

func TestDebugCommandSpecForOpenclawQQBotLogs(t *testing.T) {
	spec, ok := debugCommandSpecFor("openclaw_qqbot_logs")
	if !ok {
		t.Fatalf("expected qqbot logs command to be registered")
	}
	if spec.timeoutSec != 60 {
		t.Fatalf("expected 60s timeout, got %d", spec.timeoutSec)
	}
	if !strings.Contains(spec.bash, "openclaw channels logs --channel qqbot") {
		t.Fatalf("expected qqbot channel logs command, got %s", spec.bash)
	}
	if !strings.Contains(spec.bash, "openclaw logs --limit 120 --local-time") {
		t.Fatalf("expected gateway logs fallback, got %s", spec.bash)
	}
}

func TestDebugCommandSpecForOpenclawDoctor(t *testing.T) {
	spec, ok := debugCommandSpecFor("openclaw_doctor")
	if !ok {
		t.Fatalf("expected doctor command to be registered")
	}
	if spec.timeoutSec != 90 {
		t.Fatalf("expected 90s timeout, got %d", spec.timeoutSec)
	}
	if spec.bash != "openclaw doctor" {
		t.Fatalf("expected direct doctor command, got %s", spec.bash)
	}
}

func TestDebugCommandSpecForOpenclawGatewayStatus(t *testing.T) {
	spec, ok := debugCommandSpecFor("openclaw_gateway_status")
	if !ok {
		t.Fatalf("expected gateway status command to be registered")
	}
	if spec.timeoutSec != debugExecTimeoutSec {
		t.Fatalf("expected debug timeout, got %d", spec.timeoutSec)
	}
	if !strings.Contains(spec.bash, `ps -ef | grep -E 'openclaw-gateway|openclaw gateway'`) {
		t.Fatalf("expected process inspection command, got %s", spec.bash)
	}
	if !strings.Contains(spec.bash, `systemctl is-active openclaw-gateway`) {
		t.Fatalf("expected systemd status command, got %s", spec.bash)
	}
}

func TestOpenclawShellCommandUsesDirectBinaryOnly(t *testing.T) {
	cmd := openclawShellCommand("gateway restart")
	if cmd != "openclaw gateway restart" {
		t.Fatalf("expected direct openclaw command, got %s", cmd)
	}
	if strings.Contains(cmd, ".bashrc") || strings.Contains(cmd, "NVM_DIR") || strings.Contains(cmd, "PNPM_HOME") {
		t.Fatalf("expected no shell env bootstrap, got %s", cmd)
	}
	if strings.Contains(cmd, "openclaw.mjs") {
		t.Fatalf("expected no node fallback, got %s", cmd)
	}
	if strings.Contains(cmd, "OPENCLAW_GLOBAL_ROOT") {
		t.Fatalf("expected no pnpm global root fallback, got %s", cmd)
	}
	if strings.Contains(cmd, "restored=0") || strings.Contains(cmd, "OPENCLAW_CONFIG_FILE") || strings.Contains(cmd, "OPENCLAW_CONFIG_PATH") {
		t.Fatalf("expected no config restore fallback, got %s", cmd)
	}
}

func TestConfigureChannelReturnsErrorWhenRestartCommandFails(t *testing.T) {
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: &commandSandboxAdapterStub{
			processEvents: []psandbox.ProcessStreamEvent{
				{Stdout: "added"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
				{Stdout: "restart failed"},
				{Ended: true, ExitCode: 1, Status: "FAILED", Stderr: "restart failed"},
			},
		},
		logger: zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	resp, err := logic.ConfigureChannel(ctx, "ins-1", &transport.ConfigureChannelRequest{
		Channel: "openclaw-weixin",
		Token:   "token-1",
	})
	if !errors.Is(err, errcode.ErrChannelConfigFailed) {
		t.Fatalf("expected channel config failed, got %v", err)
	}
	if resp == nil {
		t.Fatalf("expected response on restart failure")
	}
	if resp.Status != "Failed" {
		t.Fatalf("expected failed response, got %s", resp.Status)
	}
	if resp.GatewayRestarted {
		t.Fatalf("expected gateway restart to be false")
	}
}

func TestConfigureChannelShellEscapesUserControlledArguments(t *testing.T) {
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: &commandSandboxAdapterStub{
			processEvents: []psandbox.ProcessStreamEvent{
				{Stdout: "added"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
				{Stdout: "restarted"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
			},
		},
		logger: zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	_, err := logic.ConfigureChannel(ctx, "ins-1", &transport.ConfigureChannelRequest{
		Channel: "qqbot; touch /tmp/pwned",
		Account: "acct'$(id)'",
		Token:   `tok"; rm -rf /`,
	})
	if err != nil {
		t.Fatalf("configure channel: %v", err)
	}

	adapter := logic.sandboxAdapter.(*commandSandboxAdapterStub)
	if len(adapter.processCalls) == 0 {
		t.Fatalf("expected command execution")
	}
	addReq := adapter.processCalls[0]
	if addReq.Cmd != "/bin/bash" || len(addReq.Args) != 3 {
		t.Fatalf("expected bash -l -c request, got %#v", addReq)
	}
	addCmd := addReq.Args[2]
	if !strings.Contains(addCmd, "--channel 'qqbot; touch /tmp/pwned'") {
		t.Fatalf("expected quoted channel argument, got %s", addCmd)
	}
	if !strings.Contains(addCmd, "--account 'acct'\"'\"'$(id)'\"'\"''") {
		t.Fatalf("expected quoted account argument, got %s", addCmd)
	}
	if !strings.Contains(addCmd, "--token 'tok\"; rm -rf /'") {
		t.Fatalf("expected quoted token argument, got %s", addCmd)
	}
}

func TestConfigureChannelUsesTATSafeGatewayRestartCommand(t *testing.T) {
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: &commandSandboxAdapterStub{
			processEvents: []psandbox.ProcessStreamEvent{
				{Stdout: "added"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
				{Stdout: "restarted"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
			},
		},
		logger: zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	_, err := logic.ConfigureChannel(ctx, "ins-1", &transport.ConfigureChannelRequest{
		Channel: "openclaw-weixin",
		Token:   "token-1",
	})
	if err != nil {
		t.Fatalf("configure channel: %v", err)
	}

	adapter := logic.sandboxAdapter.(*commandSandboxAdapterStub)
	if len(adapter.processCalls) < 2 {
		t.Fatalf("expected restart command execution")
	}
	restartReq := adapter.processCalls[1]
	if restartReq.Cmd != "/bin/bash" || len(restartReq.Args) != 3 {
		t.Fatalf("expected bash -l -c request, got %#v", restartReq)
	}
	restartCmd := restartReq.Args[2]
	if !strings.Contains(restartCmd, `runtime_uid="$(id -u)"`) ||
		!strings.Contains(restartCmd, `export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/${runtime_uid}}"`) {
		t.Fatalf("expected XDG_RUNTIME_DIR bootstrap in restart command, got %s", restartCmd)
	}
	if !strings.Contains(restartCmd, `loginctl enable-linger "$(id -un)" 2>/dev/null || true`) {
		t.Fatalf("expected loginctl bootstrap in restart command, got %s", restartCmd)
	}
	if !strings.Contains(restartCmd, `run_openclaw gateway restart`) &&
		!strings.Contains(restartCmd, `openclaw gateway restart`) &&
		!strings.Contains(restartCmd, `node "$OPENCLAW_GLOBAL_ROOT/openclaw/openclaw.mjs" gateway restart`) {
		t.Fatalf("expected gateway restart invocation, got %s", restartCmd)
	}
}

func TestConfigureQQChannelEnsuresPluginBeforeAdd(t *testing.T) {
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &modelinstance.Entity{
				InstanceId: "ins-1",
				SandboxId:  "sbx-1",
				Status:     modelinstance.InstanceStatusRunning,
			},
		},
		sandboxAdapter: &commandSandboxAdapterStub{
			processEvents: []psandbox.ProcessStreamEvent{
				{Stdout: "plugin ready"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
				{Stdout: "added"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
				{Stdout: "restarted"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
			},
		},
		logger: zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	_, err := logic.ConfigureChannel(ctx, "ins-1", &transport.ConfigureChannelRequest{
		Channel: "qqbot",
		Token:   "token-1",
	})
	if err != nil {
		t.Fatalf("configure channel: %v", err)
	}

	adapter := logic.sandboxAdapter.(*commandSandboxAdapterStub)
	if len(adapter.calls) != 0 {
		t.Fatalf("expected channel config to avoid TAT ExecCommand, got %d calls", len(adapter.calls))
	}
	if len(adapter.processCalls) != 3 {
		t.Fatalf("expected plugin check + add + restart process calls, got %d", len(adapter.processCalls))
	}
	pluginCmd := adapter.processCalls[0].Args[2]
	if !strings.Contains(pluginCmd, `openclaw plugins list`) {
		t.Fatalf("expected qqbot plugin list preflight, got %s", pluginCmd)
	}
	if !strings.Contains(pluginCmd, `grep -Fq`) || !strings.Contains(pluginCmd, `openclaw-qqbot`) {
		t.Fatalf("expected qqbot plugin runtime id check, got %s", pluginCmd)
	}
	if !strings.Contains(pluginCmd, `openclaw plugins install @tencent-connect/openclaw-qqbot`) {
		t.Fatalf("expected qqbot plugin install fallback, got %s", pluginCmd)
	}
	addCmd := adapter.processCalls[1].Args[2]
	if !strings.Contains(addCmd, "--channel 'qqbot'") {
		t.Fatalf("expected qqbot add command after plugin preflight, got %s", addCmd)
	}
}

func TestFinishWeixinLoginSuccessFailsOnCommandFailure(t *testing.T) {
	logic := &logic{
		sandboxAdapter: &commandSandboxAdapterStub{
			processEvents: []psandbox.ProcessStreamEvent{
				{Stdout: "restart failed"},
				{Ended: true, ExitCode: 1, Status: "FAILED", Stderr: "restart failed"},
			},
		},
		logger: zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	var lastUpdates map[string]interface{}
	var lastEvent transport.WeixinLoginSessionEvent
	err := logic.finishWeixinLoginSuccess(ctx, "sbx-1", &channelloginsession.Entity{
		SessionID:  "sess-1",
		InstanceID: "ins-1",
	}, func(updates map[string]interface{}, event transport.WeixinLoginSessionEvent) {
		lastUpdates = updates
		lastEvent = event
	})
	if err == nil {
		t.Fatalf("expected restart failure")
	}
	if got := lastUpdates[channelloginsession.ColumnStatus]; got != channelloginsession.StatusFailed {
		t.Fatalf("expected failed status update, got %v", got)
	}
	if got := lastUpdates[channelloginsession.ColumnRestartStatus]; got != "failed" {
		t.Fatalf("expected failed restart status, got %v", got)
	}
	if lastEvent.Status != channelloginsession.StatusFailed {
		t.Fatalf("expected failed event status, got %s", lastEvent.Status)
	}
}

func TestFinishWeixinLoginSuccessUsesProcessGatewayRestartCommand(t *testing.T) {
	logic := &logic{
		sandboxAdapter: &commandSandboxAdapterStub{
			processEvents: []psandbox.ProcessStreamEvent{
				{Stdout: "restarted"},
				{Ended: true, ExitCode: 0, Status: "SUCCESS"},
			},
		},
		logger: zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	err := logic.finishWeixinLoginSuccess(ctx, "sbx-1", &channelloginsession.Entity{
		SessionID:  "sess-1",
		InstanceID: "ins-1",
	}, func(map[string]interface{}, transport.WeixinLoginSessionEvent) {})
	if err != nil {
		t.Fatalf("finish weixin login success: %v", err)
	}

	adapter := logic.sandboxAdapter.(*commandSandboxAdapterStub)
	if len(adapter.calls) != 0 {
		t.Fatalf("expected weixin login restart to avoid TAT ExecCommand, got %d calls", len(adapter.calls))
	}
	if len(adapter.processCalls) != 1 {
		t.Fatalf("expected one process restart command, got %d", len(adapter.processCalls))
	}
	restartReq := adapter.processCalls[0]
	if restartReq.Cmd != "/bin/bash" || len(restartReq.Args) != 3 {
		t.Fatalf("expected bash -l -c restart request, got %#v", restartReq)
	}
	restartCmd := restartReq.Args[2]
	if !strings.Contains(restartCmd, `runtime_uid="$(id -u)"`) ||
		!strings.Contains(restartCmd, `export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/${runtime_uid}}"`) {
		t.Fatalf("expected XDG_RUNTIME_DIR bootstrap in restart command, got %s", restartCmd)
	}
	if !strings.Contains(restartCmd, `loginctl enable-linger "$(id -un)" 2>/dev/null || true`) {
		t.Fatalf("expected loginctl bootstrap in restart command, got %s", restartCmd)
	}
}
