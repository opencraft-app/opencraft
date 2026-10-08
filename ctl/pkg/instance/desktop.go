package instance

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	adapterfactory "ctl/pkg/adapter/factory"
	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/transport"

	"go.uber.org/zap"
)

// 云桌面（VNC）会话编排。
//
// 设计依据：ctl/docs/cloud-desktop-vnc-plan.md §4 + §12（v3，复用主 sandbox）。
//
// 部署模式（v3，§12）：**复用实例主 sandbox**，不再新建独立桌面 CVM。
//   - 桌面直接跑在实例自己的机器上（entity.SandboxId），与全模块其它 TAT
//     功能（configureOnboard / ChatClaw / debug / weixin 等）一致的范式；
//     不额外开机、不新增计费机器。
//   - 会话状态（VNC 密码 / 状态机 / lastActive）存进程内 sync.Map；sandboxID
//     不再缓存于会话，每次从 entity.SandboxId 取（主机生命周期归实例主流程）。
//     ctl 重启后状态丢失，下次请求幂等重建（storepasswd + systemctl 均幂等）。
//   - TAT 命令受 sandbox 300s / 1MiB 硬上限约束：provision 命令只做
//     「检测图形层已装 + 注入密码 + 拉起 4 个 systemd unit + 快速探测一次」
//     （120s 超时），就绪判定由 GET 轮询外层完成（探测命令 20s 超时）。
//   - **按需装图形层（§12 TB.2，范式 C）**：provision 检测到图形层未装时，
//     启动后台 goroutine 经 TAT 发起「nohup 安装脚本 + 进度文件」（apt 装
//     Xvfb/xfce4/x11vnc/noVNC + 落 4 个 systemd unit，秒回避免撞 300s），
//     状态置 Installing 带进度；装完转 Provisioning 幂等拉起。适配未预装镜像。
//   - **idle 回收 = 停桌面服务，绝不 pause/停主机**（agent 可能在跑）：
//     reaper 只 `systemctl stop` 桌面 4 个 unit（Stopped 态），再次访问重新拉起。
//   - wsUrl 由后端组装下发（域名取 DESKTOP_INGRESS_DOMAIN），前端绝不拼内网 IP。

const (
	desktopRuntimeUser       = "agentuser"
	desktopProvisionTimeoutS = 120
	desktopProbeTimeoutS     = 20
	// desktopProvisionRetryAfter：Provisioning 态 GET 轮询只走轻量探测的时间窗。
	// 超过该时长仍未就绪，才允许重发一次 provision 兜底（CR-C：避免秒级轮询
	// 反复下发 120s 超时的重命令：storepasswd + 4 个 unit + 探测）。
	desktopProvisionRetryAfter = 60 * time.Second
	desktopNoVNCPort           = 6080
	desktopWidth               = 1440
	desktopHeight              = 900
	desktopProbeOKMarker       = "DESKTOP_PROBE_OK"
	desktopProbePendingMarker  = "DESKTOP_PROBE_PENDING"
	desktopMissingLayerMarker  = "DESKTOP_LAYER_MISSING"
	// desktopProvisionFailedMarker：provision 关键步骤（写 VNC 密码 / 拉起桌面服务）
	// 真失败时输出并 exit 非零（CR-P1#2）。只有「图形层缺失(Missing)」和「探测未就绪
	// (Pending)」是正常业务信号可返回成功；密码写入/服务启动失败必须显式暴露，否则会被
	// 当成 Pending 反复轮询、永久卡在 Provisioning 且无可见原因（旧 noVNC 甚至可能误报 Ready）。
	desktopProvisionFailedMarker  = "DESKTOP_PROVISION_FAILED"
	desktopDefaultIdleMinutes     = 30
	desktopDefaultReapIntervalMin = 5

	// 桌面 4 个 systemd unit（镜像预装或按需装落盘），provision 拉起 / reaper 停止均引用。
	desktopSystemdUnits = "vela-xvfb vela-desktop-wm vela-x11vnc vela-novnc"

	// 按需装图形层（§12 TB.2，范式 C）：后台脚本把进度写到该文件，goroutine 轮询。
	desktopInstallProgressFile = "/tmp/vela-desktop-install.progress"
	desktopInstallDoneMarker   = "DESKTOP_INSTALL_DONE"
	desktopInstallFailMarker   = "DESKTOP_INSTALL_FAIL"
	desktopInstallStartedMark  = "DESKTOP_INSTALL_STARTED"
	// 安装总超时（秒）：apt 装图形层通常 2-5 分钟。
	desktopInstallTimeoutS = 600
	// 进度轮询连续失败上限：连续这么多次读进度失败即判定为真实故障（如 TAT
	// 鉴权失效、sandbox 不可达），带确切原因快速失败，而非静默卡满整个超时窗口。
	desktopInstallMaxPollFailures = 5

	// ingressproxy 对外泛域名（证书需覆盖 *-<sandboxID>）。
	desktopIngressDomainEnv = "DESKTOP_INGRESS_DOMAIN"
	// 桌面空闲回收阈值（分钟），默认 30；<=0 视为禁用回收。
	desktopIdleTimeoutMinutesEnv = "DESKTOP_IDLE_TIMEOUT_MINUTES"
	// idle reaper 扫描间隔（分钟），默认 5；<=0 回退默认值（CR-D）。
	desktopReapIntervalMinutesEnv = "DESKTOP_REAP_INTERVAL_MINUTES"
)

