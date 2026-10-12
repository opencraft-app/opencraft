package instance

import (
	stdctx "context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	"ctl/pkg/model/channelloginsession"
	"ctl/pkg/model/instance"
	"ctl/pkg/transport"

	"go.uber.org/zap"
)

const (
	weixinLoginTTL               = 5 * time.Minute
	weixinProtocolPollEvery      = 3 * time.Second
	weixinProtocolCommandTimeout = 30
	weixinProtocolStateRoot      = "/tmp/lightclaw-weixin-login"
)

type weixinRuntime struct {
	cancel    stdctx.CancelFunc
	botID     string
	profileID string
	closing   atomic.Bool
}

type weixinProtocolPID int64

func (p *weixinProtocolPID) UnmarshalJSON(data []byte) error {
	raw := strings.TrimSpace(string(data))
	if raw == "" || raw == "null" {
		*p = 0
		return nil
	}
	if raw[0] == '"' {
		var text string
		if err := json.Unmarshal(data, &text); err != nil {
			return err
		}
		text = strings.TrimSpace(text)
		if text == "" {
			*p = 0
			return nil
		}
		value, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			return err
		}
		*p = weixinProtocolPID(value)
		return nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return err
	}
	*p = weixinProtocolPID(value)
	return nil
}

type weixinProtocolResponse struct {
	OK             bool              `json:"ok"`
	SessionID      string            `json:"session_id"`
	Status         string            `json:"status"`
	QRURL          string            `json:"qr_url"`
	QRASCII        string            `json:"qr_ascii"`
	Error          string            `json:"error"`
	ErrorCode      string            `json:"error_code"`
	PID            weixinProtocolPID `json:"pid"`
	LastOutputTail string            `json:"last_output_tail"`
}

type weixinLoginHub struct {
	mu          sync.RWMutex
	subscribers map[string]map[chan transport.WeixinLoginSessionEvent]struct{}
	runtimes    map[string]*weixinRuntime
}

func newWeixinLoginHub() *weixinLoginHub {
	return &weixinLoginHub{
		subscribers: make(map[string]map[chan transport.WeixinLoginSessionEvent]struct{}),
		runtimes:    make(map[string]*weixinRuntime),
	}
}

func (h *weixinLoginHub) setRuntime(sessionID string, runtime *weixinRuntime) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if runtime == nil {
		delete(h.runtimes, sessionID)
		return
	}
	h.runtimes[sessionID] = runtime
}

func (h *weixinLoginHub) runtime(sessionID string) *weixinRuntime {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.runtimes[sessionID]
}

func (h *weixinLoginHub) subscribe(sessionID string) (<-chan transport.WeixinLoginSessionEvent, func()) {
	ch := make(chan transport.WeixinLoginSessionEvent, 16)
	var once sync.Once
	h.mu.Lock()
	if h.subscribers[sessionID] == nil {
		h.subscribers[sessionID] = make(map[chan transport.WeixinLoginSessionEvent]struct{})
	}
	h.subscribers[sessionID][ch] = struct{}{}
	h.mu.Unlock()
	cancel := func() {
		once.Do(func() {
			h.mu.Lock()
			if subs := h.subscribers[sessionID]; subs != nil {
				delete(subs, ch)
				if len(subs) == 0 {
					delete(h.subscribers, sessionID)
				}
			}
			h.mu.Unlock()
			close(ch)
		})
	}
	return ch, cancel
}

func (h *weixinLoginHub) publish(sessionID string, event transport.WeixinLoginSessionEvent) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.subscribers[sessionID] {
		select {
		case ch <- event:
		default:
		}
	}
}

