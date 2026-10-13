package instance

import (
	"context"
	"strings"
	"sync"
	"time"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/transport"
	"github.com/google/uuid"
)

const desktopResourcePreparationTimeout = 15 * time.Minute

func (s *desktopSession) operationMutex() *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.provisionMu == nil {
		s.provisionMu = &sync.Mutex{}
	}
	return s.provisionMu
}

// Pin cached state to the authorized user and physical sandbox. Replacements
// share a command mutex: an old in-flight command cannot overlap new provision.
func (l *logic) desktopSessionForEntity(ctx pctx.Context, entity *modelinstance.Entity) (*desktopSession, error) {
	if strings.TrimSpace(entity.SandboxId) == "" {
		return nil, errcode.ErrDesktopNotConfigured
	}
	for {
		session := l.desktopSessionOf(entity.InstanceId)
		session.mu.Lock()
		matches := session.userID == entity.UserId && session.sandboxID == entity.SandboxId && session.generation != ""
		session.mu.Unlock()
		if matches {
			return session, nil
		}
		operationMu := session.operationMutex()
		operationMu.Lock()
		// A caller may have waited behind TAT. Reload authority before binding.
		fresh, err := l.loadDesktopInstance(ctx, entity.InstanceId)
		if err != nil {
			operationMu.Unlock()
			return nil, err
		}
		entity = fresh
		if strings.TrimSpace(entity.SandboxId) == "" {
			operationMu.Unlock()
			return nil, errcode.ErrDesktopNotConfigured
		}
		current, _ := desktopSessions.Load(entity.InstanceId)
		if current != session {
			operationMu.Unlock()
			continue
		}
		session.mu.Lock()
		if session.userID == entity.UserId && session.sandboxID == entity.SandboxId && session.generation != "" {
			session.mu.Unlock()
			operationMu.Unlock()
			return session, nil
		}
		id, err := uuid.NewRandom()
		if err != nil {
			session.mu.Unlock()
			operationMu.Unlock()
			return nil, errcode.ErrSandboxServiceError
		}
		// An unbound initial record (also used by legacy fixtures) can be adopted,
		// but losing the session does not prove a pending remote grant is gone.
		adopt := session.userID == "" && (session.sandboxID == "" || session.sandboxID == entity.SandboxId)
		cancel := session.prepareCancel
		session.mu.Unlock()
		if err := l.revokeDesktopViewersLocked(ctx, session); err != nil {
			operationMu.Unlock()
			return nil, err
		}
		fresh, err = l.loadDesktopInstance(ctx, entity.InstanceId)
		if err != nil || fresh.UserId != entity.UserId || fresh.SandboxId != entity.SandboxId {
			operationMu.Unlock()
			if err != nil {
				return nil, err
			}
			return nil, errcode.ErrDesktopTargetChanged
		}
		if adopt {
			session.mu.Lock()
			session.userID, session.sandboxID, session.generation = entity.UserId, entity.SandboxId, id.String()
			session.mu.Unlock()
			operationMu.Unlock()
			return session, nil
		}
		next := &desktopSession{instanceID: entity.InstanceId, userID: entity.UserId,
			sandboxID: entity.SandboxId, generation: id.String(), provisionMu: operationMu}
		desktopSessions.Store(entity.InstanceId, next)
		operationMu.Unlock()
		if cancel != nil {
			cancel()
		}
		return next, nil
	}
}

func (l *logic) validateDesktopSession(ctx pctx.Context, session *desktopSession) error {
	entity, err := l.loadDesktopInstance(ctx, session.instanceID)
	if err != nil {
		return err
	}
	current, _ := desktopSessions.Load(entity.InstanceId)
	session.mu.Lock()
	matches := current == session && entity.UserId == session.userID && entity.SandboxId == session.sandboxID
	session.mu.Unlock()
	if !matches {
		return errcode.ErrDesktopTargetChanged
	}
	return nil
}