// desktopSession 进程内会话状态。指针存入 sync.Map，字段读写由 mu 保护。
//
// 锁分层（CR-A 并发防护）：
//   - provisionMu：粗粒度「编排锁」，整个 provision 编排全程持有，确保
//     「双检状态 → 拉起桌面服务 → 写回」是一个原子临界区，杜绝并发 POST/GET
//     对同一实例重复下发 provision 命令与状态竞争。
//   - mu：细粒度字段锁，保护单个字段的读写快照（snapshot/setStatus/touch），
//     供 reaper 等旁路只读快照，不与 provisionMu 的长临界区互相阻塞。
//
// 两把锁不嵌套获取（provisionMu 临界区内获取 mu 是允许的短暂持有；反之禁止），
// 避免死锁。
type desktopSession struct {
	provisionMu *sync.Mutex // Shared by replacement generations of this instance.

	mu               sync.Mutex
	instanceID       string
	userID           string
	generation       string
	preparing        bool
	observerPrepared bool // Successful optional observer startup, NOT incarnation proof.
	prepareCancel    context.CancelFunc
	sandboxID        string
	password         string
	status           string // transport.DesktopSessionStatus*
	reason           string
	lastActive       time.Time
	// provisionStartedAt：进入 Provisioning 态的时刻。GET 轮询据此判断
	// 是否仍在「轻量探测窗口」内（CR-C），避免每次轮询重发 provision 命令。
	provisionStartedAt time.Time

	// 按需装图形层（§12 TB.2）：installing 防止重复启动后台安装 goroutine；
	// installProgress/installMessage 供 GET 轮询展示进度。均由 mu 保护。
	installing      bool
	installProgress int
	installMessage  string
}

func (s *desktopSession) snapshot() (sandboxID, password, status, reason string, lastActive time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sandboxID, s.password, s.status, s.reason, s.lastActive
}

func (s *desktopSession) setStatus(status, reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// 只在「首次进入」Provisioning 时打时间戳：探测失败续留在 Provisioning
	// 不应刷新计时，否则重试窗口被无限续期、永远退回不到重发 provision。
	if status == transport.DesktopSessionStatusProvisioning {
		if s.status != transport.DesktopSessionStatusProvisioning {
			s.provisionStartedAt = time.Now()
		}
	} else {
		s.provisionStartedAt = time.Time{}
	}
	s.status = status
	if status != transport.DesktopSessionStatusReady {
		s.observerPrepared = false
	}
	s.reason = reason
}

// provisionAge 返回处于 Provisioning 态的时长；未记录起始时间时返回
// desktopProvisionRetryAfter（视为已超窗口，退回旧的「重发 provision」语义）。
func (s *desktopSession) provisionAge() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.provisionStartedAt.IsZero() {
		return desktopProvisionRetryAfter
	}
	return time.Since(s.provisionStartedAt)
}

func (s *desktopSession) touch() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastActive = time.Now()
}

// tryBeginInstall 原子地：若尚未在安装则标记 installing=true 并置 Installing 状态，返回 true；
// 若已在安装返回 false（防止并发请求重复启动安装 goroutine）。
func (s *desktopSession) tryBeginInstall(message string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.installing {
		return false
	}
	s.installing = true
	s.status = transport.DesktopSessionStatusInstalling
	s.reason = ""
	s.installProgress = 0
	s.installMessage = message
	return true
}

// setInstallProgress 更新安装进度（0-100）与提示文案。
func (s *desktopSession) setInstallProgress(progress int, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if progress < 0 {
		progress = 0
	}
	if progress > 100 {
		progress = 100
	}
	s.installProgress = progress
	if message != "" {
		s.installMessage = message
	}
}

// endInstall 清除 installing 标记，并置目标状态（成功 → Provisioning；失败 → Failed）。
func (s *desktopSession) endInstall(status, reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.installing = false
	s.status = status
	s.reason = reason
	if status == transport.DesktopSessionStatusProvisioning {
		// Installation only creates units; startup must run immediately, not
		// inherit the earlier missing-layer command's pending-probe window.
		s.provisionStartedAt = time.Time{}
	}
	if status != transport.DesktopSessionStatusInstalling {
		s.installMessage = ""
	}
}

// installSnapshot 读安装进度快照（供响应组装）。
func (s *desktopSession) installSnapshot() (progress int, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.installProgress, s.installMessage
}

// desktopSessions 包级会话表：instanceID → *desktopSession。
// server 侧 handler 与 idle reaper 并发访问。
var desktopSessions sync.Map

// desktopInstallPollInterval 按需装进度轮询间隔（§12 TB.2）；用 var 便于测试注入小值加速。
var desktopInstallPollInterval = 8 * time.Second

func resetDesktopSessionsForTest() {
	desktopSessions = sync.Map{}
}

// EnsureDesktopSession POST /v1/instances/{id}/desktop/session
// 幂等触发：复用实例主 sandbox，通过 TAT 拉起桌面服务。
func (l *logic) EnsureDesktopSession(ctx pctx.Context, instanceID string) (*transport.DesktopSessionResponse, error) {
	entity, err := l.loadDesktopInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	session, err := l.desktopSessionForEntity(ctx, entity)
	if err != nil {
		return nil, err
	}

	session.mu.Lock()
	status := session.status
	session.mu.Unlock()

	switch status {
	case transport.DesktopSessionStatusReady:
		session.touch()
		return l.desktopSessionResponse(session)
	case transport.DesktopSessionStatusInstalling:
		// 正在按需装图形层：直接返回进度，不重复触发（§12 TB.2）。
		return l.desktopSessionResponse(session)
	default:
		// Provisioning / Failed / 空：走（重新）provision 路径，幂等。
		return l.provisionDesktop(ctx, session, entity)
	}
}

// GetDesktopSession GET /v1/instances/{id}/desktop/session
// 轮询：Provisioning 时快速探测 6080；Paused 时先 Resume；Ready 刷新活跃时间。
// ctl 重启后（会话表为空）自动降级为触发语义，保证幂等。
func (l *logic) GetDesktopSession(ctx pctx.Context, instanceID string) (*transport.DesktopSessionResponse, error) {
	entity, err := l.loadDesktopInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	session, err := l.desktopSessionForEntity(ctx, entity)
	if err != nil {
		return nil, err
	}

	session.mu.Lock()
	status := session.status
	session.mu.Unlock()

	switch status {
	case transport.DesktopSessionStatusReady:
		session.touch()
		return l.desktopSessionResponse(session)
	case transport.DesktopSessionStatusInstalling:
		// 正在按需装图形层：直接返回进度，后台 goroutine 装完会自动转 Provisioning。
		return l.desktopSessionResponse(session)
	case transport.DesktopSessionStatusPaused:
		// v3（§12 TB.4）：Paused = 桌面服务被 idle 回收停掉、但主机仍在跑。
		// 恢复 = 重新 provision（幂等 storepasswd + systemctl start + 探测），
		// 不再 ResumeSandbox（那是唤醒整机，主机从未停机）。
		return l.provisionDesktop(ctx, session, entity)
	case transport.DesktopSessionStatusProvisioning:
		// CR-C：provision 是 120s 超时的重命令（storepasswd + 4 个 unit + 探测），
		// 前端按秒级轮询时不能每次重发。Provisioning 期间只走 20s 的轻量探测；
		// 超过 desktopProvisionRetryAfter 仍未就绪，才允许重发一次 provision 兜底。
		if session.provisionAge() < desktopProvisionRetryAfter {
			return l.probeDesktop(ctx, session)
		}
		return l.provisionDesktop(ctx, session, entity)
	default:
		// Failed / 空（首次访问或 ctl 重启后状态丢失）。
		return l.provisionDesktop(ctx, session, entity)
	}
}