func (l *logic) CreateWeixinLoginSession(ctx pctx.Context, instanceID string, req *transport.CreateWeixinLoginSessionRequest) (*transport.CreateWeixinLoginSessionResponse, error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, errcode.ErrInstanceMissingUserID
	}
	entity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	if entity.Status != instance.InstanceStatusRunning {
		return nil, errcode.Wrap(errcode.ErrDebugNotSupported, "instance status is %s, expected running", entity.Status)
	}
	if err := l.requireActivePass(ctx); err != nil {
		return nil, activePassGuardError("create weixin login session", err)
	}
	botID := ""
	profileID := ""
	if req != nil {
		botID = strings.TrimSpace(req.BotID)
		profileID = strings.TrimSpace(req.ProfileID)
	}
	var bot *transport.InstanceBotResponse
	if botID == "" {
		bot, err = l.getInstanceBotByProfileID(ctx, instanceID, rootProfileID)
	} else {
		bot, err = l.getInstanceBotResponse(ctx, instanceID, botID)
	}
	if err != nil {
		return nil, err
	}
	if bot.Status != instanceBotStatusReady {
		return nil, errcode.Wrap(errcode.ErrInstanceBotConflict, "bot status is %s", bot.Status)
	}
	if profileID != "" && profileID != bot.ProfileID {
		return nil, errcode.Wrap(errcode.ErrInstanceBotInvalidParam, "profile_id does not match bot")
	}
	if _, err := l.ClaimInstanceBotChannel(ctx, instanceID, bot.BotID, uniqueChannelWeixin); err != nil {
		return nil, err
	}
	existing, err := l.channelLoginSessionDao.GetActiveByInstance(ctx, instanceID, channelloginsession.ChannelWeixin)
	if err != nil {
		_ = l.releaseReservedInstanceBotChannel(ctx, instanceID, bot.BotID, bot.ProfileID)
		return nil, err
	}
	if existing != nil {
		_ = l.releaseReservedInstanceBotChannel(ctx, instanceID, bot.BotID, bot.ProfileID)
		return nil, errcode.Wrap(errcode.ErrChannelLoginConflict, "active session already exists: %s", existing.SessionID)
	}

	now := time.Now().UTC()
	sessionID := l.objectIdLogic.GenerateWxLoginSessionId()
	record := &channelloginsession.Entity{
		SessionID:  sessionID,
		InstanceID: instanceID,
		BotID:      bot.BotID,
		ProfileID:  bot.ProfileID,
		Channel:    channelloginsession.ChannelWeixin,
		Status:     channelloginsession.StatusStarting,
		StartedAt:  now,
		ExpiresAt:  now.Add(weixinLoginTTL),
	}
	if err := l.channelLoginSessionDao.Create(ctx, record); err != nil {
		_ = l.releaseReservedInstanceBotChannel(ctx, instanceID, bot.BotID, bot.ProfileID)
		return nil, err
	}

	bgCtx := pctx.NewContext(stdctx.Background()).WithUserID(ctx.GetUserID()).WithRegion(ctx.GetRegion())
	bgCtx.SetRequestId(ctx.GetRequestId())
	bgCtx.SetAction("weixin_login_session")
	l.startWeixinLoginSession(bgCtx, entity, record, bot.BotID, bot.ProfileID)

	return &transport.CreateWeixinLoginSessionResponse{
		SessionID: sessionID,
		Status:    channelloginsession.StatusStarting,
	}, nil
}

func (l *logic) GetWeixinLoginSession(ctx pctx.Context, instanceID, sessionID string) (*transport.WeixinLoginSessionResponse, error) {
	entity, err := l.channelLoginSessionDao.GetBySessionID(ctx, instanceID, sessionID)
	if err != nil {
		if errors.Is(err, errcode.ErrInstanceNotFound) {
			return nil, errcode.ErrChannelLoginNotFound
		}
		return nil, err
	}
	return toWeixinSessionResponse(entity, l.weixinHub.runtime(sessionID)), nil
}

