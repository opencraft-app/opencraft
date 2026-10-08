package instance

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	adapterfactory "ctl/pkg/adapter/factory"
	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/transport"

	"go.uber.org/zap"
)

// ---- stubs ----

// desktopInstanceDaoStub 通过 embed Dao 接口，只覆盖桌面链路用到的 GetByInstanceID。
type desktopInstanceDaoStub struct {
	modelinstance.Dao
	entity *modelinstance.Entity
}

func (s *desktopInstanceDaoStub) GetByInstanceID(_ pctx.Context, _ string) (*modelinstance.Entity, error) {
	if s.entity == nil {
		return nil, errcode.ErrInstanceNotFound
	}
	return s.entity, nil
}

// desktopSandboxStub 通过 embed Adapter 接口，只覆盖桌面链路用到的方法。
// v3：桌面复用主 sandbox，不再 CreateSandbox；provision/probe 走 StreamPtyCommand，
// idle 停服务走 ExecCommand。
type desktopSandboxStub struct {
	psandbox.Adapter
	mu         sync.Mutex
	ptyCalls   []psandbox.PtyExecStreamRequest
	ptyOutputs [][]psandbox.PtyExecStreamEvent
	// ExecCommand（reaper 停服务 / 按需装）记录与可控返回。
	execCalls   []string // 记录 sandboxID
	execCmds    []string // 记录命令内容
	execResult  *psandbox.ExecCommandResult
	execErr     error
	pauseCalls  []string
	resumeCalls []string
	// execFunc 若非空，则按命令内容动态返回（用于模拟按需装的进度序列，线程安全）。
	execFunc func(bash string) (*psandbox.ExecCommandResult, error)
	// execAuths 记录每次 ExecCommand 调用时从 ctx 取出的 session 鉴权，
	// 用于断言后台安装 goroutine 的 ctx 正确透传了用户 session。
	execAuths []string
}

func (s *desktopSandboxStub) StreamPtyCommand(_ context.Context, _ string, req *psandbox.PtyExecStreamRequest, onEvent func(psandbox.PtyExecStreamEvent) error) error {
	s.mu.Lock()
	idx := len(s.ptyCalls)
	s.ptyCalls = append(s.ptyCalls, *req)
	s.mu.Unlock()
	if idx >= len(s.ptyOutputs) {
		return nil
	}
	for _, ev := range s.ptyOutputs[idx] {
		if err := onEvent(ev); err != nil {
			return err
		}
	}
	return nil
}

func (s *desktopSandboxStub) ExecCommand(ctx context.Context, sandboxID string, bash string, _ int) (*psandbox.ExecCommandResult, error) {
	// 捕获 ctx 透传的 session 鉴权：真实 adapter 的 TAT 调用（/tat/*）依赖它，
	// 后台安装 goroutine 若漏传会导致鉴权失败。此处记录以便测试断言。
	var auth string
	if p, ok := ctx.(interface{ GetSessionAuthorization() string }); ok {
		auth = p.GetSessionAuthorization()
	}
	s.mu.Lock()
	s.execCalls = append(s.execCalls, sandboxID)
	s.execCmds = append(s.execCmds, bash)
	s.execAuths = append(s.execAuths, auth)
	fn := s.execFunc
	execErr := s.execErr
	execResult := s.execResult
	s.mu.Unlock()

	if fn != nil {
		return fn(bash)
	}
	if execErr != nil {
		return nil, execErr
	}
	if execResult != nil {
		return execResult, nil
	}
	return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0}, nil
}

// execCmdCount 线程安全读 ExecCommand 调用次数。
func (s *desktopSandboxStub) execCmdCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.execCalls)
}

// execAuthsSnapshot 线程安全快照每次 ExecCommand 捕获到的 session 鉴权。
func (s *desktopSandboxStub) execAuthsSnapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.execAuths...)
}

// ptyCallCount 线程安全读 StreamPtyCommand 调用次数。
func (s *desktopSandboxStub) ptyCallCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.ptyCalls)
}

func (s *desktopSandboxStub) PauseSandbox(_ context.Context, sandboxID string) error {
	s.pauseCalls = append(s.pauseCalls, sandboxID)
	return nil
}

func (s *desktopSandboxStub) ResumeSandbox(_ context.Context, sandboxID string, _ *psandbox.ResumeSandboxRequest) (*psandbox.Sandbox, error) {
	s.resumeCalls = append(s.resumeCalls, sandboxID)
	return &psandbox.Sandbox{SandboxID: sandboxID}, nil
}

// desktopStubAdapterFactory 供 reaper 测试替换全局工厂。
type desktopStubAdapterFactory struct {
	adapterfactory.AdapterFactory
	adapter psandbox.Adapter
}

func (f *desktopStubAdapterFactory) SandboxAdapter() psandbox.Adapter { return f.adapter }

func newDesktopTestLogic(dao *desktopInstanceDaoStub, sb *desktopSandboxStub) *logic {
	return &logic{
		instanceDao:    dao,
		sandboxAdapter: sb,
		logger:         zap.NewNop(),
	}
}

// desktopTestEntity 复用主 sandbox：entity.SandboxId 即桌面运行的机器。
func desktopTestEntity() *modelinstance.Entity {
	return &modelinstance.Entity{
		InstanceId: "ins-desktop-1",
		UserId:     "user-desktop-1",
		SandboxId:  "sb-desktop-1",
		Status:     modelinstance.InstanceStatusRunning,
	}
}

func ptyFinishEvents(output string) []psandbox.PtyExecStreamEvent {
	return []psandbox.PtyExecStreamEvent{
		{Type: "output", Chunk: output},
		{Type: "finished", Status: "SUCCESS", ExitCode: 0},
	}
}

// ptyFinishEventsWithExit 模拟命令输出 + 指定退出码/状态，用于复现
// "PTY set -e 污染退出码" 场景（stdout 有业务 marker 但 exit != 0）。
func ptyFinishEventsWithExit(output, status string, exitCode int64) []psandbox.PtyExecStreamEvent {
	return []psandbox.PtyExecStreamEvent{
		{Type: "output", Chunk: output},
		{Type: "finished", Status: status, ExitCode: exitCode},
	}
}