// loadDesktopInstance 校验用户与实例归属。桌面复用主 sandbox；
// 是否能启动由实际 sandbox/TAT 结果判断，而非实例展示状态。
func (l *logic) loadDesktopInstance(ctx pctx.Context, instanceID string) (*modelinstance.Entity, error) {
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
	if entity == nil || entity.UserId != ctx.GetUserID() {
		return nil, errcode.ErrInstanceNotFound
	}
	return entity, nil
}

func (l *logic) desktopSessionOf(instanceID string) *desktopSession {
	raw, ok := desktopSessions.Load(instanceID)
	if ok {
		if session, ok2 := raw.(*desktopSession); ok2 {
			return session
		}
	}
	session := &desktopSession{instanceID: instanceID}
	actual, loaded := desktopSessions.LoadOrStore(instanceID, session)
	if loaded {
		if s, ok := actual.(*desktopSession); ok {
			return s
		}
	}
	return session
}

// provisionDesktop 复用实例主 sandbox（entity.SandboxId）+ TAT 拉起桌面服务 + 一次探测。
//
// v3（§12 TB.1）：不再 CreateSandbox 新建独立 CVM，直接在实例自己的机器上拉桌面。
// 全程持 provisionMu：把「读状态 → 拉起服务 → 写回」收敛为临界区，避免并发请求
// 重复下发 provision 命令与状态竞争（CR-A 保留语义）。进入前若已 Ready 直接返回。
func (l *logic) provisionDesktop(ctx pctx.Context, session *desktopSession, entity *modelinstance.Entity) (resp *transport.DesktopSessionResponse, err error) {
	operationMu := session.operationMutex()
	operationMu.Lock()
	defer operationMu.Unlock()
	if err := l.validateDesktopSession(ctx, session); err != nil {
		return nil, err
	}
	defer func() {
		if scopeErr := l.validateDesktopSession(ctx, session); scopeErr != nil {
			resp, err = nil, scopeErr
		}
	}()

	// 双检：拿到锁后重新读状态，可能已被前一个持锁者推到 Ready / 正在安装。
	session.mu.Lock()
	status := session.status
	session.mu.Unlock()
	if status == transport.DesktopSessionStatusReady {
		session.touch()
		return l.desktopSessionResponse(session)
	}
	if status == transport.DesktopSessionStatusInstalling {
		// 已有后台安装在进行，避免重复触发；返回当前进度。
		return l.desktopSessionResponse(session)
	}

	// 使用已绑定并重新核验的目标，不使用等待锁之前的 entity 快照。
	session.mu.Lock()
	sandboxID := session.sandboxID
	session.mu.Unlock()
	if sandboxID == "" {
		// 实例主机尚未就绪（无 sandbox），桌面无处可跑。
		session.setStatus(transport.DesktopSessionStatusFailed, "instance sandbox not ready")
		return nil, errcode.Wrap(errcode.ErrDesktopNotConfigured, "instance %s has no sandbox", entity.InstanceId)
	}

	// 生成/复用 VNC 密码：首次生成，重试复用已有（幂等，避免每次轮换密码）。
	session.mu.Lock()
	password := session.password
	session.mu.Unlock()
	if password == "" {
		pw, err := generateDesktopPassword()
		if err != nil {
			session.setStatus(transport.DesktopSessionStatusFailed, fmt.Sprintf("generate desktop password: %v", err))
			return nil, err
		}
		password = pw
	}

	session.mu.Lock()
	session.sandboxID = sandboxID
	session.password = password
	session.status = transport.DesktopSessionStatusProvisioning
	session.reason = ""
	session.provisionStartedAt = time.Now()
	session.mu.Unlock()

	// TAT 短命令：检测图形层已装 + 注入密码 + 拉起 4 个 unit + 快速探测一次。
	result, err := l.execSandboxPtyCommandStream(
		ctx,
		sandboxID,
		"desktop_provision",
		renderDesktopProvisionCommand(password),
		desktopRuntimeUser,
		desktopProvisionTimeoutS,
		nil,
	)
	if err != nil {
		session.setStatus(transport.DesktopSessionStatusProvisioning, fmt.Sprintf("provision command dispatch: %v", err))
		return l.desktopSessionResponse(session)
	}
	out := desktopCommandOutput(result)
	// 图形层未预装（范式 A 检测）：触发按需 apt 安装（§12 TB.2，范式 C）。
	//
	// 【标记优先于退出码】此判定必须在 sandboxCommandSucceeded 之前：
	// provision 脚本对"图形层缺失"是正常业务信号（echo DESKTOP_LAYER_MISSING; exit 0），
	// 但 PTY 流式执行 + set -e 下，检测行里 systemctl 非零返回可能污染会话最终退出码
	// 使其变为 1，导致 sandboxCommandSucceeded 误判失败、直接 Failed，永远走不到安装分支
	// （现网 bj-7 表现：status=FAILED exit_code=1 stdout=DESKTOP_LAYER_MISSING）。
	// 因此只要 stdout 含该标记，无论退出码，一律走按需安装。
	// 启动后台安装 goroutine，本次请求立即返回 Installing，前端轮询看进度。
	if strings.Contains(out, desktopMissingLayerMarker) {
		l.startDesktopInstall(ctx, session, sandboxID)
		return l.desktopSessionResponse(session)
	}
	// 【标记优先】provision 关键步骤失败（写密码/拉起服务）显式暴露：置 Failed 并带原因，
	// 避免被下面的 Pending 分支当成"还在启动"而永久轮询（CR-P1#2）。marker 里带了失败原因。
	if strings.Contains(out, desktopProvisionFailedMarker) {
		session.setStatus(transport.DesktopSessionStatusFailed, desktopProvisionFailureDetail(out))
		return l.desktopSessionResponse(session)
	}
	if !sandboxCommandSucceeded(result) {
		session.setStatus(transport.DesktopSessionStatusFailed, sandboxCommandFailureDetail(result))
		return l.desktopSessionResponse(session)
	}
	// provision 命令自带一次探测：若已就绪直接置 Ready，省一次 GET 探测往返。
	if strings.Contains(out, desktopProbeOKMarker) {
		session.setStatus(transport.DesktopSessionStatusReady, "")
		session.touch()
		return l.desktopSessionResponse(session)
	}
	// 命令成功但桌面仍在启动（provision 探测 pending）：交由 GET 轮询继续判定。
	return l.probeDesktopLocked(ctx, session)
}