func (l *logic) CancelWeixinLoginSession(ctx pctx.Context, instanceID, sessionID string) (*transport.WeixinLoginSessionResponse, error) {
	entity, err := l.channelLoginSessionDao.GetBySessionID(ctx, instanceID, sessionID)
	if err != nil {
		if errors.Is(err, errcode.ErrInstanceNotFound) {
			return nil, errcode.ErrChannelLoginNotFound
		}
		return nil, err
	}
	if !isWeixinSessionActive(entity.Status) {
		return nil, errcode.ErrChannelLoginNotRunning
	}
	inst, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	rt := l.weixinHub.runtime(sessionID)
	if rt != nil {
		rt.closing.Store(true)
		defer func() {
			if err != nil {
				rt.closing.Store(false)
			}
		}()
	}
	botID, profileID, err := l.weixinSessionTarget(ctx, instanceID, sessionID)
	if err != nil {
		return nil, err
	}
	protocolResp, err := l.execWeixinProtocolCommandForProfile(ctx, inst.SandboxId, profileID, "cancel", sessionID, 20)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	updates := map[string]interface{}{
		channelloginsession.ColumnStatus:       normalizeWeixinProtocolStatus(protocolResp.Status, protocolResp.OK),
		channelloginsession.ColumnFinishedAt:   &now,
		channelloginsession.ColumnErrorMessage: coalesce(protocolResp.Error, "cancelled by user"),
	}
	if protocolResp.QRURL != "" {
		updates[channelloginsession.ColumnQRCodeURL] = protocolResp.QRURL
	}
	if protocolResp.QRASCII != "" {
		updates[channelloginsession.ColumnQRCodeASCII] = protocolResp.QRASCII
	}
	if protocolResp.LastOutputTail != "" {
		updates[channelloginsession.ColumnLastOutput] = protocolResp.LastOutputTail
	}
	if protocolResp.PID > 0 {
		updates[channelloginsession.ColumnRemotePID] = int64(protocolResp.PID)
	}
	if err := l.channelLoginSessionDao.UpdateFields(ctx, instanceID, sessionID, updates); err != nil {
		return nil, err
	}
	if rt := l.weixinHub.runtime(sessionID); rt != nil && rt.cancel != nil {
		rt.cancel()
	}
	snapshot, _ := l.GetWeixinLoginSession(ctx, instanceID, sessionID)
	if snapshot != nil {
		l.weixinHub.publish(sessionID, transport.WeixinLoginSessionEvent{Type: "finished", Status: snapshot.Status, Data: snapshot})
	}
	_ = l.releaseReservedInstanceBotChannel(ctx, instanceID, botID, profileID)
	return snapshot, nil
}

func (l *logic) weixinSessionTarget(ctx pctx.Context, instanceID, sessionID string) (string, string, error) {
	if runtime := l.weixinHub.runtime(sessionID); runtime != nil {
		return runtime.botID, runtime.profileID, nil
	}
	session, err := l.channelLoginSessionDao.GetBySessionID(ctx, instanceID, sessionID)
	if err != nil {
		return "", "", err
	}
	if session.BotID == "" || session.ProfileID == "" {
		// Sessions created before bot_id/profile_id were persisted live for at
		// most five minutes. Recover only when their instance has one owner.
		catalog, listErr := l.ListInstanceBots(ctx, instanceID)
		if listErr != nil {
			return "", "", listErr
		}
		var owner *transport.InstanceChannelBindingResponse
		for _, bot := range catalog.Items {
			if bot.WeixinOwner == nil {
				continue
			}
			if owner != nil {
				return "", "", errcode.Wrap(errcode.ErrChannelLoginNotFound, "ambiguous legacy weixin session target")
			}
			owner = bot.WeixinOwner
		}
		if owner == nil {
			return "", "", errcode.Wrap(errcode.ErrChannelLoginNotFound, "weixin session target is unavailable")
		}
		return owner.BotID, owner.ProfileID, nil
	}
	return session.BotID, session.ProfileID, nil
}

func (l *logic) SubscribeWeixinLoginSession(ctx pctx.Context, instanceID, sessionID string) (*transport.WeixinLoginSessionResponse, <-chan transport.WeixinLoginSessionEvent, func(), error) {
	snapshot, err := l.GetWeixinLoginSession(ctx, instanceID, sessionID)
	if err != nil {
		return nil, nil, nil, err
	}
	ch, cancel := l.weixinHub.subscribe(sessionID)
	if !isWeixinSessionActive(snapshot.Status) {
		go func() {
			l.weixinHub.publish(sessionID, transport.WeixinLoginSessionEvent{Type: "finished", Status: snapshot.Status, Data: snapshot})
			cancel()
		}()
	}
	return snapshot, ch, cancel, nil
}

