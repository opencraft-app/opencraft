package instance

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	adapterfactory "ctl/pkg/adapter/factory"
	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	"ctl/pkg/transport"
	"go.uber.org/zap"
)

// desktopViewerFixture wires a logic whose desktop resource is already
// prepared: the read-only observer is up for the current owner/sandbox.
// 沙箱内验证脚本的成功输出：只回物理 incarnation，不回 key/MAC。
func desktopVerifyOutput(incarnation string) string {
	return `{"verified":true,"incarnation":"` + incarnation + `","readOnly":true}`
}

const desktopTestIncarnation = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func desktopViewerFixture(t *testing.T) (*logic, *desktopResourceDAO, pctx.Context, *desktopSession) {
	t.Helper()
	resetDesktopSessionsForTest()
	resetDesktopViewersForTest()
	sb := &desktopSandboxStub{ptyOutputs: [][]psandbox.PtyExecStreamEvent{ptyFinishEvents(desktopProbeOKMarker)}}
	// 签发租约前会先验证目标机器物理身份。
	sb.execFunc = func(string) (*psandbox.ExecCommandResult, error) {
		return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0,
			Output: desktopVerifyOutput(desktopTestIncarnation)}, nil
	}
	l, dao, ctx := desktopResourceFixture(sb)
	session := &desktopSession{
		instanceID:       dao.entity.InstanceId,
		userID:           dao.entity.UserId,
		sandboxID:        dao.entity.SandboxId,
		generation:       "11111111-1111-4111-8111-111111111111",
		status:           transport.DesktopSessionStatusReady,
		observerPrepared: true,
		inputPrepared:    true,
	}
	desktopSessions.Store(dao.entity.InstanceId, session)
	return l, dao, ctx, session
}

func desktopViewerExpire(attachmentID string) {
	desktopViewerMu.Lock()
	defer desktopViewerMu.Unlock()
	if attachment, ok := desktopViewers[attachmentID]; ok {
		attachment.expiresAt = time.Now().Add(-time.Second)
	}
}

func TestCreateDesktopViewerRequiresPreparedResource(t *testing.T) {
	l, _, ctx, session := desktopViewerFixture(t)
	// 未准备完成（observer 未起）时不得签发任何观看凭证。
	session.mu.Lock()
	session.observerPrepared = false
	session.mu.Unlock()

	if _, err := l.CreateDesktopViewer(ctx, "ins-desktop-1"); err != errcode.ErrDesktopNotConfigured {
		t.Fatalf("expected ErrDesktopNotConfigured before preparation, got %v", err)
	}
}

func TestDesktopViewerWaitsForInputPreparation(t *testing.T) {
	for _, inputReady := range []bool{false, true} {
		t.Run(fmt.Sprintf("inputReady=%v", inputReady), func(t *testing.T) {
			l, _, ctx, session := desktopViewerFixture(t)
			session.mu.Lock()
			session.preparing = true
			session.inputPrepared = inputReady
			session.mu.Unlock()
			if got := l.desktopResourceResponse(session).State; got != transport.DesktopResourceStatePreparing {
				t.Errorf("published prepared before worker finished: %s", got)
			}
			if _, err := l.CreateDesktopViewer(ctx, session.instanceID); err != errcode.ErrDesktopNotConfigured {
				t.Errorf("mint during preparation: %v", err)
			}
			session.mu.Lock()
			session.preparing = false
			session.mu.Unlock()
			if got := l.desktopResourceResponse(session).State; got != transport.DesktopResourceStatePrepared {
				t.Fatalf("finished preparation must publish prepared: %s", got)
			}
			viewer, err := l.CreateDesktopViewer(ctx, session.instanceID)
			if err != nil {
				t.Fatal(err)
			}
			want := transport.DesktopViewerAccessRead
			if inputReady {
				want = transport.DesktopViewerAccessWrite
			}
			if viewer.Access != want {
				t.Fatalf("access=%s, want %s", viewer.Access, want)
			}
		})
	}
}

func TestCreateDesktopViewerRejectsForeignInstance(t *testing.T) {
	l, _, _, _ := desktopViewerFixture(t)
	if _, err := l.CreateDesktopViewer(pctx.NewContext(nil).WithUserID("someone-else"), "ins-desktop-1"); err != errcode.ErrInstanceNotFound {
		t.Fatalf("expected ErrInstanceNotFound for foreign user, got %v", err)
	}
}

func TestCreateDesktopViewerRejectsChangedSandbox(t *testing.T) {
	l, dao, ctx, _ := desktopViewerFixture(t)
	// 主机被换掉：缓存代次与当前实体不一致，签发必须拒绝。
	dao.change("sb-replacement", dao.entity.UserId)
	if _, err := l.CreateDesktopViewer(ctx, "ins-desktop-1"); err != errcode.ErrDesktopTargetChanged {
		t.Fatalf("expected ErrDesktopTargetChanged after sandbox replacement, got %v", err)
	}
}

// TestDesktopViewerLeaseNeverCarriesCredentials 是本次改造的核心回归：
// ingressproxy 下线后不能下发公网 URL，且不得再向浏览器下发 VNC 密码。
func TestDesktopViewerLeaseNeverCarriesCredentials(t *testing.T) {
	l, _, ctx, session := desktopViewerFixture(t)

	resp, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Version != desktopViewerVersion {
		t.Fatalf("unexpected version %d", resp.Version)
	}
	if resp.AttachmentID == "" || resp.Ticket == "" {
		t.Fatalf("expected attachment id and ticket, got %+v", resp)
	}
	if resp.GenerationID != session.generation {
		t.Fatalf("lease must bind to the prepared generation: got %q want %q", resp.GenerationID, session.generation)
	}
	if resp.ExpiresAt <= time.Now().UnixMilli() {
		t.Fatalf("expected a future expiry, got %d", resp.ExpiresAt)
	}
	if resp.Tunnel.IP == "" || resp.Tunnel.Port == "" {
		t.Fatalf("expected a tunnel target, got %+v", resp.Tunnel)
	}

	encoded, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	payload := string(encoded)
	for _, forbidden := range []string{"password", "ws_url", "wsUrl", "sb-desktop-1", "ingress"} {
		if strings.Contains(payload, forbidden) {
			t.Fatalf("viewer lease must not expose %q: %s", forbidden, payload)
		}
	}
}