// probeDesktop 快速探测 noVNC 端口就绪；就绪则置 Ready。
func (l *logic) probeDesktop(ctx pctx.Context, session *desktopSession) (resp *transport.DesktopSessionResponse, err error) {
	operationMu := session.operationMutex()
	operationMu.Lock()
	defer operationMu.Unlock()
	if err := l.validateDesktopSession(ctx, session); err != nil {
		return nil, err
	}
	defer func() {
		if scopeErr := l.validateDesktopSession(ctx, session); scopeErr != nil {
			resp, err = nil, scopeErr
		}
	}()
	return l.probeDesktopLocked(ctx, session)
}

// Caller holds the shared operation mutex and validates the target on exit.
func (l *logic) probeDesktopLocked(ctx pctx.Context, session *desktopSession) (*transport.DesktopSessionResponse, error) {
	session.mu.Lock()
	sandboxID := session.sandboxID
	session.mu.Unlock()
	if sandboxID == "" {
		return nil, errcode.ErrDesktopNotConfigured
	}

	result, err := l.execSandboxPtyCommandStream(
		ctx,
		sandboxID,
		"desktop_probe",
		renderDesktopProbeCommand(),
		desktopRuntimeUser,
		desktopProbeTimeoutS,
		nil,
	)
	if err != nil {
		session.setStatus(transport.DesktopSessionStatusProvisioning, fmt.Sprintf("probe command dispatch: %v", err))
		return l.desktopSessionResponse(session)
	}
	if !sandboxCommandSucceeded(result) {
		session.setStatus(transport.DesktopSessionStatusProvisioning, sandboxCommandFailureDetail(result))
		return l.desktopSessionResponse(session)
	}
	if strings.Contains(desktopCommandOutput(result), desktopProbeOKMarker) {
		session.setStatus(transport.DesktopSessionStatusReady, "")
		session.touch()
	}
	return l.desktopSessionResponse(session)
}

// desktopSessionResponse 组装对外响应；Ready 时附 ws_url / password / 分辨率。
func (l *logic) desktopSessionResponse(session *desktopSession) (*transport.DesktopSessionResponse, error) {
	sandboxID, password, status, reason, _ := session.snapshot()
	resp := &transport.DesktopSessionResponse{
		Status: status,
		Reason: reason,
	}
	if status == transport.DesktopSessionStatusInstalling {
		progress, message := session.installSnapshot()
		resp.InstallProgress = progress
		resp.Message = message
		return resp, nil
	}
	if status != transport.DesktopSessionStatusReady {
		return resp, nil
	}
	wsURL, err := buildDesktopWSURL(sandboxID)
	if err != nil {
		return nil, err
	}
	resp.WsURL = wsURL
	resp.Password = password
	resp.Width = desktopWidth
	resp.Height = desktopHeight
	return resp, nil
}

// buildDesktopWSURL 组装 noVNC WebSocket 地址：
// wss://<6080>-<sandboxID>.<DESKTOP_INGRESS_DOMAIN>/websockify
// 端口来自域名（ingressproxy route.Rule 不绑端口，见方案 §4.2）。
// v3（§12 TB.5）：sandboxID 为**实例主 sandbox**，ingress 泛域名证书需覆盖
// `*-<主 sandboxID>.<域名>`（原覆盖独立桌面 sandboxID，现随复用切换）。
func buildDesktopWSURL(sandboxID string) (string, error) {
	domain := strings.TrimSpace(os.Getenv(desktopIngressDomainEnv))
	if domain == "" {
		return "", errcode.Wrap(errcode.ErrDesktopNotConfigured, "env %s is not set", desktopIngressDomainEnv)
	}
	if strings.TrimSpace(sandboxID) == "" {
		return "", errcode.ErrDesktopNotConfigured
	}
	return fmt.Sprintf("wss://%d-%s.%s/websockify", desktopNoVNCPort, sandboxID, domain), nil
}

// generateDesktopPassword 生成 8 位字母数字 VNC 密码（免 shell 转义）。
//
// 熵说明（CR-C）：VNC/RFB 认证密码最多 8 个字符，超出会被截断，因此**不能靠
// 加长**提升强度；改为把字符集从 16 进制（16^8 = 32 bit）扩到 62 个字母数字
// （62^8 ≈ 47.6 bit），在协议上限内把暴力枚举成本提高约 5 万倍。桌面经公网
// noVNC 暴露、密码是唯一凭据，32 bit 可被脚本化枚举，故不再使用 hex。
//
// crypto/rand 失败（极罕见）时直接返回错误，由 provision 走 Failed 路径并记录
// 原因，宁可本次建会话失败、由前端重试，也不下发弱密码。
func generateDesktopPassword() (string, error) {
	const (
		length  = 8
		charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	)
	// 拒绝采样：丢弃 >= floor(256/62)*62 的字节，消除取模偏置。
	limit := 256 - (256 % len(charset))
	buf := make([]byte, length)
	out := make([]byte, 0, length)
	for len(out) < length {
		if _, err := rand.Read(buf); err != nil {
			return "", errcode.Wrap(errcode.ErrSandboxServiceError, "generate desktop password: %v", err)
		}
		for _, b := range buf {
			if int(b) >= limit {
				continue
			}
			out = append(out, charset[int(b)%len(charset)])
			if len(out) == length {
				break
			}
		}
	}
	// 安全白名单校验（阻塞 1）：显式拒绝字符集外的字符（如 shell 元字符）。
	// 虽当前 62 字符集安全，但防止未来字符集变更引入注入风险。
	for _, c := range out {
		found := false
		for j := 0; j < len(charset); j++ {
			if c == charset[j] {
				found = true
				break
			}
		}
		if !found {
			return "", errcode.Wrap(errcode.ErrSandboxServiceError, "invalid character in generated password")
		}
	}
	return string(out), nil
}