// withDesktopEnv v3：仅需 ingress 域名（不再有独立桌面模板）。
func withDesktopEnv(t *testing.T, domain string) {
	t.Helper()
	t.Setenv(desktopIngressDomainEnv, domain)
}

// fastDesktopInstallPoll 把按需装轮询间隔缩到极小，加速异步安装测试；测试结束恢复。
func fastDesktopInstallPoll(t *testing.T) {
	t.Helper()
	orig := desktopInstallPollInterval
	desktopInstallPollInterval = 5 * time.Millisecond
	t.Cleanup(func() { desktopInstallPollInterval = orig })
}

// ---- 纯函数测试 ----

func TestGenerateDesktopPassword(t *testing.T) {
	for i := 0; i < 32; i++ {
		pw, err := generateDesktopPassword()
		if err != nil {
			t.Fatalf("generateDesktopPassword returned error: %v", err)
		}
		if len(pw) != 8 {
			t.Fatalf("expected 8-char password, got %q", pw)
		}
		// VNC/RFB 密码上限 8 字符，靠扩字符集（62 个字母数字 ≈ 47.6 bit）提熵。
		for _, c := range pw {
			if !strings.ContainsRune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", c) {
				t.Fatalf("password %q contains char %q outside the 62-char alphanumeric set", pw, c)
			}
		}
	}
}

// TestGenerateDesktopPasswordEntropy 校验密码不是窄熵的 16 进制（CR-C）：
// 多次采样应覆盖远多于 16 种字符。
func TestGenerateDesktopPasswordEntropy(t *testing.T) {
	seen := map[rune]struct{}{}
	for i := 0; i < 500; i++ {
		pw, err := generateDesktopPassword()
		if err != nil {
			t.Fatalf("generateDesktopPassword returned error: %v", err)
		}
		for _, c := range pw {
			seen[c] = struct{}{}
		}
	}
	if len(seen) < 32 {
		t.Fatalf("password charset looks too narrow: only %d distinct chars in 500 samples", len(seen))
	}
}

func TestRenderDesktopProvisionCommand(t *testing.T) {
	const pw = "a1b2c3d4"
	cmd := renderDesktopProvisionCommand(pw)
	for _, want := range []string{
		// 阻塞 1：密码以 base64 传输、shell 侧解码后经命令替换注入，
		// 不再是单引号裸拼接（避免字符集扩展后变成命令注入面）。
		fmt.Sprintf("VNC_PW_B64=%q", base64.StdEncoding.EncodeToString([]byte(pw))),
		"base64 -d",
		"printf %s",
		`x11vnc -storepasswd "$VNC_PW"`,
		"systemctl enable --now " + desktopSystemdUnits,
		desktopProbeOKMarker,
		desktopProbePendingMarker,
		desktopMissingLayerMarker, // 范式 A：图形层检测桩
		"systemctl cat vela-novnc.service",
		desktopProvisionFailedMarker, // CR-P1#2：关键步骤失败必须能输出 fail marker
	} {
		if !strings.Contains(cmd, want) {
			t.Fatalf("provision command missing %q:\n%s", want, cmd)
		}
	}
	// 反向断言：不得退化回单引号包裹裸密码的拼接形态。
	if strings.Contains(cmd, "'"+pw+"'") {
		t.Fatalf("provision command must not embed password in raw single quotes:\n%s", cmd)
	}
}

// TestRenderDesktopProvisionCommandFailsHardOnKeySteps CR-P1#2 回归：
// 密码写入 / 服务启动等关键步骤必须走 fail()（输出 DESKTOP_PROVISION_FAILED 并 exit 非零），
// 不得再用 "|| true" 把失败吞成 exit 0——否则上层会误判为 Pending 永久轮询。
func TestRenderDesktopProvisionCommandFailsHardOnKeySteps(t *testing.T) {
	cmd := renderDesktopProvisionCommand("a1b2c3d4")
	for _, want := range []string{
		`x11vnc -storepasswd "$VNC_PW" "$VNC_PASSWD_FILE" >/dev/null 2>&1 || fail`,
		"|| fail \"enable desktop services\"",
	} {
		if !strings.Contains(cmd, want) {
			t.Fatalf("provision command must fail hard on key step, missing %q:\n%s", want, cmd)
		}
	}
	// 关键步骤不得再吞成 "|| true"（探测行仍允许，故检查带 storepasswd 的密码步骤）。
	if strings.Contains(cmd, `-storepasswd "$VNC_PW" "$VNC_PASSWD_FILE" >/dev/null 2>&1 || true`) {
		t.Fatalf("password store must not swallow failure with || true:\n%s", cmd)
	}
}

// TestDesktopProvisionFailureDetail CR-P1#2：从 fail marker 行提取可诊断原因。
func TestDesktopProvisionFailureDetail(t *testing.T) {
	cases := map[string]string{
		"DESKTOP_PROVISION_FAILED store vnc password":               "desktop provision failed: store vnc password",
		"noise\nDESKTOP_PROVISION_FAILED enable desktop services\n": "desktop provision failed: enable desktop services",
		"DESKTOP_PROVISION_FAILED":                                  "desktop provision failed",
		"no marker here":                                            "desktop provision failed",
	}
	for out, want := range cases {
		if got := desktopProvisionFailureDetail(out); got != want {
			t.Fatalf("desktopProvisionFailureDetail(%q)=%q, want %q", out, got, want)
		}
	}
}