func (l *logic) startWeixinLoginSession(ctx pctx.Context, inst *instance.Entity, session *channelloginsession.Entity, botID, profileID string) {
	runCtx, cancel := stdctx.WithDeadline(ctx, session.ExpiresAt)
	l.weixinHub.setRuntime(session.SessionID, &weixinRuntime{cancel: cancel, botID: botID, profileID: profileID})

	go func() {
		defer l.weixinHub.setRuntime(session.SessionID, nil)
		defer cancel()
		defer func() { _ = l.releaseReservedInstanceBotChannel(ctx, session.InstanceID, botID, profileID) }()

		update := func(updates map[string]interface{}, event transport.WeixinLoginSessionEvent) {
			if err := l.channelLoginSessionDao.UpdateFields(ctx, session.InstanceID, session.SessionID, updates); err != nil {
				ctx.Logger().Error("update weixin login session failed")
				return
			}
			snapshot, err := l.GetWeixinLoginSession(ctx, session.InstanceID, session.SessionID)
			if err != nil {
				return
			}
			event.Data = snapshot
			if event.Status == "" {
				event.Status = snapshot.Status
			}
			l.weixinHub.publish(session.SessionID, event)
		}

		var stateMu sync.Mutex
		currentStatus := session.Status
		currentQRURL := ""
		currentQRASCII := ""
		currentLastOutput := ""

		applyProtocolSnapshot := func(resp *weixinProtocolResponse) bool {
			if resp == nil {
				return false
			}
			nextStatus := normalizeWeixinProtocolStatus(resp.Status, resp.OK)
			if rt := l.weixinHub.runtime(session.SessionID); rt != nil && rt.closing.Load() && isWeixinSessionActive(nextStatus) {
				return false
			}

			stateMu.Lock()
			prevStatus := currentStatus
			prevQRURL := currentQRURL
			prevQRASCII := currentQRASCII
			prevLastOutput := currentLastOutput
			stateMu.Unlock()

			updates := map[string]interface{}{}
			event := transport.WeixinLoginSessionEvent{Type: "status", Status: nextStatus}

			if resp.PID > 0 {
				updates[channelloginsession.ColumnRemotePID] = int64(resp.PID)
			}
			if resp.LastOutputTail != "" && resp.LastOutputTail != prevLastOutput {
				updates[channelloginsession.ColumnLastOutput] = resp.LastOutputTail
				event.Type = "output"
				event.Output = resp.LastOutputTail
			}
			if resp.QRURL != "" && resp.QRURL != prevQRURL {
				updates[channelloginsession.ColumnQRCodeURL] = resp.QRURL
				event.Type = "qr"
				event.QRURL = resp.QRURL
			}
			if resp.QRASCII != "" && resp.QRASCII != prevQRASCII {
				updates[channelloginsession.ColumnQRCodeASCII] = resp.QRASCII
				event.Type = "qr"
				event.QRASCII = resp.QRASCII
			}
			if nextStatus != prevStatus {
				updates[channelloginsession.ColumnStatus] = nextStatus
			}

			terminal := !isWeixinSessionActive(nextStatus)
			if nextStatus == channelloginsession.StatusSuccess {
				if err := l.finishWeixinLoginSuccess(ctx, inst.SandboxId, session, botID, profileID, update); err != nil {
					_ = l.releaseReservedInstanceBotChannel(ctx, session.InstanceID, botID, profileID)
				}
				return true
			}
			if terminal {
				now := time.Now().UTC()
				updates[channelloginsession.ColumnFinishedAt] = &now
				if resp.Error != "" {
					updates[channelloginsession.ColumnErrorMessage] = resp.Error
				}
				event.Type = "finished"
				event.Error = resp.Error
			} else if resp.Error != "" {
				updates[channelloginsession.ColumnErrorMessage] = resp.Error
			}

			if len(updates) > 0 {
				update(updates, event)
				stateMu.Lock()
				currentStatus = nextStatus
				if resp.QRURL != "" {
					currentQRURL = resp.QRURL
				}
				if resp.QRASCII != "" {
					currentQRASCII = resp.QRASCII
				}
				if resp.LastOutputTail != "" {
					currentLastOutput = resp.LastOutputTail
				}
				stateMu.Unlock()
			}
			if terminal {
				_ = l.releaseReservedInstanceBotChannel(ctx, session.InstanceID, botID, profileID)
			}

			return terminal
		}

		startResp, err := l.execWeixinProtocolCommandForProfile(
			ctx,
			inst.SandboxId,
			profileID,
			"start",
			session.SessionID,
			weixinProtocolCommandTimeout,
			"--timeout-seconds",
			strconv.Itoa(int(session.ExpiresAt.Sub(session.StartedAt).Seconds())),
		)
		if err != nil {
			now := time.Now().UTC()
			update(map[string]interface{}{
				channelloginsession.ColumnStatus:       channelloginsession.StatusFailed,
				channelloginsession.ColumnFinishedAt:   &now,
				channelloginsession.ColumnErrorMessage: err.Error(),
			}, transport.WeixinLoginSessionEvent{Type: "finished", Status: channelloginsession.StatusFailed, Error: err.Error()})
			return
		}
		if startResp.SessionID != "" && startResp.SessionID != session.SessionID {
			now := time.Now().UTC()
			err = errcode.Wrap(errcode.ErrChannelLoginExecFailed, "unexpected weixin session id: %s", startResp.SessionID)
			update(map[string]interface{}{
				channelloginsession.ColumnStatus:       channelloginsession.StatusFailed,
				channelloginsession.ColumnFinishedAt:   &now,
				channelloginsession.ColumnErrorMessage: err.Error(),
			}, transport.WeixinLoginSessionEvent{Type: "finished", Status: channelloginsession.StatusFailed, Error: err.Error()})
			return
		}
		if applyProtocolSnapshot(startResp) {
			return
		}

		ticker := time.NewTicker(weixinProtocolPollEvery)
		defer ticker.Stop()
		for {
			var statusResp *weixinProtocolResponse
			select {
			case <-ticker.C:
				var pollErr error
				statusResp, pollErr = l.execWeixinProtocolCommandForProfile(
					ctx,
					inst.SandboxId,
					profileID,
					"status",
					session.SessionID,
					weixinProtocolCommandTimeout,
				)
				if pollErr != nil {
					ctx.Logger().Warn("poll weixin protocol status failed")
					continue
				}
			case <-runCtx.Done():
				if errors.Is(runCtx.Err(), stdctx.Canceled) {
					return
				}
				now := time.Now().UTC()
				finalStatus := channelloginsession.StatusExpired
				update(map[string]interface{}{
					channelloginsession.ColumnStatus:       finalStatus,
					channelloginsession.ColumnFinishedAt:   &now,
					channelloginsession.ColumnErrorMessage: "weixin login session expired",
				}, transport.WeixinLoginSessionEvent{Type: "finished", Status: finalStatus, Error: "weixin login session expired"})
				return
			}
			if applyProtocolSnapshot(statusResp) {
				return
			}
		}
	}()
}