func TestDesktopViewerTicketIsSingleUse(t *testing.T) {
	l, _, ctx, _ := desktopViewerFixture(t)
	resp, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}

	claimed, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: resp.Ticket})
	if err != nil {
		t.Fatalf("first claim must succeed: %v", err)
	}
	if claimed.GenerationID != resp.GenerationID || claimed.Tunnel.Mode != resp.Tunnel.Mode {
		t.Fatalf("claim response diverged from the lease: %+v", claimed)
	}
	// 重放同一票据：不得再次放行媒体。
	if _, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: resp.Ticket}); err != errcode.ErrDesktopTargetChanged {
		t.Fatalf("replayed ticket must be rejected, got %v", err)
	}
}

func TestDesktopViewerRejectsWrongTicket(t *testing.T) {
	l, _, ctx, _ := desktopViewerFixture(t)
	resp, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: "not-the-ticket"}); err == nil {
		t.Fatal("expected a wrong ticket to be rejected")
	}
	if _, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID, nil); err != errcode.ErrInvalidParam {
		t.Fatalf("expected ErrInvalidParam for a missing body, got %v", err)
	}
}

func TestDesktopViewerExpiredTicketIsRejected(t *testing.T) {
	l, _, ctx, _ := desktopViewerFixture(t)
	resp, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	desktopViewerExpire(resp.AttachmentID)
	if _, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: resp.Ticket}); err != errcode.ErrDesktopTargetChanged {
		t.Fatalf("expired ticket must be rejected, got %v", err)
	}
}

func TestDesktopViewerUnclaimedTicketExpiresWithClaimWindow(t *testing.T) {
	l, _, ctx, _ := desktopViewerFixture(t)
	resp, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	desktopViewerMu.Lock()
	if attachment, ok := desktopViewers[resp.AttachmentID]; ok {
		attachment.createdAt = time.Now().Add(-desktopViewerClaimWindow - time.Second)
	}
	desktopViewerMu.Unlock()

	if _, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: resp.Ticket}); err != errcode.ErrDesktopTargetChanged {
		t.Fatalf("a stale unclaimed ticket must be reclaimed, got %v", err)
	}
}

func TestDesktopViewerGenerationReplacementRevokesLease(t *testing.T) {
	l, _, ctx, _ := desktopViewerFixture(t)
	resp, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	// 代次替换（重准备/换机）必须撤权，旧票据不得重放到新代次。
	revokeDesktopViewers("ins-desktop-1")
	if _, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: resp.Ticket}); err != errcode.ErrDesktopTargetChanged {
		t.Fatalf("revoked ticket must be rejected, got %v", err)
	}
}

func TestDesktopViewerReleaseIsIdempotentAndRevokes(t *testing.T) {
	l, _, ctx, _ := desktopViewerFixture(t)
	resp, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != err {
		t.Fatal(err)
	}
	if err := l.ReleaseDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID); err != nil {
		t.Fatal(err)
	}
	if _, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: resp.Ticket}); err != errcode.ErrDesktopTargetChanged {
		t.Fatalf("released ticket must be rejected, got %v", err)
	}
	// 幂等：重复释放与释放不存在的租约都不是错误。
	if err := l.ReleaseDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID); err != nil {
		t.Fatalf("release must be idempotent, got %v", err)
	}
	if err := l.ReleaseDesktopViewer(ctx, "ins-desktop-1", "missing-attachment"); err != nil {
		t.Fatalf("releasing an unknown attachment must not fail, got %v", err)
	}
}

func TestDesktopViewerForeignUserCannotClaim(t *testing.T) {
	l, dao, ctx, _ := desktopViewerFixture(t)
	resp, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	// 换主后原 owner 的票据不再可用（其他用户的租约对当前身份不可见）。
	dao.change(dao.entity.SandboxId, "user-someone-else")
	if err := l.ReleaseDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID); err != errcode.ErrInstanceNotFound {
		t.Fatalf("expected ErrInstanceNotFound after ownership change, got %v", err)
	}
}

func TestDesktopViewerPerInstanceCap(t *testing.T) {
	l, _, ctx, session := desktopViewerFixture(t)
	// 只读观看可共享：关闭可写端点后走 read 分支，额度为 desktopViewerMaxPerInstance。
	session.mu.Lock()
	session.inputPrepared = false
	session.mu.Unlock()
	for i := 0; i < desktopViewerMaxPerInstance; i++ {
		if _, err := l.CreateDesktopViewer(ctx, "ins-desktop-1"); err != nil {
			t.Fatalf("lease %d must be issued: %v", i+1, err)
		}
	}
	if _, err := l.CreateDesktopViewer(ctx, "ins-desktop-1"); err != errcode.ErrDesktopNotConfigured {
		t.Fatalf("expected the per-instance cap to reject a new lease, got %v", err)
	}
	// 释放一个后额度回收。
	desktopViewerMu.Lock()
	var first string
	for id := range desktopViewers {
		first = id
		break
	}
	desktopViewerMu.Unlock()
	if err := l.ReleaseDesktopViewer(ctx, "ins-desktop-1", first); err != nil {
		t.Fatal(err)
	}
	if _, err := l.CreateDesktopViewer(ctx, "ins-desktop-1"); err != nil {
		t.Fatalf("expected a free slot after release, got %v", err)
	}
}

// TestDesktopViewerReclaimsUnredeemedWriteLease 上一连接异常断开且未释放租约时，
// 可写名额不能被一个从未兑换的废票占用整个 TTL，否则重连会一直降级为只读、
// 键鼠不可用。
func TestDesktopViewerReclaimsUnredeemedWriteLease(t *testing.T) {
	l, _, ctx, session := desktopViewerFixture(t)
	session.mu.Lock()
	session.inputPrepared = true
	session.mu.Unlock()

	first, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	if first.Access != transport.DesktopViewerAccessWrite {
		t.Fatalf("expected the first lease to own the write slot, got %q", first.Access)
	}
	// 票据从未兑换且已过兑换窗口：这是一个死租约。
	desktopViewerMu.Lock()
	if attachment, ok := desktopViewers[first.AttachmentID]; ok {
		attachment.createdAt = time.Now().Add(-desktopViewerClaimWindow - time.Second)
	}
	desktopViewerMu.Unlock()

	next, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	if next.Access != transport.DesktopViewerAccessWrite {
		t.Fatalf("dead write lease must be reclaimed, got %q", next.Access)
	}
	if next.Tunnel.Path != "/desktop/input" {
		t.Fatalf("reclaimed slot must target the writable gateway, got %+v", next.Tunnel)
	}
}