// renderDesktopProvisionCommand TAT 短命令：检测图形层 → 注入密码 → 拉起服务 → 探测一次。
//
// v3（§12 TB.1/TB.2）：桌面跑在实例主 sandbox 上，4 个 unit
// （vela-xvfb / vela-desktop-wm / vela-x11vnc / vela-novnc）由镜像预装
// （build.sh --with-desktop）或按需装（TB.2）落盘。前置检测（范式 A）：
// unit 不存在则输出 DESKTOP_LAYER_MISSING，由上层触发按需安装（startDesktopInstall）。
//
// 阻塞 1 修复：密码以 base64 传输、shell 侧解码，再经命令替换注入。
//
// 为何不用「%q + 双引号」：%q 只转义引号与反斜杠，但 shell 仍会在双引号内做
// 命令替换（$(...)、反引号），恶意字符照样逃逸。base64 编码后命令行只剩
// [A-Za-z0-9+/=]，`VNC_PW="$(printf %s "$B64" | base64 -d)"` 的命令替换结果
// **不会被 shell 二次展开**，因此任意字节（含 ; $ ` " '）都无法逃逸成指令。
// 这样密码字符集未来即使扩展也无需再改注入方式。
func renderDesktopProvisionCommand(password string) string {
	pwB64 := base64.StdEncoding.EncodeToString([]byte(password))
	// 【不用 set -e】范式与 renderDesktopProbeCommand 一致：脚本靠输出 marker 区分状态，
	// 始终尽量 exit 0，把"图形层缺失/就绪/pending"作为正常业务信号用 stdout 传递。
	// 早期用 set -e 会让检测行里 systemctl 的非零返回污染 PTY 会话退出码（→ exit 1），
	// 使上层误判命令失败、走不到 DESKTOP_LAYER_MISSING 分支（现网 bj-7 复现）。
	// 故去掉 set -e，改用显式错误处理：关键步骤失败 echo 明确 marker 并 exit 0。
	return fmt.Sprintf(`# 范式 A：检测图形层 systemd unit 是否已预装
# 注意：这里刻意不开启 errexit 选项 —— 该检测行里 systemctl 的非零返回不能污染 PTY 会话退出码，
# 否则上层会误判命令失败、走不到 DESKTOP_LAYER_MISSING 分支（现网 bj-7 复现）。
if ! systemctl list-unit-files vela-novnc.service >/dev/null 2>&1 || ! systemctl cat vela-novnc.service >/dev/null 2>&1; then
  echo %s
  exit 0
fi
# 图形层已就位：以下是关键步骤（写 VNC 密码 / 拉起服务），失败必须显式暴露而非吞掉（CR-P1#2）。
# fail() 输出明确 marker + 原因并 exit 非零，让上层置 Failed 而不是被当成 Pending 永久轮询。
fail() { echo "%s $1"; exit 1; }
VNC_PASSWD_FILE="$HOME/.vnc/passwd"
mkdir -p "$HOME/.vnc" || fail "mkdir .vnc"
VNC_PW_B64=%q
VNC_PW="$(printf %%s "$VNC_PW_B64" | base64 -d)" || fail "decode password"
x11vnc -storepasswd "$VNC_PW" "$VNC_PASSWD_FILE" >/dev/null 2>&1 || fail "store vnc password"
chmod 600 "$VNC_PASSWD_FILE" 2>/dev/null || fail "chmod passwd"
sudo systemctl enable --now %s >/dev/null 2>&1 || systemctl enable --now %s >/dev/null 2>&1 || fail "enable desktop services"
# 探测非关键：未就绪是正常 Pending（服务刚拉起需要时间），返回成功让上层继续轮询探测。
if curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:%d/ 2>/dev/null; then
  echo %s
else
  echo %s
fi
exit 0`, desktopMissingLayerMarker, desktopProvisionFailedMarker, pwB64, desktopSystemdUnits, desktopSystemdUnits, desktopNoVNCPort, desktopProbeOKMarker, desktopProbePendingMarker)
}

// renderDesktopProbeCommand 快速探测命令：总是 exit 0，靠输出 marker 区分，
// 「未就绪」不会被误判为「失败」。
func renderDesktopProbeCommand() string {
	return fmt.Sprintf(`if curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:%d/ 2>/dev/null; then
  echo %s
else
  echo %s
fi`, desktopNoVNCPort, desktopProbeOKMarker, desktopProbePendingMarker)
}

// renderDesktopStopServicesCommand idle 回收用：包含可选的只读观看服务，不动主机。
// systemctl stop 幂等（已停/不存在都不报错），总是 exit 0。
func renderDesktopStopServicesCommand() string {
	return fmt.Sprintf(`sudo systemctl stop %s >/dev/null 2>&1 || systemctl stop %s >/dev/null 2>&1 || true`,
		desktopSystemdUnits+" "+desktopObserverUnit+" "+desktopObserverProxyUnit,
		desktopSystemdUnits+" "+desktopObserverUnit+" "+desktopObserverProxyUnit)
}