func (l *logic) execWeixinProtocolCommand(ctx pctx.Context, sandboxID, subcommand, sessionID string, timeoutSec int, extraArgs ...string) (*weixinProtocolResponse, error) {
	return l.execWeixinProtocolCommandForProfile(ctx, sandboxID, rootProfileID, subcommand, sessionID, timeoutSec, extraArgs...)
}

func (l *logic) execWeixinProtocolCommandForProfile(ctx pctx.Context, sandboxID, profileID, subcommand, sessionID string, timeoutSec int, extraArgs ...string) (*weixinProtocolResponse, error) {
	args := []string{"--session-id", sessionID}
	args = append(args, extraArgs...)
	result, err := l.execSandboxProcessCommand(ctx, sandboxID, "weixin_protocol_"+subcommand, &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", openclawWeixinProtocolCommandForProfile(profileID, subcommand, args...)},
		Pty:  false,
	}, timeoutSec)
	if err != nil {
		return l.maybeFallbackWeixinProtocolState(ctx, sandboxID, subcommand, sessionID, timeoutSec, err)
	}
	resp, parseErr := parseWeixinProtocolResult(result)
	if parseErr != nil {
		return l.maybeFallbackWeixinProtocolState(ctx, sandboxID, subcommand, sessionID, timeoutSec, parseErr)
	}
	return resp, nil
}