// TestDesktopViewerKeepsLiveWriteLease 回收必须保守：已兑换且仍在有效期内、
// 正在使用输入的租约不能被抢占，否则会打断正常会话的键鼠。
func TestDesktopViewerKeepsLiveWriteLease(t *testing.T) {
	l, _, ctx, session := desktopViewerFixture(t)
	session.mu.Lock()
	session.inputPrepared = true
	session.mu.Unlock()

	first, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", first.AttachmentID,
		&transport.DesktopViewerClaimRequest{Ticket: first.Ticket}); err != nil {
		t.Fatal(err)
	}

	next, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	if next.Access != transport.DesktopViewerAccessRead {
		t.Fatalf("a live write lease must not be preempted, got %q", next.Access)
	}
	if next.Tunnel.Port != desktopViewerDefaultTunnelReadPort {
		t.Fatalf("read lease must target the observer, got port %q", next.Tunnel.Port)
	}
}

// TestDesktopViewerLeaseBlocksIdleReap desktop/resource 的准备态只读、没有心跳
// 接口；存活的观看租约是唯一活跃信号，否则 reaper 会在用户观看时停掉桌面服务。
func TestDesktopViewerLeaseBlocksIdleReap(t *testing.T) {
	resetDesktopSessionsForTest()
	resetDesktopViewersForTest()

	sb := &desktopSandboxStub{}
	original := adapterfactory.DefaultAdapterFactory
	adapterfactory.DefaultAdapterFactory = &desktopStubAdapterFactory{adapter: sb}
	t.Cleanup(func() { adapterfactory.DefaultAdapterFactory = original })

	session := &desktopSession{
		sandboxID:  "sb-idle-2",
		status:     transport.DesktopSessionStatusReady,
		lastActive: time.Now().Add(-2 * time.Hour),
	}
	desktopSessions.Store("ins-idle-2", session)
	desktopViewers["att-live"] = &desktopViewerAttachment{
		id:         "att-live",
		instanceID: "ins-idle-2",
		createdAt:  time.Now(),
		expiresAt:  time.Now().Add(time.Minute),
	}

	t.Setenv(desktopIdleTimeoutMinutesEnv, "30")
	reapIdleDesktops(zap.NewNop())

	if len(sb.execCalls) != 0 {
		t.Fatalf("a live viewer lease must keep the desktop running, got %v", sb.execCalls)
	}
}

// TestDesktopViewerGrantsWriteWhenInputEndpointIsReady 键鼠是硬需求：准备出可写
// 端点后租约必须是 write，且指向可写端口（不是只读 observer）。
func TestDesktopViewerGrantsWriteWhenInputEndpointIsReady(t *testing.T) {
	l, _, ctx, _ := desktopViewerFixture(t)

	resp, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Access != transport.DesktopViewerAccessWrite {
		t.Fatalf("expected write access, got %q", resp.Access)
	}
	if resp.Tunnel.Port != desktopViewerDefaultTunnelWritePort {
		t.Fatalf("write lease must target the writable endpoint, got port %q", resp.Tunnel.Port)
	}
	if resp.Tunnel.Port == desktopViewerDefaultTunnelReadPort {
		t.Fatal("write lease must not target the read-only observer")
	}

	claimed, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: resp.Ticket})
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Access != transport.DesktopViewerAccessWrite {
		t.Fatalf("claim must repeat write access, got %q", claimed.Access)
	}
	if claimed.Tunnel.Port != desktopViewerDefaultTunnelWritePort {
		t.Fatalf("claim must return the writable endpoint, got port %q", claimed.Tunnel.Port)
	}
}

// TestDesktopViewerDegradesToReadWhenInputEndpointIsMissing 可写端点没起来时不能
// 让整个桌面不可用，而是降级为只读观看。
func TestDesktopViewerDegradesToReadWhenInputEndpointIsMissing(t *testing.T) {
	l, _, ctx, session := desktopViewerFixture(t)
	session.mu.Lock()
	session.inputPrepared = false
	session.mu.Unlock()

	resp, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Access != transport.DesktopViewerAccessRead {
		t.Fatalf("expected read fallback, got %q", resp.Access)
	}
	if resp.Tunnel.Port != desktopViewerDefaultTunnelReadPort {
		t.Fatalf("read lease must target the observer, got port %q", resp.Tunnel.Port)
	}
}

func TestDesktopViewerWriteLeaseIsSingleOwner(t *testing.T) {
	for _, active := range []bool{false, true} {
		t.Run(fmt.Sprint(active), func(t *testing.T) {
			l, _, ctx, _ := desktopViewerFixture(t)
			first, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
			if err != nil {
				t.Fatal(err)
			}
			if active {
				if _, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", first.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: first.Ticket}); err != nil {
					t.Fatal(err)
				}
			}
			for i := 0; i < desktopViewerMaxPerInstance; i++ {
				next, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
				if err != nil || next.Access != transport.DesktopViewerAccessRead {
					t.Fatalf("new viewers must not take over reserved or active input: %v", err)
				}
				if _, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", next.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: "wrong"}); err == nil {
					t.Fatal("invalid candidate claim must fail")
				}
			}
			if _, err := l.CreateDesktopViewer(ctx, "ins-desktop-1"); err != errcode.ErrDesktopNotConfigured {
				t.Fatalf("read fallback must respect read quota: %v", err)
			}
			if !active {
				claimed, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", first.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: first.Ticket})
				if err != nil || claimed.Access != transport.DesktopViewerAccessWrite {
					t.Fatalf("original writer must remain claimable: %+v %v", claimed, err)
				}
			}
			desktopViewerMu.Lock()
			writer := desktopViewers[first.AttachmentID]
			count := desktopViewerCountWithAccess("ins-desktop-1", transport.DesktopViewerAccessWrite)
			desktopViewerMu.Unlock()
			if writer == nil || count != 1 {
				t.Fatal("mint or failed candidate claim revoked the original writer")
			}
		})
	}
}