// Explicit preparation command. The resource job survives HTTP cancellation;
// only a bounded worker or a target replacement cancels its local orchestration.
func (l *logic) EnsureDesktopResource(ctx pctx.Context, instanceID string) (*transport.DesktopResourceResponse, error) {
	entity, err := l.loadDesktopInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	session, err := l.desktopSessionForEntity(ctx, entity)
	if err != nil {
		return nil, err
	}
	session, err = l.desktopResourceRetry(ctx, session)
	if err != nil {
		return nil, err
	}
	job, cancel := context.WithTimeout(context.Background(), desktopResourcePreparationTimeout)
	// observer 准备（prepareDesktopResource → execDesktopInstallCommand）经
	// /sandboxes/{id}/tat/commands 下发，该 TAT endpoint 鉴权只认 ctx 透传的用户
	// session（见 adapter.applySandboxSessionAuth，无服务级凭据回退）。请求早已返回，
	// 这里必须从 ctx 显式继承 SessionAuth，否则后台 worker 的 session 为空，TAT 调用
	// 会鉴权失败 → "desktop observation unavailable" → Failed（与 startDesktopInstall
	// 同源）。注意 provision/probe 走 PTY（X-API-Key 服务级密钥）不受此影响。
	worker := pctx.NewContext(job).
		WithUserID(ctx.GetUserID()).
		WithRegion(ctx.GetRegion()).
		WithSessionAuth(ctx.GetSessionAuthorization(), ctx.GetSessionCookie())
	worker.SetGormDB(ctx.GormDB())
	session.mu.Lock()
	if (session.status == transport.DesktopSessionStatusReady && session.observerPrepared) || session.preparing {
		session.mu.Unlock()
		cancel()
		return l.desktopResourceResponse(session), nil
	}
	session.preparing, session.prepareCancel = true, cancel
	session.mu.Unlock()
	go l.prepareDesktopResource(worker, session, cancel)
	return l.desktopResourceResponse(session), nil
}

// Replace the record on explicit retry, not just its generation label. An old
// detached installer may still finish remotely, but cannot publish into this job.
func (l *logic) desktopResourceRetry(ctx pctx.Context, session *desktopSession) (*desktopSession, error) {
	session.mu.Lock()
	retry := !session.preparing && (session.status == transport.DesktopSessionStatusPaused || session.status == transport.DesktopSessionStatusFailed)
	session.mu.Unlock()
	if !retry {
		return session, nil
	}
	op := session.operationMutex()
	op.Lock()
	defer op.Unlock()
	if current, _ := desktopSessions.Load(session.instanceID); current != session {
		return nil, errcode.ErrDesktopTargetChanged
	}
	if err := l.validateDesktopSession(ctx, session); err != nil {
		return nil, err
	}
	session.mu.Lock()
	if session.preparing || (session.status != transport.DesktopSessionStatusPaused && session.status != transport.DesktopSessionStatusFailed) {
		session.mu.Unlock()
		return session, nil
	}
	next := &desktopSession{instanceID: session.instanceID, userID: session.userID,
		sandboxID: session.sandboxID, provisionMu: op}
	session.mu.Unlock()
	id, err := uuid.NewRandom()
	if err != nil {
		return nil, errcode.ErrSandboxServiceError
	}
	next.generation = id.String()
	if err := l.revokeDesktopViewersLocked(ctx, session); err != nil {
		return nil, err
	}
	if err := l.validateDesktopSession(ctx, session); err != nil {
		return nil, err
	}
	desktopSessions.Store(session.instanceID, next)
	return next, nil
}