func parseWeixinProtocolResult(result *psandbox.ExecCommandResult) (*weixinProtocolResponse, error) {
	if result == nil {
		return nil, errcode.Wrap(errcode.ErrChannelLoginExecFailed, "empty weixin protocol result")
	}
	payload := strings.TrimSpace(result.Output)
	if payload == "" {
		if !sandboxCommandSucceeded(result) {
			return nil, errcode.Wrap(errcode.ErrChannelLoginExecFailed, "%s", sandboxCommandFailureDetail(result))
		}
		return nil, errcode.Wrap(errcode.ErrChannelLoginExecFailed, "empty weixin protocol response")
	}
	var resp weixinProtocolResponse
	if err := json.Unmarshal([]byte(payload), &resp); err != nil {
		if !sandboxCommandSucceeded(result) {
			return nil, errcode.Wrap(errcode.ErrChannelLoginExecFailed, "%s", sandboxCommandFailureDetail(result))
		}
		return nil, errcode.Wrap(errcode.ErrChannelLoginExecFailed, "invalid weixin protocol response: %s", err.Error())
	}
	if !sandboxCommandSucceeded(result) && !resp.OK && strings.TrimSpace(resp.Status) == "" {
		return nil, errcode.Wrap(errcode.ErrChannelLoginExecFailed, "%s", sandboxCommandFailureDetail(result))
	}
	return &resp, nil
}

func (l *logic) maybeFallbackWeixinProtocolState(
	ctx pctx.Context,
	sandboxID string,
	subcommand string,
	sessionID string,
	timeoutSec int,
	primaryErr error,
) (*weixinProtocolResponse, error) {
	switch subcommand {
	case "status":
		resp, err := l.readWeixinProtocolState(ctx, sandboxID, sessionID, timeoutSec)
		if err == nil {
			return resp, nil
		}
	case "cancel":
		lastStatus := ""
		var lastErr error
		for attempt := 0; attempt < 8; attempt++ {
			resp, err := l.readWeixinProtocolState(ctx, sandboxID, sessionID, timeoutSec)
			if err == nil {
				status := normalizeWeixinProtocolStatus(resp.Status, resp.OK)
				lastStatus = status
				if status != "" && !isWeixinSessionActive(status) {
					return resp, nil
				}
				lastErr = nil
			} else {
				lastErr = err
			}
			if attempt < 7 {
				time.Sleep(250 * time.Millisecond)
			}
		}
		fields := []zap.Field{
			zap.String("session_id", sessionID),
			zap.String("subcommand", subcommand),
			zap.String("last_status", lastStatus),
			zap.String("primary_error", primaryErr.Error()),
		}
		if lastErr != nil {
			fields = append(fields, zap.String("fallback_error", lastErr.Error()))
		}
		ctx.Logger().Warn("weixin protocol fallback exhausted", fields...)
	}
	return nil, primaryErr
}

func (l *logic) readWeixinProtocolState(ctx pctx.Context, sandboxID, sessionID string, timeoutSec int) (*weixinProtocolResponse, error) {
	stateFile := fmt.Sprintf("%s/%s/state.json", weixinProtocolStateRoot, sessionID)
	fallbackJSON := fmt.Sprintf(
		`{"ok":false,"session_id":%s,"status":"","error":"session state not found","error_code":"session_not_found"}`,
		jsonQuoted(sessionID),
	)
	command := strings.Join([]string{
		`state_file=` + shellQuoteArg(stateFile),
		`if [ -f "$state_file" ]; then`,
		`  cat "$state_file"`,
		`else`,
		`  printf '%s\n' ` + shellQuoteArg(fallbackJSON),
		`fi`,
	}, "\n")
	result, err := l.execSandboxProcessCommand(ctx, sandboxID, "weixin_protocol_state_fallback", &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", command},
		Pty:  false,
	}, timeoutSec)
	if err != nil {
		return nil, err
	}
	return parseWeixinProtocolResult(result)
}

func openclawWeixinProtocolCommand(subcommand string, args ...string) string {
	return openclawWeixinProtocolCommandForProfile(rootProfileID, subcommand, args...)
}

func openclawWeixinProtocolCommandForProfile(profileID, subcommand string, args ...string) string {
	parts := []string{
		`env -i`,
		`HOME="$HOME"`,
		`USER="$USER"`,
		`HERMES_HOME=` + hermesProfileHomeShellValue(profileID),
		`HERMES_PROFILE=` + shellQuoteArg(hermesNativeProfileID(profileID)),
		`PATH=/usr/bin:/bin`,
		`openclaw-weixin-login-session`,
		shellQuoteArg(subcommand),
	}
	for _, arg := range args {
		parts = append(parts, shellQuoteArg(arg))
	}
	return openclawRuntimeUserCommand(strings.Join(parts, " "))
}