// TestRenderDesktopProvisionCommandEscapesPassword 阻塞 1 回归：
// 即使密码含 shell 元字符（分号 / 反引号 / $() / 引号），经 base64 传输后也不得
// 以明文出现在命令行里执行——这是「%q + 双引号」做不到的（双引号内仍会命令替换）。
func TestRenderDesktopProvisionCommandEscapesPassword(t *testing.T) {
	hostile := `x"; rm -rf /; echo "$(id)"; '` + "`whoami`"
	cmd := renderDesktopProvisionCommand(hostile)

	// 元字符原样出现在命令里 = 注入成功 = 回归。
	for _, dangerous := range []string{`"; rm -rf /;`, "$(id)", "`whoami`"} {
		if strings.Contains(cmd, dangerous) {
			t.Fatalf("password not neutralized, command contains raw %q:\n%s", dangerous, cmd)
		}
	}
	// 必须走 base64 解码注入路径。
	for _, want := range []string{"base64 -d", "printf %s"} {
		if !strings.Contains(cmd, want) {
			t.Fatalf("expected base64-based password injection, missing %q:\n%s", want, cmd)
		}
	}
}

// TestRenderDesktopInstallCommandUsesDisplayOne 阻塞 2 回归：
// 按需装落盘的 4 个 unit 必须统一 DISPLAY :1，与镜像预装（build.sh --with-desktop）对齐；
// 遗留 :0 会导致 Xvfb 与 x11vnc/wm 连不上同一个 display。
func TestRenderDesktopInstallCommandUsesDisplayOne(t *testing.T) {
	cmd := renderDesktopInstallCommand()
	for _, want := range []string{
		"/usr/bin/Xvfb :1",
		"Environment=DISPLAY=:1",
		"x11vnc -display :1",
	} {
		if !strings.Contains(cmd, want) {
			t.Fatalf("install command missing %q:\n%s", want, cmd)
		}
	}
	if strings.Contains(cmd, ":0") {
		t.Fatalf("install command must not use DISPLAY :0 (inconsistent with prebuilt image):\n%s", cmd)
	}
}

func TestRenderDesktopProbeCommand(t *testing.T) {
	cmd := renderDesktopProbeCommand()
	if !strings.Contains(cmd, desktopProbeOKMarker) {
		t.Fatalf("probe command missing marker %q", desktopProbeOKMarker)
	}
	if !strings.Contains(cmd, "127.0.0.1:6080") {
		t.Fatalf("probe command missing noVNC port 6080:\n%s", cmd)
	}
}

func TestRenderDesktopStopServicesCommand(t *testing.T) {
	cmd := renderDesktopStopServicesCommand()
	if !strings.Contains(cmd, "systemctl stop "+desktopSystemdUnits) {
		t.Fatalf("stop command missing systemctl stop units:\n%s", cmd)
	}
	// 不得含 pause/关机语义（TB.4：只停服务不停机）。
	if strings.Contains(strings.ToLower(cmd), "poweroff") || strings.Contains(strings.ToLower(cmd), "shutdown") {
		t.Fatalf("stop command must not power off host:\n%s", cmd)
	}
}

func TestBuildDesktopWSURL(t *testing.T) {
	t.Setenv(desktopIngressDomainEnv, "ingress.example.com")
	got, err := buildDesktopWSURL("sb-abc123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := "wss://6080-sb-abc123.ingress.example.com/websockify"
	if got != want {
		t.Fatalf("ws url mismatch: got %q want %q", got, want)
	}

	t.Setenv(desktopIngressDomainEnv, "")
	if _, err := buildDesktopWSURL("sb-abc123"); !errors.Is(err, errcode.ErrDesktopNotConfigured) {
		t.Fatalf("expected ErrDesktopNotConfigured when domain unset, got %v", err)
	}
}

// ---- 状态机测试 ----

// TestEnsureDesktopSessionRequiresInstanceSandbox 实例主机无 sandbox 时应 Failed（TB.1）。
func TestEnsureDesktopSessionRequiresInstanceSandbox(t *testing.T) {
	resetDesktopSessionsForTest()
	withDesktopEnv(t, "ingress.example.com")
	entity := desktopTestEntity()
	entity.SandboxId = "" // 主机尚未就绪
	dao := &desktopInstanceDaoStub{entity: entity}
	l := newDesktopTestLogic(dao, &desktopSandboxStub{})
	ctx := pctx.NewContext(nil).WithUserID("user-desktop-1")

	if _, err := l.EnsureDesktopSession(ctx, "ins-desktop-1"); !errors.Is(err, errcode.ErrDesktopNotConfigured) {
		t.Fatalf("expected ErrDesktopNotConfigured when instance has no sandbox, got %v", err)
	}
}

func TestEnsureDesktopSessionRejectsForeignInstance(t *testing.T) {
	resetDesktopSessionsForTest()
	withDesktopEnv(t, "ingress.example.com")
	dao := &desktopInstanceDaoStub{entity: desktopTestEntity()}
	l := newDesktopTestLogic(dao, &desktopSandboxStub{})
	ctx := pctx.NewContext(nil).WithUserID("someone-else")

	if _, err := l.EnsureDesktopSession(ctx, "ins-desktop-1"); !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("expected ErrInstanceNotFound for foreign user, got %v", err)
	}
}