// TestDesktopViewerPinsLeaseToVerifiedIncarnation 「如何验证目标机器」：租约必须
// 携带沙箱内 HMAC 校验出的物理 incarnation，而不是 CTL 的编排代次。
func TestDesktopViewerPinsLeaseToVerifiedIncarnation(t *testing.T) {
	l, _, ctx, _ := desktopViewerFixture(t)

	resp, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Incarnation != desktopTestIncarnation {
		t.Fatalf("lease must pin the verified incarnation, got %q", resp.Incarnation)
	}
	if resp.GenerationID == resp.Incarnation {
		t.Fatal("incarnation must never be the preparation generation")
	}

	claimed, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: resp.Ticket})
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Incarnation != desktopTestIncarnation {
		t.Fatalf("claim must repeat the incarnation, got %q", claimed.Incarnation)
	}
}

// TestDesktopViewerRejectsUnverifiedTarget 物理身份无法验证时不签发任何租约：
// 宁可看不到桌面，也不能把画面交给一台未证明身份的机器。
func TestDesktopViewerRejectsUnverifiedTarget(t *testing.T) {
	l, _, ctx, _ := desktopViewerFixture(t)
	sb, ok := l.sandboxAdapter.(*desktopSandboxStub)
	if !ok {
		t.Fatalf("expected the desktop sandbox stub, got %T", l.sandboxAdapter)
	}

	reject := func(output string) {
		sb.execFunc = func(string) (*psandbox.ExecCommandResult, error) {
			return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: output}, nil
		}
		if _, err := l.CreateDesktopViewer(ctx, "ins-desktop-1"); err != errcode.ErrDesktopNotConfigured {
			t.Fatalf("target must be rejected for output %s, got %v", output, err)
		}
	}

	// 验证脚本失败（代理不可用 / MAC 不符）。
	reject(`{"verified":false,"reason":"observer proxy unavailable"}`)
	// verified=true 但 incarnation 不是 64 位 hex。
	reject(`{"verified":true,"incarnation":"short","readOnly":true}`)
	// readOnly 丢失说明代理被替换。
	reject(`{"verified":true,"incarnation":"` + desktopTestIncarnation + `","readOnly":false}`)
	// 输出不是 JSON。
	reject("sudo: python3: command not found")
}

// TestDesktopViewerNeverBypassesInputGateway 可写必须经输入网关（5904），不能
// 直连原始可写 x11vnc（5903）——后者没有输入仲裁、也没有撤权能力。
func TestDesktopViewerNeverBypassesInputGateway(t *testing.T) {
	l, _, ctx, _ := desktopViewerFixture(t)

	t.Setenv(desktopViewerTunnelWritePortEnv, "5903")
	resp, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Access != transport.DesktopViewerAccessWrite {
		t.Fatalf("expected write access, got %q", resp.Access)
	}
	if resp.Tunnel.Port == fmt.Sprint(desktopInputPort) {
		t.Fatalf("write lease must not target the raw writable port, got %q", resp.Tunnel.Port)
	}
	if resp.Tunnel.Port != desktopViewerDefaultTunnelWritePort {
		t.Fatalf("expected the gateway port %q, got %q", desktopViewerDefaultTunnelWritePort, resp.Tunnel.Port)
	}
}

// TestDesktopViewerGrantFollowsClaimAndRelease 键鼠只在兑换成功后授予，释放即
// 撤权：这是「谁能控制 / 如何撤权」的落点。
func TestDesktopViewerGrantFollowsClaimAndRelease(t *testing.T) {
	l, _, ctx, _ := desktopViewerFixture(t)
	sb, ok := l.sandboxAdapter.(*desktopSandboxStub)
	if !ok {
		t.Fatalf("expected the desktop sandbox stub, got %T", l.sandboxAdapter)
	}

	resp, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	// 签发阶段不应下发授权：授权只属于兑换成功的连接。
	for _, command := range sb.execCmds {
		if strings.Contains(command, "--grant") {
			t.Fatal("grant must not be written before the ticket is claimed")
		}
	}

	if _, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: resp.Ticket}); err != nil {
		t.Fatal(err)
	}
	desktopViewerMu.Lock()
	digest := fmt.Sprintf("%x", desktopViewers[resp.AttachmentID].ticketDigest)
	desktopViewerMu.Unlock()
	granted := false
	for _, command := range sb.execCmds {
		if strings.Contains(command, "--grant") {
			granted = true
			if !strings.Contains(command, fmt.Sprint(resp.ExpiresAt)) || !strings.Contains(command, resp.AttachmentID) || !strings.Contains(command, digest) {
				t.Fatal("grant must bind the real attachment, ticket digest and lease expiry")
			}
			if strings.Contains(command, resp.Ticket) {
				t.Fatal("grant command must never carry the raw ticket")
			}
		}
	}
	if !granted {
		t.Fatal("claiming a write lease must grant bounded input")
	}

	if err := l.ReleaseDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID); err != nil {
		t.Fatal(err)
	}
	revoked := false
	for _, command := range sb.execCmds {
		if strings.Contains(command, "--revoke") {
			revoked = true
			if !strings.Contains(command, resp.AttachmentID) || !strings.Contains(command, fmt.Sprint(resp.ExpiresAt)) {
				t.Fatal("revoke must be fenced to the released attachment and expiry")
			}
		}
	}
	if !revoked {
		t.Fatal("releasing a write lease must revoke input immediately")
	}
	next, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", next.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: next.Ticket}); err != nil {
		t.Fatal(err)
	}
	before := sb.execCmdCount()
	if err := l.ReleaseDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID); err != nil {
		t.Fatal(err)
	}
	if sb.execCmdCount() != before {
		t.Fatal("repeated old release must not revoke the new writer")
	}
}