// startDesktopInstall 触发按需安装图形层（§12 TB.2，范式 C）。
//
// 抢占 installing 标记后起后台 goroutine：用独立 context（请求早已返回）经 TAT
// 发起「后台安装脚本 + 进度文件」，再周期轮询进度文件；装完转 Provisioning、
// 失败/超时转 Failed。前端在此期间轮询 GET 看 Installing 进度。
func (l *logic) startDesktopInstall(parent pctx.Context, session *desktopSession, sandboxID string) {
	if !session.tryBeginInstall("正在安装桌面环境（首次约 2-5 分钟）…") {
		return // 已有安装在进行
	}
	job, cancel := context.WithTimeout(context.Background(), desktopInstallTimeoutS*time.Second)
	// 后台安装经 TAT 下发命令，而 TAT endpoint（/tat/*）鉴权只认 ctx 透传的用户
	// session（见 adapter.applySandboxSessionAuth）。请求早已返回，这里必须从
	// parent 显式继承 SessionAuth，否则后台 ctx 的 session 为空，TAT 调用会以
	// "authentication required: authentication failed" 失败，桌面安装永远起不来。
	ctx := pctx.NewContext(job).
		WithUserID(parent.GetUserID()).
		WithRegion(parent.GetRegion()).
		WithSessionAuth(parent.GetSessionAuthorization(), parent.GetSessionCookie())
	ctx.SetGormDB(parent.GormDB())
	go func() { defer cancel(); l.runDesktopInstall(ctx, sandboxID, session) }()
}

// runDesktopInstall 后台安装主体：发起安装 → 轮询进度 → 收敛状态。
func (l *logic) runDesktopInstall(ctx pctx.Context, sandboxID string, session *desktopSession) {

	// 1. 发起后台安装（TAT 命令秒回：脚本用 nohup 丢后台，避免撞 300s 上限）。
	startRes, err := l.execDesktopInstallCommand(ctx, session, sandboxID, renderDesktopInstallCommand())
	if err != nil || !sandboxCommandSucceeded(startRes) {
		detail := "dispatch desktop install"
		if err != nil {
			detail = err.Error()
		} else if startRes != nil {
			detail = sandboxCommandFailureDetail(startRes)
		}
		session.endInstall(transport.DesktopSessionStatusFailed, "start desktop install: "+detail)
		return
	}

	// 2. 轮询进度文件，直到 DONE / FAIL / 超时。
	deadline := time.Now().Add(desktopInstallTimeoutS * time.Second)
	// 单次轮询失败（网络抖动等）不致命，但连续多次失败往往是真实错误（如 TAT
	// 鉴权失效、sandbox 不可达）。此时应带确切原因快速失败，而非静默卡满整个
	// 安装超时窗口、把真实故障伪装成「正在安装」。
	consecutivePollFailures := 0
	for time.Now().Before(deadline) {
		timer := time.NewTimer(desktopInstallPollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			session.endInstall(transport.DesktopSessionStatusFailed, "desktop install timed out")
			return
		case <-timer.C:
		}

		res, perr := l.execDesktopInstallCommand(ctx, session, sandboxID, renderDesktopInstallProgressCommand())
		if perr != nil || !sandboxCommandSucceeded(res) {
			if l.validateDesktopSession(ctx, session) != nil {
				session.endInstall(transport.DesktopSessionStatusFailed, "desktop target changed")
				return
			}
			consecutivePollFailures++
			if consecutivePollFailures >= desktopInstallMaxPollFailures {
				detail := "poll desktop install progress"
				if perr != nil {
					detail = perr.Error()
				} else if res != nil {
					detail = sandboxCommandFailureDetail(res)
				}
				session.endInstall(transport.DesktopSessionStatusFailed, "desktop install progress unreachable: "+detail)
				return
			}
			continue // 偶发失败：继续重试直至连续失败上限或整体超时
		}
		consecutivePollFailures = 0
		out := desktopCommandOutput(res)
		if strings.Contains(out, desktopInstallFailMarker) {
			session.endInstall(transport.DesktopSessionStatusFailed, "desktop install failed on sandbox (see /tmp/vela-desktop-install.log)")
			return
		}
		if strings.Contains(out, desktopInstallDoneMarker) {
			session.setInstallProgress(100, "安装完成，正在启动桌面…")
			// 转 Provisioning：下次 GET/POST 幂等走 provision 拉起服务并探测。
			session.endInstall(transport.DesktopSessionStatusProvisioning, "")
			return
		}
		if p := parseDesktopInstallProgress(out); p >= 0 {
			session.setInstallProgress(p, "")
		}
	}
	session.endInstall(transport.DesktopSessionStatusFailed, "desktop install timed out")
}

// Serialize local TAT dispatches and fence detached jobs. This cannot revoke an
// already dispatched remote nohup installer; its file lock remains authoritative.
func (l *logic) execDesktopInstallCommand(ctx pctx.Context, session *desktopSession, sandboxID, command string) (*psandbox.ExecCommandResult, error) {
	op := session.operationMutex()
	op.Lock()
	defer op.Unlock()
	if err := l.validateDesktopSession(ctx, session); err != nil {
		return nil, err
	}
	return l.sandboxAdapter.ExecCommand(ctx, sandboxID, command, desktopProbeTimeoutS)
}