func hermesProfileHomeShellValue(profileID string) string {
	if profileID == rootProfileID {
		return `"$HOME/.hermes"`
	}
	return `"$HOME/.hermes/profiles/"` + shellQuoteArg(profileID)
}

func normalizeWeixinProtocolStatus(status string, ok bool) string {
	switch strings.TrimSpace(status) {
	case "", channelloginsession.StatusStarting:
		if !ok && strings.TrimSpace(status) == "" {
			return channelloginsession.StatusFailed
		}
		return channelloginsession.StatusStarting
	case channelloginsession.StatusWaitingQR:
		return channelloginsession.StatusWaitingQR
	case channelloginsession.StatusCancelled:
		return channelloginsession.StatusCancelled
	case channelloginsession.StatusExpired:
		return channelloginsession.StatusExpired
	case channelloginsession.StatusFailed:
		return channelloginsession.StatusFailed
	default:
		if !ok {
			return channelloginsession.StatusFailed
		}
		return status
	}
}

func (l *logic) finishWeixinLoginSuccess(ctx pctx.Context, sandboxID string, session *channelloginsession.Entity, botID, profileID string, update func(map[string]interface{}, transport.WeixinLoginSessionEvent)) error {
	// Check the account before starting this Profile's gateway.
	binding, err := l.runChannelBindingAction(ctx, session.InstanceID, uniqueChannelWeixin, "confirm", botID, profileID)
	if err != nil || !binding.OK {
		if err == nil {
			err = l.channelBindingFailure(ctx, session.InstanceID, binding)
		}
		now := time.Now().UTC()
		update(map[string]interface{}{
			channelloginsession.ColumnStatus:       channelloginsession.StatusFailed,
			channelloginsession.ColumnFinishedAt:   &now,
			channelloginsession.ColumnErrorMessage: "weixin account confirmation failed",
		}, transport.WeixinLoginSessionEvent{Type: "finished", Status: channelloginsession.StatusFailed, Error: err.Error()})
		return err
	}
	restartStatus := "running"
	update(map[string]interface{}{
		channelloginsession.ColumnRestartStatus: restartStatus,
	}, transport.WeixinLoginSessionEvent{Type: "status", Status: channelloginsession.StatusScanned})

	result, err := l.execSandboxProcessCommand(ctx, sandboxID, "weixin_gateway_restart", &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", fmt.Sprintf("acli gateway restart --agent %s", shellQuoteArg(profileID))},
		Pty:  false,
	}, 60)
	now := time.Now().UTC()
	if err != nil || !sandboxCommandSucceeded(result) {
		restartErr := err
		if restartErr == nil {
			restartErr = errcode.Wrap(errcode.ErrChannelLoginExecFailed, "%s", sandboxCommandFailureDetail(result))
		}
		update(map[string]interface{}{
			channelloginsession.ColumnStatus:        channelloginsession.StatusFailed,
			channelloginsession.ColumnFinishedAt:    &now,
			channelloginsession.ColumnRestartStatus: "failed",
			channelloginsession.ColumnRestartError:  restartErr.Error(),
			channelloginsession.ColumnErrorMessage:  "gateway restart failed after login success",
		}, transport.WeixinLoginSessionEvent{Type: "finished", Status: channelloginsession.StatusFailed, Error: restartErr.Error()})
		return restartErr
	}
	update(map[string]interface{}{
		channelloginsession.ColumnStatus:        channelloginsession.StatusSuccess,
		channelloginsession.ColumnFinishedAt:    &now,
		channelloginsession.ColumnRestartStatus: "success",
	}, transport.WeixinLoginSessionEvent{Type: "finished", Status: channelloginsession.StatusSuccess})
	return nil
}

func openclawShellCommand(args string) string {
	return `openclaw ` + args
}

func shellUserCommand(user string, command string) string {
	targetUser := strings.TrimSpace(user)
	if targetUser == "" {
		return command
	}
	// Select the launcher first so a long script is quoted only once in bash -c's
	// argument. Duplicating it in both branches can exceed Linux MAX_ARG_STRLEN.
	return strings.Join([]string{
		`target_user=` + shellQuoteArg(targetUser),
		`if [ "$(id -un)" = "$target_user" ]; then`,
		`  set -- bash`,
		`else`,
		`  set -- sudo -u "$target_user" -H env HOME="$HOME" USER="$USER" PATH="$PATH" bash`,
		`fi`,
		`"$@" -c ` + shellQuoteArg(command),
	}, "\n")
}