// TestDesktopViewerClaimDegradesToReadWhenGrantFails 授权没落盘就不能声称 write。
// 否则网关静默丢弃输入，而 access 仍是 write —— 用户看到「已连接但敲键没反应」，
// 界面也不会提示只读。
func TestDesktopViewerClaimDegradesToReadWhenGrantFails(t *testing.T) {
	l, _, ctx, _ := desktopViewerFixture(t)
	sb, ok := l.sandboxAdapter.(*desktopSandboxStub)
	if !ok {
		t.Fatalf("expected the desktop sandbox stub, got %T", l.sandboxAdapter)
	}

	resp, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Access != transport.DesktopViewerAccessWrite {
		t.Fatalf("fixture should mint a write lease, got %q", resp.Access)
	}

	// 只让授权写入失败，物理身份核验照常成功。
	sb.execFunc = func(bash string) (*psandbox.ExecCommandResult, error) {
		if strings.Contains(bash, "--grant") {
			return &psandbox.ExecCommandResult{Status: "FAILED", ExitCode: 1}, nil
		}
		return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0,
			Output: desktopVerifyOutput(desktopTestIncarnation)}, nil
	}

	claimed, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID,
		&transport.DesktopViewerClaimRequest{Ticket: resp.Ticket})
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Access != transport.DesktopViewerAccessRead {
		t.Fatalf("a failed grant must degrade to read, got %q", claimed.Access)
	}
	if claimed.Tunnel.Port == fmt.Sprint(desktopInputProxyPort) {
		t.Fatal("degraded claim must not point at the writable gateway")
	}
	if claimed.Tunnel.Port != desktopViewerDefaultTunnelReadPort {
		t.Fatalf("degraded claim must target the read-only observer, got %q", claimed.Tunnel.Port)
	}
}

func TestDesktopViewerClaimRevalidatesPhysicalIncarnation(t *testing.T) {
	for _, access := range []string{transport.DesktopViewerAccessWrite, transport.DesktopViewerAccessRead} {
		for _, outcome := range []string{"changed", "unverified", "timeout"} {
			t.Run(access+"/"+outcome, func(t *testing.T) {
				l, _, ctx, session := desktopViewerFixture(t)
				session.inputPrepared = access == transport.DesktopViewerAccessWrite
				viewer, err := l.CreateDesktopViewer(ctx, session.instanceID)
				if err != nil {
					t.Fatal(err)
				}
				other, err := l.CreateDesktopViewer(ctx, session.instanceID)
				if err != nil {
					t.Fatal(err)
				}
				sb := l.sandboxAdapter.(*desktopSandboxStub)
				verified, granted := 0, 0
				sb.execFunc = func(command string) (*psandbox.ExecCommandResult, error) {
					if strings.Contains(command, "--grant ") {
						granted++
					}
					output := ""
					if strings.Contains(command, "DESKTOP_TARGET_VERIFY") {
						verified++
						if outcome == "timeout" {
							return nil, context.DeadlineExceeded
						}
						if outcome == "changed" {
							output = desktopVerifyOutput(strings.Repeat("b", 64))
						}
					}
					return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: output}, nil
				}
				claimed, err := l.ClaimDesktopViewer(ctx, session.instanceID, viewer.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: viewer.Ticket})
				if err == nil || claimed != nil || verified != 1 || granted != 0 {
					t.Fatalf("stale physical target was granted: verify=%d grant=%d err=%v", verified, granted, err)
				}
				desktopViewerMu.Lock()
				preserved := desktopViewers[other.AttachmentID] != nil && !desktopViewers[other.AttachmentID].revoked
				attempted := desktopViewers[viewer.AttachmentID].grantAttempted
				desktopViewerMu.Unlock()
				if !preserved || attempted {
					t.Fatal("failed incarnation proof modified another lease or claimed an unattempted grant")
				}
			})
		}
	}
}

func TestDesktopViewerClaimRejectsChangedBinding(t *testing.T) {
	for _, change := range []string{"sandbox", "owner", "generation", "session"} {
		for _, duringGrant := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/during=%v", change, duringGrant), func(t *testing.T) {
				l, dao, ctx, session := desktopViewerFixture(t)
				viewer, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
				if err != nil {
					t.Fatal(err)
				}
				mutate := func() {
					switch change {
					case "sandbox":
						dao.change("sb-replacement", ctx.GetUserID())
					case "owner":
						dao.change("sb-desktop-1", "new-owner")
					case "generation":
						session.mu.Lock()
						session.generation = "next-generation"
						session.mu.Unlock()
					case "session":
						desktopSessions.Store("ins-desktop-1", &desktopSession{instanceID: "ins-desktop-1", userID: ctx.GetUserID(), sandboxID: "sb-desktop-1", generation: "next", status: transport.DesktopSessionStatusReady, observerPrepared: true, inputPrepared: true, provisionMu: session.operationMutex()})
					}
				}
				sb := l.sandboxAdapter.(*desktopSandboxStub)
				before := sb.execCmdCount()
				if duringGrant {
					sb.execFunc = func(command string) (*psandbox.ExecCommandResult, error) {
						if strings.Contains(command, "--grant ") {
							mutate()
						}
						return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: desktopVerifyOutput(desktopTestIncarnation)}, nil
					}
				} else {
					mutate()
				}
				claimed, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", viewer.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: viewer.Ticket})
				if err == nil || claimed != nil {
					t.Fatalf("changed authority must not publish read or write: %+v %v", claimed, err)
				}
				wantCommands := before
				if duringGrant {
					wantCommands += 2 // Physical verification followed by the grant.
				}
				if sb.execCmdCount() != wantCommands {
					t.Fatal("stale binding dispatched grant or cleanup to an unauthorized target")
				}
			})
		}
	}
}

func TestDesktopViewerMintRejectsLateTargetChange(t *testing.T) {
	l, dao, ctx, _ := desktopViewerFixture(t)
	sb := l.sandboxAdapter.(*desktopSandboxStub)
	sb.execFunc = func(string) (*psandbox.ExecCommandResult, error) {
		dao.change("sb-replacement", ctx.GetUserID())
		return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: desktopVerifyOutput(desktopTestIncarnation)}, nil
	}
	viewer, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err == nil || viewer != nil {
		t.Fatalf("verification completed after replacement must not mint: %v", err)
	}
}