// renderDesktopInstallCommand 后台安装脚本（§12 TB.2）：nohup 丢后台立即返回，
// 分阶段写进度到进度文件；落盘 4 个 systemd unit（与镜像预装等价）。
// 幂等：重复执行覆盖脚本、重启安装。所有网络/apt 失败写 FAIL marker。
//
// 阻塞 2 修复：统一 DISPLAY :1（与镜像预装对齐）。
// 问题 3 修复：进度文件加 flock 独占写，清空旧残留。
func renderDesktopInstallCommand() string {
	// 说明：进度文件按阶段写 "PROGRESS=<n>"；成功尾附 DONE、失败尾附 FAIL。
	// Ubuntu 包名与 images/build.sh --with-desktop 对齐；TencentOS 4.4 仅分叉包安装。
	// 两种系统共享 agentuser、unit 与进度协议，供未预装镜像按需补齐。
	return fmt.Sprintf(`set +e
PF=%q
LOG=/tmp/vela-desktop-install.log
# 问题 3 修复：清空进度文件残留，防止跨阶段复读
: > "$PF" && : > "$LOG" || exit 1
cat > /tmp/vela-desktop-install.sh <<'INSTALL' || exit 1
#!/usr/bin/env bash
set +e
PF=%q
LOG=/tmp/vela-desktop-install.log
# 问题 3 修复：flock 独占锁，单次写入，避免 echo >> 累积旧进度
say(){ (flock -x 9; echo "PROGRESS=$1" > "$PF"; echo "[install] $2" >> "$LOG") 9>"$PF.lock"; }
fail(){ (flock -x 9; echo "%s" >> "$PF"; echo "[install][FAIL] $1" >> "$LOG") 9>"$PF.lock"; exit 1; }
sudo -n true >>"$LOG" 2>&1 || fail "non-interactive sudo required"
[ -d /run/systemd/system ] || fail "systemd is not running"
DESKTOP_USER=%q
DESKTOP_HOME=%q
DESKTOP_UID=$(id -u "$DESKTOP_USER" 2>/dev/null) || fail "desktop runtime user missing"
[ "$DESKTOP_UID" != 0 ] || fail "desktop runtime user must not be root"
[ "$(getent passwd "$DESKTOP_USER" | cut -d: -f6)" = "$DESKTOP_HOME" ] || fail "desktop runtime home mismatch"
%s
# 验证两种发行版实际安装结果，不能仅凭包管理器返回值报告成功。
for executable in /usr/bin/Xvfb /usr/bin/x11vnc /usr/bin/websockify /usr/bin/dbus-run-session /usr/bin/startxfce4; do
  [ -x "$executable" ] || fail "desktop executable missing: $executable"
done
[ -r /usr/share/novnc/vnc.html ] || fail "noVNC assets missing"
say 70 "write systemd units"
# 阻塞 2 修复：4 个 unit 统一 DISPLAY :1（与镜像预装对齐）。
# agentuser 对齐（与 images/build.sh --with-desktop 预装版本一致）：
#   - User=agentuser：桌面进程以 agent 运行用户跑，避免 root 会话（与 agent 本体一致，
#     修掉「桌面里创建的文件属主 root、agent 读不了」的错配，并降低公网 noVNC 暴露 root 的风险）。
#   - HOME/DISPLAY 显式注入；WM 用 dbus-run-session 包裹 startxfce4（非 root 下起 XFCE 会话的关键）。
#   - Requires/After 补齐依赖链，与预装 unit 对齐。
sudo -n tee /etc/systemd/system/vela-xvfb.service >/dev/null <<'U1' || fail "write vela-xvfb unit"
[Unit]
Description=vela Xvfb
After=network.target
[Service]
Type=simple
User=%s
ExecStart=/usr/bin/Xvfb :1 -screen 0 1440x900x24 -nolisten tcp
Restart=on-failure
RestartSec=2
[Install]
WantedBy=multi-user.target
U1
sudo -n tee /etc/systemd/system/vela-desktop-wm.service >/dev/null <<'U2' || fail "write vela-desktop-wm unit"
[Unit]
Description=vela WM
Requires=vela-xvfb.service
After=vela-xvfb.service
[Service]
Type=simple
User=%s
Environment=DISPLAY=:1
Environment=HOME=%s
ExecStart=/usr/bin/dbus-run-session -- /usr/bin/startxfce4
Restart=on-failure
RestartSec=3
[Install]
WantedBy=multi-user.target
U2
sudo -n tee /etc/systemd/system/vela-x11vnc.service >/dev/null <<'U3' || fail "write vela-x11vnc unit"
[Unit]
Description=vela x11vnc
Requires=vela-xvfb.service
After=vela-xvfb.service vela-desktop-wm.service
[Service]
Type=simple
User=%s
Environment=DISPLAY=:1
Environment=HOME=%s
ExecStart=/usr/bin/x11vnc -display :1 -rfbport 5900 -rfbauth %s/.vnc/passwd -forever -shared -noxdamage -wait 5 -defer 5
Restart=on-failure
RestartSec=3
[Install]
WantedBy=multi-user.target
U3
sudo -n tee /etc/systemd/system/vela-novnc.service >/dev/null <<'U4' || fail "write vela-novnc unit"
[Unit]
Description=vela noVNC
After=network.target vela-x11vnc.service
Requires=vela-x11vnc.service
[Service]
Type=simple
User=%s
ExecStart=/usr/bin/websockify --web=/usr/share/novnc %d localhost:5900
Restart=on-failure
RestartSec=3
[Install]
WantedBy=multi-user.target
U4
sudo -n tee /etc/systemd/system/vela-desktop-observer.service >/dev/null <<'U5' || fail "write vela-desktop-observer unit"
%s
U5
say 90 "daemon-reload"
sudo -n systemctl daemon-reload >>"$LOG" 2>&1 || fail "daemon-reload"
say 100 "done"
(flock -x 9; echo "%s" >> "$PF") 9>"$PF.lock"
INSTALL
chmod +x /tmp/vela-desktop-install.sh || exit 1
echo "%s"
nohup bash /tmp/vela-desktop-install.sh >>"$LOG" 2>&1 &
exit 0`,
		desktopInstallProgressFile,  // 外层 PF=%q
		desktopInstallProgressFile,  // heredoc 内 PF=%q
		desktopInstallFailMarker,    // fail(){ echo "%s" }
		desktopRuntimeUser,          // DESKTOP_USER=%q
		"/home/"+desktopRuntimeUser, // DESKTOP_HOME=%q
		renderDesktopInstallPackagesCommand(),
		desktopRuntimeUser,          // vela-xvfb   User=%s
		desktopRuntimeUser,          // vela-desktop-wm User=%s
		"/home/"+desktopRuntimeUser, // vela-desktop-wm HOME=%s
		desktopRuntimeUser,          // vela-x11vnc User=%s
		"/home/"+desktopRuntimeUser, // vela-x11vnc HOME=%s
		"/home/"+desktopRuntimeUser, // vela-x11vnc -rfbauth %s/.vnc/passwd
		desktopRuntimeUser,          // vela-novnc  User=%s
		desktopNoVNCPort,            // vela-novnc  websockify %d
		renderDesktopObserverUnit(), // Separate, not auto-enabled by legacy provision.
		desktopInstallDoneMarker,    // 尾部 DONE marker
		desktopInstallStartedMark,   // echo "%s"（STARTED）
	)
}