// TestEnsureDesktopSessionReusesInstanceSandbox 复用主 sandbox 拉起到 Ready（TB.1）。
func TestEnsureDesktopSessionReusesInstanceSandbox(t *testing.T) {
	resetDesktopSessionsForTest()
	withDesktopEnv(t, "ingress.example.com")
	dao := &desktopInstanceDaoStub{entity: desktopTestEntity()}
	sb := &desktopSandboxStub{
		// 第 1 次：provision 命令成功（探测 pending）；第 2 次：probe 成功。
		ptyOutputs: [][]psandbox.PtyExecStreamEvent{
			ptyFinishEvents(desktopProbePendingMarker),
			ptyFinishEvents(desktopProbeOKMarker),
		},
	}
	l := newDesktopTestLogic(dao, sb)
	ctx := pctx.NewContext(nil).WithUserID("user-desktop-1")

	resp, err := l.EnsureDesktopSession(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != transport.DesktopSessionStatusReady {
		t.Fatalf("expected Ready, got %q (reason=%q)", resp.Status, resp.Reason)
	}
	// 不新建机器：pause/resume/create 均不应被调用。
	if len(sb.pauseCalls) != 0 || len(sb.resumeCalls) != 0 {
		t.Fatalf("reuse mode must not pause/resume host: pause=%v resume=%v", sb.pauseCalls, sb.resumeCalls)
	}
	if len(sb.ptyCalls) != 2 {
		t.Fatalf("expected provision + probe TAT calls, got %d", len(sb.ptyCalls))
	}
	if !strings.Contains(sb.ptyCalls[0].Command, "x11vnc -storepasswd") {
		t.Fatalf("expected provision command to inject VNC password, got:\n%s", sb.ptyCalls[0].Command)
	}
	// 复用主 sandbox 的 ID 组装 ws url。
	if resp.WsURL != "wss://6080-sb-desktop-1.ingress.example.com/websockify" {
		t.Fatalf("unexpected ws url: %q", resp.WsURL)
	}
	if resp.Password == "" {
		t.Fatal("expected non-empty VNC password on Ready")
	}
	if resp.Width != desktopWidth || resp.Height != desktopHeight {
		t.Fatalf("unexpected resolution: %dx%d", resp.Width, resp.Height)
	}
}

// TestDesktopProvisionMissingLayerTriggersInstall 图形层未装应触发按需装 → Installing（TB.2）。
func TestDesktopProvisionMissingLayerTriggersInstall(t *testing.T) {
	resetDesktopSessionsForTest()
	fastDesktopInstallPoll(t)
	withDesktopEnv(t, "ingress.example.com")
	dao := &desktopInstanceDaoStub{entity: desktopTestEntity()}
	sb := &desktopSandboxStub{
		// provision 命令成功执行，但输出 MISSING marker（图形层未装）。
		ptyOutputs: [][]psandbox.PtyExecStreamEvent{
			ptyFinishEvents(desktopMissingLayerMarker),
		},
	}
	// 安装序列：启动命令成功（STARTED），进度查询立刻返回 DONE（模拟装完）。
	sb.execFunc = func(bash string) (*psandbox.ExecCommandResult, error) {
		if strings.Contains(bash, "vela-desktop-install.sh") {
			return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: desktopInstallStartedMark}, nil
		}
		// 进度查询命令
		return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: "PROGRESS=100\n" + desktopInstallDoneMarker}, nil
	}
	l := newDesktopTestLogic(dao, sb)
	ctx := pctx.NewContext(nil).WithUserID("user-desktop-1")

	resp, err := l.EnsureDesktopSession(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 首次返回应为 Installing（后台安装刚启动）。
	if resp.Status != transport.DesktopSessionStatusInstalling {
		t.Fatalf("expected Installing on missing graphics layer, got %q (reason=%q)", resp.Status, resp.Reason)
	}
	if resp.Message == "" {
		t.Fatal("expected install message for user")
	}

	// 后台 goroutine 应把状态推进到 Provisioning（装完转拉起）。
	session := l.desktopSessionOf("ins-desktop-1")
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, status, _, _ := session.snapshot(); status == transport.DesktopSessionStatusProvisioning {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, _, status, _, _ := session.snapshot(); status != transport.DesktopSessionStatusProvisioning {
		t.Fatalf("expected Provisioning after install done, got %q", status)
	}
	// 安装期间发过 ExecCommand（启动 + 至少一次进度查询）。
	if sb.execCmdCount() < 2 {
		t.Fatalf("expected install dispatch + progress poll ExecCommand, got %d", sb.execCmdCount())
	}
}

// TestDesktopInstallPropagatesSessionAuth 回归：后台安装 goroutine 经 TAT 下发命令，
// TAT endpoint 鉴权只认 ctx 透传的用户 session。startDesktopInstall 用 context.Background()
// 重建 ctx 时若漏传 SessionAuth，后台所有 ExecCommand 的 ctx 鉴权为空 → TAT
// "authentication required: authentication failed" → 桌面安装永远起不来（现网实测）。
// 本测试断言：后台安装 goroutine 的每次 ExecCommand 都带上了 parent 的 session 鉴权。
func TestDesktopInstallPropagatesSessionAuth(t *testing.T) {
	resetDesktopSessionsForTest()
	fastDesktopInstallPoll(t)
	withDesktopEnv(t, "ingress.example.com")
	dao := &desktopInstanceDaoStub{entity: desktopTestEntity()}
	sb := &desktopSandboxStub{
		ptyOutputs: [][]psandbox.PtyExecStreamEvent{
			ptyFinishEvents(desktopMissingLayerMarker),
		},
	}
	sb.execFunc = func(bash string) (*psandbox.ExecCommandResult, error) {
		if strings.Contains(bash, "vela-desktop-install.sh") {
			return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: desktopInstallStartedMark}, nil
		}
		return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: "PROGRESS=100\n" + desktopInstallDoneMarker}, nil
	}
	l := newDesktopTestLogic(dao, sb)

	const wantAuth = "Bearer test-session-token"
	const wantCookie = "lc_session=test-session-token"
	// parent ctx 带上用户 session 鉴权（模拟真实 HTTP 请求链路）。
	ctx := pctx.NewContext(nil).
		WithUserID("user-desktop-1").
		WithSessionAuth(wantAuth, wantCookie)

	resp, err := l.EnsureDesktopSession(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != transport.DesktopSessionStatusInstalling {
		t.Fatalf("expected Installing, got %q (reason=%q)", resp.Status, resp.Reason)
	}

	// 等后台安装 goroutine 收敛到 Provisioning。
	session := l.desktopSessionOf("ins-desktop-1")
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, status, _, _ := session.snapshot(); status == transport.DesktopSessionStatusProvisioning {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	auths := sb.execAuthsSnapshot()
	if len(auths) == 0 {
		t.Fatal("expected background install ExecCommand calls, got none")
	}
	// 核心断言：后台安装 goroutine 的每次 TAT 下发都必须带上 parent 的 session 鉴权。
	for i, got := range auths {
		if got != wantAuth {
			t.Fatalf("background install ExecCommand #%d ctx missing session auth: got %q, want %q", i, got, wantAuth)
		}
	}
}

// TestDesktopProvisionMissingLayerWithNonZeroExitTriggersInstall 现网 bj-7 回归：
// provision 命令输出了 DESKTOP_LAYER_MISSING，但因 PTY + set -e 把退出码污染成 1
// （status=FAILED exit_code=1 stdout=DESKTOP_LAYER_MISSING）。修复前会被 sandboxCommandSucceeded
// 误判为失败、直接置 Failed；修复后"标记优先于退出码"，仍应触发按需装 → Installing。
func TestDesktopProvisionMissingLayerWithNonZeroExitTriggersInstall(t *testing.T) {
	resetDesktopSessionsForTest()
	fastDesktopInstallPoll(t)
	withDesktopEnv(t, "ingress.example.com")
	dao := &desktopInstanceDaoStub{entity: desktopTestEntity()}
	sb := &desktopSandboxStub{
		// 关键：exit_code=1 + status=FAILED，但 stdout 含 MISSING marker（复现现网表现）。
		ptyOutputs: [][]psandbox.PtyExecStreamEvent{
			ptyFinishEventsWithExit(desktopMissingLayerMarker, "FAILED", 1),
		},
	}
	sb.execFunc = func(bash string) (*psandbox.ExecCommandResult, error) {
		if strings.Contains(bash, "vela-desktop-install.sh") {
			return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: desktopInstallStartedMark}, nil
		}
		return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: "PROGRESS=100\n" + desktopInstallDoneMarker}, nil
	}
	l := newDesktopTestLogic(dao, sb)
	ctx := pctx.NewContext(nil).WithUserID("user-desktop-1")

	resp, err := l.EnsureDesktopSession(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 修复后：即使 exit_code=1，只要 stdout 有 MISSING marker，就应走安装 → Installing。
	if resp.Status != transport.DesktopSessionStatusInstalling {
		t.Fatalf("regression: expected Installing on MISSING marker despite exit_code=1, got %q (reason=%q)", resp.Status, resp.Reason)
	}
	// 应确实 dispatch 了安装命令（而非停在 Failed）。
	session := l.desktopSessionOf("ins-desktop-1")
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, status, _, _ := session.snapshot(); status == transport.DesktopSessionStatusProvisioning {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, _, status, _, _ := session.snapshot(); status != transport.DesktopSessionStatusProvisioning {
		t.Fatalf("expected Provisioning after install done, got %q", status)
	}
}

// TestRenderDesktopProvisionCommandNoSetE 修复回归：provision 脚本不得使用 set -e，
// 且必须以 exit 0 收尾——把"缺失/就绪/pending"作为 stdout marker 传递，避免退出码污染。
func TestRenderDesktopProvisionCommandNoSetE(t *testing.T) {
	cmd := renderDesktopProvisionCommand("a1b2c3d4")
	if strings.Contains(cmd, "set -e") {
		t.Fatalf("provision command must not use set -e (pollutes PTY exit code):\n%s", cmd)
	}
	if !strings.Contains(cmd, "exit 0") {
		t.Fatalf("provision command must explicitly exit 0:\n%s", cmd)
	}
}

// TestDesktopInstallConcurrentSingleDispatch 并发触发按需装只应启动 1 次安装。
func TestDesktopInstallConcurrentSingleDispatch(t *testing.T) {
	resetDesktopSessionsForTest()
	fastDesktopInstallPoll(t)
	withDesktopEnv(t, "ingress.example.com")
	dao := &desktopInstanceDaoStub{entity: desktopTestEntity()}
	sb := &desktopSandboxStub{
		ptyOutputs: [][]psandbox.PtyExecStreamEvent{
			ptyFinishEvents(desktopMissingLayerMarker),
		},
	}
	var installDispatches int32
	sb.execFunc = func(bash string) (*psandbox.ExecCommandResult, error) {
		if strings.Contains(bash, "vela-desktop-install.sh") {
			atomic.AddInt32(&installDispatches, 1)
			return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: desktopInstallStartedMark}, nil
		}
		// 进度查询直接 DONE，让安装 goroutine 尽快收敛（避免泄漏 goroutine 干扰后续测试）。
		return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: "PROGRESS=100\n" + desktopInstallDoneMarker}, nil
	}
	l := newDesktopTestLogic(dao, sb)

	const goroutines = 12
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			ctx := pctx.NewContext(nil).WithUserID("user-desktop-1")
			_, _ = l.EnsureDesktopSession(ctx, "ins-desktop-1")
		}()
	}
	wg.Wait()

	// 等安装 goroutine 收敛到 Provisioning（说明它已退出，不再触碰全局状态）。
	session := l.desktopSessionOf("ins-desktop-1")
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, status, _, _ := session.snapshot(); status == transport.DesktopSessionStatusProvisioning {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	// installing 标记应确保并发下只 dispatch 一次安装。
	if got := atomic.LoadInt32(&installDispatches); got != 1 {
		t.Fatalf("TB.2 regression: expected exactly 1 install dispatch under concurrency, got %d", got)
	}
	if _, _, status, _, _ := session.snapshot(); status != transport.DesktopSessionStatusProvisioning {
		t.Fatalf("expected Provisioning after concurrent install converges, got %q", status)
	}
}