func TestDesktopViewerUnknownGrantRetainsWriterUntilCleanup(t *testing.T) {
	l, _, ctx, _ := desktopViewerFixture(t)
	viewer, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	sb := l.sandboxAdapter.(*desktopSandboxStub)
	sb.execFunc = func(command string) (*psandbox.ExecCommandResult, error) {
		if strings.Contains(command, "DESKTOP_TARGET_VERIFY") {
			return desktopPreparationCommandResult(command), nil
		}
		return nil, fmt.Errorf("remote command outcome unknown")
	}
	claimed, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", viewer.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: viewer.Ticket})
	if err == nil || claimed != nil {
		t.Fatalf("unconfirmed cleanup must not publish a read fallback: %+v %v", claimed, err)
	}
	desktopViewerMu.Lock()
	attachment := desktopViewers[viewer.AttachmentID]
	retained := attachment != nil && attachment.access == transport.DesktopViewerAccessWrite && !attachment.claimedAt.IsZero()
	desktopViewerMu.Unlock()
	if !retained {
		t.Fatal("unknown remote grant must keep an unclaimable write reservation")
	}
	if _, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", viewer.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: viewer.Ticket}); err == nil {
		t.Fatal("unknown grant must not be claimable again")
	}
	if err := l.ReleaseDesktopViewer(ctx, "ins-desktop-1", viewer.AttachmentID); err == nil {
		t.Fatal("failed cleanup must report an error")
	}
	desktopViewerMu.Lock()
	_, retained = desktopViewers[viewer.AttachmentID]
	desktopViewerMu.Unlock()
	if !retained {
		t.Fatal("failed release must retain the write reservation")
	}
	sb.execFunc = func(string) (*psandbox.ExecCommandResult, error) {
		return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0, Output: desktopVerifyOutput(desktopTestIncarnation)}, nil
	}
	next, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil || next.Access != transport.DesktopViewerAccessRead {
		t.Fatalf("unknown grant still owns the writer slot: %v", err)
	}
	if err := l.ReleaseDesktopViewer(ctx, "ins-desktop-1", viewer.AttachmentID); err != nil {
		t.Fatal(err)
	}
	writer, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil || writer.Access != transport.DesktopViewerAccessWrite {
		t.Fatalf("confirmed cleanup must free writer slot: %v", err)
	}
}

func TestDesktopViewerCleanupOutcomes(t *testing.T) {
	for _, outcome := range []string{"empty-success", "failed", "unknown", "authority-changed"} {
		t.Run(outcome, func(t *testing.T) {
			l, dao, ctx, _ := desktopViewerFixture(t)
			viewer, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
			if err != nil {
				t.Fatal(err)
			}
			sb := l.sandboxAdapter.(*desktopSandboxStub)
			var commands []string
			sb.execFunc = func(command string) (*psandbox.ExecCommandResult, error) {
				if strings.Contains(command, "DESKTOP_TARGET_VERIFY") {
					return desktopPreparationCommandResult(command), nil
				}
				commands = append(commands, command)
				if strings.Contains(command, "--grant") {
					return nil, fmt.Errorf("grant completion unknown")
				}
				switch outcome {
				case "failed":
					return &psandbox.ExecCommandResult{Status: "FAILED", ExitCode: 1}, nil
				case "unknown":
					return nil, fmt.Errorf("revoke completion unknown")
				case "authority-changed":
					dao.change("replacement", ctx.GetUserID())
				}
				return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0}, nil
			}
			claimed, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", viewer.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: viewer.Ticket})
			if len(commands) != 2 || !strings.Contains(commands[1], "--revoke "+viewer.AttachmentID+" "+fmt.Sprint(viewer.ExpiresAt)) {
				t.Fatal("uncertain grant requires an attachment-scoped revoke before fallback")
			}
			if outcome == "empty-success" {
				if err != nil || claimed.Access != transport.DesktopViewerAccessRead {
					t.Fatalf("zero exit with empty output confirms cleanup: %v", err)
				}
				if err := l.ReleaseDesktopViewer(ctx, "ins-desktop-1", viewer.AttachmentID); err != nil {
					t.Fatal(err)
				}
				if len(commands) != 2 {
					t.Fatal("already revoked read fallback must not repeat remote cleanup")
				}
			} else if err == nil || claimed != nil {
				t.Fatalf("failed or stale cleanup cannot publish a tunnel: %v", err)
			}
		})
	}
}

func TestDesktopViewerReleaseAfterPreparationFailure(t *testing.T) {
	l, _, ctx, session := desktopViewerFixture(t)
	viewer, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", viewer.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: viewer.Ticket}); err != nil {
		t.Fatal(err)
	}
	session.mu.Lock()
	session.status = transport.DesktopSessionStatusFailed
	session.mu.Unlock()
	sb := l.sandboxAdapter.(*desktopSandboxStub)
	before := sb.execCmdCount()
	if err := l.ReleaseDesktopViewer(ctx, "ins-desktop-1", viewer.AttachmentID); err != nil {
		t.Fatalf("same authorized target must allow cleanup even when not ready: %v", err)
	}
	if sb.execCmdCount() != before+1 {
		t.Fatal("release skipped the active grant after preparation failed")
	}
}

func TestDesktopViewerStaleReleaseNeverTargetsReplacement(t *testing.T) {
	l, dao, ctx, oldSession := desktopViewerFixture(t)
	viewer, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", viewer.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: viewer.Ticket}); err != nil {
		t.Fatal(err)
	}
	dao.change("replacement", ctx.GetUserID())
	desktopSessions.Store("ins-desktop-1", &desktopSession{instanceID: "ins-desktop-1", userID: ctx.GetUserID(), sandboxID: "replacement", generation: "next", status: transport.DesktopSessionStatusReady, observerPrepared: true, inputPrepared: true, provisionMu: oldSession.operationMutex()})
	sb := l.sandboxAdapter.(*desktopSandboxStub)
	before := sb.execCmdCount()
	_ = l.ReleaseDesktopViewer(ctx, "ins-desktop-1", viewer.AttachmentID)
	if sb.execCmdCount() != before {
		t.Fatal("old release must not pair current session with stale sandbox")
	}
}

func TestDesktopViewerReleaseUnclaimedDoesNotRevoke(t *testing.T) {
	l, _, ctx, _ := desktopViewerFixture(t)
	viewer, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	sb := l.sandboxAdapter.(*desktopSandboxStub)
	before := sb.execCmdCount()
	if err := l.ReleaseDesktopViewer(ctx, "ins-desktop-1", viewer.AttachmentID); err != nil {
		t.Fatal(err)
	}
	if sb.execCmdCount() != before {
		t.Fatal("unclaimed leases never dispatched a grant and must not revoke remote input")
	}
}

func TestDesktopViewerClaimExpiryDuringGrant(t *testing.T) {
	l, _, ctx, _ := desktopViewerFixture(t)
	viewer, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	sb := l.sandboxAdapter.(*desktopSandboxStub)
	sb.execFunc = func(command string) (*psandbox.ExecCommandResult, error) {
		if strings.Contains(command, "--grant ") {
			desktopViewerExpire(viewer.AttachmentID)
		}
		return desktopPreparationCommandResult(command), nil
	}
	claimed, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", viewer.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: viewer.Ticket})
	if err == nil || claimed != nil {
		t.Fatalf("expired in-flight claim must not publish any tunnel: %+v %v", claimed, err)
	}
}