// Observation only. No cache allocation, TAT, provision, or idle heartbeat.
func (l *logic) GetDesktopResource(ctx pctx.Context, instanceID string) (*transport.DesktopResourceResponse, error) {
	entity, err := l.loadDesktopInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	raw, ok := desktopSessions.Load(instanceID)
	if !ok {
		return &transport.DesktopResourceResponse{ResourceID: instanceID, State: transport.DesktopResourceStateUnprepared}, nil
	}
	session, ok := raw.(*desktopSession)
	if !ok {
		return nil, errcode.ErrDesktopNotConfigured
	}
	session.mu.Lock()
	matches := session.userID == entity.UserId && session.sandboxID == entity.SandboxId && session.generation != ""
	session.mu.Unlock()
	if !matches {
		return &transport.DesktopResourceResponse{ResourceID: instanceID, State: transport.DesktopResourceStateUnprepared}, nil
	}
	return l.desktopResourceResponse(session), nil
}

func (l *logic) desktopResourceResponse(session *desktopSession) *transport.DesktopResourceResponse {
	session.mu.Lock()
	defer session.mu.Unlock()
	state := transport.DesktopResourceStateUnprepared
	switch session.status {
	case transport.DesktopSessionStatusReady:
		state = transport.DesktopResourceStatePreparing
		if session.observerPrepared && !session.preparing {
			state = transport.DesktopResourceStatePrepared
		}
	case transport.DesktopSessionStatusPaused:
		state = transport.DesktopResourceStatePaused
	case transport.DesktopSessionStatusFailed:
		state = transport.DesktopResourceStateFailed
	case transport.DesktopSessionStatusInstalling, transport.DesktopSessionStatusProvisioning:
		state = transport.DesktopResourceStatePreparing
	default:
		if session.preparing {
			state = transport.DesktopResourceStatePreparing
		}
	}
	return &transport.DesktopResourceResponse{ResourceID: session.instanceID, GenerationID: session.generation,
		State: state, Progress: session.installProgress}
}