// TestDesktopInstallFailureMarksFailed 安装脚本失败应转 Failed。
func TestDesktopInstallFailureMarksFailed(t *testing.T) {
	resetDesktopSessionsForTest()
	fastDesktopInstallPoll(t)
	withDesktopEnv(t, "ingress.example.com")
	dao := &desktopInstanceDaoStub{entity: desktopTestEntity()}
	sb := &desktopSandboxStub{
		ptyOutputs: [][]psandbox.PtyExecStreamEvent{
			ptyFinishEvents(desktopMissingLayerMarker),
		},
	}
	sb.execFunc = func(bash string) (*psandbox.ExecCommandResult, error) {
		if strings.Contains(bash, "vela-desktop-install.sh") {
			return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: desktopInstallStartedMark}, nil
		}
		return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: "PROGRESS=30\n" + desktopInstallFailMarker}, nil
	}
	l := newDesktopTestLogic(dao, sb)
	ctx := pctx.NewContext(nil).WithUserID("user-desktop-1")

	if _, err := l.EnsureDesktopSession(ctx, "ins-desktop-1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	session := l.desktopSessionOf("ins-desktop-1")
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, status, _, _ := session.snapshot(); status == transport.DesktopSessionStatusFailed {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, _, status, reason, _ := session.snapshot(); status != transport.DesktopSessionStatusFailed {
		t.Fatalf("expected Failed after install failure, got %q (reason=%q)", status, reason)
	}
}

func TestRenderDesktopInstallCommand(t *testing.T) {
	cmd := renderDesktopInstallCommand()
	for _, want := range []string{
		"apt-get install",
		"dnf install",
		"xorg-x11-server-Xvfb",
		"python3-websockify",
		"vela-xvfb.service",
		"vela-novnc.service",
		desktopInstallDoneMarker,
		desktopInstallFailMarker,
		desktopInstallStartedMark,
		"nohup",
	} {
		if !strings.Contains(cmd, want) {
			t.Fatalf("install command missing %q", want)
		}
	}
}

func TestParseDesktopInstallProgress(t *testing.T) {
	cases := map[string]int{
		"PROGRESS=0":               0,
		"PROGRESS=42\nfoo":         42,
		"x\nPROGRESS=100":          100,
		"no progress here":         -1,
		"PROGRESS=":                -1,
		"PROGRESS=30\nPROGRESS=70": 70, // 取最后一次
	}
	for in, want := range cases {
		if got := parseDesktopInstallProgress(in); got != want {
			t.Fatalf("parseDesktopInstallProgress(%q)=%d want %d", in, got, want)
		}
	}
}

func TestGetDesktopSessionReadyDoesNotReprovision(t *testing.T) {
	resetDesktopSessionsForTest()
	withDesktopEnv(t, "ingress.example.com")
	dao := &desktopInstanceDaoStub{entity: desktopTestEntity()}
	sb := &desktopSandboxStub{
		ptyOutputs: [][]psandbox.PtyExecStreamEvent{
			ptyFinishEvents(desktopProbePendingMarker),
			ptyFinishEvents(desktopProbeOKMarker),
		},
	}
	l := newDesktopTestLogic(dao, sb)
	ctx := pctx.NewContext(nil).WithUserID("user-desktop-1")

	if _, err := l.EnsureDesktopSession(ctx, "ins-desktop-1"); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	callsBefore := len(sb.ptyCalls)

	resp, err := l.GetDesktopSession(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if resp.Status != transport.DesktopSessionStatusReady {
		t.Fatalf("expected Ready on poll, got %q", resp.Status)
	}
	if len(sb.ptyCalls) != callsBefore {
		t.Fatalf("expected no extra TAT calls on Ready poll, got %d → %d", callsBefore, len(sb.ptyCalls))
	}
}

func TestGetDesktopSessionProvisioningStaysPending(t *testing.T) {
	resetDesktopSessionsForTest()
	withDesktopEnv(t, "ingress.example.com")
	dao := &desktopInstanceDaoStub{entity: desktopTestEntity()}
	sb := &desktopSandboxStub{
		ptyOutputs: [][]psandbox.PtyExecStreamEvent{
			ptyFinishEvents(desktopProbePendingMarker), // provision
			ptyFinishEvents(desktopProbePendingMarker), // probe 仍 pending
		},
	}
	l := newDesktopTestLogic(dao, sb)
	ctx := pctx.NewContext(nil).WithUserID("user-desktop-1")

	resp, err := l.EnsureDesktopSession(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if resp.Status != transport.DesktopSessionStatusProvisioning {
		t.Fatalf("expected Provisioning, got %q", resp.Status)
	}
	// 未就绪时不得泄露 ws_url/password。
	if resp.WsURL != "" || resp.Password != "" {
		t.Fatalf("expected empty ws_url/password while provisioning, got %+v", resp)
	}
}

// TestGetDesktopSessionProvisioningOnlyProbes CR-C：Provisioning 态轮询只走轻量
// 探测，绝不重发 120s 的 provision 命令（storepasswd + 4 个 unit）。
func TestGetDesktopSessionProvisioningOnlyProbes(t *testing.T) {
	resetDesktopSessionsForTest()
	withDesktopEnv(t, "ingress.example.com")
	dao := &desktopInstanceDaoStub{entity: desktopTestEntity()}
	sb := &desktopSandboxStub{
		ptyOutputs: [][]psandbox.PtyExecStreamEvent{
			ptyFinishEvents(desktopProbePendingMarker), // probe 仍 pending
		},
	}
	l := newDesktopTestLogic(dao, sb)
	ctx := pctx.NewContext(nil).WithUserID("user-desktop-1")

	session := l.desktopSessionOf("ins-desktop-1")
	session.mu.Lock()
	session.sandboxID = "sb-desktop-1"
	session.password = "aaaaaaaa"
	session.status = transport.DesktopSessionStatusProvisioning
	session.provisionStartedAt = time.Now()
	session.mu.Unlock()

	resp, err := l.GetDesktopSession(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if resp.Status != transport.DesktopSessionStatusProvisioning {
		t.Fatalf("expected Provisioning, got %q", resp.Status)
	}
	if len(sb.ptyCalls) != 1 {
		t.Fatalf("expected exactly 1 TAT call (probe), got %d", len(sb.ptyCalls))
	}
	if strings.Contains(sb.ptyCalls[0].Command, "x11vnc -storepasswd") {
		t.Fatalf("must not re-dispatch provision command while provisioning, got:\n%s", sb.ptyCalls[0].Command)
	}
	if !strings.Contains(sb.ptyCalls[0].Command, desktopProbeOKMarker) {
		t.Fatalf("expected probe command, got:\n%s", sb.ptyCalls[0].Command)
	}
}

// TestGetDesktopSessionProvisioningRetriesAfterWindow 超过重试窗口仍未就绪时，
// 允许重发一次 provision 兜底（避免卡死在探测里）。
func TestGetDesktopSessionProvisioningRetriesAfterWindow(t *testing.T) {
	resetDesktopSessionsForTest()
	withDesktopEnv(t, "ingress.example.com")
	dao := &desktopInstanceDaoStub{entity: desktopTestEntity()}
	sb := &desktopSandboxStub{
		ptyOutputs: [][]psandbox.PtyExecStreamEvent{
			ptyFinishEvents(desktopProbeOKMarker), // provision 就绪
		},
	}
	l := newDesktopTestLogic(dao, sb)
	ctx := pctx.NewContext(nil).WithUserID("user-desktop-1")

	session := l.desktopSessionOf("ins-desktop-1")
	session.mu.Lock()
	session.sandboxID = "sb-desktop-1"
	session.password = "aaaaaaaa"
	session.status = transport.DesktopSessionStatusProvisioning
	session.provisionStartedAt = time.Now().Add(-desktopProvisionRetryAfter - time.Second)
	session.mu.Unlock()

	resp, err := l.GetDesktopSession(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if resp.Status != transport.DesktopSessionStatusReady {
		t.Fatalf("expected Ready after retry-window reprovision, got %q", resp.Status)
	}
	if len(sb.ptyCalls) != 1 || !strings.Contains(sb.ptyCalls[0].Command, "x11vnc -storepasswd") {
		t.Fatalf("expected a provision command after the retry window, got %+v", sb.ptyCalls)
	}
}

func TestDesktopProvisionCommandFailureMarksFailed(t *testing.T) {
	resetDesktopSessionsForTest()
	withDesktopEnv(t, "ingress.example.com")
	dao := &desktopInstanceDaoStub{entity: desktopTestEntity()}
	sb := &desktopSandboxStub{
		ptyOutputs: [][]psandbox.PtyExecStreamEvent{
			{{Type: "finished", Status: "FAILED", ExitCode: 1}}, // provision 命令失败
		},
	}
	l := newDesktopTestLogic(dao, sb)
	ctx := pctx.NewContext(nil).WithUserID("user-desktop-1")

	resp, err := l.EnsureDesktopSession(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != transport.DesktopSessionStatusFailed {
		t.Fatalf("expected Failed, got %q", resp.Status)
	}
	if resp.Reason == "" {
		t.Fatal("expected failure reason to be surfaced")
	}
}

// TestGetDesktopSessionPausedRestartsServices Paused 再访问应重新拉起服务到 Ready（TB.4）。
func TestGetDesktopSessionPausedRestartsServices(t *testing.T) {
	resetDesktopSessionsForTest()
	withDesktopEnv(t, "ingress.example.com")
	dao := &desktopInstanceDaoStub{entity: desktopTestEntity()}
	sb := &desktopSandboxStub{
		ptyOutputs: [][]psandbox.PtyExecStreamEvent{
			ptyFinishEvents(desktopProbeOKMarker), // provision 直接就绪
		},
	}
	l := newDesktopTestLogic(dao, sb)
	ctx := pctx.NewContext(nil).WithUserID("user-desktop-1")

	// 预置一个 Paused 会话（模拟 idle 停服务后）。
	session := l.desktopSessionOf("ins-desktop-1")
	session.mu.Lock()
	session.sandboxID = "sb-desktop-1"
	session.password = "aaaaaaaa"
	session.status = transport.DesktopSessionStatusPaused
	session.mu.Unlock()

	resp, err := l.GetDesktopSession(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if resp.Status != transport.DesktopSessionStatusReady {
		t.Fatalf("expected Ready after resume-by-reprovision, got %q", resp.Status)
	}
	// 复用主 sandbox：绝不 ResumeSandbox（主机从未停机）。
	if len(sb.resumeCalls) != 0 {
		t.Fatalf("must not ResumeSandbox host on paused resume, got %v", sb.resumeCalls)
	}
	// 复用已有密码（幂等，不轮换）。
	if resp.Password != "aaaaaaaa" {
		t.Fatalf("expected reused password, got %q", resp.Password)
	}
}

// ---- idle 回收测试（TB.4：停服务而非 pause 主机）----

func TestReapIdleDesktopsStopsServicesNotHost(t *testing.T) {
	resetDesktopSessionsForTest()

	sb := &desktopSandboxStub{}
	original := adapterfactory.DefaultAdapterFactory
	adapterfactory.DefaultAdapterFactory = &desktopStubAdapterFactory{adapter: sb}
	t.Cleanup(func() { adapterfactory.DefaultAdapterFactory = original })

	session := &desktopSession{
		sandboxID:  "sb-idle-1",
		password:   "aaaaaaaa",
		status:     transport.DesktopSessionStatusReady,
		lastActive: time.Now().Add(-2 * time.Hour), // 远超 30 分钟阈值
	}
	desktopSessions.Store("ins-idle-1", session)

	t.Setenv(desktopIdleTimeoutMinutesEnv, "30")
	reapIdleDesktops(zap.NewNop())

	// 只发一次 stop-services 的 ExecCommand，绝不 PauseSandbox。
	if len(sb.pauseCalls) != 0 {
		t.Fatalf("TB.4 regression: reaper must NOT pause host, got pause=%v", sb.pauseCalls)
	}
	if len(sb.execCalls) != 1 || sb.execCalls[0] != "sb-idle-1" {
		t.Fatalf("expected one stop-services ExecCommand for sb-idle-1, got %v", sb.execCalls)
	}
	if !strings.Contains(sb.execCmds[0], "systemctl stop "+desktopSystemdUnits) {
		t.Fatalf("expected stop-services command, got:\n%s", sb.execCmds[0])
	}
	if _, _, status, _, _ := session.snapshot(); status != transport.DesktopSessionStatusPaused {
		t.Fatalf("expected session Paused after reap, got %q", status)
	}
}

func TestReapIdleDesktopsKeepsActiveSession(t *testing.T) {
	resetDesktopSessionsForTest()

	sb := &desktopSandboxStub{}
	original := adapterfactory.DefaultAdapterFactory
	adapterfactory.DefaultAdapterFactory = &desktopStubAdapterFactory{adapter: sb}
	t.Cleanup(func() { adapterfactory.DefaultAdapterFactory = original })

	session := &desktopSession{
		sandboxID:  "sb-active-1",
		status:     transport.DesktopSessionStatusReady,
		lastActive: time.Now().Add(-1 * time.Minute), // 活跃中
	}
	desktopSessions.Store("ins-active-1", session)

	t.Setenv(desktopIdleTimeoutMinutesEnv, "30")
	reapIdleDesktops(zap.NewNop())

	if len(sb.execCalls) != 0 {
		t.Fatalf("expected no stop for active session, got %v", sb.execCalls)
	}
}

func TestDesktopIdleTimeoutMinutesDefault(t *testing.T) {
	t.Setenv(desktopIdleTimeoutMinutesEnv, "")
	if got := desktopIdleTimeoutMinutes(); got != desktopDefaultIdleMinutes {
		t.Fatalf("expected default %d, got %d", desktopDefaultIdleMinutes, got)
	}
	t.Setenv(desktopIdleTimeoutMinutesEnv, "0")
	if got := desktopIdleTimeoutMinutes(); got != 0 {
		t.Fatalf("expected 0 (disabled) to round-trip, got %d", got)
	}
	t.Setenv(desktopIdleTimeoutMinutesEnv, "garbage")
	if got := desktopIdleTimeoutMinutes(); got != desktopDefaultIdleMinutes {
		t.Fatalf("expected fallback to default on garbage, got %d", got)
	}
}

// TestDesktopReapInterval 验证 CR-D：扫描间隔可配 + 非法/<=0 回退默认值。
func TestDesktopReapInterval(t *testing.T) {
	defaultInterval := time.Duration(desktopDefaultReapIntervalMin) * time.Minute

	t.Setenv(desktopReapIntervalMinutesEnv, "")
	if got := DesktopReapInterval(); got != defaultInterval {
		t.Fatalf("expected default %v, got %v", defaultInterval, got)
	}
	t.Setenv(desktopReapIntervalMinutesEnv, "10")
	if got := DesktopReapInterval(); got != 10*time.Minute {
		t.Fatalf("expected 10m, got %v", got)
	}
	// 非正值与非法值都回退默认，避免 time.NewTicker 因非正间隔 panic。
	for _, bad := range []string{"0", "-3", "garbage"} {
		t.Setenv(desktopReapIntervalMinutesEnv, bad)
		if got := DesktopReapInterval(); got != defaultInterval {
			t.Fatalf("expected fallback to default for %q, got %v", bad, got)
		}
	}
}

// ---- 并发防护测试（CR-A：复用主 sandbox 后，并发只应下发 1 次 provision 命令）----

// concurrentDesktopSandboxStub 线程安全 stub：StreamPtyCommand 用原子计数，
// provision 时人为 sleep 放大竞态窗口，验证 provisionMu 临界区。
type concurrentDesktopSandboxStub struct {
	psandbox.Adapter
	provisionCalls int32
	provisionDelay time.Duration
}

func (s *concurrentDesktopSandboxStub) StreamPtyCommand(_ context.Context, _ string, req *psandbox.PtyExecStreamRequest, onEvent func(psandbox.PtyExecStreamEvent) error) error {
	// 只对 provision 命令计数（含 storepasswd 特征）。
	if strings.Contains(req.Command, "x11vnc -storepasswd") {
		atomic.AddInt32(&s.provisionCalls, 1)
		if s.provisionDelay > 0 {
			time.Sleep(s.provisionDelay)
		}
	}
	events := []psandbox.PtyExecStreamEvent{
		{Type: "output", Chunk: desktopProbeOKMarker},
		{Type: "finished", Status: "SUCCESS", ExitCode: 0},
	}
	for _, ev := range events {
		if err := onEvent(ev); err != nil {
			return err
		}
	}
	return nil
}

// TestProvisionDesktopConcurrentSingleProvision 验证 CR-A：
// N 个并发 EnsureDesktopSession 只应下发 1 次 provision 命令（provisionMu 临界区 + 双检生效）。
func TestProvisionDesktopConcurrentSingleProvision(t *testing.T) {
	resetDesktopSessionsForTest()
	withDesktopEnv(t, "ingress.example.com")

	dao := &desktopInstanceDaoStub{entity: desktopTestEntity()}
	sb := &concurrentDesktopSandboxStub{
		provisionDelay: 20 * time.Millisecond, // 放大窗口：无锁/无双检时并发必然多次 provision
	}
	l := &logic{instanceDao: dao, sandboxAdapter: sb, logger: zap.NewNop()}

	const goroutines = 16
	var wg sync.WaitGroup
	wg.Add(goroutines)
	errCh := make(chan error, goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			ctx := pctx.NewContext(nil).WithUserID("user-desktop-1")
			if _, err := l.EnsureDesktopSession(ctx, "ins-desktop-1"); err != nil {
				errCh <- err
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatalf("concurrent EnsureDesktopSession returned error: %v", err)
	}

	if got := atomic.LoadInt32(&sb.provisionCalls); got != 1 {
		t.Fatalf("CR-A regression: expected exactly 1 provision command under concurrency, got %d", got)
	}

	session := l.desktopSessionOf("ins-desktop-1")
	sandboxID, _, status, _, _ := session.snapshot()
	if status != transport.DesktopSessionStatusReady {
		t.Fatalf("expected Ready after concurrent provision, got %q", status)
	}
	if sandboxID != "sb-desktop-1" {
		t.Fatalf("unexpected sandbox id (should reuse instance sandbox): %q", sandboxID)
	}
}