func TestDesktopViewerConcurrentClaimAndRelease(t *testing.T) {
	l, _, ctx, _ := desktopViewerFixture(t)
	viewer, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	sb := l.sandboxAdapter.(*desktopSandboxStub)
	entered, unblock := make(chan struct{}, 1), make(chan struct{})
	sb.execFunc = func(command string) (*psandbox.ExecCommandResult, error) {
		if !desktopViewerMu.TryLock() {
			t.Error("remote I/O must not hold the global viewer lock")
		} else {
			desktopViewerMu.Unlock()
		}
		if strings.Contains(command, "--grant") {
			entered <- struct{}{}
			<-unblock
		}
		return desktopPreparationCommandResult(command), nil
	}
	claimed := make(chan error, 1)
	go func() {
		_, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", viewer.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: viewer.Ticket})
		claimed <- err
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		close(unblock)
		t.Fatal("claim did not dispatch grant")
	}
	replayed := make(chan error, 1)
	go func() {
		_, err := l.ClaimDesktopViewer(ctx, "ins-desktop-1", viewer.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: viewer.Ticket})
		replayed <- err
	}()
	released := make(chan error, 1)
	go func() { released <- l.ReleaseDesktopViewer(ctx, "ins-desktop-1", viewer.AttachmentID) }()
	select {
	case <-released:
		close(unblock)
		<-claimed
		<-replayed
		t.Fatal("release overtook an in-flight grant")
	case <-time.After(30 * time.Millisecond):
	}
	desktopViewerMu.Lock()
	_, reserved := desktopViewers[viewer.AttachmentID]
	desktopViewerMu.Unlock()
	if !reserved {
		t.Error("release removed the writer reservation before confirming revoke")
	}
	close(unblock)
	if err := <-claimed; err != nil {
		t.Fatal(err)
	}
	if err := <-replayed; err == nil {
		t.Fatal("concurrent ticket replay must fail")
	}
	if err := <-released; err != nil {
		t.Fatal(err)
	}
	desktopViewerMu.Lock()
	_, present := desktopViewers[viewer.AttachmentID]
	desktopViewerMu.Unlock()
	if present {
		t.Fatal("confirmed release must remove the claimed lease")
	}
	grants, revokes := 0, 0
	for _, command := range sb.execCmds {
		if strings.Contains(command, "--grant") {
			grants++
		}
		if strings.Contains(command, "--revoke") {
			revokes++
		}
	}
	if grants != 1 || revokes != 1 {
		t.Fatalf("concurrent single-use claim must produce one grant then revoke, got %d/%d", grants, revokes)
	}
}

func TestDesktopViewerGenerationCleanupBeforePublish(t *testing.T) {
	for _, change := range []string{"retry", "owner", "sandbox"} {
		for _, outcome := range []string{"success", "timeout", "failed"} {
			t.Run(change+"/"+outcome, func(t *testing.T) {
				l, dao, ctx, old := desktopViewerFixture(t)
				viewer, err := l.CreateDesktopViewer(ctx, old.instanceID)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := l.ClaimDesktopViewer(ctx, old.instanceID, viewer.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: viewer.Ticket}); err != nil {
					t.Fatal(err)
				}
				if change == "owner" {
					dao.change(old.sandboxID, "new-owner")
					ctx = pctx.NewContext(nil).WithUserID("new-owner").WithSessionAuth("Bearer current-owner", "")
				} else if change == "sandbox" {
					dao.change("new-sandbox", ctx.GetUserID())
				} else {
					old.setStatus(transport.DesktopSessionStatusFailed, "retry")
				}
				sb := l.sandboxAdapter.(*desktopSandboxStub)
				revokes := 0
				sb.execFunc = func(command string) (*psandbox.ExecCommandResult, error) {
					if !desktopViewerMu.TryLock() {
						t.Error("cleanup holds viewer lock")
					} else {
						desktopViewerMu.Unlock()
					}
					if !strings.Contains(command, "--revoke "+viewer.AttachmentID+" ") {
						t.Errorf("unexpected cleanup command")
					}
					revokes++
					if outcome == "timeout" {
						return nil, fmt.Errorf("revoke timeout")
					}
					if outcome == "failed" {
						return &psandbox.ExecCommandResult{Status: "FAILED", ExitCode: 1}, nil
					}
					return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0}, nil
				}
				var next *desktopSession
				if change == "retry" {
					next, err = l.desktopResourceRetry(ctx, old)
				} else {
					entity, _ := dao.GetByInstanceID(ctx, old.instanceID)
					next, err = l.desktopSessionForEntity(ctx, entity)
				}
				if change == "sandbox" {
					if revokes != 0 {
						t.Fatal("cleanup followed current owner to an unauthorized old sandbox")
					}
				} else if revokes != 1 {
					t.Fatalf("generation replacement must dispatch revoke, got %d", revokes)
				}
				if change == "owner" {
					auths := sb.execAuthsSnapshot()
					if auths[len(auths)-1] != "Bearer current-owner" {
						t.Fatal("cleanup reused old owner authorization")
					}
				}
				// A replaced sandbox takes its grant with it, so cleanup has
				// nothing to revoke and must not block: the generation replaces
				// immediately regardless of the stubbed revoke outcome, instead of
				// stalling for the whole TTL + skew window on every retry.
				blocked := change != "sandbox" && outcome != "success"
				current, _ := desktopSessions.Load(old.instanceID)
				desktopViewerMu.Lock()
				pending := desktopViewers[viewer.AttachmentID] != nil
				desktopViewerMu.Unlock()
				if blocked {
					if err == nil || next != nil || current != old || !pending {
						t.Fatal("unconfirmed revoke published generation or lost pending lease")
					}
					if err := l.ReleaseDesktopViewer(ctx, old.instanceID, viewer.AttachmentID); err == nil {
						t.Fatal("pending cleanup falsely succeeded")
					}
				} else if err != nil || next == nil || next == old || pending {
					t.Fatalf("confirmed cleanup did not replace: %v", err)
				}
				if _, err := l.ClaimDesktopViewer(ctx, old.instanceID, viewer.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: viewer.Ticket}); err == nil {
					t.Fatal("old claim survived generation invalidation")
				}
			})
		}
	}
}