// renderDesktopInstallProgressCommand 读进度文件（总是 exit 0，缺文件回显空）。
func renderDesktopInstallProgressCommand() string {
	return fmt.Sprintf(`cat %q 2>/dev/null || true`, desktopInstallProgressFile)
}

// parseDesktopInstallProgress 从进度文件输出解析 "PROGRESS=<n>"；无则返回 -1。
//
// 问题 3 补充防护：flock 已在写侧阻止累积，此处保留 LastIndex 作双保险
// （取最后一次有效写），但 say 改为 > 单次覆盖后，实际已不会累积旧进度。
func parseDesktopInstallProgress(out string) int {
	idx := strings.LastIndex(out, "PROGRESS=")
	if idx < 0 {
		return -1
	}
	rest := out[idx+len("PROGRESS="):]
	end := 0
	for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
		end++
	}
	if end == 0 {
		return -1
	}
	n, err := strconv.Atoi(rest[:end])
	if err != nil {
		return -1
	}
	return n
}

// desktopCommandOutput 归一取命令输出（Output 优先，回退 Stdout）。
func desktopCommandOutput(result *psandbox.ExecCommandResult) string {
	if result == nil {
		return ""
	}
	if result.Output != "" {
		return result.Output
	}
	return result.Stdout
}

// desktopProvisionFailureDetail 从 provision 输出里提取失败原因（CR-P1#2）。
// provision 脚本 fail() 输出形如 "DESKTOP_PROVISION_FAILED <reason>"；这里取含该
// marker 的那一行、剥掉 marker 前缀返回原因，供上层写进 Failed 状态的可诊断消息。
func desktopProvisionFailureDetail(out string) string {
	for _, line := range strings.Split(out, "\n") {
		idx := strings.Index(line, desktopProvisionFailedMarker)
		if idx < 0 {
			continue
		}
		reason := strings.TrimSpace(line[idx+len(desktopProvisionFailedMarker):])
		if reason == "" {
			return "desktop provision failed"
		}
		return "desktop provision failed: " + reason
	}
	return "desktop provision failed"
}

// defaultDesktopSandboxAdapter reaper 与 server 启动期共用全局工厂，
// 避免给 Logic 接口增加生命周期方法。
func defaultDesktopSandboxAdapter() psandbox.Adapter {
	if adapterfactory.DefaultAdapterFactory == nil {
		return nil
	}
	return adapterfactory.DefaultAdapterFactory.SandboxAdapter()
}

// StartDesktopIdleReaper 桌面空闲回收（方案 §4.5 / §12 TB.4）：
// 周期扫描会话表，lastActive 超过阈值（默认 30 分钟）的桌面**只停桌面服务**
// （TAT `systemctl stop` 4 个 unit），**绝不 pause/停主机**——主机可能在跑 agent。
// 停服务后置 Paused，再次访问由 GET → provisionDesktop 幂等重新拉起服务。
// 进程内状态重启即失 → 重启后 lastActive 归零，桌面服务若仍在跑则下次探测即 Ready。
func StartDesktopIdleReaper(logger *zap.Logger, interval time.Duration, done <-chan struct{}) {
	if logger == nil {
		logger = zap.NewNop()
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				reapIdleDesktops(logger)
			}
		}
	}()
}

func reapIdleDesktops(logger *zap.Logger) {
	idleMinutes := desktopIdleTimeoutMinutes()
	if idleMinutes <= 0 {
		return // 回收禁用
	}
	threshold := time.Duration(idleMinutes) * time.Minute

	desktopSessions.Range(func(key, value any) bool {
		instanceID, _ := key.(string)
		session, ok := value.(*desktopSession)
		if !ok || session == nil {
			return true
		}
		operationMu := session.operationMutex()
		operationMu.Lock()
		defer operationMu.Unlock()
		if current, _ := desktopSessions.Load(instanceID); current != session {
			return true
		}
		sandboxID, _, status, _, lastActive := session.snapshot()
		if status != transport.DesktopSessionStatusReady || sandboxID == "" {
			return true
		}
		if time.Since(lastActive) < threshold {
			return true
		}
		// adapter 从全局工厂获取（与 reaper 包级生命周期一致）。
		adapter := defaultDesktopSandboxAdapter()
		if adapter == nil {
			return true
		}
		ctx := context.Background()
		// 只停桌面服务，不动主机（TB.4）。systemctl stop 幂等：已停返回 0。
		result, err := adapter.ExecCommand(ctx, sandboxID, renderDesktopStopServicesCommand(), desktopProbeTimeoutS)
		if err != nil || !sandboxCommandSucceeded(result) {
			detail := ""
			if err != nil {
				detail = err.Error()
			} else {
				detail = sandboxCommandFailureDetail(result)
			}
			logger.Warn("desktop idle reaper: stop desktop services failed",
				zap.String("instance_id", instanceID),
				zap.String("sandbox_id", sandboxID),
				zap.String("detail", detail))
			return true
		}
		session.setStatus(transport.DesktopSessionStatusPaused, "idle timeout")
		logger.Info("desktop idle reaper: desktop services stopped",
			zap.String("instance_id", instanceID),
			zap.String("sandbox_id", sandboxID))
		return true
	})
}

func desktopIdleTimeoutMinutes() int {
	raw := strings.TrimSpace(os.Getenv(desktopIdleTimeoutMinutesEnv))
	if raw == "" {
		return desktopDefaultIdleMinutes
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return desktopDefaultIdleMinutes
	}
	return value
}

// DesktopReapInterval idle reaper 扫描间隔（CR-D）：由 DESKTOP_REAP_INTERVAL_MINUTES
// 控制，默认 5 分钟；非法/<=0 回退默认值，避免 time.NewTicker 因非正间隔 panic。
// 供 server 启动期调用，把间隔配置内聚在桌面模块，与 desktopIdleTimeoutMinutes 同范式。
func DesktopReapInterval() time.Duration {
	minutes := desktopDefaultReapIntervalMin
	if raw := strings.TrimSpace(os.Getenv(desktopReapIntervalMinutesEnv)); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value > 0 {
			minutes = value
		}
	}
	return time.Duration(minutes) * time.Minute
}