func (l *logic) prepareDesktopInput(ctx pctx.Context, session *desktopSession, sandboxID string) error {
	op := session.operationMutex()
	op.Lock()
	defer op.Unlock()
	session.mu.Lock()
	generation := session.generation
	session.inputPrepared = false
	session.mu.Unlock()
	result, err := l.execDesktopInstallCommandLocked(ctx, session, sandboxID, renderDesktopInputPrepareCommand())
	if err != nil {
		return err
	}
	if !sandboxCommandSucceeded(result) {
		return errcode.ErrDesktopNotConfigured
	}
	incarnation, err := l.verifyDesktopIncarnationLocked(ctx, session, sandboxID)
	if err != nil {
		return err
	}
	result, err = l.execDesktopInstallCommandLocked(ctx, session, sandboxID, renderDesktopInputEpochCommand())
	if err != nil {
		return err
	}
	if !sandboxCommandSucceeded(result) {
		return errcode.ErrDesktopNotConfigured
	}
	expected, ok := parseDesktopInputEpoch(result.Output)
	if !ok {
		expected, ok = parseDesktopInputEpoch(result.Stdout)
	}
	if !ok || ctx.Err() != nil {
		return errcode.ErrDesktopNotConfigured
	}
	session.mu.Lock()
	matches := session.generation == generation
	session.mu.Unlock()
	if !matches {
		return errcode.ErrDesktopTargetChanged
	}
	result, err = l.execDesktopInstallCommandLocked(ctx, session, sandboxID,
		renderDesktopInputActivateCommand(generation, expected, incarnation))
	if err != nil {
		return err
	}
	if !sandboxCommandSucceeded(result) || ctx.Err() != nil {
		// 激活失败且网关已记录本代次，说明物理身份在本代次内被换掉了（观察进程
		// 带 Restart=on-failure，崩溃后自动拉起即改变身份）。网关刻意拒绝在同一
		// 代次下静默替换身份，只有换代才会被接受；继续用同一代次重试会让 epoch
		// 永远停在已消失的进程上，写授权再也签不出来，键鼠永久不可用且不可自愈。
		if expected != generation || ctx.Err() != nil {
			return errcode.ErrDesktopNotConfigured
		}
		fresh, uuidErr := uuid.NewRandom()
		if uuidErr != nil {
			return errcode.ErrSandboxServiceError
		}
		// 旧代次签出的观看租约绑定的是已消失的桌面，换代前必须先撤销。
		if err := l.revokeDesktopViewersLocked(ctx, session); err != nil {
			return err
		}
		session.mu.Lock()
		if session.generation != generation {
			session.mu.Unlock()
			return errcode.ErrDesktopTargetChanged
		}
		generation = fresh.String()
		session.generation = generation
		session.mu.Unlock()
		// 仍以旧代次作为 CAS 期望值，迟到的旧激活命令不会复活被淘汰的身份。
		result, err = l.execDesktopInstallCommandLocked(ctx, session, sandboxID,
			renderDesktopInputActivateCommand(generation, expected, incarnation))
		if err != nil {
			return err
		}
		if !sandboxCommandSucceeded(result) || ctx.Err() != nil {
			return errcode.ErrDesktopNotConfigured
		}
	}
	currentIncarnation, err := l.verifyDesktopIncarnationLocked(ctx, session, sandboxID)
	if err != nil {
		return err
	}
	if currentIncarnation != incarnation || ctx.Err() != nil {
		return errcode.ErrDesktopTargetChanged
	}
	if err := l.validateDesktopSession(ctx, session); err != nil {
		return err
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.generation != generation {
		return errcode.ErrDesktopTargetChanged
	}
	session.incarnation, session.inputPrepared = incarnation, true
	return nil
}

func (l *logic) prepareDesktopResource(ctx pctx.Context, session *desktopSession, cancel context.CancelFunc) {
	defer cancel()
	defer func() { session.mu.Lock(); session.preparing, session.prepareCancel = false, nil; session.mu.Unlock() }()
	for {
		if ctx.Err() != nil {
			session.setStatus(transport.DesktopSessionStatusFailed, "desktop preparation expired")
			return
		}
		if err := l.validateDesktopSession(ctx, session); err != nil {
			session.setStatus(transport.DesktopSessionStatusFailed, "desktop preparation unavailable")
			return
		}
		sandboxID, _, status, _, _ := session.snapshot()
		if status == transport.DesktopSessionStatusReady {
			result, err := l.execDesktopInstallCommand(ctx, session, sandboxID, renderDesktopObserverPrepareCommand())
			if err != nil || !sandboxCommandSucceeded(result) || ctx.Err() != nil || l.validateDesktopSession(ctx, session) != nil {
				session.setStatus(transport.DesktopSessionStatusFailed, "desktop observation unavailable")
				return
			}
			session.mu.Lock()
			session.observerPrepared = true
			session.mu.Unlock()
			// A process restart may lose local grants while the gateway retains them.
			// Without a confirmed epoch fence, even a read-only fallback is unsafe.
			if err := l.prepareDesktopInput(ctx, session, sandboxID); err != nil {
				session.setStatus(transport.DesktopSessionStatusFailed, "desktop input authorization unavailable")
			}
			return
		}
		if status == transport.DesktopSessionStatusFailed {
			return
		}
		if status != transport.DesktopSessionStatusInstalling {
			entity, err := l.loadDesktopInstance(ctx, session.instanceID)
			if err != nil {
				session.setStatus(transport.DesktopSessionStatusFailed, "desktop preparation unavailable")
				return
			}
			if status == transport.DesktopSessionStatusProvisioning && session.provisionAge() < desktopProvisionRetryAfter {
				_, err = l.probeDesktop(ctx, session)
			} else {
				_, err = l.provisionDesktop(ctx, session, entity)
			}
			// A prepared resource does not require legacy noVNC ingress credentials.
			_, _, status, _, _ = session.snapshot()
			if status == transport.DesktopSessionStatusReady {
				continue // Start the verified observer before publishing prepared.
			}
			if status == transport.DesktopSessionStatusFailed {
				return
			}
			if err != nil {
				session.setStatus(transport.DesktopSessionStatusFailed, "desktop preparation failed")
				return
			}
		}
		timer := time.NewTimer(desktopInstallPollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
}