func TestDesktopSandboxReplacementDoesNotBlockResource(t *testing.T) {
	l, dao, ctx, old := desktopViewerFixture(t)
	viewer, err := l.CreateDesktopViewer(ctx, old.instanceID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.ClaimDesktopViewer(ctx, old.instanceID, viewer.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: viewer.Ticket}); err != nil {
		t.Fatal(err)
	}
	// The sandbox is replaced while a granted viewer is still recorded against
	// the old sandbox. Its grant is gone with the old sandbox, so cleanup has
	// nothing to revoke and must not reach the old target.
	dao.change("new-sandbox", ctx.GetUserID())
	sb := l.sandboxAdapter.(*desktopSandboxStub)
	sb.execFunc = func(command string) (*psandbox.ExecCommandResult, error) {
		if strings.Contains(command, "--revoke "+viewer.AttachmentID+" ") {
			t.Error("cleanup dispatched revoke to the replaced sandbox")
		}
		return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0,
			Output: desktopVerifyOutput(desktopTestIncarnation)}, nil
	}
	// Every resource preparation after replacement must succeed immediately
	// instead of failing for the whole TTL + skew window.
	for i := 0; i < 3; i++ {
		entity, _ := dao.GetByInstanceID(ctx, old.instanceID)
		next, err := l.desktopSessionForEntity(ctx, entity)
		if err != nil {
			t.Fatalf("replacement blocked resource preparation on attempt %d: %v", i, err)
		}
		if next == old || next.sandboxID != "new-sandbox" {
			t.Fatalf("resource not rebound to the new sandbox on attempt %d", i)
		}
	}
	desktopViewerMu.Lock()
	_, pending := desktopViewers[viewer.AttachmentID]
	desktopViewerMu.Unlock()
	if pending {
		t.Fatal("stale viewer lingered after sandbox replacement")
	}
}

func TestDesktopViewerReleasePendingWithoutSession(t *testing.T) {
	l, dao, ctx, session := desktopViewerFixture(t)
	viewer, err := l.CreateDesktopViewer(ctx, session.instanceID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.ClaimDesktopViewer(ctx, session.instanceID, viewer.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: viewer.Ticket}); err != nil {
		t.Fatal(err)
	}
	desktopSessions.Delete(session.instanceID)
	dao.change(session.sandboxID, "new-owner")
	ctx = pctx.NewContext(nil).WithUserID("new-owner")
	sb := l.sandboxAdapter.(*desktopSandboxStub)
	sb.execFunc = func(string) (*psandbox.ExecCommandResult, error) { return nil, context.DeadlineExceeded }
	if err := l.ReleaseDesktopViewer(ctx, session.instanceID, viewer.AttachmentID); err == nil {
		t.Fatal("missing session hid pending remote grant")
	}
	desktopViewerMu.Lock()
	pending := desktopViewers[viewer.AttachmentID]
	desktopViewerMu.Unlock()
	if pending == nil || !pending.revoked {
		t.Fatal("pending lease was not retained and invalidated")
	}
	entity, _ := dao.GetByInstanceID(ctx, session.instanceID)
	if next, err := l.desktopSessionForEntity(ctx, entity); err == nil || next != nil {
		t.Fatal("unbound session adoption bypassed pending cleanup")
	}
	sb.execFunc = func(command string) (*psandbox.ExecCommandResult, error) {
		if !strings.Contains(command, "--revoke "+viewer.AttachmentID+" ") {
			t.Error("release did not dispatch scoped revoke")
		}
		return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0}, nil
	}
	if err := l.ReleaseDesktopViewer(ctx, session.instanceID, viewer.AttachmentID); err != nil {
		t.Fatalf("new owner could not clear same-target old id: %v", err)
	}
}

func TestDesktopViewerPendingGrantSurvivesExpirySkew(t *testing.T) {
	l, _, ctx, session := desktopViewerFixture(t)
	viewer, err := l.CreateDesktopViewer(ctx, session.instanceID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.ClaimDesktopViewer(ctx, session.instanceID, viewer.AttachmentID, &transport.DesktopViewerClaimRequest{Ticket: viewer.Ticket}); err != nil {
		t.Fatal(err)
	}
	desktopViewerExpire(viewer.AttachmentID)
	next, err := l.CreateDesktopViewer(ctx, session.instanceID)
	if err != nil || next.Access != transport.DesktopViewerAccessRead {
		t.Fatalf("remote skew window freed writer: %v", err)
	}
}

func TestDesktopViewerTunnelModes(t *testing.T) {
	l, _, ctx, _ := desktopViewerFixture(t)

	resp, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Tunnel.Mode != transport.DesktopViewerTunnelModeRFB {
		t.Fatalf("default tunnel mode must be rfb, got %q", resp.Tunnel.Mode)
	}
	if resp.Tunnel.Path != "/desktop/input" {
		t.Fatalf("raw write must advertise the attachment handshake, got %q", resp.Tunnel.Path)
	}
	if read := desktopViewerTunnelFor(transport.DesktopViewerAccessRead); read.Path != "" {
		t.Fatalf("raw read must not require the write handshake: %+v", read)
	}
	if err := l.ReleaseDesktopViewer(ctx, "ins-desktop-1", resp.AttachmentID); err != nil {
		t.Fatal(err)
	}

	t.Setenv(desktopViewerTunnelModeEnv, "ws")
	t.Setenv(desktopViewerTunnelWritePortEnv, "6080")
	ws, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	if ws.Tunnel.Mode != transport.DesktopViewerTunnelModeWS || ws.Tunnel.Port != "6080" {
		t.Fatalf("unexpected ws tunnel: %+v", ws.Tunnel)
	}
	if ws.Tunnel.Path != "/desktop/connect" {
		t.Fatalf("ws mode must advertise the broker path, got %q", ws.Tunnel.Path)
	}
	// 未知 mode 一律收敛到 rfb，绝不回退到公网 URL。
	t.Setenv(desktopViewerTunnelModeEnv, "http")
	fallback, err := l.CreateDesktopViewer(ctx, "ins-desktop-1")
	if err != nil {
		t.Fatal(err)
	}
	if fallback.Tunnel.Mode != transport.DesktopViewerTunnelModeRFB {
		t.Fatalf("unknown mode must fall back to rfb, got %q", fallback.Tunnel.Mode)
	}
}