func shellUserEnv(user string) map[string]string {
	targetUser := strings.TrimSpace(user)
	if targetUser == "" {
		return nil
	}
	targetHome := "/home/" + targetUser
	return map[string]string{
		"HOME": targetHome,
		"USER": targetUser,
		"PATH": targetHome + "/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin",
	}
}

func openclawRuntimeUserCommand(command string) string {
	return strings.Join([]string{
		`runtime_user="${LIGHTCLAW_RUNTIME_USER:-lightclaw}"`,
		`target_user="${runtime_user}"`,
		`target_home="$(getent passwd "$target_user" | cut -d: -f6)"`,
		`target_path="$target_home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"`,
		`if [ -z "$target_home" ]; then`,
		`  echo "runtime home not found for $target_user" >&2`,
		`  exit 1`,
		`fi`,
		`if [ "$(id -un)" = "$target_user" ]; then`,
		`  export HOME="$target_home" USER="$target_user" PATH="$target_path"`,
		`  bash -c ` + shellQuoteArg(command),
		`else`,
		`  sudo -u "$target_user" -H env HOME="$target_home" USER="$target_user" PATH="$target_path" bash -c ` + shellQuoteArg(command),
		`fi`,
	}, "\n")
}

func openclawUserSystemdCommand(command string) string {
	return openclawRuntimeUserCommand(strings.Join([]string{
		`runtime_uid="$(id -u)"`,
		`export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/${runtime_uid}}"`,
		`mkdir -p "$XDG_RUNTIME_DIR" 2>/dev/null || true`,
		`if command -v loginctl >/dev/null 2>&1; then loginctl enable-linger "$(id -un)" 2>/dev/null || true; fi`,
		`if [ -S "$XDG_RUNTIME_DIR/bus" ]; then export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"; fi`,
		command,
	}, "\n"))
}

func openclawGatewayRestartCommand() string {
	return openclawUserSystemdCommand(strings.Join([]string{
		openclawShellCommand("gateway restart"),
	}, "\n"))
}

func openclawEnsureQQBotPluginCommand() string {
	return openclawRuntimeUserCommand(strings.Join([]string{
		// Mia: plugins list shows plugin id/path, not npm package name. Grep the runtime id.
		`if openclaw plugins list 2>/dev/null | grep -Fq 'openclaw-qqbot'; then`,
		`  echo "plugin ready"`,
		`else`,
		`  openclaw plugins install @tencent-connect/openclaw-qqbot`,
		`fi`,
	}, "\n"))
}

func shellQuoteArg(value string) string {
	if value == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

func jsonQuoted(value string) string {
	data, _ := json.Marshal(value)
	return string(data)
}

func toWeixinSessionResponse(entity *channelloginsession.Entity, runtime *weixinRuntime) *transport.WeixinLoginSessionResponse {
	if entity == nil {
		return nil
	}
	response := &transport.WeixinLoginSessionResponse{
		SessionID:     entity.SessionID,
		BotID:         entity.BotID,
		ProfileID:     entity.ProfileID,
		Status:        entity.Status,
		QRURL:         entity.QRURL,
		QRASCII:       entity.QRASCII,
		LastOutput:    entity.LastOutput,
		StartedAt:     entity.StartedAt,
		ExpiresAt:     entity.ExpiresAt,
		FinishedAt:    entity.FinishedAt,
		ErrorMessage:  entity.ErrorMessage,
		RestartStatus: entity.RestartStatus,
		RestartError:  entity.RestartError,
	}
	if runtime != nil {
		response.BotID = runtime.botID
		response.ProfileID = runtime.profileID
	}
	return response
}

func isWeixinSessionActive(status string) bool {
	switch status {
	case channelloginsession.StatusStarting, channelloginsession.StatusWaitingQR:
		return true
	default:
		return false
	}
}

func appendBounded(buf *strings.Builder, chunk string, max int) {
	current := buf.String() + chunk
	if len(current) > max {
		current = current[len(current)-max:]
	}
	buf.Reset()
	buf.WriteString(current)
}

func coalesce(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
